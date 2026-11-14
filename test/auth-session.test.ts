import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSession, isDestructiveLink, isStateFresh } from '../src/core/auth.js';
import { resolveConfig } from '../src/core/config.js';
import { crawl } from '../src/core/discovery.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { createContext } from '../src/core/pipeline.js';
import { normalizeSite } from '../src/core/storage.js';
import { startFixtureSite, FIXTURE_PASSWORD, FIXTURE_USER, type Fixture } from './helpers/fixture-site.js';
import { fixtureCreds, writeCreds } from './helpers/credentials.js';

let fx: Fixture;
let host = '';
beforeAll(async () => { fx = await startFixtureSite(); host = normalizeSite(fx.url).id; });
afterAll(async () => { await fx.close(); });

function setup(opts: { creds?: unknown; llm?: MockLLM } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const credentialsFile = writeCreds(opts.creds ?? fixtureCreds(host));
  const config = resolveConfig({ cli: { dataDir, credentialsFile, auth: true, timeoutMs: 30_000 } });
  const ctx = createContext({ config, llm: opts.llm });
  return { ctx, dataDir };
}
const statePath = (dataDir: string) => path.join(dataDir, 'sites', host, 'auth', 'member.json');

describe('isDestructiveLink (AC-13)', () => {
  it.each([
    ['Log out', '/logout'], ['Sign out', '/x'], ['Delete account', '/account/delete'], ['Remove item', '/cart/remove/3'],
    ['Cancel subscription', '/billing/cancel'], ['Deactivate', '/a'], ['Close my account', '/a'], ['Unsubscribe', '/u'], ['ok', '/signout'], ['x', '/users/1/delete?confirm=1'],
  ])('flags %s %s', (t, h) => expect(isDestructiveLink(t, h)).toBe(true));
  it.each([['Settings', '/account/settings'], ['Orders', '/orders'], ['Deliveries', '/deliveries'], ['Blog', '/blog'], ['Cancellation policy', '/policies/cancel-info-faq']])('keeps %s', (t, h) => expect(isDestructiveLink(t, h)).toBe(false));
});

describe('isStateFresh (AC-10)', () => {
  const write = (cookies: { expires: number }[]) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), 's.json');
    fs.writeFileSync(f, JSON.stringify({ cookies: cookies.map((c, i) => ({ name: `c${i}`, value: 'v', domain: 'x', path: '/', ...c })), origins: [] }));
    return f;
  };
  it('fresh with a session cookie or a future expiry', () => {
    expect(isStateFresh(write([{ expires: -1 }]))).toBe(true);
    expect(isStateFresh(write([{ expires: Date.now() / 1000 + 3600 }]))).toBe(true);
  });
  it('stale when all cookies expired, file missing/corrupt, or older than max age', () => {
    expect(isStateFresh(write([{ expires: Date.now() / 1000 - 10 }]))).toBe(false);
    expect(isStateFresh(path.join(os.tmpdir(), 'nope-state.json'))).toBe(false);
    const bad = write([]); fs.writeFileSync(bad, 'not json');
    expect(isStateFresh(bad)).toBe(false);
    expect(isStateFresh(write([{ expires: -1 }]), { now: Date.now() + 13 * 3600_000 })).toBe(false);
  });
});

describe('ensureSession (AC-9..AC-12)', () => {
  beforeEach(() => fx.expireSessions());

  it('AC-9: logs in with hints, saves storageState with the cookie but not the password', async () => {
    const { ctx, dataDir } = setup();
    const s = await ensureSession(ctx, fx.url, { user: 'member' });
    expect(s).toMatchObject({ user: 'member', reused: false, storageState: statePath(dataDir) });
    const raw = fs.readFileSync(statePath(dataDir), 'utf8');
    expect(JSON.parse(raw).cookies.some((c: { name: string }) => c.name === 'sid')).toBe(true);
    expect(raw).not.toContain(FIXTURE_PASSWORD);
    expect(raw).not.toContain(FIXTURE_USER);
    if (process.platform !== 'win32') {
      expect(fs.statSync(statePath(dataDir)).mode & 0o077).toBe(0);
      expect(fs.statSync(path.dirname(statePath(dataDir))).mode & 0o077).toBe(0);
    }
  }, 60_000);

  it('AC-10: reuses a valid session (no second login), re-logs in after expiry or force', async () => {
    const { ctx } = setup();
    const before = fx.loginPosts();
    await ensureSession(ctx, fx.url, { user: 'member' });
    expect(fx.loginPosts()).toBe(before + 1);
    const again = await ensureSession(ctx, fx.url, { user: 'member' });
    expect(again.reused).toBe(true);
    expect(fx.loginPosts()).toBe(before + 1);
    fx.expireSessions(); // server forgets the session; checkUrl hint detects it
    const third = await ensureSession(ctx, fx.url, { user: 'member' });
    expect(third.reused).toBe(false);
    expect(fx.loginPosts()).toBe(before + 2);
    await ensureSession(ctx, fx.url, { user: 'member', force: true });
    expect(fx.loginPosts()).toBe(before + 3);
  }, 90_000);

  it('AC-11: wrong credentials throw an error that contains neither value', async () => {
    const bad = fixtureCreds(host);
    (bad[host].users.member as { password: string }).password = 'definitely-wrong-pw-1';
    const { ctx } = setup({ creds: bad });
    let msg = '';
    try { await ensureSession(ctx, fx.url, { user: 'member' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/login failed/i);
    expect(msg).not.toContain('definitely-wrong-pw-1');
    expect(msg).not.toContain(FIXTURE_USER);
  }, 60_000);

  it('errors clearly when auth is not configured for the site', async () => {
    const { ctx } = setup({ creds: { 'other.test': { users: { a: { username: 'aaa', password: 'bbb-ccc' } } } } });
    await expect(ensureSession(ctx, fx.url, {})).rejects.toThrow(/no credentials.*other|no credentials/i);
  });

  it('AC-12: without hints the LLM locates the form; its prompt has placeholders only', async () => {
    const llm = new MockLLM((req) => {
      expect(req.name).toBe('locate_login_form');
      return { usernameSelector: 'input[name=email]', passwordSelector: 'input[name=password]', submitSelector: 'button[type=submit]' };
    });
    const { ctx, dataDir } = setup({ creds: { [host]: { users: { member: { username: FIXTURE_USER, password: FIXTURE_PASSWORD } } } }, llm });
    const s = await ensureSession(ctx, fx.url, { user: 'member' });
    expect(s.reused).toBe(false);
    expect(fs.existsSync(statePath(dataDir))).toBe(true);
    const sent = llm.calls.map((c) => c.system + c.prompt).join('\n');
    expect(sent).toContain('{{username}}');
    expect(sent).toContain('{{password}}');
    expect(sent).not.toContain(FIXTURE_PASSWORD);
    expect(sent).not.toContain(FIXTURE_USER);
  }, 60_000);
});

describe('authenticated crawl (AC-13)', () => {
  it('sees protected pages, never requests logout/destructive links', async () => {
    fx.expireSessions();
    const { ctx } = setup();
    const s = await ensureSession(ctx, fx.url, { user: 'member' });
    const before = fx.hits.length;
    const pages = await crawl(fx.url + '/account', { maxPages: 10, maxDepth: 2, timeoutMs: 30_000, headless: true, storageState: s.storageState });
    const hits = fx.hits.slice(before);
    expect(pages.some((p) => p.title === 'My account')).toBe(true);
    expect(pages.some((p) => p.path === '/account/settings')).toBe(true);
    expect(hits).not.toContain('/logout');
    expect(hits).not.toContain('/account/delete');
  }, 60_000);

  it('without a session the same URL lands on the login page', async () => {
    const pages = await crawl(fx.url + '/account', { maxPages: 1, maxDepth: 0, timeoutMs: 20_000, headless: true });
    expect(pages[0].title).toBe('Login');
  }, 30_000);
});
