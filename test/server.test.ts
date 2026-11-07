import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { resolveConfig } from '../src/core/config.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { Store } from '../src/core/storage.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';

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

  it('rejects cross-origin mutating requests', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/jobs', headers: { origin: 'http://evil.example', host: 'localhost:4173' }, payload: { action: 'run', url: fx.url } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/jobs', headers: { origin: 'http://localhost:4173', host: 'localhost:4173' }, payload: { action: 'run', url: 'http://same-origin-ok.test' } });
    expect(ok.statusCode).toBe(202);
  });
});
