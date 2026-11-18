import type { z } from 'zod';
// Cycle-safe: configSchema is only used inside functions (config.ts imports this module).
import { configSchema } from './config.js';

/**
 * SPEC-014 FR-17/18: strict, helpful config validation. Messages contain key paths, expectations and the *type* of a bad
 * value, never the value itself (a config value can be a secret).
 */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export function suggestKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined, bestD = Infinity;
  for (const k of known) {
    const dist = levenshtein(key.toLowerCase(), k.toLowerCase());
    if (dist < bestD) { best = k; bestD = dist; }
  }
  return bestD <= 3 ? best : undefined;
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function valueAt(root: unknown, p: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const k of p) cur = cur && typeof cur === 'object' ? (cur as Record<PropertyKey, unknown>)[k] : undefined;
  return cur;
}

/** Keys of nested object schemas (zod v4 `shape`), following `default`/`optional`/`prefault`/`pipe` wrappers. */
function shapeAt(schema: z.ZodType, p: readonly PropertyKey[]): Record<string, unknown> | undefined {
  type Node = { shape?: Record<string, unknown>; def?: { innerType?: unknown; in?: unknown } };
  const unwrap = (s: unknown): Node => {
    let x = s as Node;
    for (let n = 0; n < 10 && x && !x.shape && (x.def?.innerType || x.def?.in); n++) x = (x.def.innerType ?? x.def.in) as Node;
    return x;
  };
  let cur = unwrap(schema);
  for (const k of p) {
    if (!cur?.shape || typeof k !== 'string' || !(k in cur.shape)) return undefined;
    cur = unwrap(cur.shape[k]);
  }
  return cur?.shape;
}

/** Turn zod issues into readable lines (no values). */
export function formatIssues(schema: z.ZodType, error: z.ZodError, input: unknown, source?: string): string[] {
  const suffix = source ? ` [${source}]` : '';
  const out: string[] = [];
  for (const i of error.issues) {
    const p = i.path.map(String).join('.');
    if (i.code === 'unrecognized_keys') {
      const known = Object.keys(shapeAt(schema, i.path) ?? {});
      for (const key of i.keys) {
        const hint = suggestKey(key, known);
        out.push(`${p ? `${p}.` : ''}${key}: unknown key${hint ? ` (did you mean "${hint}"?)` : ''}${suffix}`);
      }
      continue;
    }
    let msg = i.message;
    if (i.code === 'invalid_type') msg = `expected ${i.expected}, got ${typeOf(valueAt(input, i.path))}`;
    else if (i.code === 'invalid_value') msg = `expected one of ${i.values.map((v) => JSON.stringify(v)).join(', ')}`;
    out.push(`${p || '(root)'}: ${msg}${suffix}`);
  }
  return out;
}

/** Validate `input` against `schema`; returns readable issues (empty = valid) and the parsed data. */
export function validateWith<S extends z.ZodType>(schema: S, input: unknown, source?: string): { issues: string[]; data?: z.infer<S> } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { issues: [], data: parsed.data } : { issues: formatIssues(schema, parsed.error, input, source) };
}

/** Validate a raw config object (e.g. file contents) against the strict config schema. */
export function checkConfigInput(input: unknown, source?: string): string[] {
  return validateWith(configSchema, input, source).issues;
}
