import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageRoot } from '../src/core/paths.js';
import { isForbiddenTrackedPath, findForbiddenTrackedFiles } from '../scripts/check-tracked-secrets.js';

const root = packageRoot();
const script = path.join(root, 'scripts', 'check-tracked-secrets.ts');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}
function runCli(cwd: string) {
  return spawnSync(tsx, [script], { cwd, encoding: 'utf8' });
}
function write(dir: string, rel: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

describe('isForbiddenTrackedPath (SPEC-010 AC-1)', () => {
  it.each([
    'credentials.json',
    'a/credentials.prod.json',
    'x.credentials.json',
    'storageState.json',
    'e2e/storageState-admin.json',
    '.agentic-e2e/credentials.json',
    '.agentic-e2e/notes.txt',
    '.auth/u.json',
    'a\\.auth\\u.json',
  ])('forbids %s', (p) => expect(isForbiddenTrackedPath(p)).toBe(true));

  it.each([
    'credentials.example.json',
    'docs/credentials.example.json',
    'src/core/credentials.ts',
    'test/credentials.test.ts',
    'auth.json',
    'src/core/auth.ts',
    'my.auth.ts',
    'test/helpers/credentials.ts',
  ])('allows %s', (p) => expect(isForbiddenTrackedPath(p)).toBe(false));
});

describe('findForbiddenTrackedFiles + CLI (SPEC-010 AC-2..AC-4)', () => {
  let dir: string;
  const SECRET = 'super-secret-value-123';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-secrets-'));
    git(dir, 'init', '-q');
    // a .gitignore like the real one, so the files must be force-added (the bypass we guard against)
    write(dir, '.gitignore', 'credentials*.json\n!credentials.example.json\n.auth/\n');
    write(dir, 'credentials.example.json', '{"example.com":{"users":{"a":{"username":"x","password":"y"}}}}');
    write(dir, 'README.md', 'hi');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists only the force-added forbidden files and the CLI fails without printing contents', () => {
    write(dir, 'credentials.json', `{"password":"${SECRET}"}`);
    write(dir, '.auth/s.json', `{"cookies":[{"value":"${SECRET}"}]}`);
    git(dir, 'add', '.gitignore', 'credentials.example.json', 'README.md');
    git(dir, 'add', '-f', 'credentials.json', '.auth/s.json');

    expect(findForbiddenTrackedFiles(dir).sort()).toEqual(['.auth/s.json', 'credentials.json']);

    const r = runCli(dir);
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1);
    expect(out).toContain('credentials.json');
    expect(out).toContain('.auth/s.json');
    expect(out).toContain('git rm --cached');
    expect(out).not.toContain(SECRET);
  });

  it('exits 0 for a clean repo', () => {
    git(dir, 'add', '.');
    expect(findForbiddenTrackedFiles(dir)).toEqual([]);
    const r = runCli(dir);
    expect(r.status).toBe(0);
  });

  it('exits 2 outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const r = spawnSync(tsx, [script], {
        cwd: plain,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(plain) },
      });
      expect(r.status).toBe(2);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('finds nothing forbidden in this repository', () => {
    expect(findForbiddenTrackedFiles(root)).toEqual([]);
  });
});
