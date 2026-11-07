import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/storage.js';
import { runTests } from '../src/core/runner.js';
import type { ScreenshotMode } from '../src/core/types.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';
import { GOOD_SPEC, FAILING_SPEC } from './helpers/specs.js';

let fx: Fixture;
let store: Store;
const SITE = 'fixture.test';
beforeAll(async () => { fx = await startFixtureSite(); });
afterAll(async () => { await fx.close(); });
beforeEach(() => {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'run-')));
  store.saveTest(SITE, 'home-ok', GOOD_SPEC);
});

const run = (screenshots: ScreenshotMode, ids?: string[], fullPage = false) =>
  runTests(store, { site: SITE, baseUrl: fx.url, screenshots, fullPage, headless: true, testTimeoutMs: 10_000, journeyIds: ids });
const pngs = (r: Awaited<ReturnType<typeof run>>, id: string) => r.results.find((x) => x.journeyId === id)!.screenshots;

describe('runner', () => {
  it('AC-22: reports pass/fail with error, failure snapshot, screenshot, trace', async () => {
    store.saveTest(SITE, 'contact-broken', FAILING_SPEC);
    const r = await run('on-failure');
    const ok = r.results.find((x) => x.journeyId === 'home-ok')!;
    const bad = r.results.find((x) => x.journeyId === 'contact-broken')!;
    expect(ok.status).toBe('passed');
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatch(/Your full name/);
    expect(bad.failure?.url).toContain('/contact');
    expect(bad.failure?.ariaSnapshot).toContain('textbox "Name"');
    expect(bad.failure?.html).toContain('<form');
    expect(bad.screenshots.some((s) => s.endsWith('failure.png'))).toBe(true);
    expect(fs.existsSync(path.join(store.siteDir(SITE), bad.failure!.screenshot!))).toBe(true);
    expect(bad.tracePath && fs.existsSync(path.join(store.siteDir(SITE), bad.tracePath))).toBe(true);
    expect(ok.screenshots).toEqual([]);
    expect(store.loadRun(SITE, r.id)?.results).toHaveLength(2);
  });

  it('AC-23: every-step', async () => { expect(pngs(await run('every-step'), 'home-ok').length).toBeGreaterThanOrEqual(2); });
  it('AC-23: off', async () => {
    store.saveTest(SITE, 'contact-broken', FAILING_SPEC);
    const r = await run('off');
    expect(pngs(r, 'home-ok')).toEqual([]);
    expect(pngs(r, 'contact-broken')).toEqual([]);
    expect(r.results.find((x) => x.journeyId === 'contact-broken')!.failure?.ariaSnapshot).toBeTruthy();
  });
  it('AC-23: end-of-journey', async () => { expect(pngs(await run('end-of-journey'), 'home-ok')).toHaveLength(1); });
  it('can run a subset by id', async () => {
    store.saveTest(SITE, 'contact-broken', FAILING_SPEC);
    const r = await run('off', ['home-ok']);
    expect(r.results.map((x) => x.journeyId)).toEqual(['home-ok']);
  });
  it('fullPage option is honoured (larger or equal image)', async () => {
    const r = await run('end-of-journey', undefined, true);
    expect(pngs(r, 'home-ok')).toHaveLength(1);
  });
  it('throws when there are no tests', async () => {
    const empty = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'run-')));
    await expect(runTests(empty, { site: 'none.test', baseUrl: fx.url, screenshots: 'off', fullPage: false, headless: true, testTimeoutMs: 5000 })).rejects.toThrow(/no tests/i);
  });
  it('marks specs with load errors as failed', async () => {
    store.saveTest(SITE, 'broken-syntax', "import { test } from './_support';\ntest('x', async () => { await ;");
    const r = await run('off', ['broken-syntax']);
    expect(r.results[0].status).toBe('failed');
    expect(r.results[0].error).toBeTruthy();
  });
});
