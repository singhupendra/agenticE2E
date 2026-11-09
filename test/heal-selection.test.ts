import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord, TestResult, Journey } from '../src/core/types.js';

// The real Playwright runner is replaced; `runBehaviour` decides what each (re-)run reports.
const runCalls: { ids: string[]; kind?: string }[] = [];
let runBehaviour: (ids: string[], kind?: string) => Partial<Record<string, TestResult['status']>>;
vi.mock('../src/core/runner.js', () => ({
  runTests: async (store: { listTests: (s: string) => string[] }, o: { site: string; journeyIds?: string[]; kind?: RunRecord['kind'] }) => {
    const ids = o.journeyIds ?? store.listTests(o.site);
    runCalls.push({ ids, kind: o.kind });
    const st = runBehaviour(ids, o.kind);
    const results: TestResult[] = ids.map((id) => ({ journeyId: id, file: `${id}.spec.ts`, status: st[id] ?? 'passed', durationMs: 1, screenshots: [], error: st[id] && st[id] !== 'passed' ? 'locator not found' : undefined }));
    return { id: 'r', kind: o.kind ?? 'run', startedAt: '', finishedAt: '', screenshots: 'off', fullPage: false, results } satisfies RunRecord;
  },
}));

const { MockLLM } = await import('../src/core/llm/mock.js');
const { Store } = await import('../src/core/storage.js');
const { resolveConfig } = await import('../src/core/config.js');
const { createContext, healSelected } = await import('../src/core/pipeline.js');
const { resolveHealSelection, HealSelectionError, UnknownSiteError } = await import('../src/core/heal-selection.js');
const { FAILING_SPEC, HEALED_SPEC } = await import('./helpers/specs.js');

const SITE = 'example.com';
const j = (id: string): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status: 'selected' });
const res = (journeyId: string, status: TestResult['status']): TestResult => ({ journeyId, file: `${journeyId}.spec.ts`, status, durationMs: 1, error: status === 'passed' ? undefined : 'boom', screenshots: [] });

let dir: string, store: InstanceType<typeof Store>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'));
  store = new Store(dir);
  runCalls.length = 0;
  runBehaviour = () => ({});
  store.saveSite({ id: SITE, origin: 'https://example.com', url: 'https://example.com' });
  store.saveJourneys(SITE, [j('a'), j('b'), j('c')]);
  for (const id of ['a', 'b', 'c']) store.saveTest(SITE, id, FAILING_SPEC);
  // a: passed last, b: timedOut last, c: never run
  store.saveRun(SITE, { id: '2026-01-01T00-00-00-000Z', kind: 'run', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:05Z', screenshots: 'off', fullPage: false, results: [res('a', 'failed'), res('b', 'failed')] });
  store.saveRun(SITE, { id: '2026-01-02T00-00-00-000Z', kind: 'run', startedAt: '2026-01-02T00:00:00Z', finishedAt: '2026-01-02T00:00:05Z', screenshots: 'off', fullPage: false, results: [res('a', 'passed'), res('b', 'timedOut')] });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ctxWith = (llm: InstanceType<typeof MockLLM>) => createContext({ config: resolveConfig({ cli: { dataDir: dir, healAttempts: 1 } }), llm });
const healingLLM = () => new MockLLM(() => ({ verdict: 'test_breakage', reason: 'renamed', code: HEALED_SPEC }));

describe('resolveHealSelection', () => {
  it('AC-1: selects given ids', () => {
    expect(resolveHealSelection(store, SITE, { ids: ['b'] })).toMatchObject({ ids: ['b'], validIds: ['a', 'b', 'c'] });
  });
  it('no selection means everything (null)', () => {
    expect(resolveHealSelection(store, SITE, {}).ids).toBeNull();
    expect(resolveHealSelection(store, SITE, { ids: [] }).ids).toBeNull();
  });
  it('AC-2: failedOnly picks latest-failed (timedOut counts); intersects with ids', () => {
    expect(resolveHealSelection(store, SITE, { failedOnly: true }).ids).toEqual(['b']);
    expect(resolveHealSelection(store, SITE, { ids: ['a', 'b'], failedOnly: true }).ids).toEqual(['b']);
  });
  it('de-duplicates ids and keeps order', () => {
    expect(resolveHealSelection(store, SITE, { ids: ['c', 'a', 'c'] }).ids).toEqual(['c', 'a']);
  });
  it('AC-3: unknown ids throw with the valid ids', () => {
    try { resolveHealSelection(store, SITE, { ids: ['a', 'zzz'] }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(HealSelectionError);
      const err = e as InstanceType<typeof HealSelectionError>;
      expect(err.unknownIds).toEqual(['zzz']);
      expect(err.validIds).toEqual(['a', 'b', 'c']);
      expect(err.message).toMatch(/zzz/);
      expect(err.message).toMatch(/a, b, c/);
    }
  });
  it('unknown site throws UnknownSiteError', () => {
    expect(() => resolveHealSelection(store, 'nope.test', { ids: ['a'] })).toThrow(UnknownSiteError);
  });
  it('is read-only', () => {
    const before = JSON.stringify(fs.readdirSync(dir, { recursive: true }));
    resolveHealSelection(store, SITE, { failedOnly: true });
    expect(JSON.stringify(fs.readdirSync(dir, { recursive: true }))).toBe(before);
  });
});

describe('healSelected', () => {
  it('AC-4: failedOnly with nothing failing runs nothing and never calls the LLM', async () => {
    store.saveRun(SITE, { id: '2026-01-03T00-00-00-000Z', kind: 'run', startedAt: '', finishedAt: '2026-01-03T00:00:05Z', screenshots: 'off', fullPage: false, results: [res('b', 'passed')] });
    const llm = healingLLM();
    const r = await healSelected(ctxWith(llm), 'https://example.com', { failedOnly: true });
    expect(r).toMatchObject({ noneFailing: true, selected: [], results: [], heals: [], run: null });
    expect(runCalls).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
  it('AC-5: only the selected tests are re-run', async () => {
    runBehaviour = () => ({});
    await healSelected(ctxWith(healingLLM()), 'https://example.com', { ids: ['b'] });
    expect(runCalls).toEqual([{ ids: ['b'], kind: undefined }]);
  });
  it('AC-6: a selected test that now passes is "already passing" and the LLM is not called', async () => {
    const llm = healingLLM();
    const r = await healSelected(ctxWith(llm), 'https://example.com', { ids: ['b'] });
    expect(r.results).toEqual([{ journeyId: 'b', outcome: 'already_passing' }]);
    expect(r.heals).toEqual([]);
    expect(llm.calls).toHaveLength(0);
    expect(store.loadHeals(SITE)).toEqual([]);
  });
  it('AC-7: only tests still failing are healed', async () => {
    runBehaviour = (ids, kind) => (kind === 'heal-rerun' ? {} : { b: 'failed' });
    const llm = healingLLM();
    const r = await healSelected(ctxWith(llm), 'https://example.com', { ids: ['a', 'b'] });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].prompt).toContain('Journey: b');
    expect(r.selected).toEqual(['a', 'b']);
    expect(r.results).toEqual([{ journeyId: 'a', outcome: 'already_passing' }, { journeyId: 'b', outcome: 'healed' }]);
    expect(runCalls[0]).toEqual({ ids: ['a', 'b'], kind: undefined });
    expect(store.loadTest(SITE, 'a')).toBe(FAILING_SPEC); // untouched
  });
  it('unknown ids fail before anything runs', async () => {
    const llm = healingLLM();
    await expect(healSelected(ctxWith(llm), 'https://example.com', { ids: ['zzz'] })).rejects.toThrow(HealSelectionError);
    expect(runCalls).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
  it('FR-3: no selection runs the whole suite', async () => {
    await healSelected(ctxWith(healingLLM()), 'https://example.com', {});
    expect(runCalls[0].ids).toEqual(['a', 'b', 'c']);
  });
  it('reports each heal outcome and skipped', async () => {
    runBehaviour = (ids, kind) => (kind === 'heal-rerun' ? {} : { a: 'failed', b: 'skipped' });
    const llm = new MockLLM(() => ({ verdict: 'app_bug', reason: 'real bug' }));
    const r = await healSelected(ctxWith(llm), 'https://example.com', { ids: ['a', 'b', 'c'] });
    expect(r.results).toEqual([{ journeyId: 'a', outcome: 'app_bug' }, { journeyId: 'b', outcome: 'skipped' }, { journeyId: 'c', outcome: 'already_passing' }]);
  });
});
