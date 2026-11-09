import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/index.js';
import { Store } from '../src/core/storage.js';
import { listTestCases } from '../src/core/test-cases.js';
import type { HealRecord, Journey, RunRecord, TestResult } from '../src/core/types.js';

const j = (id: string, status: Journey['status'] = 'selected'): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status });
const res = (journeyId: string, status: TestResult['status'], error?: string): TestResult => ({ journeyId, file: `tests/${journeyId}.spec.ts`, status, durationMs: 120, error, screenshots: [] });
const runRec = (id: string, finishedAt: string, results: TestResult[], kind: RunRecord['kind'] = 'run'): RunRecord =>
  ({ id, kind, startedAt: finishedAt, finishedAt, screenshots: 'off', fullPage: false, results });
const heal = (journeyId: string, outcome: HealRecord['outcome'], at: string): HealRecord =>
  ({ id: `h-${journeyId}-${at}`, journeyId, at, outcome, reason: 'r', originalError: 'e', attempts: [] });

let dir: string, store: Store, out: string[], err: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  store = new Store(dir);
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);

function seedSite() {
  store.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
  store.saveJourneys('example.com', [j('a', 'selected'), j('b', 'approved'), j('c', 'proposed')]);
  for (const id of ['a', 'b', 'c']) store.saveTest('example.com', id, `// ${id}\n`);
  store.saveRun('example.com', runRec('2026-01-01T00-00-00-000Z', '2026-01-01T00:00:05.000Z', [res('a', 'failed', 'boom\nstack'), res('b', 'failed', 'bad\nmore')]));
  store.saveRun('example.com', runRec('2026-01-02T00-00-00-000Z', '2026-01-02T00:00:05.000Z', [res('a', 'passed')]));
}

describe('listTestCases (core)', () => {
  it('AC-1/2/9: lists specs with journey info and the latest outcome', () => {
    seedSite();
    store.saveTest('example.com', 'orphan', '// o\n');
    const r = listTestCases(store, 'example.com')!;
    expect(r.site).toEqual({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    expect(r.tests.map((t) => t.journeyId)).toEqual(['a', 'b', 'c', 'orphan']);
    const [a, b, c, o] = r.tests;
    expect(a).toMatchObject({ name: 'Journey a', journeyStatus: 'selected', specFile: path.resolve(dir, 'sites/example.com/tests/a.spec.ts') });
    expect(a.lastRun).toMatchObject({ outcome: 'passed', runId: '2026-01-02T00-00-00-000Z', at: '2026-01-02T00:00:05.000Z', durationMs: 120 });
    expect(b.journeyStatus).toBe('approved');
    expect(b.lastRun).toMatchObject({ outcome: 'failed', error: 'bad' });
    expect(c.lastRun).toEqual({ outcome: 'never_run' });
    expect(o).toMatchObject({ name: 'orphan', journeyStatus: 'unknown', lastRun: { outcome: 'never_run' } });
  });
  it('AC-13: stray spec files with non-standard names do not break the listing', () => {
    seedSite();
    fs.writeFileSync(path.join(store.testsDir('example.com'), 'My Test.spec.ts'), '// x\n');
    fs.writeFileSync(path.join(store.testsDir('example.com'), 'Foo.spec.ts'), '// x\n');
    const r = listTestCases(store, 'example.com')!;
    expect(r.tests.map((t) => t.journeyId)).toEqual(['Foo', 'My Test', 'a', 'b', 'c']);
    expect(r.tests[1]).toMatchObject({ name: 'My Test', journeyStatus: 'unknown', lastRun: { outcome: 'never_run' } });
  });
  it('AC-4: timedOut counts as failed, skipped stays skipped', () => {
    seedSite();
    store.saveRun('example.com', runRec('2026-01-03T00-00-00-000Z', '2026-01-03T00:00:05.000Z', [res('b', 'timedOut', 'slow'), res('c', 'skipped')]));
    const t = Object.fromEntries(listTestCases(store, 'example.com')!.tests.map((x) => [x.journeyId, x.lastRun.outcome]));
    expect(t).toMatchObject({ b: 'failed', c: 'skipped' });
  });
  it('AC-3: healed only for a passing heal-rerun with a healed record', () => {
    seedSite();
    store.saveRun('example.com', runRec('2026-01-03T00-00-00-000Z', '2026-01-03T00:00:05.000Z', [res('b', 'passed'), res('c', 'passed')], 'heal-rerun'));
    store.appendHeal('example.com', heal('b', 'healed', '2026-01-03T00:00:06.000Z'));
    store.appendHeal('example.com', heal('c', 'flaky_or_environment', '2026-01-03T00:00:06.000Z'));
    const t = Object.fromEntries(listTestCases(store, 'example.com')!.tests.map((x) => [x.journeyId, x.lastRun.outcome]));
    expect(t).toMatchObject({ b: 'healed', c: 'passed' });
  });
  it('a later plain run supersedes an earlier heal', () => {
    seedSite();
    store.saveRun('example.com', runRec('2026-01-03T00-00-00-000Z', '2026-01-03T00:00:05.000Z', [res('b', 'passed')], 'heal-rerun'));
    store.appendHeal('example.com', heal('b', 'healed', '2026-01-03T00:00:06.000Z'));
    store.saveRun('example.com', runRec('2026-01-04T00-00-00-000Z', '2026-01-04T00:00:05.000Z', [res('b', 'failed', 'again')]));
    expect(listTestCases(store, 'example.com')!.tests.find((x) => x.journeyId === 'b')!.lastRun.outcome).toBe('failed');
  });
  it('AC-5: known site without tests gives an empty list', () => {
    store.saveSite({ id: 'empty.com', origin: 'https://empty.com', url: 'https://empty.com' });
    expect(listTestCases(store, 'empty.com')!.tests).toEqual([]);
  });
  it('AC-12: unknown site returns null and writes nothing', () => {
    expect(listTestCases(store, 'nope.com')).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('cli list-test-cases', () => {
  it('AC-1: prints a table', async () => {
    seedSite();
    expect(await cli('list-test-cases', 'https://example.com')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/example\.com/);
    expect(text).toMatch(/3 tests/);
    for (const h of ['JOURNEY', 'NAME', 'STATUS', 'LAST RUN', 'SPEC FILE']) expect(text).toContain(h);
    expect(text).toMatch(/a\s+Journey a\s+selected\s+passed 2026-01-02T00:00:05\.000Z\s+\S*a\.spec\.ts/);
    expect(text).toMatch(/b\s+Journey b\s+approved\s+failed 2026-01-01T00:00:05\.000Z/);
    expect(text).toMatch(/c\s+Journey c\s+proposed\s+never run\s/);
  });
  it('AC-8: URL is normalized like other commands', async () => {
    seedSite();
    expect(await cli('list-test-cases', 'https://Example.com:443/some/path')).toBe(0);
    expect(out.join('\n')).toContain('Journey a');
  });
  it('AC-5: known site without tests exits 0 with a message', async () => {
    store.saveSite({ id: 'empty.com', origin: 'https://empty.com', url: 'https://empty.com' });
    expect(await cli('list-test-cases', 'https://empty.com')).toBe(0);
    expect(out.join('\n')).toMatch(/No generated tests for empty\.com yet.*generate/);
    out.length = 0;
    expect(await cli('list-test-cases', 'https://empty.com', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).tests).toEqual([]);
  });
  it('AC-6: unknown site exits 1 with a clear message and empty stdout', async () => {
    for (const extra of [[], ['--json']]) {
      out.length = 0; err.length = 0;
      expect(await cli('list-test-cases', 'https://nowhere.test', ...extra)).toBe(1);
      expect(err.join('\n')).toMatch(/Unknown site nowhere\.test/);
      expect(err.join('\n')).toContain(dir);
      expect(err.join('\n')).toMatch(/discover/);
      expect(out).toEqual([]);
    }
  });
  it('AC-7: --json shape', async () => {
    seedSite();
    expect(await cli('list-test-cases', 'https://example.com', '--json')).toBe(0);
    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]);
    expect(Object.keys(doc).sort()).toEqual(['dataDir', 'site', 'tests']);
    expect(doc.site).toEqual({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    expect(doc.dataDir).toBe(dir);
    expect(doc.tests).toHaveLength(3);
    expect(Object.keys(doc.tests[0]).sort()).toEqual(['journeyId', 'journeyStatus', 'lastRun', 'name', 'specFile']);
    expect(doc.tests[0].lastRun).toMatchObject({ outcome: 'passed', at: '2026-01-02T00:00:05.000Z' });
    expect(doc.tests[2].lastRun).toEqual({ outcome: 'never_run' });
  });
  it('AC-10: honors --config dataDir', async () => {
    seedSite();
    const cfg = path.join(dir, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ dataDir: dir }));
    expect(await main(['node', 'agentic-e2e', 'list-test-cases', 'https://example.com', '--config', cfg])).toBe(0);
    expect(out.join('\n')).toContain('Journey a');
  });
  it('AC-11: non-http URL fails', async () => {
    expect(await cli('list-test-cases', 'ftp://example.com')).toBe(1);
    expect(err.join('\n')).toMatch(/http/);
  });
});
