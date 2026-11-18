import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/storage.js';
import { runTests, type RunOptions } from '../src/core/runner.js';
import { resolveTargets } from '../src/core/scale/targets.js';
import { startScaleSite, OK_SPEC, FAIL_SPEC, FLAKY_SPEC, SLOW_SPEC, type ScaleSite } from './helpers/scale-site.js';

const SITE = 'scale.test';
let site: ScaleSite;
let store: Store;
beforeAll(async () => { site = await startScaleSite(); });
afterAll(async () => { await site.close(); });
beforeEach(() => { store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'scale-run-'))); });

const run = (extra: Partial<RunOptions> = {}) =>
  runTests(store, { site: SITE, baseUrl: site.url, screenshots: 'on-failure', fullPage: false, headless: true, testTimeoutMs: 10_000, ...extra });
const pwConfig = (runId: string) => fs.readFileSync(path.join(store.runDir(SITE, runId), 'playwright.config.mjs'), 'utf8');
function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('SPEC-012 runner', () => {
  it('AC-1/AC-15: one result per (journey, project) with browser/device recorded; per-project artifacts', async () => {
    store.saveTest(SITE, 'ok', OK_SPEC);
    store.saveTest(SITE, 'bad', FAIL_SPEC);
    const r = await run({ targets: resolveTargets({ browsers: ['chromium'], devices: ['Pixel 7'] }), workers: 3 });
    expect(r.results.map((x) => `${x.journeyId}@${x.project}:${x.status}`).sort()).toEqual(['bad@Pixel 7:failed', 'bad@chromium:failed', 'ok@Pixel 7:passed', 'ok@chromium:passed']);
    const mobile = r.results.find((x) => x.journeyId === 'bad' && x.project === 'Pixel 7')!;
    const desktop = r.results.find((x) => x.journeyId === 'bad' && x.project === 'chromium')!;
    expect(mobile).toMatchObject({ browser: 'chromium', device: 'Pixel 7' });
    expect(desktop.browser).toBe('chromium');
    expect(desktop.device).toBeUndefined();
    expect(mobile.failure?.screenshot).toBeTruthy();
    expect(mobile.failure!.screenshot).not.toBe(desktop.failure!.screenshot);
    expect(mobile.screenshots[0]).not.toBe(desktop.screenshots[0]);
    for (const s of [mobile.failure!.screenshot!, desktop.failure!.screenshot!]) expect(fs.existsSync(path.join(store.siteDir(SITE), s))).toBe(true);
    expect(r.targets?.map((t) => t.name)).toEqual(['chromium', 'Pixel 7']);
    expect(r.workers).toBe(3);
    expect(store.loadRun(SITE, r.id)!.results).toHaveLength(4);
    expect(pwConfig(r.id)).toMatch(/"workers": 3/);
  }, 120_000);

  it('AC-6: retries recorded; flaky pass is passed with flaky=true', async () => {
    store.saveTest(SITE, 'flaky', FLAKY_SPEC);
    const r = await run({ retries: 1 });
    expect(r.results[0]).toMatchObject({ journeyId: 'flaky', status: 'passed', retries: 1, flaky: true, project: 'chromium', browser: 'chromium' });
    expect(r.retries).toBe(1);
  }, 60_000);

  it('AC-7/AC-8: env baseUrl + headers reach the server; header values never written to disk', async () => {
    const staging = await startScaleSite('Staging');
    try {
      store.saveTest(SITE, 'ok', OK_SPEC);
      const token = 'Bearer s3cr3t-token-xyz';
      const r = await run({ baseUrl: staging.url, env: { name: 'staging', baseUrl: staging.url, headers: { 'x-env-token': token } } });
      expect(r.results[0]).toMatchObject({ status: 'passed', env: 'staging' });
      expect(r.env).toBe('staging');
      expect(r.baseUrl).toBe(staging.url);
      expect(staging.requests.some((q) => q.headers['x-env-token'] === token)).toBe(true);
      for (const f of allFiles(store.dataDir)) {
        if (/\.(png|zip|webm)$/.test(f)) continue;
        expect(fs.readFileSync(f, 'utf8'), f).not.toContain('s3cr3t-token-xyz');
      }
    } finally { await staging.close(); }
  }, 60_000);

  it('AC-13: per-test, per-journey and global timeouts', async () => {
    store.saveTest(SITE, 'slow', SLOW_SPEC);
    store.saveTest(SITE, 'ok', OK_SPEC);
    const r = await run({ testTimeoutMs: 8000, globalTimeoutMs: 60_000, journeyTimeouts: { slow: 1000 } });
    expect(r.results.find((x) => x.journeyId === 'slow')!.status).toBe('timedOut');
    expect(r.results.find((x) => x.journeyId === 'ok')!.status).toBe('passed');
    const c = pwConfig(r.id);
    expect(c).toMatch(/"timeout": 8000/);
    expect(c).toMatch(/"globalTimeout": 60000/);
  }, 60_000);

  it('AC-14: trace/video policy mapping and recorded video path', async () => {
    store.saveTest(SITE, 'bad', FAIL_SPEC);
    const r = await run({ trace: 'on-failure', video: 'retain-on-failure' });
    const c = pwConfig(r.id);
    expect(c).toMatch(/"trace": "retain-on-first-failure"/);
    expect(c).toMatch(/"video": "retain-on-failure"/);
    const bad = r.results[0];
    expect(bad.videoPath).toMatch(/\.webm$/);
    expect(fs.existsSync(path.join(store.siteDir(SITE), bad.videoPath!))).toBe(true);
    expect(bad.tracePath).toBeTruthy();
  }, 60_000);

  it('FR-19: auth runs force trace and video off', async () => {
    store.saveTest(SITE, 'ok', OK_SPEC);
    const state = path.join(store.dataDir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const r = await run({ trace: 'on', video: 'on', auth: { storageState: state, env: {}, journeyIds: ['ok'] } });
    expect(r.results[0]).toMatchObject({ status: 'passed', project: 'chromium [auth]' });
    expect(r.results[0].videoPath).toBeUndefined();
    const c = pwConfig(r.id);
    expect(c).toMatch(/"trace": "off"/);
    expect(c).toMatch(/"video": "off"/);
  }, 60_000);
});
