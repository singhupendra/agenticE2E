/**
 * SPEC-010 FR-6..FR-8: fail when files that hold credentials or browser sessions are tracked by git.
 * `.gitignore` already ignores them (SPEC-009), but `git add -f` bypasses it; this check runs in CI.
 * Prints paths only, never file contents.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_DIRS = new Set(['.agentic-e2e', '.auth']);
const ALLOWED_BASENAMES = new Set(['credentials.example.json']);
const FORBIDDEN_BASENAMES = [/^credentials.*\.json$/i, /\.credentials\.json$/i, /^storageState.*\.json$/i];

export function isForbiddenTrackedPath(p: string): boolean {
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = segments.at(-1) ?? '';
  if (segments.slice(0, -1).some((s) => FORBIDDEN_DIRS.has(s))) return true;
  // <dataDir>/sites/<host>/auth/<user>.json — stored Playwright sessions (e.g. in a committed nightly data dir)
  for (let i = 0; i + 2 < segments.length - 1; i++) {
    if (segments[i] === 'sites' && segments[i + 2] === 'auth') return true;
  }
  if (ALLOWED_BASENAMES.has(base)) return false;
  return FORBIDDEN_BASENAMES.some((re) => re.test(base));
}

export class NotAGitRepoError extends Error {}

export function findForbiddenTrackedFiles(cwd: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new NotAGitRepoError(`git ls-files failed in ${cwd}: ${(r.stderr ?? '').trim()}`);
  return r.stdout.split('\0').filter(Boolean).filter(isForbiddenTrackedPath);
}

export function main(cwd = process.cwd()): number {
  let found: string[];
  try {
    found = findForbiddenTrackedFiles(cwd);
  } catch (e) {
    console.error(`check:secrets: ${(e as Error).message}`);
    return 2;
  }
  if (found.length === 0) {
    console.log('check:secrets: OK — no credentials, storageState or session files are tracked.');
    return 0;
  }
  console.error('check:secrets: these tracked files may contain credentials or browser sessions (SPEC-009/SPEC-010):');
  for (const f of found) console.error(`  - ${f}`);
  console.error('\nRemove them from git (they stay on disk) and rotate any secret they contained:');
  for (const f of found) console.error(`  git rm --cached -- '${f}'`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
