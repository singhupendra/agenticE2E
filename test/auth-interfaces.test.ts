import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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

describe('credentials errors never leak paths or env var names through the API (PR #10 review)', () => {
  const secretVar = 'E2E_TOTALLY_PRIVATE_VAR_NAME';
  async function appFor(credentialsFile: string) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-leak-'));
    const config = resolveConfig({ cli: { dataDir, credentialsFile } });
    return buildApp({ config, llm: new MockLLM(() => ({})), webDir: path.join(dataDir, 'no-web') });
  }
  const brokenFiles = (): Record<string, string> => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-leak-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const tracked = writeCreds({ 'a.test': { users: { u: { username: 'uuu', password: 'ppp-ppp' } } } }, { dir: repo });
    execFileSync('git', ['add', 'credentials.json'], { cwd: repo });
    return {
      missing: path.join(os.tmpdir(), 'leak-check-dir-missing', 'credentials.json'),
      tracked,
      badJson: writeCreds('{ nope', { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-dir-json-')) }),
      envVar: writeCreds({ 'a.test': { users: { u: { username: `\${${secretVar}}`, password: 'ppp-ppp' } } } }, { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-dir-env-')) }),
      badShape: writeCreds({ 'a.test': { users: {} } }, { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-dir-shape-')) }),
    };
  };
  const leaks = (body: string, file: string) => [file, path.dirname(file), secretVar, 'git rm --cached'].filter((x) => body.includes(x));

  it.each(['missing', 'tracked', 'badJson', 'envVar', 'badShape'])('GET /api/auth (%s): generic error, no path / env var name', async (kind) => {
    const file = brokenFiles()[kind];
    const app = await appFor(file);
    const res = await app.inject(`/api/auth?url=${encodeURIComponent('https://a.test')}`);
    expect(res.json()).toMatchObject({ configured: false, users: [], error: 'credentials file could not be loaded' });
    expect(leaks(res.body, file)).toEqual([]);
    await app.close();
  });

  it.each(['missing', 'tracked', 'badJson', 'envVar', 'badShape'])('POST /api/jobs auth (%s): 400 with a generic message, no path / env var name', async (kind) => {
    const file = brokenFiles()[kind];
    const app = await appFor(file);
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: 'https://a.test', options: { auth: true } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('credentials file could not be loaded');
    expect(leaks(res.body, file)).toEqual([]);
    await app.close();
  });

  it('selection errors stay informative (names only) and path-free', async () => {
    const file = writeCreds(fixtureCreds('a.test'));
    const app = await appFor(file);
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: 'https://a.test', options: { auth: true, authUser: 'ghost' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown user.*ghost.*member/i);
    const noSite = await app.inject({ method: 'POST', url: '/api/jobs', payload: { action: 'discover', url: 'https://other.test', options: { auth: true } } });
    expect(noSite.statusCode).toBe(400);
    expect(leaks(res.body + noSite.body, file)).toEqual([]);
    await app.close();
  });

  it('the server logs the detail to stderr instead', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = brokenFiles().missing;
    const app = await appFor(file);
    await app.inject(`/api/auth?url=${encodeURIComponent('https://a.test')}`);
    expect(spy.mock.calls.flat().join(' ')).toContain(file);
    spy.mockRestore();
    await app.close();
  });

  it('the chmod warning emitted through progress (SSE) does not contain the path', async () => {
    const { createContext } = await import('../src/core/pipeline.js');
    const file = writeCreds(fixtureCreds('a.test'), { mode: 0o644 });
    const events: { message: string }[] = [];
    createContext({ config: resolveConfig({ cli: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'x-')), credentialsFile: file, auth: true } }), onProgress: (e) => events.push(e) });
    const warn = events.find((e) => /chmod 600/.test(e.message));
    expect(warn).toBeDefined();
    expect(warn!.message).not.toContain(file);
    expect(warn!.message).not.toContain(path.dirname(file));
  });
});
