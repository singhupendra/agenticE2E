import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveConfig, type Config } from '../src/core/config.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { createContext, heal, run } from '../src/core/pipeline.js';
import { proposeJourneys } from '../src/core/planner.js';
import { listTestCases } from '../src/core/test-cases.js';
import { Store, normalizeSite } from '../src/core/storage.js';
import { main } from '../src/cli/index.js';
import { buildApp } from '../src/server/app.js';
import { mergeJobConfig, parseJobRequest } from '../src/server/jobs.js';
import type { Journey, PageModel, ProgressEvent, RunRecord, TestResult } from '../src/core/types.js';
import { startScaleSite, OK_SPEC, type ScaleSite } from './helpers/scale-site.js';

const URL_ = 'https://shop.example.test';
const SITE = normalizeSite(URL_).id;
const j = (id: string, extra: Partial<Journey> = {}): Journey => ({
  id,
  name: `Journey ${id}`,
  goal: 'look around',
  priority: 'medium',
  tags: [],
  steps: ['open the page'],
  status: 'selected',
  ...extra,
});

let site: ScaleSite;
let dataDir: string;
let store: Store;
let events: ProgressEvent[];
beforeAll(async () => {
  site = await startScaleSite('Staging');
});
afterAll(async () => {
  await site.close();
});
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-pipe-'));
  store = new Store(dataDir);
  events = [];
  store.saveSite({ id: SITE, origin: URL_, url: URL_ });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seed(journeys: Journey[]) {
  store.saveJourneys(SITE, journeys);
  for (const x of journeys) store.saveTest(SITE, x.id, OK_SPEC);
}
const ctxWith = (file: Record<string, unknown>, cli: Partial<Config> = {}, llm?: MockLLM) =>
  createContext({
    config: resolveConfig({ file: { dataDir, testTimeoutMs: 10_000, ...file } as never, cli, env: {} }),
    llm,
    onProgress: (e) => events.push(e),
  });

describe('SPEC-012 pipeline', () => {
  it('AC-7: --env runs the stored journeys of <url> against the env baseUrl', async () => {
    seed([j('browse')]);
    const ctx = ctxWith({ environments: { staging: { baseUrl: site.url } } }, { env: 'staging' });
    const r = await run(ctx, URL_);
    expect(r.results[0]).toMatchObject({ journeyId: 'browse', status: 'passed', env: 'staging' });
    expect(r.baseUrl).toBe(site.url);
    expect(listTestCases(store, SITE)!.tests[0].lastRun.outcome).toBe('passed');
  }, 60_000);

  it('AC-9: a read-only (prod) env skips destructive journeys with a warning', async () => {
    seed([
      j('browse', { name: 'Browse products' }),
      j('delete-account', { name: 'Delete account', steps: ['open settings', 'click Delete account'] }),
      j('buy', { tags: ['destructive'] }),
    ]);
    const r = await run(ctxWith({ environments: { prod: { baseUrl: site.url } } }, { env: 'prod' }), URL_);
    expect(r.results.map((x) => x.journeyId)).toEqual(['browse']);
    const warns = events
      .filter((e) => e.type === 'warn')
      .map((e) => e.message)
      .join('\n');
    expect(warns).toMatch(/delete-account/);
    expect(warns).toMatch(/buy/);
    events = [];
    const r2 = await run(
      ctxWith({ environments: { prod: { baseUrl: site.url, readOnly: false } } }, { env: 'prod' }),
      URL_,
    );
    expect(r2.results.map((x) => x.journeyId).sort()).toEqual(['browse', 'buy', 'delete-account']);
  }, 90_000);

  it('AC-8: env header values (from ${VAR}) never reach progress events or stored data', async () => {
    seed([j('browse')]);
    process.env.SCALE_TEST_TOKEN = 'tok-9f8e7d6c5b';
    try {
      const ctx = ctxWith(
        { environments: { staging: { baseUrl: site.url, headers: { authorization: 'Bearer ${SCALE_TEST_TOKEN}' } } } },
        { env: 'staging' },
      );
      const r = await run(ctx, URL_);
      expect(r.results[0].status).toBe('passed');
      expect(site.requests.some((q) => q.headers.authorization === 'Bearer tok-9f8e7d6c5b')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('tok-9f8e7d6c5b');
      expect(JSON.stringify(store.loadRun(SITE, r.id))).not.toContain('tok-9f8e7d6c5b');
    } finally {
      delete process.env.SCALE_TEST_TOKEN;
    }
  }, 60_000);

  it('AC-8: unset header variable fails before running', async () => {
    seed([j('browse')]);
    expect(() =>
      ctxWith(
        { environments: { staging: { baseUrl: site.url, headers: { authorization: '${SCALE_UNSET_VAR_X}' } } } },
        { env: 'staging' },
      ),
    ).toThrow(/SCALE_UNSET_VAR_X/);
  });

  it('FR-8: unknown env is an error listing env names', () => {
    expect(() => ctxWith({ environments: { dev: { baseUrl: site.url } } }, { env: 'qa' })).toThrow(
      /Unknown environment "qa".*dev/,
    );
  });

  it('AC-12: --tag / --grep filter the run; no match is an error', async () => {
    seed([
      j('a', { tags: ['smoke'] }),
      j('b', { tags: ['regression'] }),
      j('checkout', { name: 'Checkout', tags: ['regression'] }),
    ]);
    const env = { environments: { dev: { baseUrl: site.url } }, env: 'dev' };
    expect((await run(ctxWith(env, { tag: ['smoke'] }), URL_)).results.map((x) => x.journeyId)).toEqual(['a']);
    expect((await run(ctxWith(env, { grep: 'checkout' }), URL_)).results.map((x) => x.journeyId)).toEqual(['checkout']);
    await expect(run(ctxWith(env, { tag: ['critical'] }), URL_)).rejects.toThrow(/No tests match/);
  }, 90_000);

  it('AC-5: --shard runs only its chunk; an empty shard runs nothing and stores nothing', async () => {
    seed([j('a'), j('b'), j('c')]);
    const env = { environments: { dev: { baseUrl: site.url } }, env: 'dev' };
    const r = await run(ctxWith(env, { shard: '2/2' }), URL_);
    expect(r.results.map((x) => x.journeyId)).toEqual(['c']);
    expect(r.shard).toEqual({ current: 2, total: 2 });
    const before = store.listRuns(SITE).length;
    const empty = await run(ctxWith({ ...env, testTimeoutMs: 10_000 }, { shard: '4/4' }), URL_);
    expect(empty.results).toEqual([]);
    expect(store.listRuns(SITE).length).toBe(before);
  }, 60_000);

  it('retry / heal re-runs are never sharded', async () => {
    seed([j('a'), j('b'), j('c')]);
    const r = await run(ctxWith({ environments: { dev: { baseUrl: site.url } }, env: 'dev' }, { shard: '2/2' }), URL_, {
      journeyIds: ['a'],
      kind: 'retry',
    });
    expect(r.results.map((x) => x.journeyId)).toEqual(['a']);
  }, 60_000);

  it('AC-16: a journey failing on two projects is healed once', async () => {
    seed([j('x')]);
    const llm = new MockLLM(() => ({ verdict: 'app_bug', reason: 'server bug' }));
    const res = (project: string): TestResult => ({
      journeyId: 'x',
      file: 'tests/x.spec.ts',
      status: 'failed',
      durationMs: 1,
      error: 'boom',
      screenshots: [],
      project,
      browser: project === 'firefox' ? 'firefox' : 'chromium',
    });
    const failed: RunRecord = {
      id: 'r1',
      kind: 'run',
      startedAt: '',
      finishedAt: '',
      screenshots: 'off',
      fullPage: false,
      results: [res('chromium'), res('firefox')],
    };
    const heals = await heal(ctxWith({}, {}, llm), URL_, failed);
    expect(heals).toHaveLength(1);
    expect(llm.callsFor('heal_test')).toHaveLength(1);
  });
});

describe('SPEC-012 planner tags (AC-10)', () => {
  it('assigns default suite tags and keeps LLM ones', async () => {
    const page: PageModel = {
      url: URL_,
      path: '/',
      title: 't',
      depth: 0,
      headings: [],
      ariaSnapshot: '',
      elements: [],
      forms: [],
      navLinks: [],
    };
    const llm = new MockLLM(() => ({
      journeys: [
        { name: 'Search', goal: 'g', priority: 'high', steps: ['s'] },
        { name: 'Footer', goal: 'g', priority: 'low', tags: ['Smoke'], steps: ['s'] },
      ],
    }));
    const js = await proposeJourneys(llm, [page]);
    expect(js.map((x) => x.tags)).toEqual([['smoke', 'critical', 'regression'], ['smoke']]);
    expect(llm.calls[0].system).toMatch(/smoke.*regression.*critical/s);
    expect(llm.calls[0].system).toMatch(/destructive/);
  });
});

describe('SPEC-012 history per env/target (AC-17)', () => {
  const res = (status: TestResult['status'], project: string, env: string): TestResult => ({
    journeyId: 'x',
    file: 'tests/x.spec.ts',
    status,
    durationMs: 5,
    screenshots: [],
    project,
    browser: 'chromium',
    env,
    ...(status === 'passed' ? {} : { error: 'nope' }),
  });
  const rec = (id: string, env: string, results: TestResult[]): RunRecord => ({
    id,
    kind: 'run',
    startedAt: id,
    finishedAt: id,
    screenshots: 'off',
    fullPage: false,
    env,
    results,
  });
  beforeEach(() => {
    seed([j('x', { tags: ['smoke'] }), j('y', { tags: ['regression'] })]);
    store.saveRun(
      SITE,
      rec('2026-01-01T00-00-00-000Z', 'staging', [
        res('passed', 'chromium', 'staging'),
        res('failed', 'Pixel 7', 'staging'),
      ]),
    );
    store.saveRun(SITE, rec('2026-01-02T00-00-00-000Z', 'dev', [res('passed', 'chromium', 'dev')]));
  });
  it('lastRun per env; aggregated over projects; targets list', () => {
    const all = listTestCases(store, SITE)!.tests.find((t) => t.journeyId === 'x')!;
    expect(all.lastRun.outcome).toBe('passed');
    expect(all.tags).toEqual(['smoke']);
    expect(all.targets!.map((t) => `${t.env}/${t.project}:${t.outcome}`).sort()).toEqual([
      'dev/chromium:passed',
      'staging/Pixel 7:failed',
      'staging/chromium:passed',
    ]);
    const stg = listTestCases(store, SITE, { env: 'staging' })!.tests.find((t) => t.journeyId === 'x')!;
    expect(stg.lastRun).toMatchObject({ outcome: 'failed', error: 'nope' });
    expect(listTestCases(store, SITE, { tag: ['regression'] })!.tests.map((t) => t.journeyId)).toEqual(['y']);
  });

  it('CLI: list-test-cases --env / --tag / --grep, and journeys tag editing', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      out.push(a.join(' '));
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dataDir]);
      expect(await cli('list-test-cases', URL_, '--env', 'staging', '--json')).toBe(0);
      const doc = JSON.parse(out.join('\n'));
      expect(doc.tests.find((t: { journeyId: string }) => t.journeyId === 'x').lastRun.outcome).toBe('failed');
      out.length = 0;
      expect(await cli('list-test-cases', URL_, '--tag', 'smoke')).toBe(0);
      expect(out.join('\n')).toMatch(/TAGS/);
      expect(out.join('\n')).not.toMatch(/\by\b.*regression/);
      out.length = 0;
      expect(await cli('journeys', URL_, '--add-tags', 'x=Critical', '--remove-tags', 'x=smoke')).toBe(0);
      expect(store.loadJourneys(SITE)!.find((x) => x.id === 'x')!.tags).toEqual(['critical']);
      expect(store.loadJourneys(SITE)!.find((x) => x.id === 'y')!.tags).toEqual(['regression']);
      expect(out.join('\n')).toMatch(/tags: critical/);
      expect(await cli('journeys', URL_, '--add-tags', 'zz=a')).toBe(1);
      expect(await cli('journeys', URL_, '--add-tags', 'x=!!')).toBe(1);
      expect(await cli('journeys', URL_, '--add-tags', 'x=Bad Tag')).toBe(1);
      expect(await cli('journeys', URL_, '--add-tags', 'nonsense')).toBe(1);
      expect(store.loadJourneys(SITE)!.find((x) => x.id === 'x')!.tags).toEqual(['critical']);
      expect(await cli('journeys', URL_, '--set-tags', '*=smoke', 'y=regression,critical')).toBe(0);
      expect(store.loadJourneys(SITE)!.map((x) => x.tags)).toEqual([['smoke'], ['regression', 'critical']]);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe('SPEC-012 server (AC-18)', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });
  it('review: bad env/device/shard job options are a 400 and do not block later jobs for the site', async () => {
    const config = resolveConfig({
      file: {
        dataDir,
        environments: { staging: { baseUrl: site.url, headers: { authorization: '${SCALE_UNSET_FOR_JOB}' } } },
      } as never,
      env: {},
    });
    app = await buildApp({ config, webDir: path.join(dataDir, 'no-web') });
    for (const options of [{ env: 'nope' }, { devices: ['iPhone 99'] }, { shard: '0/2' }, { env: 'staging' }]) {
      const r = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: URL_, options } });
      expect(r.statusCode, JSON.stringify(options)).toBe(400);
      expect(r.body).not.toContain('SCALE_UNSET_FOR_JOB');
    }
    const ok = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: URL_ } });
    expect(ok.statusCode).toBe(202);
  });

  it('never returns env header values and ignores client-provided environments', async () => {
    const config = resolveConfig({
      file: {
        dataDir,
        environments: {
          staging: { baseUrl: 'https://stg.example.test', headers: { authorization: 'Bearer srv-secret-123' } },
        },
      } as never,
      env: {},
    });
    app = await buildApp({ config, webDir: path.join(dataDir, 'no-web') });
    const body = (await app.inject('/api/config')).body;
    expect(body).not.toContain('srv-secret-123');
    expect(JSON.parse(body).environments).toEqual({
      staging: { baseUrl: 'https://stg.example.test', readOnly: false, headers: ['authorization'] },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/sites/${SITE}/journeys`,
      payload: [j('x', { tags: [' Smoke ', 'smoke', 'Critical'] })],
    });
    expect(put.statusCode).toBe(200);
    expect(store.loadJourneys(SITE)![0].tags).toEqual(['smoke', 'critical']);
    expect(
      parseJobRequest({ action: 'run', url: URL_, options: { environments: { x: { baseUrl: 'https://evil.test' } } } })
        .options,
    ).toEqual({});
    expect(
      mergeJobConfig(config, parseJobRequest({ action: 'run', url: URL_, options: JSON.parse(body) }).options)
        .environments,
    ).toEqual(config.environments);
    expect(
      parseJobRequest({
        action: 'run',
        url: URL_,
        options: { env: 'staging', browsers: ['firefox'], tag: ['smoke'], retries: 1 },
      }).options,
    ).toEqual({ env: 'staging', browsers: ['firefox'], tag: ['smoke'], retries: 1 });
  });
});
