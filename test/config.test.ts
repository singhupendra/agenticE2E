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

  it('SPEC-002 AC-1: provider defaults to anthropic', () => {
    const c = resolveConfig({});
    expect(c.provider).toBe('anthropic');
    expect(c.awsRegion).toBeUndefined();
  });

  it('SPEC-002 AC-2: provider precedence file < env < cli', () => {
    const e = resolveConfig({ file: { provider: 'anthropic' }, env: { AGENTIC_E2E_PROVIDER: 'bedrock', AGENTIC_E2E_AWS_REGION: 'us-east-1' }, cli: {} });
    expect(e.provider).toBe('bedrock');
    expect(e.awsRegion).toBe('us-east-1');
    expect(resolveConfig({ file: { provider: 'anthropic' }, env: { AGENTIC_E2E_PROVIDER: 'bedrock' }, cli: { provider: 'anthropic' } }).provider).toBe('anthropic');
  });

  it('SPEC-002 AC-3/4: rejects unknown provider and unsafe region', () => {
    expect(() => resolveConfig({ cli: { provider: 'openai' as never } })).toThrow(/provider/);
    for (const r of ['us-east-1; evil', '../x', 'evil.com/x', 'US-EAST-1']) expect(() => resolveConfig({ cli: { awsRegion: r } })).toThrow(/awsRegion/);
    for (const r of ['us-east-1', 'ap-southeast-1', 'eu-central-2']) expect(resolveConfig({ cli: { awsRegion: r } }).awsRegion).toBe(r);
  });

  it('SPEC-003 AC-1: awsProfile defaults to undefined', () => {
    expect(resolveConfig({}).awsProfile).toBeUndefined();
  });

  it('SPEC-003 AC-2: awsProfile precedence file < env < cli', () => {
    expect(resolveConfig({ file: { awsProfile: 'a' } }).awsProfile).toBe('a');
    expect(resolveConfig({ file: { awsProfile: 'a' }, env: { AGENTIC_E2E_AWS_PROFILE: 'b' } }).awsProfile).toBe('b');
    expect(resolveConfig({ file: { awsProfile: 'a' }, env: { AGENTIC_E2E_AWS_PROFILE: 'b' }, cli: { awsProfile: 'c' } }).awsProfile).toBe('c');
  });

  it('SPEC-003 AC-3: rejects unsafe profile names, accepts normal ones', () => {
    for (const p of ['x; rm -rf', '-bad', 'a b', '../x', 'a'.repeat(129)]) expect(() => resolveConfig({ cli: { awsProfile: p } })).toThrow(/awsProfile/);
    for (const p of ['default', 'my-profile', 'corp.sso_admin', 'user@acct:role']) expect(resolveConfig({ cli: { awsProfile: p } }).awsProfile).toBe(p);
  });
});

describe('AGENTICQA_BEDROCK_MODEL_ID (SPEC-004)', () => {
  const MODEL = 'us.anthropic.claude-sonnet-5-5';

  it('AC-6: sets the model when the provider is bedrock', () => {
    const c = resolveConfig({ env: { AGENTIC_E2E_PROVIDER: 'bedrock', AGENTICQA_BEDROCK_MODEL_ID: MODEL } });
    expect(c.model).toBe(MODEL);
  });

  it('AC-7: beats file and AGENTIC_E2E_MODEL, loses to the CLI', () => {
    const env = { AGENTIC_E2E_PROVIDER: 'bedrock', AGENTIC_E2E_MODEL: 'b', AGENTICQA_BEDROCK_MODEL_ID: MODEL };
    expect(resolveConfig({ file: { model: 'a' }, env }).model).toBe(MODEL);
    expect(resolveConfig({ file: { model: 'a' }, env, cli: { model: 'c' } }).model).toBe('c');
  });

  it('AC-8: ignored for anthropic and when empty; provider may come from file or CLI', () => {
    expect(resolveConfig({ env: { AGENTICQA_BEDROCK_MODEL_ID: MODEL } }).model).toBe('claude-sonnet-5-5');
    expect(resolveConfig({ env: { AGENTIC_E2E_PROVIDER: 'bedrock', AGENTICQA_BEDROCK_MODEL_ID: '' } }).model).toBe('claude-sonnet-5-5');
    expect(resolveConfig({ file: { provider: 'bedrock' }, env: { AGENTICQA_BEDROCK_MODEL_ID: MODEL } }).model).toBe(MODEL);
    expect(resolveConfig({ cli: { provider: 'bedrock' }, env: { AGENTICQA_BEDROCK_MODEL_ID: MODEL } }).model).toBe(MODEL);
    expect(resolveConfig({ cli: { provider: 'anthropic' }, env: { AGENTIC_E2E_PROVIDER: 'bedrock', AGENTICQA_BEDROCK_MODEL_ID: MODEL } }).model).toBe('claude-sonnet-5-5');
  });

  it('AC-9: the resolved config carries no token', () => {
    const c = resolveConfig({ env: { AGENTIC_E2E_PROVIDER: 'bedrock', AWS_BEARER_TOKEN_BEDROCK: 'super-secret-token', AWS_REGION: 'us-east-1' } });
    expect(JSON.stringify(c)).not.toContain('super-secret-token');
  });
});
