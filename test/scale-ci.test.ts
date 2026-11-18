import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Journey, RunRecord, TestResult } from '../src/core/types.js';

// SPEC-012 × SPEC-011: `ci` with several projects per journey.
const calls: { ids: string[]; kind?: string; retries?: number }[] = [];
let seq = 0;
vi.mock('../src/core/runner.js', () => ({
  runTests: async (store: { listTests: (s: string) => string[]; saveRun: (s: string, r: RunRecord) => void }, o: { site: string; journeyIds?: string[]; kind?: RunRecord['kind']; retries?: number }) => {
    const ids = o.journeyIds ?? store.listTests(o.site);
    calls.push({ ids, kind: o.kind, retries: o.retries });
    // `a` always fails on chromium (the first project) and passes on firefox; `b` passes everywhere.
    const results: TestResult[] = ids.flatMap((id) => ['chromium', 'firefox'].map((project): TestResult => {
      const fail = id === 'a' && project === 'chromium';
      return { journeyId: id, file: `tests/${id}.spec.ts`, status: fail ? 'failed' : 'passed', durationMs: 5, error: fail ? 'boom' : undefined, screenshots: [], project, browser: project };
    }));
    const rec: RunRecord = { id: `2026-02-01T00-00-${String(++seq).padStart(2, '0')}-000Z`, kind: o.kind ?? 'run', startedAt: '2026-02-01T00:00:00Z', finishedAt: '2026-02-01T00:00:01Z', screenshots: 'off', fullPage: false, results, targets: [{ name: 'chromium', browser: 'chromium' }, { name: 'firefox', browser: 'firefox' }] };
    store.saveRun(o.site, rec);
    return rec;
  },
}));

const { main } = await import('../src/cli/index.js');
const { Store } = await import('../src/core/storage.js');
const { buildRunReport } = await import('../src/core/reporting/model.js');
const { detectFlaky } = await import('../src/core/reporting/flaky.js');
const { createContext, run } = await import('../src/core/pipeline.js');
const { resolveConfig } = await import('../src/core/config.js');

const j = (id: string): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status: 'selected' });
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-ci-'));
  calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const s = new Store(dir);
  s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
  s.saveJourneys('example.com', [j('a'), j('b')]);
  for (const id of ['a', 'b']) s.saveTest('example.com', id, '// x\n');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('SPEC-012 ci integration', () => {
  it('a journey failing on one project is retried and fails the build; ci disables Playwright retries', async () => {
    const code = await main(['node', 'agentic-e2e', 'ci', 'https://example.com', '--retries', '1', '--reporter', 'json', '--notify-on', 'never', '--data-dir', dir]);
    expect(code).toBe(1);
    expect(calls.map((c) => [c.kind ?? 'run', c.ids.join(','), c.retries])).toEqual([['run', 'a,b', 0], ['retry', 'a', 0]]);
  });

  it('review: a stable browser-specific failure is not flaky (detection aggregates per journey and run)', () => {
    const res = (project: string, status: TestResult['status']): TestResult => ({ journeyId: 'a', file: '', status, durationMs: 1, screenshots: [], project, browser: project });
    const rec = (id: string, kind: RunRecord['kind'] = 'run'): RunRecord => ({ id, kind, startedAt: id, finishedAt: id, screenshots: 'off', fullPage: false, results: [res('chromium', 'passed'), res('firefox', 'failed')] });
    const flaky = detectFlaky([rec('r1'), rec('r2'), rec('r3'), rec('r4', 'retry')], []);
    expect(flaky.a?.flaky ?? false).toBe(false);
  });

  it('review: heal re-runs use 0 Playwright retries; normal runs use config.retries', async () => {
    const ctx = createContext({ config: resolveConfig({ cli: { dataDir: dir, retries: 2 }, env: {} }) });
    await run(ctx, 'https://example.com', { journeyIds: ['b'], kind: 'heal-rerun' });
    await run(ctx, 'https://example.com', { journeyIds: ['b'] });
    expect(calls.map((c) => [c.kind ?? 'run', c.retries])).toEqual([['heal-rerun', 0], ['run', 2]]);
  });

  it('report has one row per journey × project with attempts matched per project', () => {
    const res = (id: string, project: string, status: TestResult['status']): TestResult => ({ journeyId: id, file: '', status, durationMs: 1, screenshots: [], project, browser: project, env: 'staging' });
    const run = (id: string, kind: RunRecord['kind'], results: TestResult[]): RunRecord => ({ id, kind, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', screenshots: 'off', fullPage: false, results, targets: [{ name: 'chromium', browser: 'chromium' }, { name: 'firefox', browser: 'firefox' }] });
    const report = buildRunReport({
      site: { id: 'example.com', origin: 'https://example.com' }, mode: 'ci', heals: [], journeys: [j('a')],
      runs: [run('r1', 'run', [res('a', 'chromium', 'failed'), res('a', 'firefox', 'passed')]), run('r2', 'retry', [res('a', 'chromium', 'passed'), res('a', 'firefox', 'passed')])],
    });
    expect(report.tests.map((t) => [t.name, t.project, t.outcome, t.attempts])).toEqual([['Journey a [chromium]', 'chromium', 'passed', 2], ['Journey a [firefox]', 'firefox', 'passed', 2]]);
    expect(report.tests[0]).toMatchObject({ browser: 'chromium', env: 'staging' });
  });
});
