import path from 'node:path';
import ts from 'typescript';
import { packageRoot } from './paths.js';
import { SUPPORT_SOURCE } from './support.js';

export interface Validation { ok: boolean; errors: string[] }

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const EXPECT_RE = /\bexpect(?:\.(?:soft|poll))?\s*\(/g;
export function countAssertions(code: string): number {
  return (stripComments(code).match(EXPECT_RE) ?? []).length;
}

const SKIP_RE = /\btest(?:\.describe)?\.(skip|fixme)\b|\btest\.fail\b|\btest\.slow\b/;
const TAUTOLOGY_RE = /\bexpect\s*\(\s*(?:true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy|toBeFalsy|toStrictEqual)\b/g;

/** Returns a reason string if `next` weakens the assertions of `prev`, else null. */
export function weakensAssertions(prev: string, next: string): string | null {
  const n = stripComments(next);
  if (SKIP_RE.test(n) && !SKIP_RE.test(stripComments(prev))) return 'patch skips/fixmes the test (test.skip/test.fixme)';
  const before = countAssertions(prev), after = countAssertions(next);
  if (after < before) return `patch has fewer assertions (${after}) than the original (${before})`;
  const taut = (s: string) => (stripComments(s).match(TAUTOLOGY_RE) ?? []).length;
  if (taut(next) > taut(prev)) return 'patch adds tautological assertions (e.g. expect(true).toBe(true))';
  return null;
}

const ALLOWED_MODULES = new Set(['./_support', './_support.js', './_support.ts', '@playwright/test']);
const FORBIDDEN_IDENTS = new Set(['require', 'eval', 'Function', 'process', 'globalThis', 'global', 'module', 'exports', '__dirname', '__filename']);

/** AST-based safety checks: specs are LLM output steered by untrusted page content, so lock down what they can touch. */
export function securityErrors(code: string): string[] {
  const sf = ts.createSourceFile('spec.ts', code, ts.ScriptTarget.ES2022, true);
  const errors = new Set<string>();
  const checkSpecifier = (node: ts.Node, spec: ts.Expression | undefined, what: string) => {
    if (!spec || !ts.isStringLiteralLike(spec) || !ALLOWED_MODULES.has(spec.text)) {
      errors.add(`${what} of ${spec && ts.isStringLiteralLike(spec) ? JSON.stringify(spec.text) : 'a non-literal module'} is not allowed (only './_support' and '@playwright/test' are permitted) (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) checkSpecifier(node, node.moduleSpecifier, 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) checkSpecifier(node, node.moduleSpecifier, 'export-from');
    else if (ts.isImportEqualsDeclaration(node)) errors.add('import = require() is not allowed');
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.add('dynamic import() is not allowed');
    else if (ts.isImportTypeNode(node)) errors.add('import() types are not allowed');
    else if (ts.isIdentifier(node) && FORBIDDEN_IDENTS.has(node.text)) {
      const p = node.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isPropertySignature(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node);
      if (!isName) errors.add(`use of "${node.text}" is not allowed (line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);
    } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ['globalThis', 'window', 'self'].includes(node.expression.text) && !ts.isStringLiteralLike(node.argumentExpression)) {
      errors.add('computed access on global objects is not allowed');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...errors];
}

// ---- TypeScript type-check against real Playwright types, in memory ----
const root = () => packageRoot();
let cached: ts.Program | undefined;

function check(code: string): string[] {
  const dir = path.join(root(), '.agentic-virtual');
  const specPath = path.join(dir, 'spec.spec.ts');
  const supportPath = path.join(dir, '_support.ts');
  const virtual = new Map([[specPath, code], [supportPath, SUPPORT_SOURCE]]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: ['node'], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  };
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => root();
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(f) || fileExists(f);
  const dirExists = host.directoryExists?.bind(host);
  host.directoryExists = (d) => d === dir || (dirExists ? dirExists(d) : false);
  host.readFile = (f) => virtual.get(f) ?? readFile(f);
  host.getSourceFile = (f, lang, ...rest) => (virtual.has(f) ? ts.createSourceFile(f, virtual.get(f)!, lang, true) : getSourceFile(f, lang, ...rest));
  cached = ts.createProgram([specPath], options, host, cached);
  const sf = cached.getSourceFile(specPath)!;
  const diags = [...cached.getSyntacticDiagnostics(sf), ...(cached.getSyntacticDiagnostics(sf).length ? [] : cached.getSemanticDiagnostics(sf))];
  return diags.map((d) => {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    return `line ${pos ? pos.line + 1 : '?'}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

export async function validateSpec(code: string): Promise<Validation> {
  const errors: string[] = [];
  const clean = stripComments(code);
  if (!/from\s+['"]\.\/_support(\.js|\.ts)?['"]/.test(clean)) errors.push("must import { test, expect } from './_support' (not directly from '@playwright/test')");
  if (!/\btest\s*\(/.test(clean)) errors.push('must define at least one test( ... ) block');
  if (!EXPECT_RE.test(clean)) errors.push('must contain at least one expect(...) assertion');
  EXPECT_RE.lastIndex = 0;
  if (/\btest\.only\b/.test(clean)) errors.push('test.only is not allowed');
  if (SKIP_RE.test(clean)) errors.push('test.skip/test.fixme is not allowed');
  errors.push(...securityErrors(code));
  if (!errors.length || errors.every((e) => !e.startsWith('must import'))) errors.push(...check(code));
  return { ok: errors.length === 0, errors };
}
