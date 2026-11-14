import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { main } from '../src/cli/index.js';
import { resolveConfig } from '../src/core/config.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { Store, normalizeSite } from '../src/core/storage.js';
import { buildApp } from '../src/server/app.js';
import { parseJobRequest } from '../src/server/jobs.js';
import { startFixtureSite, FIXTURE_PASSWORD, FIXTURE_USER, type Fixture } from './helpers/fixture-site.js';
import { fixtureCreds, writeCreds } from './helpers/credentials.js';

let fx: Fixture;
let host = '';
beforeAll(async () => { fx = await startFixtureSite(); host = normalizeSite(fx.url).id; });
afterAll(async () => { await fx.close(); });

describe('server (AC-20)', () => {
  let app: FastifyInstance, dataDir: string, store: Store;
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-srv-'));
    const credentialsFile = writeCreds(fixtureCreds(host));
    const config = resolveConfig({ cli: { dataDir, credentialsFile, maxPages: 3, maxDepth: 1 } });
    const llm = new MockLLM((req) => (req.name === 'propose_journeys' ? { journeys: [{ name: 'Browse', goal: 'g', priority: 'high', steps: ['open'] }] } : { ranked: [{ id: 'browse', rationale: 'r' }] }));
    app = await buildApp({ config, llm, webDir: path.join(dataDir, 'no-web') });
    store = new Store(dataDir);
  });
  afterAll(async () => { await app.close(); });

  it('GET /api/auth returns configured + user names only', async () => {
    const res = await app.inject(`/api/auth?url=${encodeURIComponent(fx.url)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: true, users: ['member'] });
    expect(res.body).not.toContain(FIXTURE_PASSWORD);
    expect(res.body).not.toContain(FIXTURE_USER);
    const none = await app.inject(`/api/auth?url=${encodeURIComponent('https://unknown.example.com')}`);
    expect(none.json()).toEqual({ configured: false, users: [] });
    expect((await app.inject('/api/auth?url=ftp://x')).statusCode).toBe(400);
    expect((await app.inject('/api/auth')).statusCode).toBe(400);
  });

  it('/api/config never exposes the credentials file', async () => {
    const c = (await app.inject('/api/config')).json();
    expect(JSON.stringify(c)).not.toMatch(/credentials/i);
    expect(c.auth).toBe(false);
  });

  it('jobs accept auth/authUser but never a credentials path', () => {
    expect(parseJobRequest({ action: 'run', url: fx.url, options: { auth: true, authUser: 'member' } }).options).toEqual({ auth: true, authUser: 'member' });
    expect(() => parseJobRequest({ action: 'run', url: fx.url, options: { credentialsFile: '/etc/passwd' } })).toThrow(/Invalid options/);
    expect(() => parseJobRequest({ action: 'run', url: fx.url, options: { authUser: '../../x' } })).toThrow(/Invalid options/);
  });

  it('a job with auth for an unconfigured user is rejected up front, naming no secrets', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: fx.url, options: { auth: true, authUser: 'ghost' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown user/i);
    expect(res.body).not.toContain(FIXTURE_PASSWORD);
  });

  it('storageState / auth files are never served', async () => {
    store.saveSite({ id: host, origin: fx.url, url: fx.url });
    fs.mkdirSync(path.join(store.siteDir(host), 'auth'), { recursive: true });
    fs.writeFileSync(path.join(store.siteDir(host), 'auth', 'member.json'), '{"cookies":[]}');
    expect((await app.inject(`/api/sites/${host}/files/auth/member.json`)).statusCode).toBe(403);
  });

  it('job events and results never contain the secrets (auth discover job)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: fx.url + '/account', options: { auth: true, screenshots: 'off' } } });
    expect(res.statusCode).toBe(202);
    const ev = await app.inject(`/api/jobs/${res.json().jobId}/events`);
    expect(ev.body).not.toContain(FIXTURE_PASSWORD);
    expect(ev.body).not.toContain(FIXTURE_USER);
    expect(ev.body).toContain('"type":"done"');
    const job = (await app.inject(`/api/jobs/${res.json().jobId}`)).json();
    expect(job.status).toBe('done');
  }, 60_000);
});

describe('cli (AC-21)', () => {
  let dir: string, out: string[], err: string[], credentialsFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-'));
    credentialsFile = writeCreds(fixtureCreds(host));
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  });
  afterEach(() => vi.restoreAllMocks());
  const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);

  it('auth-check logs in, saves the session and prints no secret', async () => {
    expect(await cli('auth-check', fx.url, '--credentials', credentialsFile, '--user', 'member')).toBe(0);
    const text = out.join('\n') + err.join('\n');
    expect(text).toMatch(/login ok/i);
    expect(text).not.toContain(FIXTURE_PASSWORD);
    expect(text).not.toContain(FIXTURE_USER);
    expect(fs.existsSync(path.join(dir, 'sites', host, 'auth', 'member.json'))).toBe(true);
  }, 60_000);

  it('auth-check fails with a clear message for an unknown user', async () => {
    expect(await cli('auth-check', fx.url, '--credentials', credentialsFile, '--user', 'ghost')).toBe(1);
    expect(err.join('\n')).toMatch(/unknown user.*ghost.*member/i);
  });

  it('refuses a missing explicit credentials file', async () => {
    expect(await cli('auth-check', fx.url, '--credentials', path.join(dir, 'nope.json'))).toBe(1);
    expect(err.join('\n')).toMatch(/not found/i);
  });

  it.each(['discover', 'generate', 'run', 'heal', 'all'])('%s accepts --auth --user --credentials', async (cmd) => {
    // an unknown user must fail fast (before any crawl / LLM call), proving the flags are wired through
    expect(await cli(cmd, fx.url, '--auth', '--user', 'ghost', '--credentials', credentialsFile)).toBe(1);
    expect(err.join('\n')).toMatch(/unknown user.*ghost/i);
  });

  it('list-test-cases shows the AUTH column and json fields', async () => {
    const s = new Store(dir);
    s.saveSite({ id: 'a.test', origin: 'https://a.test', url: 'https://a.test' });
    s.saveJourneys('a.test', [
      { id: 'acct', name: 'Account', goal: 'g', priority: 'high', tags: [], steps: ['x'], status: 'selected', requiresAuth: true, user: 'member' },
      { id: 'home', name: 'Home', goal: 'g', priority: 'high', tags: [], steps: ['x'], status: 'selected' },
    ]);
    s.saveTest('a.test', 'acct', 'x'); s.saveTest('a.test', 'home', 'x');
    expect(await cli('list-test-cases', 'https://a.test')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/AUTH/);
    expect(text).toMatch(/acct.*member/);
    out.length = 0;
    expect(await cli('list-test-cases', 'https://a.test', '--json')).toBe(0);
    const j = JSON.parse(out.join('\n'));
    expect(j.tests.find((t: { journeyId: string }) => t.journeyId === 'acct')).toMatchObject({ requiresAuth: true, user: 'member' });
  });
});
