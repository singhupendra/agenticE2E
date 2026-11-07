import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, loadConfigFile } from '../src/core/config.js';

describe('config', () => {
  it('AC-1: defaults', () => {
    const c = resolveConfig({});
    expect(c.screenshots).toBe('on-failure');
    expect(c.fullPage).toBe(false);
    expect(c.model).toBe('claude-sonnet-5-5');
    expect(c.healAttempts).toBe(2);
  });

  it('AC-2: CLI overrides file overrides defaults', () => {
    const c = resolveConfig({ file: { screenshots: 'every-step', maxPages: 5 }, cli: { screenshots: 'off' } });
    expect(c.screenshots).toBe('off');
    expect(c.maxPages).toBe(5);
  });

  it('env sits between file and cli', () => {
    const c = resolveConfig({ file: { model: 'a' }, env: { AGENTIC_E2E_MODEL: 'b' }, cli: {} });
    expect(c.model).toBe('b');
    const d = resolveConfig({ file: { model: 'a' }, env: { AGENTIC_E2E_MODEL: 'b' }, cli: { model: 'c' } });
    expect(d.model).toBe('c');
  });

  it('ignores undefined cli values', () => {
    const c = resolveConfig({ file: { maxPages: 7 }, cli: { maxPages: undefined } });
    expect(c.maxPages).toBe(7);
  });

  it('AC-3: invalid screenshots value names the field', () => {
    expect(() => resolveConfig({ cli: { screenshots: 'sometimes' as never } })).toThrow(/screenshots/);
  });

  it('AC-4: loads json and ts config files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir, 'agentic-e2e.config.json'), JSON.stringify({ screenshots: 'end-of-journey' }));
    expect(await loadConfigFile(dir)).toEqual({ screenshots: 'end-of-journey' });
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    fs.writeFileSync(path.join(dir2, 'agentic-e2e.config.ts'), `export default { fullPage: true } satisfies Record<string, unknown>;`);
    expect(await loadConfigFile(dir2)).toEqual({ fullPage: true });
    expect(await loadConfigFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')))).toEqual({});
  });

  it('resolves dataDir to absolute path', () => {
    const c = resolveConfig({ cli: { dataDir: 'x/y' }, cwd: '/tmp/base' });
    expect(c.dataDir).toBe('/tmp/base/x/y');
  });
});
