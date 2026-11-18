import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/core/config.js';
import { checkConfigInput, suggestKey } from '../src/core/config-check.js';
import { parseJobRequest } from '../src/server/jobs.js';
import { main } from '../src/cli/index.js';
import { generateToken, hashToken } from '../src/core/security/tokens.js';

describe('SPEC-014 config validation', () => {
  it('AC-21: unknown keys are errors with a did-you-mean suggestion', () => {
    expect(() => resolveConfig({ file: { maxPage: 3 } as never })).toThrow(/maxPage: unknown key \(did you mean "maxPages"\?\)/);
    expect(() => resolveConfig({ file: { server: { rateLimt: {} } } as never })).toThrow(/server\.rateLimt: unknown key \(did you mean "rateLimit"\?\)/);
    expect(suggestKey('zzzzzzzz', ['maxPages'])).toBeUndefined();
  });

  it('AC-22: type errors say what was expected and never echo the value', () => {
    let msg = '';
    try { resolveConfig({ file: { maxPages: 'ten-secret-value' } as never }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/maxPages: .*expected number.*got string/i);
    expect(msg).not.toContain('ten-secret-value');
  });

  it('lists every issue with its source', () => {
    const issues = checkConfigInput({ maxPage: 1, screenshots: 'sometimes' }, 'config file x.json');
    expect(issues.length).toBe(2);
    expect(issues.join('\n')).toMatch(/config file x\.json/);
  });

  it('server block has defaults and validates', () => {
    const c = resolveConfig({});
    expect(c.server).toMatchObject({ allowedHosts: [], bodyLimitBytes: 1048576, rateLimit: { max: 300, timeWindowMs: 60000, loginMax: 10 }, shutdownTimeoutMs: 30000, trustProxy: false });
    expect(() => resolveConfig({ file: { server: { bodyLimitBytes: -1 } } as never })).toThrow(/server\.bodyLimitBytes/);
  });

  it('env AGENTIC_E2E_ALLOWED_HOSTS and AGENTIC_E2E_API_TOKENS_FILE feed the server block', () => {
    const c = resolveConfig({ env: { AGENTIC_E2E_ALLOWED_HOSTS: 'E2E.example.com, other.test', AGENTIC_E2E_API_TOKENS_FILE: '/run/secrets/tokens.json' } });
    expect(c.server.allowedHosts).toEqual(['e2e.example.com', 'other.test']);
    expect(c.server.tokensFile).toBe('/run/secrets/tokens.json');
  });

  it('AC-24: job options cannot carry server settings', () => {
    expect(() => parseJobRequest({ action: 'run', url: 'http://a.test', options: { server: { allowedHosts: ['x'] } } })).toThrow(/server/);
  });
});

describe('SPEC-014 config CLI', () => {
  let dir: string, out: string[], err: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgcli-'));
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('AC-23: config validate succeeds on a valid file', async () => {
    const f = path.join(dir, 'agentic-e2e.config.json');
    fs.writeFileSync(f, JSON.stringify({ maxPages: 3 }));
    expect(await main(['node', 'agentic-e2e', 'config', 'validate', '--config', f])).toBe(0);
    expect(out.join('\n')).toMatch(/Configuration OK/);
  });

  it('AC-23: config validate fails with the issue list', async () => {
    const f = path.join(dir, 'agentic-e2e.config.json');
    fs.writeFileSync(f, JSON.stringify({ maxPage: 3, headless: 'yes' }));
    expect(await main(['node', 'agentic-e2e', 'config', 'validate', '--config', f])).toBe(1);
    const text = err.join('\n');
    expect(text).toMatch(/maxPage: unknown key/);
    expect(text).toMatch(/headless/);
  });

  it('AC-23: config show prints JSON without token data', async () => {
    const f = path.join(dir, 'agentic-e2e.config.json');
    const tokensFile = path.join(dir, 'tokens.json');
    fs.writeFileSync(f, JSON.stringify({ maxPages: 7, server: { tokensFile } }));
    const prev = process.env.AGENTIC_E2E_API_TOKENS;
    const h = hashToken(generateToken());
    process.env.AGENTIC_E2E_API_TOKENS = `ci:viewer:${h}`;
    try {
      expect(await main(['node', 'agentic-e2e', 'config', 'show', '--config', f])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_E2E_API_TOKENS; else process.env.AGENTIC_E2E_API_TOKENS = prev;
    }
    const text = out.join('\n');
    const shown = JSON.parse(text);
    expect(shown.maxPages).toBe(7);
    expect(shown.server.tokensFile).toBe('(set)');
    expect(text).not.toContain(h);
    expect(text).not.toContain(tokensFile);
  });
});
