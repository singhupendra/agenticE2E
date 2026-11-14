import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../src/core/paths.js';

const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: packageRoot() }).status === 0;

describe('gitignore protects credentials (SPEC-009 AC-7)', () => {
  it.each([
    '.agentic-e2e/credentials.json',
    '.agentic-e2e/anything.json',
    'credentials.json',
    'credentials.prod.json',
    'staging.credentials.json',
    '.auth/user.json',
    'data/sites/example.com/auth/alice.json',
    'a/b/storageState.json',
    'storageState.alice.json',
  ])('ignores %s', (p) => expect(ignored(p)).toBe(true));

  it('does not ignore the committed example file', () => {
    expect(ignored('credentials.example.json')).toBe(false);
  });
});
