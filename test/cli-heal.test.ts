import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunRecord, TestResult, Journey } from '../src/core/types.js';

const runCalls: string[][] = [];
let failing: Set<string>;
vi.mock('../src/core/runner.js', () => ({
  runTests: async (store: { listTests: (s: string) => string[] }, o: { site: string; journeyIds?: string[]; kind?: RunRecord['kind'] }) => {
    const ids = o.journeyIds ?? store.listTests(o.site);
    runCalls.push(ids);
    const results: TestResult[] = ids.map((id) => ({ journeyId: id, file: `${id}.spec.ts`, status: failing.has(id) && o.kind !== 'heal-rerun' ? 'failed' : 'passed', durationMs: 1, error: 'boom', screenshots: [] }));
    return { id: 'r', kind: o.kind ?? 'run', startedAt: '', finishedAt: '', screenshots: 'off', fullPage: false, results } satisfies RunRecord;
  },
}));
let llmCalls = 0;
vi.mock('../src/core/llm/index.js', () => ({
  createLLMProvider: () => ({ structured: async () => { llmCalls++; return { verdict: 'app_bug', reason: 'real bug' }; } }),
}));

const { main } = await import('../src/cli/index.js');
const { Store } = await import('../src/core/storage.js');
const { FAILING_SPEC } = await import('./helpers/specs.js');

const j = (id: string): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status: 'selected' });
const res = (journeyId: string, status: TestResult['status']): TestResult => ({ journeyId, file: `${journeyId}.spec.ts`, status, durationMs: 1, error: status === 'passed' ? undefined : 'boom', screenshots: [] });
let dir: string, out: string[], err: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clih-'));
  out = []; err = []; runCalls.length = 0; llmCalls = 0; failing = new Set();
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  const s = new Store(dir);
  s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
  s.saveJourneys('example.com', [j('a'), j('b'), j('c')]);
  for (const id of ['a', 'b', 'c']) s.saveTest('example.com', id, FAILING_SPEC);
  s.saveRun('example.com', { id: '2026-01-01T00-00-00-000Z', kind: 'run', startedAt: '', finishedAt: '2026-01-01T00:00:05Z', screenshots: 'off', fullPage: false, results: [res('a', 'passed'), res('b', 'failed')] });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);
const U = 'https://example.com';

describe('heal CLI selection (SPEC-008)', () => {
  it('AC-8: positional ids and --journey are equivalent, and merged without duplicates', async () => {
    await cli('heal', U, 'a', 'b');
    await cli('heal', U, '--journey', 'a', 'b');
    await cli('heal', U, 'a', '--journey', 'a', 'b');
    expect(runCalls).toEqual([['a', 'b'], ['a', 'b'], ['a', 'b']]);
  });
  it('AC-9: unknown id exits 1, lists valid ids, runs nothing', async () => {
    expect(await cli('heal', U, 'a', 'zzz')).toBe(1);
    expect(err.join('\n')).toMatch(/zzz/);
    expect(err.join('\n')).toMatch(/a, b, c/);
    expect(runCalls).toEqual([]);
    expect(llmCalls).toBe(0);
  });
  it('AC-10: --failed with nothing failing exits 0 with a message, no run, no LLM', async () => {
    new Store(dir).saveRun('example.com', { id: '2026-01-02T00-00-00-000Z', kind: 'run', startedAt: '', finishedAt: '2026-01-02T00:00:05Z', screenshots: 'off', fullPage: false, results: [res('b', 'passed')] });
    expect(await cli('heal', U, '--failed')).toBe(0);
    expect(out.join('\n')).toMatch(/No failing tests to heal for example\.com/);
    expect(runCalls).toEqual([]);
    expect(llmCalls).toBe(0);
  });
  it('--failed re-runs and heals only the latest-failed tests', async () => {
    failing = new Set(['b']);
    expect(await cli('heal', U, '--failed')).toBe(1); // app_bug => non-zero, as before
    expect(runCalls[0]).toEqual(['b']);
    expect(llmCalls).toBe(1);
  });
  it('AC-11: prints a per-test summary; already passing skips the LLM and exits 0', async () => {
    expect(await cli('heal', U, 'a', 'b')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/a: already passing, not healed/);
    expect(text).toMatch(/b: already passing, not healed/);
    expect(llmCalls).toBe(0);
  });
  it('summary names the heal outcome of still-failing tests', async () => {
    failing = new Set(['b']);
    await cli('heal', U, 'a', 'b');
    const text = out.join('\n');
    expect(text).toMatch(/a: already passing/);
    expect(text).toMatch(/b: app_bug/);
  });
  it('no selection keeps the old behaviour: whole suite', async () => {
    await cli('heal', U);
    expect(runCalls[0]).toEqual(['a', 'b', 'c']);
  });
});
