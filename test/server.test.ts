import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { mergeJobConfig, parseJobRequest } from '../src/server/jobs.js';
import { resolveConfig } from '../src/core/config.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { Store } from '../src/core/storage.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';
import { fakeAwsFiles, SAMPLE_CONFIG, SAMPLE_CREDENTIALS } from './helpers/aws-files.js';

let fx: Fixture, app: FastifyInstance, store: Store, dataDir: string;
beforeAll(async () => {
  fx = await startFixtureSite();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const config = resolveConfig({ cli: { dataDir, maxPages: 4, maxDepth: 1, maxJourneys: 1 } });
  const llm = new MockLLM((req) => req.name === 'propose_journeys'
    ? { journeys: [{ name: 'Browse', goal: 'g', priority: 'high', steps: ['open home'] }] }
    : { ranked: [{ id: 'browse', rationale: 'r' }] });
  app = await buildApp({ config, llm, webDir: path.join(dataDir, 'no-web') });
  store = new Store(dataDir);
});
afterAll(async () => { await app.close(); await fx.close(); });

const sse = (body: string) => body.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));

describe('server', () => {
  it('serves health and default config', async () => {
    expect((await app.inject('/api/health')).json()).toEqual({ ok: true });
    const c = (await app.inject('/api/config')).json();
    expect(c.screenshots).toBe('on-failure');
    expect(c.dataDir).toBeUndefined();
  });

  it('AC-32: POST /api/jobs returns an id and SSE streams to a terminal event', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: fx.url, options: { screenshots: 'off' } } });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    const ev = await app.inject(`/api/jobs/${jobId}/events`);
    expect(ev.headers['content-type']).toContain('text/event-stream');
    const events = sse(ev.body);
    expect(events.some((e) => e.type === 'stage' && e.stage === 'discover')).toBe(true);
    expect(events.at(-1).type).toBe('done');
    expect((await app.inject(`/api/jobs/${jobId}`)).json().status).toBe('done');
  });

  it('accepts the exact settings object the UI loads from /api/config as job options', async () => {
    const options = (await app.inject('/api/config')).json();
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://roundtrip.test', options } });
    expect(res.statusCode).toBe(202);
  });

  it('job errors become an error terminal event', async () => {
    const { jobId } = (await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://never-seen.test' } })).json();
    const events = sse((await app.inject(`/api/jobs/${jobId}/events`)).body);
    expect(events.at(-1).type).toBe('error');
    expect(events.at(-1).message).toMatch(/no tests/i);
  });

  it('validates job input', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'nope', url: fx.url } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'ftp://x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: fx.url, options: { screenshots: 'bad' } } })).statusCode).toBe(400);
    expect((await app.inject('/api/jobs/doesnotexist')).statusCode).toBe(404);
  });

  it('lists sites and returns site detail', async () => {
    const sites = (await app.inject('/api/sites')).json();
    expect(sites).toHaveLength(1);
    const id = sites[0].id;
    const detail = (await app.inject(`/api/sites/${id}`)).json();
    expect(detail.journeys[0].id).toBe('browse');
    expect(detail.pages.length).toBeGreaterThan(0);
  });

  it('AC-33: PUT journeys persists edits and validates', async () => {
    const id = store.listSites()[0].id;
    const journeys = store.loadJourneys(id)!;
    const edited = [{ ...journeys[0], name: 'Browse edited', status: 'approved', steps: ['one', 'two'] }];
    const put = await app.inject({ method: 'PUT', url: `/api/sites/${id}/journeys`, payload: edited });
    expect(put.statusCode).toBe(200);
    const detail = (await app.inject(`/api/sites/${id}`)).json();
    expect(detail.journeys[0]).toMatchObject({ name: 'Browse edited', status: 'approved', steps: ['one', 'two'] });
    expect((await app.inject({ method: 'PUT', url: `/api/sites/${id}/journeys`, payload: [{ id: 'x' }] })).statusCode).toBe(400);
  });

  it('SPEC-006 AC-9: heal records without the new fields are returned unchanged; new fields pass through', async () => {
    const id = store.listSites()[0].id;
    const legacy = { id: 'old', journeyId: 'a', at: 't', outcome: 'failed', reason: 'r', originalError: 'e', attempts: [] };
    const fresh = { ...legacy, id: 'new', lastError: 'Error: boom', candidateDiff: '+x' };
    store.appendHeal(id, legacy as never);
    store.appendHeal(id, fresh as never);
    const heals = (await app.inject(`/api/sites/${id}`)).json().heals;
    expect(heals.find((h: { id: string }) => h.id === 'old')).toEqual(legacy);
    expect(heals.find((h: { id: string }) => h.id === 'new')).toMatchObject({ lastError: 'Error: boom', candidateDiff: '+x' });
  });

  describe('SPEC-008 heal selection', () => {
    const post = (payload: unknown, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/jobs', payload: payload as never, ...extra });
    const finish = async (jobId: string) => { await app.inject(`/api/jobs/${jobId}/events`); return (await app.inject(`/api/jobs/${jobId}`)).json(); };
    let id: string;
    beforeAll(() => { id = store.listSites()[0].id; });

    it('AC-12: unknown ids -> 400 with valid ids, no job created', async () => {
      store.saveTest(id, 'browse', 'x');
      const before = (await app.inject('/api/jobs')).json().length;
      const r = await post({ action: 'heal', url: fx.url, journeyIds: ['browse', 'zzz'] });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ unknownIds: ['zzz'], validIds: expect.arrayContaining(['browse']) });
      expect(r.json().error).toMatch(/zzz/);
      expect((await app.inject('/api/jobs')).json().length).toBe(before);
    });
    it('AC-12: failedOnly validation', async () => {
      expect((await post({ action: 'run', url: fx.url, failedOnly: true })).statusCode).toBe(400);
      expect((await post({ action: 'heal', url: fx.url, failedOnly: 'yes' })).statusCode).toBe(400);
      expect((await post({ action: 'heal', url: fx.url, journeyIds: [1] })).statusCode).toBe(400);
    });
    it('unknown site with a selection -> 404', async () => {
      expect((await post({ action: 'heal', url: 'https://nowhere.test', failedOnly: true })).statusCode).toBe(404);
    });
    it('AC-13: failedOnly with nothing failing ends done with noneFailing and no LLM calls', async () => {
      store.saveTest(id, 'browse', 'x');
      store.saveRun(id, { id: '2099-01-01T00-00-00-000Z', kind: 'run', startedAt: '', finishedAt: '2099-01-01T00:00:00Z', screenshots: 'off', fullPage: false, results: [{ journeyId: 'browse', file: 'browse.spec.ts', status: 'passed', durationMs: 1, screenshots: [] }] });
      const r = await post({ action: 'heal', url: fx.url, failedOnly: true });
      expect(r.statusCode).toBe(202);
      const job = await finish(r.json().jobId);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ noneFailing: true, selected: [], heals: [] });
    });
    it('AC-14: protections still apply to the new payload', async () => {
      const payload = { action: 'heal', url: fx.url, failedOnly: true };
      expect((await post(payload, { headers: { host: 'attacker.com:4173' } })).statusCode).toBe(403);
      expect((await post(payload, { headers: { origin: 'http://evil.test', host: 'localhost:4173' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(payload) })).statusCode).toBe(415);
    });
    it('AC-15: GET /api/sites/:site/test-cases returns the listing; unknown site 404', async () => {
      const r = await app.inject(`/api/sites/${id}/test-cases`);
      expect(r.statusCode).toBe(200);
      expect(r.json().tests.find((t: { journeyId: string }) => t.journeyId === 'browse').lastRun.outcome).toBe('passed');
      expect((await app.inject('/api/sites/not-a-site/test-cases')).statusCode).toBe(404);
    });
  });

  it('serves test code and files; AC-34 blocks traversal', async () => {
    const id = store.listSites()[0].id;
    store.saveTest(id, 'browse', 'code here');
    store.saveTestVersion(id, 'browse', 'original', 'code here');
    const t = (await app.inject(`/api/sites/${id}/tests/browse`)).json();
    expect(t.code).toBe('code here');
    expect(t.versions[0].name).toBe('original');
    fs.mkdirSync(path.join(store.siteDir(id), 'screenshots/r1'), { recursive: true });
    fs.writeFileSync(path.join(store.siteDir(id), 'screenshots/r1/a.png'), 'png');
    expect((await app.inject(`/api/sites/${id}/files/screenshots/r1/a.png`)).statusCode).toBe(200);
    for (const bad of ['screenshots/../../../../etc/passwd', '%2e%2e/%2e%2e/secret', 'tests/_support.ts', 'screenshots/..%2f..%2fsite.json']) {
      const r = await app.inject(`/api/sites/${id}/files/${bad}`);
      expect([400, 403, 404]).toContain(r.statusCode);
    }
    expect((await app.inject('/api/sites/..%2f..%2fetc/journeys')).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject('/api/sites/not-a-site')).statusCode).toBe(404);
  });

  it('rejects DNS-rebinding requests: Host not in allowlist (even when Origin matches Host)', async () => {
    const rebound = { origin: 'http://attacker.com:4173', host: 'attacker.com:4173' };
    expect((await app.inject({ method: 'GET', url: '/api/sites', headers: { host: 'attacker.com:4173' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: rebound, payload: { action: 'run', url: fx.url } })).statusCode).toBe(403);
    for (const host of ['localhost:4173', '127.0.0.1:4173', '[::1]:4173']) {
      expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode).toBe(200);
    }
  });

  it('allows an explicitly configured host', async () => {
    const custom = await buildApp({ config: resolveConfig({ cli: { dataDir } }), webDir: path.join(dataDir, 'no-web'), host: 'my-box.lan' });
    expect((await custom.inject({ method: 'GET', url: '/api/health', headers: { host: 'my-box.lan:4173' } })).statusCode).toBe(200);
    expect((await custom.inject({ method: 'GET', url: '/api/health', headers: { host: 'other.lan:4173' } })).statusCode).toBe(403);
    await custom.close();
  });

  it('requires application/json on mutating requests (blocks simple cross-site form posts)', async () => {
    const body = JSON.stringify({ action: 'run', url: 'http://ct.test' });
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const r = await app.inject({ method: 'POST', url: '/api/jobs', headers: ct ? { 'content-type': ct } : {}, payload: body });
      expect([403, 415]).toContain(r.statusCode);
    }
    expect((await app.inject({ method: 'POST', url: '/api/jobs', headers: { 'content-type': 'application/json' }, payload: body })).statusCode).toBe(202);
  });

  it('rejects cross-origin mutating requests', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/jobs', headers: { origin: 'http://evil.example', host: 'localhost:4173' }, payload: { action: 'run', url: fx.url } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/jobs', headers: { origin: 'http://localhost:4173', host: 'localhost:4173' }, payload: { action: 'run', url: 'http://same-origin-ok.test' } });
    expect(ok.statusCode).toBe(202);
  });

  it('SPEC-002 AC-8: GET /api/models returns the per-provider catalog', async () => {
    const b = await app.inject('/api/models?provider=bedrock');
    expect(b.statusCode).toBe(200);
    expect(b.json().provider).toBe('bedrock');
    expect(b.json().models.map((m: { id: string }) => m.id)).toContain('global.anthropic.claude-sonnet-5-5');
    expect((await app.inject('/api/models?provider=nope')).statusCode).toBe(400);
    const d = (await app.inject('/api/models')).json();
    expect(d.provider).toBe('anthropic');
    expect(d.models.map((m: { id: string }) => m.id)).toContain('claude-sonnet-5-5');
  });

  it('SPEC-002 AC-15/16: provider is a job option, awsRegion is not; config exposes provider only', async () => {
    const c = (await app.inject('/api/config')).json();
    expect(c.provider).toBe('anthropic');
    expect(c.awsRegion).toBeUndefined();
    const post = (options: unknown) => app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://spec2.test', options } });
    expect((await post({ provider: 'bedrock', model: 'anthropic.claude-opus-5-5' })).statusCode).toBe(202);
    expect((await post({ awsRegion: 'us-east-1' })).statusCode).toBe(400);
  });

  describe('SPEC-003 AWS profiles', () => {
    let pApp: FastifyInstance;
    beforeAll(async () => {
      const env = fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS);
      pApp = await buildApp({ config: resolveConfig({ cli: { dataDir, provider: 'bedrock', awsRegion: 'us-east-1', awsProfile: 'dev' } }), awsEnv: env, webDir: path.join(dataDir, 'no-web') });
    });
    afterAll(async () => { await pApp.close(); });

    it('AC-12: GET /api/aws-profiles lists profile names and the configured one', async () => {
      const r = await pApp.inject('/api/aws-profiles');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ profiles: ['ci', 'default', 'dev', 'weird-region'], selected: 'dev' });
      expect(r.body).not.toMatch(/SUPERSECRET|AKIA/);
    });

    it('AC-14: /api/config exposes awsProfile (not awsRegion) and round-trips as job options', async () => {
      const c = (await pApp.inject('/api/config')).json();
      expect(c.awsProfile).toBe('dev');
      expect(c.awsRegion).toBeUndefined();
      const res = await pApp.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://spec3-roundtrip.test', options: c } });
      expect(res.statusCode).toBe(202);
    });

    it('AC-13: job awsProfile must be a known profile; awsRegion still rejected', async () => {
      const post = (options: unknown) => pApp.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://spec3.test', options } });
      expect((await post({ provider: 'bedrock', awsProfile: 'ci' })).statusCode).toBe(202);
      const bad = await post({ awsProfile: 'ghost' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/ghost/);
      expect((await post({ awsProfile: 'x; evil' })).statusCode).toBe(400);
      expect((await post({ awsRegion: 'us-east-1' })).statusCode).toBe(400);
    });

    it('AC-15: null clears the configured profile; unknown profile ignored for anthropic', async () => {
      const base = resolveConfig({ cli: { dataDir, provider: 'bedrock', awsRegion: 'us-east-1', awsProfile: 'dev' } });
      expect(mergeJobConfig(base, { awsProfile: null }).awsProfile).toBeUndefined();
      expect(mergeJobConfig(base, { awsProfile: 'ci' }).awsProfile).toBe('ci');
      expect(mergeJobConfig(base, {}).awsProfile).toBe('dev');
      expect(parseJobRequest({ action: 'run', url: 'http://x.test', options: { awsProfile: null } }).options).toEqual({ awsProfile: null });
      const post = (options: unknown) => pApp.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'run', url: 'http://spec3-null.test', options } });
      expect((await post({ awsProfile: null })).statusCode).toBe(202);
      expect((await post({ provider: 'anthropic', awsProfile: 'ghost' })).statusCode).toBe(202);
    });

    it('selected is omitted when no profile is configured', async () => {
      const r = (await app.inject('/api/aws-profiles')).json();
      expect(r.selected).toBeUndefined();
      expect(Array.isArray(r.profiles)).toBe(true);
    });
  });
});
