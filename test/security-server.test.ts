import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { startServer } from '../src/server/index.js';
import { getLifecycle, Lifecycle } from '../src/server/lifecycle.js';
import { resolveConfig, type Config } from '../src/core/config.js';
import { serverSchema } from '../src/core/security/server-config.js';
import { generateToken, hashToken, TokenRegistry } from '../src/core/security/tokens.js';
import { FilesystemBackend } from '../src/core/storage/filesystem.js';
import type { StorageBackend } from '../src/core/storage/backend.js';
import { main } from '../src/cli/index.js';

const T = { viewer: generateToken(), operator: generateToken(), admin: generateToken() };
const registry = new TokenRegistry(
  Object.entries(T).map(([role, t]) => ({ name: `${role}-user`, role: role as 'viewer', hash: hashToken(t) })),
);
const bearer = (role: keyof typeof T) => ({ authorization: `Bearer ${T[role]}` });
const json = { 'content-type': 'application/json' };

let dataDir: string;
const cfg = (server: Record<string, unknown> = {}): Config =>
  resolveConfig({ cli: { dataDir, server: serverSchema.parse(server) } });
const noWeb = () => path.join(dataDir, 'no-web');
/** Wait until every job the app started has finished, so no job outlives its test or the app (deterministic teardown). */
async function settle(app: FastifyInstance, timeoutMs = 30_000) {
  const lc = getLifecycle(app);
  const deadline = Date.now() + timeoutMs;
  while (lc.activeJobs() > 0) {
    if (Date.now() > deadline) throw new Error(`${lc.activeJobs()} job(s) still running after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
});

describe('SPEC-014 roles & tokens', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ config: cfg(), webDir: noWeb(), auth: { mode: 'tokens', tokens: registry } });
  });
  afterAll(async () => {
    await settle(app);
    await app.close();
  });

  it('AC-9: missing or invalid token → 401 with WWW-Authenticate, no echo', async () => {
    const none = await app.inject('/api/sites');
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    const bad = 'ae2e_' + 'x'.repeat(43);
    const res = await app.inject({ url: '/api/sites', headers: { authorization: `Bearer ${bad}` } });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(bad);
    expect((await app.inject({ url: '/api/sites', headers: { authorization: `Basic ${T.admin}` } })).statusCode).toBe(
      401,
    );
  });

  it('AC-9: percent-encoded paths cannot bypass auth (routing decodes, auth must too)', async () => {
    for (const url of ['/%61pi/sites', '/%61%70%69/sites', '/api/%73ites', '/%61pi/config']) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    const post = await app.inject({
      method: 'POST',
      url: '/%61pi/jobs',
      headers: json,
      payload: { action: 'discover', url: 'http://roundtrip.test' },
    });
    expect(post.statusCode).toBe(401);
    const op = await app.inject({
      method: 'POST',
      url: '/%61pi/jobs',
      headers: { ...bearer('operator'), ...json },
      payload: { action: 'discover', url: 'http://roundtrip.test' },
    });
    expect(op.statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: '/%61pi/sites/example.com/journeys',
      headers: { ...bearer('viewer'), ...json },
      payload: [],
    });
    expect(put.statusCode).toBe(403);
  });

  it('AC-9: with the web UI mounted, the UI is public but encoded API paths still need auth', async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>ui</title>');
    const withUi = await buildApp({ config: cfg(), webDir: web, auth: { mode: 'tokens', tokens: registry } });
    expect((await withUi.inject('/')).statusCode).toBe(200);
    expect((await withUi.inject('/some/spa/route')).statusCode).toBe(200);
    expect((await withUi.inject('/%61pi/sites')).statusCode).toBe(401);
    expect(
      (
        await withUi.inject({
          method: 'POST',
          url: '/%61pi/jobs',
          headers: json,
          payload: { action: 'run', url: 'http://a.test' },
        })
      ).statusCode,
    ).toBe(401);
    expect((await withUi.inject('/api/nope')).statusCode).toBe(404);
    await withUi.close();
  });

  it('AC-11: health, readiness, session status and UI paths are public', async () => {
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    const s = await app.inject('/api/session');
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ authRequired: true, authenticated: false });
    expect((await app.inject('/some/ui/route')).statusCode).not.toBe(401);
  });

  it('AC-6: viewer can read but not run', async () => {
    expect((await app.inject({ url: '/api/sites', headers: bearer('viewer') })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/config', headers: bearer('viewer') })).json().server).toBeUndefined();
    const r = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...bearer('viewer'), ...json },
      payload: { action: 'run', url: 'http://roundtrip.test' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/operator/);
  });

  it('AC-7: operator can run/heal with unchanged settings, but not discover, change settings or edit journeys', async () => {
    const options = (await app.inject({ url: '/api/config', headers: bearer('operator') })).json();
    const run = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...bearer('operator'), ...json },
      payload: { action: 'run', url: 'http://roundtrip.test', options: { ...options, screenshots: 'off' } },
    });
    expect(run.statusCode).toBe(202);
    const disc = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...bearer('operator'), ...json },
      payload: { action: 'discover', url: 'http://roundtrip.test' },
    });
    expect(disc.statusCode).toBe(403);
    expect(disc.json().error).toMatch(/admin/);
    const model = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...bearer('operator'), ...json },
      payload: { action: 'heal', url: 'http://roundtrip.test', options: { model: 'some-other-model' } },
    });
    expect(model.statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/sites/example.com/journeys',
      headers: { ...bearer('operator'), ...json },
      payload: [],
    });
    expect(put.statusCode).toBe(403);
    await settle(app);
  });

  it('AC-7: operator may pick SPEC-011/012 run-time options (browsers, env, tags, retries…) but not report paths', async () => {
    let n = 0; // distinct sites, so started jobs never collide (409)
    const run = (options: Record<string, unknown>, role: keyof typeof T = 'operator') =>
      app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { ...bearer(role), ...json },
        payload: { action: 'run', url: `http://opt-${n++}.test`, options },
      });
    for (const o of [
      { browsers: ['firefox'] },
      { devices: ['iPhone 15'] },
      { workers: 4 },
      { shard: '1/2' },
      { grep: 'checkout' },
      { tag: ['smoke'] },
      { trace: 'on' },
      { video: 'on' },
      { retries: 2 },
      { globalTimeoutMs: 1000 },
    ]) {
      expect((await run(o)).statusCode, JSON.stringify(o)).toBe(202);
    }
    expect((await run({ reportDir: '/tmp/x' })).statusCode).toBe(403);
    expect((await run({ reportDir: '/tmp/x' }, 'admin')).statusCode).toBe(202);
    await settle(app);
  });

  it('AC-7: operator round-trips the UI settings (/api/config) with environments configured', async () => {
    const config = resolveConfig({
      cli: {
        dataDir,
        server: serverSchema.parse({}),
        environments: { staging: { baseUrl: 'https://s.test', headers: { 'X-Secret': 'super-secret-value' } } },
      } as never,
    });
    const envApp = await buildApp({ config, webDir: noWeb(), auth: { mode: 'tokens', tokens: registry } });
    try {
      const options = (await envApp.inject({ url: '/api/config', headers: bearer('operator') })).json();
      expect(options.environments).toBeDefined();
      expect(JSON.stringify(options)).not.toContain('super-secret-value');
      const run = await envApp.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { ...bearer('operator'), ...json },
        payload: { action: 'run', url: 'http://env-roundtrip.test', options },
      });
      expect(run.statusCode, run.body).toBe(202);
      const heal = await envApp.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { ...bearer('operator'), ...json },
        payload: { action: 'heal', url: 'http://env-roundtrip-2.test', options: { ...options, env: 'staging' } },
      });
      expect(heal.statusCode, heal.body).toBe(202);
      // a forged environments object is ignored by the job (server-only) and does not need admin
      const forged = await envApp.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: { ...bearer('operator'), ...json },
        payload: {
          action: 'run',
          url: 'http://env-roundtrip-3.test',
          options: { environments: { evil: { baseUrl: 'https://evil.test' } } },
        },
      });
      expect(forged.statusCode).toBe(202);
      // invalid requests never run: the handler rejects them (400) after authorisation by action
      expect(
        (
          await envApp.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { ...bearer('operator'), ...json },
            payload: { action: 'run', url: 'ftp://x', options: { model: 'other' } },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await envApp.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { ...bearer('operator'), ...json },
            payload: { action: 'run', url: 'http://env-roundtrip-4.test', options: { model: 'other' } },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await settle(envApp);
      await envApp.close();
    }
  });

  it('AC-8: admin passes authorisation for discover and journey edits', async () => {
    const disc = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { ...bearer('admin'), ...json },
      payload: { action: 'discover', url: 'ftp://invalid' },
    });
    expect(disc.statusCode).toBe(400); // reached the handler
    const put = await app.inject({
      method: 'PUT',
      url: '/api/sites/unknown.test/journeys',
      headers: { ...bearer('admin'), ...json },
      payload: [],
    });
    expect(put.statusCode).toBe(404);
  });

  it('AC-10: session cookie login, status, use and logout', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: json,
      payload: { token: T.operator },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ authRequired: true, authenticated: true, name: 'operator-user', role: 'operator' });
    expect(login.body).not.toContain(T.operator);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/^ae2e_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toMatch(/Secure/);
    const cookie = setCookie.split(';')[0];
    expect((await app.inject({ url: '/api/sites', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toMatchObject({
      authenticated: true,
      role: 'operator',
    });
    const out = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie, ...json }, payload: {} });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: '/api/sites', headers: { cookie } })).statusCode).toBe(401);
  });

  it('session login also accepts the Bearer header; bad tokens are 401', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/session',
          headers: { ...bearer('viewer'), ...json },
          payload: {},
        })
      ).json().role,
    ).toBe('viewer');
    expect(
      (await app.inject({ method: 'POST', url: '/api/session', headers: json, payload: { token: 'nope' } })).statusCode,
    ).toBe(401);
  });

  it('sets Secure on the cookie over https (x-forwarded-proto only with trustProxy)', async () => {
    const proxied = await buildApp({
      config: cfg({ trustProxy: true }),
      webDir: noWeb(),
      auth: { mode: 'tokens', tokens: registry },
    });
    const r = await proxied.inject({
      method: 'POST',
      url: '/api/session',
      headers: { ...json, 'x-forwarded-proto': 'https' },
      payload: { token: T.viewer },
    });
    expect(String(r.headers['set-cookie'])).toMatch(/Secure/);
    await proxied.close();
  });
});

describe('SPEC-014 modes', () => {
  const env = {};
  it('AC-12: refuses to start without tokens unless --insecure-local', async () => {
    await expect(startServer({ config: cfg(), port: 0, env })).rejects.toThrow(
      /--insecure-local[\s\S]*token create|token create[\s\S]*--insecure-local/,
    );
  });

  it('AC-13: insecure-local is loopback-only and treats requests as admin', async () => {
    await expect(startServer({ config: cfg(), port: 0, host: '0.0.0.0', insecureLocal: true, env })).rejects.toThrow(
      /loopback/,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await startServer({ config: cfg(), port: 0, host: '127.0.0.1', insecureLocal: true, env });
    try {
      expect(warn).toHaveBeenCalled();
      expect(await (await fetch(`${s.url}/api/session`)).json()).toEqual({
        authRequired: false,
        authenticated: true,
        name: 'local',
        role: 'admin',
      });
      expect((await fetch(`${s.url}/api/sites`)).status).toBe(200);
    } finally {
      await s.close();
      warn.mockRestore();
    }
  });

  it('starts with tokens from the environment and enforces them', async () => {
    const s = await startServer({
      config: cfg(),
      port: 0,
      env: { AGENTIC_E2E_API_TOKENS: `v:viewer:${hashToken(T.viewer)}` },
    });
    try {
      expect((await fetch(`${s.url}/api/sites`)).status).toBe(401);
      expect((await fetch(`${s.url}/api/sites`, { headers: bearer('viewer') })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('AC-14: buildApp without auth only allowed on loopback', async () => {
    await expect(buildApp({ config: cfg(), webDir: noWeb(), host: '0.0.0.0' })).rejects.toThrow(/auth/);
    const app = await buildApp({ config: cfg(), webDir: noWeb() });
    expect((await app.inject('/api/sites')).statusCode).toBe(200);
    await app.close();
  });
});

describe('SPEC-014 hardening', () => {
  it('AC-15: security headers on API and health responses', async () => {
    const app = await buildApp({ config: cfg(), webDir: noWeb() });
    for (const url of ['/api/sites', '/healthz']) {
      const r = await app.inject(url);
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['strict-transport-security']).toBeUndefined();
    }
    await app.close();
  });

  it('AC-16: global and login rate limits; health endpoints exempt', async () => {
    const app = await buildApp({
      config: cfg({ rateLimit: { max: 3, timeWindowMs: 60_000, loginMax: 2 } }),
      webDir: noWeb(),
      auth: { mode: 'tokens', tokens: registry },
    });
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push((await app.inject({ url: '/api/sites', headers: bearer('viewer') })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    for (let i = 0; i < 5; i++) expect((await app.inject('/healthz')).statusCode).toBe(200);
    await app.close();
    const app2 = await buildApp({
      config: cfg({ rateLimit: { max: 100, timeWindowMs: 60_000, loginMax: 2 } }),
      webDir: noWeb(),
      auth: { mode: 'tokens', tokens: registry },
    });
    const login = () =>
      app2.inject({ method: 'POST', url: '/api/session', headers: json, payload: { token: 'wrong' } });
    expect([(await login()).statusCode, (await login()).statusCode, (await login()).statusCode]).toEqual([
      401, 401, 429,
    ]);
    expect(
      (await app2.inject({ method: 'POST', url: '/%61pi/session', headers: json, payload: { token: 'wrong' } }))
        .statusCode,
    ).toBe(429);
    await app2.close();
  });

  it('AC-17: request body size limit', async () => {
    const app = await buildApp({ config: cfg({ bodyLimitBytes: 1024 }), webDir: noWeb() });
    const r = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: json,
      payload: JSON.stringify({ action: 'run', url: 'http://a.test', pad: 'x'.repeat(2048) }),
    });
    expect(r.statusCode).toBe(413);
    await app.close();
  });

  it('AC-18: existing Host / content-type protections kept; allowedHosts extends the allowlist', async () => {
    const app = await buildApp({ config: cfg({ allowedHosts: ['e2e.example.com'] }), webDir: noWeb() });
    expect((await app.inject({ url: '/api/sites', headers: { host: 'evil.test' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/sites', headers: { host: 'e2e.example.com' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/sites', headers: { host: 'e2e.example.com:8443' } })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/jobs', headers: { 'content-type': 'text/plain' }, payload: '{}' }))
        .statusCode,
    ).toBe(415);
    await app.close();
  });
});

describe('SPEC-014 health & lifecycle', () => {
  it('AC-19: healthz/readyz, draining, storage failure', async () => {
    const app = await buildApp({ config: cfg(), webDir: noWeb() });
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/readyz')).json()).toEqual({ status: 'ready' });
    getLifecycle(app).startDraining();
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'draining' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/jobs',
          headers: json,
          payload: { action: 'run', url: 'http://a.test' },
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/%61pi/jobs',
          headers: json,
          payload: { action: 'run', url: 'http://a.test' },
        })
      ).statusCode,
    ).toBe(503);
    await app.close();

    const broken: StorageBackend = Object.assign(new FilesystemBackend(dataDir), {
      healthCheck: async () => {
        throw new Error(`EACCES ${dataDir}`);
      },
    });
    const app2 = await buildApp({ config: cfg(), webDir: noWeb(), storage: broken });
    const u = await app2.inject('/readyz');
    expect(u.statusCode).toBe(503);
    expect(u.json()).toEqual({ status: 'unavailable' });
    expect(u.body).not.toContain(dataDir);
    await app2.close();
  });

  it('serves site files through the storage backend', async () => {
    const site = path.join(dataDir, 'sites', 'files.test');
    fs.mkdirSync(path.join(site, 'screenshots', 'r1'), { recursive: true });
    fs.writeFileSync(
      path.join(site, 'site.json'),
      JSON.stringify({ id: 'files.test', origin: 'http://files.test', url: 'http://files.test' }),
    );
    fs.writeFileSync(path.join(site, 'screenshots', 'r1', 'a.png'), Buffer.from([1, 2, 3]));
    const app = await buildApp({ config: cfg(), webDir: noWeb() });
    const r = await app.inject('/api/sites/files.test/files/screenshots/r1/a.png');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect((await app.inject('/api/sites/files.test/files/screenshots/r1/none.png')).statusCode).toBe(404);
    expect((await app.inject('/api/sites/files.test/files/screenshots/..%2f..%2fsite.json')).statusCode).toBe(403);
    await app.close();
  });

  it('AC-20: shutdown waits for running jobs, then closes (bounded by timeout)', async () => {
    let active = 1;
    const close = vi.fn(async () => {});
    const lc = new Lifecycle({ activeJobs: () => active, pollMs: 5 });
    lc.onClose(close);
    const done = lc.shutdown(1000);
    await new Promise((r) => setTimeout(r, 30));
    expect(lc.draining).toBe(true);
    expect(close).not.toHaveBeenCalled();
    active = 0;
    await done;
    expect(close).toHaveBeenCalledTimes(1);

    const stuck = new Lifecycle({ activeJobs: () => 1, pollMs: 5 });
    const close2 = vi.fn(async () => {});
    stuck.onClose(close2);
    const t0 = Date.now();
    expect(await stuck.shutdown(50)).toEqual({ timedOut: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(close2).toHaveBeenCalled();
  });
});

describe('SPEC-014 token CLI', () => {
  let dir: string, out: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokcli-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      out.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('token create --file stores only the hash (0600) and prints the token once', async () => {
    const f = path.join(dir, 'tokens.json');
    expect(
      await main(['node', 'agentic-e2e', 'token', 'create', '--name', 'ci', '--role', 'operator', '--file', f]),
    ).toBe(0);
    const token = out.join('\n').match(/ae2e_[A-Za-z0-9_-]{43}/)![0];
    const stored = fs.readFileSync(f, 'utf8');
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored).tokens).toEqual([{ name: 'ci', role: 'operator', hash: hashToken(token) }]);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(TokenRegistry.fromSources({ file: f }).verify(token)?.role).toBe('operator');
    out.length = 0;
    expect(await main(['node', 'agentic-e2e', 'token', 'list', '--file', f])).toBe(0);
    expect(out.join('\n')).toMatch(/ci\s+operator/);
    expect(out.join('\n')).not.toMatch(/sha256/);
    expect(await main(['node', 'agentic-e2e', 'token', 'create', '--name', 'ci', '--role', 'admin', '--file', f])).toBe(
      1,
    );
  });

  it('token create without --file prints an env line with the hash', async () => {
    expect(await main(['node', 'agentic-e2e', 'token', 'create', '--name', 'ci', '--role', 'viewer'])).toBe(0);
    const text = out.join('\n');
    const token = text.match(/ae2e_[A-Za-z0-9_-]{43}/)![0];
    expect(text).toContain(`AGENTIC_E2E_API_TOKENS=ci:viewer:${hashToken(token)}`);
    expect(await main(['node', 'agentic-e2e', 'token', 'create', '--name', 'ci', '--role', 'root'])).toBe(1);
  });
});
