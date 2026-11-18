import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../src/core/paths.js';

const root = packageRoot();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };

/** Minimal .dockerignore matcher (gitignore-ish: last match wins, `!` negates, `**` / trailing `/`). */
function dockerIgnored(rules: string[], file: string): boolean {
  let ignored = false;
  for (const raw of rules) {
    const neg = raw.startsWith('!');
    const pat = (neg ? raw.slice(1) : raw).replace(/\/$/, '');
    const re = new RegExp('^' + pat.split('**').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*') + '(/.*)?$');
    if (re.test(file)) ignored = !neg;
  }
  return ignored;
}

describe('SPEC-014 container files', () => {
  it('AC-27: multi-stage Dockerfile on the matching Playwright image, non-root, healthcheck, no secrets copied', () => {
    const df = read('Dockerfile');
    const froms = df.match(/^FROM\s+\S+/gm) ?? [];
    expect(froms.length).toBeGreaterThanOrEqual(2);
    const version = pkg.dependencies.playwright.replace(/^[\^~]/, '');
    expect(df).toContain(`ARG PLAYWRIGHT_VERSION=${version}`);
    expect(df).toMatch(/mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}/);
    const users = df.match(/^USER\s+(\S+)/gm) ?? [];
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toMatch(/root|\b0\b/);
    expect(df).toMatch(/^HEALTHCHECK .*\/healthz/m);
    expect(df).toMatch(/--frozen-lockfile/);
    for (const line of df.split('\n').filter((l) => /^(COPY|ADD)\b/.test(l))) {
      expect(line).not.toMatch(/credentials|tokens|\.env|\bdata\b|\.agentic-e2e/);
      expect(line).not.toMatch(/^COPY\s+\.\s/); // never copy the whole context into the runtime image
    }
  });

  it('AC-28: .dockerignore keeps data and secrets out of the build context', () => {
    const rules = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const f of ['data/sites/x/site.json', '.agentic-e2e/credentials.json', 'credentials.json', 'credentials.prod.json', 'staging.credentials.json', 'tokens.json', 'tokens.prod.json', '.env', '.env.production', 'node_modules/x/index.js', '.git/HEAD', 'dist/cli/index.js', 'web/dist/index.html']) {
      expect(dockerIgnored(rules, f), f).toBe(true);
    }
    for (const f of ['credentials.example.json', '.env.example', 'src/cli/index.ts', 'package.json', 'pnpm-lock.yaml', 'web/src/App.tsx']) {
      expect(dockerIgnored(rules, f), f).toBe(false);
    }
  });

  it('AC-28: compose uses a data volume, an env file and read-only secrets', () => {
    const c = read('docker-compose.yml');
    expect(c).toMatch(/env_file:/);
    expect(c).toMatch(/^\s+- agentic-e2e-data:\/app\/data/m);
    expect(c).toMatch(/^volumes:\s*\n\s+agentic-e2e-data:/m);
    expect(c).toMatch(/^secrets:/m);
    expect(c).toMatch(/AGENTIC_E2E_CREDENTIALS:\s*\/run\/secrets\//);
    expect(c).toMatch(/AGENTIC_E2E_API_TOKENS_FILE:\s*\/run\/secrets\//);
    expect(c).toMatch(/read_only:\s*true/);
    expect(c).toMatch(/no-new-privileges/);
    expect(read('.env.example')).not.toMatch(/ae2e_[A-Za-z0-9_-]{43}/);
  });

  it('gitignore also covers tokens files and .env', () => {
    const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: root }).status === 0;
    expect(ignored('tokens.json')).toBe(true);
    expect(ignored('.agentic-e2e/tokens.json')).toBe(true);
    expect(ignored('.env')).toBe(true);
    expect(ignored('.env.example')).toBe(false);
  });
});
