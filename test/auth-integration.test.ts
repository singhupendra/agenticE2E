import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLM } from '../src/core/llm/mock.js';
import { resolveConfig } from '../src/core/config.js';
import { Store, normalizeSite } from '../src/core/storage.js';
import { createContext, discover, generate, run, runAll } from '../src/core/pipeline.js';
import { listTestCases } from '../src/core/test-cases.js';
import type { ProgressEvent } from '../src/core/types.js';
import { startFixtureSite, FIXTURE_PASSWORD, FIXTURE_USER, type Fixture } from './helpers/fixture-site.js';
import { fixtureCreds, writeCreds } from './helpers/credentials.js';

const ACCOUNT_SPEC = `import { test, expect } from './_support';

test('view account', async ({ page, step }) => {
  await step('open account', async () => { await page.goto('/account'); });
  await expect(page.getByRole('heading', { name: 'Welcome back, Test Member' })).toBeVisible();
});
`;
const CONFIRM_SPEC = `import { test, expect } from './_support';

test('confirm password', async ({ page, step, credentials }) => {
  await step('open settings', async () => { await page.goto('/account/settings'); });
  await step('confirm', async () => {
    await page.getByLabel('Confirm password').fill(credentials.password);
    await page.getByRole('button', { name: 'Confirm' }).click();
  });
  await expect(page.getByRole('status')).toHaveText('Password confirmed');
});
`;
const PUBLIC_SPEC = `import { test, expect } from './_support';

test('public home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Fixture Shop' })).toBeVisible();
});
`;

let fx: Fixture;
let host = '';
beforeAll(async () => { fx = await startFixtureSite(); host = normalizeSite(fx.url).id; });
afterAll(async () => { await fx.close(); });

function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
}

function build(opts: { auth: boolean; leakFirst?: boolean }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-int-'));
  const credentialsFile = writeCreds(fixtureCreds(host));
  const config = resolveConfig({ cli: { dataDir, credentialsFile, auth: opts.auth, maxPages: 10, maxDepth: 2, maxJourneys: 5, healAttempts: 0, testTimeoutMs: 20_000, screenshots: 'on-failure' } });
  const events: ProgressEvent[] = [];
  let confirmAttempts = 0;
  const llm = new MockLLM((req) => {
    switch (req.name) {
      case 'propose_journeys':
        return { journeys: [
          { name: 'View account', goal: 'see the account page', priority: 'high', steps: ['open account', 'see welcome'], ...(opts.auth ? { requiresAuth: true, user: 'member' } : {}) },
          { name: 'Confirm password', goal: 'confirm identity', priority: 'medium', steps: ['open settings', 'confirm'], ...(opts.auth ? { requiresAuth: true, user: 'member' } : {}) },
          { name: 'Public home', goal: 'see home', priority: 'low', steps: ['open home'] },
        ] };
      case 'rank_journeys':
        return { ranked: [{ id: 'view-account', rationale: 'a' }, { id: 'confirm-password', rationale: 'b' }, { id: 'public-home', rationale: 'c' }] };
      case 'write_playwright_spec': {
        if (req.prompt.includes('id: confirm-password')) {
          confirmAttempts++;
          // first attempt (hostile/accidental): the LLM somehow emits the real password -> must be rejected
          return { code: opts.leakFirst && confirmAttempts === 1 ? CONFIRM_SPEC.replace('credentials.password', `'${FIXTURE_PASSWORD}'`) : CONFIRM_SPEC };
        }
        return { code: req.prompt.includes('id: view-account') ? ACCOUNT_SPEC : PUBLIC_SPEC };
      }
      default: throw new Error('unexpected ' + req.name);
    }
  });
  const ctx = createContext({ config, llm, onProgress: (e) => events.push(e) });
  return { ctx, llm, events, dataDir, config };
}

describe('authenticated journeys end to end (fixture site, mocked LLM, real Playwright) — AC-18', () => {
  const b = build({ auth: true, leakFirst: true });
  const store = new Store(b.dataDir);
  let site = '';

  it('discover (auth) → generate → run: authenticated journeys pass via storageState and the credentials fixture', async () => {
    site = normalizeSite(fx.url).id;
    const d = await discover(b.ctx, fx.url + '/account');
    expect(d.journeys.filter((j) => j.requiresAuth).map((j) => j.id).sort()).toEqual(['confirm-password', 'view-account']);
    expect(d.journeys.find((j) => j.id === 'view-account')).toMatchObject({ requiresAuth: true, user: 'member' });
    expect(d.pages!.some((p) => p.title === 'My account')).toBe(true);

    const g = await generate(b.ctx, fx.url + '/account');
    expect(g.result.generated.sort()).toEqual(['confirm-password', 'public-home', 'view-account']);
    expect(g.result.failed).toEqual([]);
    expect(b.llm.callsFor('write_playwright_spec').filter((c) => c.prompt.includes('id: confirm-password'))).toHaveLength(2); // leaky first attempt rejected

    const r = await run(b.ctx, fx.url + '/account');
    expect(r.results.map((x) => [x.journeyId, x.status]).sort()).toEqual([['confirm-password', 'passed'], ['public-home', 'passed'], ['view-account', 'passed']]);
    expect(fx.hits).not.toContain('/logout');
    expect(fx.hits).not.toContain('/account/delete');
  }, 180_000);

  it('the password and username appear nowhere under data/, in no LLM request and in no progress event', () => {
    for (const secret of [FIXTURE_PASSWORD, FIXTURE_USER, '48151623']) {
      const offenders = allFiles(b.dataDir).filter((f) => fs.readFileSync(f).includes(secret));
      expect(offenders, `files containing a secret`).toEqual([]);
      expect(b.llm.calls.filter((c) => (c.system + c.prompt).includes(secret))).toEqual([]);
      expect(JSON.stringify(b.events)).not.toContain(secret);
    }
    expect(store.loadTest(site, 'confirm-password')).toContain('credentials.password');
    // storageState exists, gitignored location, no credential values
    expect(fs.existsSync(path.join(b.dataDir, 'sites', site, 'auth', 'member.json'))).toBe(true);
  });

  it('the login page prompt really used placeholders (sanity: the planner saw the redacted username)', () => {
    const planned = b.llm.callsFor('propose_journeys')[0].prompt;
    expect(planned).not.toContain(FIXTURE_USER);
    expect(planned).toContain('{{username}}');
  });

  it('list-test-cases reports auth requirements', () => {
    const rows = listTestCases(store, site)!.tests;
    expect(rows.find((t) => t.journeyId === 'view-account')).toMatchObject({ requiresAuth: true, user: 'member' });
    expect(rows.find((t) => t.journeyId === 'public-home')!.requiresAuth).toBeFalsy();
  });

  it('a second run reuses the stored session (no new login POST)', async () => {
    const before = fx.loginPosts();
    const r = await run(b.ctx, fx.url + '/account');
    expect(r.results.every((x) => x.status === 'passed')).toBe(true);
    expect(fx.loginPosts()).toBe(before);
  }, 120_000);

  it('expired server session: the run re-logs in and still passes', async () => {
    fx.expireSessions();
    const before = fx.loginPosts();
    const r = await run(b.ctx, fx.url + '/account');
    expect(r.results.every((x) => x.status === 'passed')).toBe(true);
    expect(fx.loginPosts()).toBe(before + 1);
  }, 120_000);

  it('runAll in auth mode works too', async () => {
    const res = await runAll(b.ctx, fx.url + '/account', {});
    expect(res.final.every((f) => f.status === 'passed')).toBe(true);
  }, 180_000);
});

describe('without --auth (AC-19)', () => {
  it('authenticated journeys are not generated and are skipped on run with a warning', async () => {
    const b = build({ auth: true });
    await generate(b.ctx, fx.url + '/account'); // generate as authed first to create stored specs
    const off = resolveConfig({ cli: { dataDir: b.dataDir, auth: false, healAttempts: 0, testTimeoutMs: 20_000 } });
    const events: ProgressEvent[] = [];
    const ctx = createContext({ config: off, llm: b.llm, onProgress: (e) => events.push(e) });
    const r = await run(ctx, fx.url + '/account');
    expect(r.results.map((x) => x.journeyId)).toEqual(['public-home']);
    expect(events.some((e) => e.type === 'warn' && /requires? (a )?(log|auth)/i.test(e.message))).toBe(true);

    const c = build({ auth: true });
    await discover(c.ctx, fx.url + '/account');
    const c2cfg = resolveConfig({ cli: { dataDir: c.dataDir, auth: false } });
    const gen = await generate(createContext({ config: c2cfg, llm: c.llm }), fx.url + '/account');
    expect(gen.result.generated).toEqual(['public-home']);
  }, 240_000);
});
