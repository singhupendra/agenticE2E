import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord, TestResult, Journey, HealRecord } from '../src/core/types.js';

// --- mocks -------------------------------------------------------------------------------------------------------
const runCalls: { ids: string[]; kind?: string }[] = [];
let failing: Set<string>; // fail on kind 'run'
let failOnce: Set<string>; // fail only the first time
let runnerThrows = false;
let seq = 0;
vi.mock('../src/core/runner.js', () => ({
  runTests: async (store: { listTests: (s: string) => string[]; createRun: (s: string) => { id: string }; saveRun: (s: string, r: RunRecord) => void }, o: { site: string; journeyIds?: string[]; kind?: RunRecord['kind'] }) => {
    if (runnerThrows) throw new Error('spawn playwright ENOENT');
    const ids = o.journeyIds ?? store.listTests(o.site);
    runCalls.push({ ids, kind: o.kind });
    const results: TestResult[] = ids.map((id) => {
      let fail = failing.has(id) && o.kind !== 'heal-rerun';
      if (failOnce.has(id)) { fail = true; failOnce.delete(id); }
      return { journeyId: id, file: `tests/${id}.spec.ts`, status: fail ? 'failed' : 'passed', durationMs: 7, error: fail ? 'locator not found: AKIAABCDEFGHIJKLMNOP' : undefined, screenshots: [] };
    });
    seq++;
    const rec: RunRecord = { id: `2026-01-01T00-00-${String(seq).padStart(2, '0')}-000Z`, kind: o.kind ?? 'run', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', screenshots: 'off', fullPage: false, results };
    store.saveRun(o.site, rec);
    return rec;
  },
}));
let llmCalls = 0;
let llmMode: 'heal' | 'throw' = 'heal';
vi.mock('../src/core/llm/index.js', () => ({
  createLLMProvider: () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set. Export it, or use a different LLM provider.');
    return {
    structured: async () => {
      llmCalls++;
      if (llmMode === 'throw') throw new Error('ECONNRESET talking to the model');
      return { verdict: 'flaky_or_environment', reason: 'timing' };
    },
    };
  },
}));
let healAsHealed = false;
vi.mock('../src/core/healer.js', async (orig) => {
  const real = await orig<typeof import('../src/core/healer.js')>();
  return {
    ...real,
    healTest: async (...a: Parameters<typeof real.healTest>) => {
      if (!healAsHealed) return real.healTest(...a);
      llmCalls++;
      const rec: HealRecord = { id: 'h', journeyId: a[2].journeyId, at: new Date().toISOString(), outcome: 'healed', reason: 'fixed locator', originalError: 'x', attempts: [], diff: '--- o\n+++ h\n-a\n+b' };
      a[0].appendHeal(a[2].site, rec);
      return rec;
    },
  };
});

const { main } = await import('../src/cli/index.js');
const { Store } = await import('../src/core/storage.js');
const { FAILING_SPEC } = await import('./helpers/specs.js');
const { EXIT_CODES } = await import('../src/core/ci/run-ci.js');

const j = (id: string, extra: Partial<Journey> = {}): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status: 'selected', ...extra });
let dir: string, out: string[], err: string[];
const ENV_KEYS = ['GITHUB_STEP_SUMMARY', 'AGENTIC_E2E_WEBHOOK_URL', 'AGENTIC_E2E_SLACK_WEBHOOK_URL', 'ANTHROPIC_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  out = []; err = []; runCalls.length = 0; llmCalls = 0; failing = new Set(); failOnce = new Set(); runnerThrows = false; llmMode = 'heal'; healAsHealed = false;
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-value';
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  const s = new Store(dir);
  s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
  s.saveJourneys('example.com', [j('a'), j('b')]);
  for (const id of ['a', 'b']) s.saveTest('example.com', id, FAILING_SPEC);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
});
const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);
const U = 'https://example.com';
const store = () => new Store(dir);
const latestReport = () => {
  const runs = store().listRuns('example.com').filter((r) => r.kind === 'run');
  const f = path.join(store().runDir('example.com', runs[0].id), 'reports', 'summary.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

describe('ci command (SPEC-011)', () => {
  it('documents the exit codes', () => {
    expect(EXIT_CODES).toEqual({ PASS: 0, TEST_FAILURES: 1, CONFIG_OR_AUTH: 2, LLM_OR_INFRA: 3 });
  });
  it('AC-9: all pass → 0, no LLM, reports written', async () => {
    expect(await cli('ci', U)).toBe(0);
    expect(llmCalls).toBe(0);
    const rep = latestReport();
    expect(rep.mode).toBe('ci');
    expect(rep.totals).toMatchObject({ tests: 2, passed: 2 });
    const runDir = store().runDir('example.com', rep.run.id);
    expect(fs.existsSync(path.join(runDir, 'reports', 'junit.xml'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'reports', 'report.html'))).toBe(true);
  });
  it('AC-10: failing test without --allow-heal → 1, no LLM, spec untouched', async () => {
    failing.add('b');
    const before = fs.readFileSync(store().testFile('example.com', 'b'), 'utf8');
    expect(await cli('ci', U)).toBe(1);
    expect(llmCalls).toBe(0);
    expect(fs.readFileSync(store().testFile('example.com', 'b'), 'utf8')).toBe(before);
    expect(runCalls.map((c) => c.kind ?? 'run')).toEqual(['run']);
    expect(store().loadHeals('example.com')).toEqual([]);
  });
  it('AC-11: --retries re-runs failures as retry runs; pass-on-retry → 0 and flaky', async () => {
    failOnce.add('b');
    expect(await cli('ci', U, '--retries', '2')).toBe(0);
    expect(runCalls.map((c) => [c.kind ?? 'run', c.ids.join(',')])).toEqual([['run', 'a,b'], ['retry', 'b']]);
    const rep = latestReport();
    const b = rep.tests.find((t: { journeyId: string }) => t.journeyId === 'b');
    expect(b.outcome).toBe('passed');
    expect(b.flaky.reasons).toContain('passed_on_retry');
    expect(rep.totals.flaky).toBe(1);
  });
  it('retries exhausted → 1', async () => {
    failing.add('b');
    expect(await cli('ci', U, '--retries', '2')).toBe(1);
    expect(runCalls.length).toBe(3);
  });
  it('AC-12: --allow-heal heals → 0 and outcome healed', async () => {
    failing.add('b');
    healAsHealed = true;
    expect(await cli('ci', U, '--allow-heal')).toBe(0);
    expect(llmCalls).toBe(1);
    const b = latestReport().tests.find((t: { journeyId: string }) => t.journeyId === 'b');
    expect(b.outcome).toBe('healed');
    expect(b.heal.diff).toContain('+b');
  });
  it('AC-13: unknown site, invalid config, no tests, unknown user → 2 and nothing runs', async () => {
    expect(await cli('ci', 'https://unknown.example')).toBe(2);
    expect(await cli('ci', U, '--screenshots', 'bogus')).toBe(2);
    expect(await cli('ci', U, '--bogus-flag')).toBe(2);
    const s = store();
    s.saveSite({ id: 'empty.example', origin: 'https://empty.example', url: 'https://empty.example' });
    expect(await cli('ci', 'https://empty.example')).toBe(2);
    expect(await cli('ci', U, '--auth', '--user', 'nobody', '--credentials', path.join(dir, 'missing.json'))).toBe(2);
    expect(runCalls).toEqual([]);
    expect(err.join('\n')).toMatch(/Error:/);
  });
  it('AC-13: --allow-heal without LLM credentials → 2 before running', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await cli('ci', U, '--allow-heal')).toBe(2);
    expect(runCalls).toEqual([]);
    expect(err.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    // without --allow-heal no LLM credentials are needed
    expect(await cli('ci', U)).toBe(0);
  });
  it('AC-14: LLM transport error during heal → 3; runner crash → 3', async () => {
    failing.add('b');
    llmMode = 'throw';
    expect(await cli('ci', U, '--allow-heal')).toBe(3);
    runnerThrows = true;
    expect(await cli('ci', U)).toBe(3);
  });
  it('AC-15: appends a GitHub step summary, also on error', async () => {
    const f = path.join(dir, 'summary.md');
    fs.writeFileSync(f, '# previous\n');
    process.env.GITHUB_STEP_SUMMARY = f;
    failing.add('b');
    expect(await cli('ci', U)).toBe(1);
    const md = fs.readFileSync(f, 'utf8');
    expect(md.startsWith('# previous\n')).toBe(true);
    expect(md).toContain('example.com');
    expect(md).toMatch(/\| `a` \|/);
    expect(md).toMatch(/\| `b` \|/);
    expect(md).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(await cli('ci', 'https://unknown.example')).toBe(2);
    expect(fs.readFileSync(f, 'utf8')).toMatch(/exit code 2/);
  });
  it('AC-6: secrets from env never reach reports', async () => {
    failing.add('b');
    await cli('ci', U, '--report-dir', path.join(dir, 'out'));
    for (const f of fs.readdirSync(path.join(dir, 'out'))) {
      const txt = fs.readFileSync(path.join(dir, 'out', f), 'utf8');
      expect(txt).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(txt).not.toContain('test-anthropic-key-value');
    }
  });
});

describe('reports from run/heal (AC-19)', () => {
  it('run writes reports; --reporter none disables them', async () => {
    failing.add('b');
    expect(await cli('run', U)).toBe(1);
    const r1 = store().listRuns('example.com')[0];
    expect(fs.readdirSync(path.join(store().runDir('example.com', r1.id), 'reports')).sort()).toEqual(['junit.xml', 'report.html', 'summary.json']);
    await cli('run', U, '--reporter', 'none');
    const r2 = store().listRuns('example.com')[1];
    expect(fs.existsSync(path.join(store().runDir('example.com', r2.id), 'reports'))).toBe(false);
    await cli('run', U, '--reporter', 'junit,json');
    const r3 = store().listRuns('example.com')[2];
    expect(fs.readdirSync(path.join(store().runDir('example.com', r3.id), 'reports')).sort()).toEqual(['junit.xml', 'summary.json']);
  });
  it('heal writes a report including heal outcomes', async () => {
    failing.add('b');
    healAsHealed = true;
    await cli('heal', U, 'b');
    const runs = store().listRuns('example.com').filter((r) => r.kind === 'run');
    const rep = JSON.parse(fs.readFileSync(path.join(store().runDir('example.com', runs[0].id), 'reports', 'summary.json'), 'utf8'));
    expect(rep.mode).toBe('heal');
    expect(rep.tests[0].outcome).toBe('healed');
  });
});

describe('list-test-cases flaky (AC-18)', () => {
  const mk = (id: string, status: TestResult['status'], kind: RunRecord['kind'] = 'run'): RunRecord => ({ id, kind, startedAt: '', finishedAt: '', screenshots: 'off', fullPage: false, results: [{ journeyId: 'a', file: 'tests/a.spec.ts', status, durationMs: 1, screenshots: [], error: status === 'passed' ? undefined : 'e' }] });
  it('shows FLAKY only when a test is flaky', async () => {
    expect(await cli('list-test-cases', U, '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).tests[0].flaky).toBeUndefined();
    out.length = 0;
    await cli('list-test-cases', U);
    expect(out.join('\n')).not.toContain('FLAKY');
    const s = store();
    s.saveRun('example.com', mk('2026-01-01T00-00-01-000Z', 'passed'));
    s.saveRun('example.com', mk('2026-01-01T00-00-02-000Z', 'failed'));
    s.saveRun('example.com', mk('2026-01-01T00-00-03-000Z', 'passed'));
    out.length = 0;
    await cli('list-test-cases', U, '--json');
    const a = JSON.parse(out.join('\n')).tests.find((t: { journeyId: string }) => t.journeyId === 'a');
    expect(a.flaky).toMatchObject({ flaky: true, reasons: ['alternating'] });
    out.length = 0;
    await cli('list-test-cases', U);
    expect(out.join('\n')).toMatch(/FLAKY/);
    expect(out.join('\n')).toMatch(/alternating/);
  });
});
