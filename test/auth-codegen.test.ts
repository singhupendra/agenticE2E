import { describe, it, expect } from 'vitest';
import { generateSpec } from '../src/core/codegen.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { RedactingLLM } from '../src/core/llm/redacting.js';
import { proposeJourneys } from '../src/core/planner.js';
import { Redactor } from '../src/core/redact.js';
import { SUPPORT_SOURCE } from '../src/core/support.js';
import { buildRunnerEnv } from '../src/core/runner.js';
import { validateSpec } from '../src/core/validate.js';
import type { Journey, PageModel } from '../src/core/types.js';

const PW = 'Zeta-9-pass-QX7';
const redactor = new Redactor([{ value: PW, placeholder: '{{password}}' }, { value: 'member@example.test', placeholder: '{{username}}' }]);
const journey: Journey = { id: 'confirm-pw', name: 'Confirm password', goal: 'g', priority: 'high', tags: [], steps: ['open settings'], status: 'selected', requiresAuth: true, user: 'member' };
const page: PageModel = { url: 'http://x/account', path: '/account', title: 'My account', depth: 0, headings: ['Welcome'], ariaSnapshot: '', elements: [], forms: [], navLinks: [] };
const CLEAN = `import { test, expect } from './_support';
test('confirm', async ({ page, step, credentials }) => {
  await step('open', async () => { await page.goto('/account/settings'); });
  await page.getByLabel('Confirm password').fill(credentials.password);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
`;
const LEAKY = CLEAN.replace('credentials.password', `'${PW}'`);

describe('codegen secret rejection (AC-15, AC-16)', () => {
  it('validateSpec rejects a spec with a literal credential value, reporting a line but not the value', async () => {
    const v = await validateSpec(LEAKY, { redactor });
    expect(v.ok).toBe(false);
    const msg = v.errors.join('\n');
    expect(msg).toMatch(/credential/i);
    expect(msg).toMatch(/line \d+/);
    expect(msg).not.toContain(PW);
  });
  it('validateSpec accepts the credentials fixture usage and type-checks it', async () => {
    const v = await validateSpec(CLEAN, { redactor });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  }, 30_000);
  it('generateSpec regenerates; the retry prompt never contains the value; final code is clean', async () => {
    const llm = new MockLLM((_req, i) => ({ code: i === 0 ? LEAKY : CLEAN }));
    const out = await generateSpec(llm, { journey, pages: [page], baseUrl: 'http://x' }, { retries: 2, redactor });
    expect(out.attempts).toBe(2);
    expect(out.code).not.toContain(PW);
    expect(llm.calls[1].prompt).not.toContain(PW);
    expect(llm.calls[1].prompt).toMatch(/credential/i);
  }, 30_000);
  it('generateSpec fails after retries if the LLM keeps emitting the value, without leaking it', async () => {
    const llm = new MockLLM(() => ({ code: LEAKY }));
    let msg = '';
    try { await generateSpec(llm, { journey, pages: [page], baseUrl: 'http://x' }, { retries: 1, redactor }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/failed validation/);
    expect(msg).not.toContain(PW);
  }, 30_000);
  it('codegen prompt for an auth journey explains the credentials fixture and storageState, with placeholders only', async () => {
    const llm = new MockLLM(() => ({ code: CLEAN }));
    await generateSpec(llm, { journey, pages: [page], baseUrl: 'http://x', auth: { user: 'member' } }, { retries: 0, redactor });
    const { system, prompt } = llm.calls[0];
    expect(system + prompt).toMatch(/credentials\.(username|password)/);
    expect(system + prompt).toMatch(/already (logged|signed)/i);
    expect(system + prompt).not.toContain(PW);
  }, 30_000);
  it('AC-16: _support exposes a credentials fixture backed by E2E_USERNAME/E2E_PASSWORD', () => {
    expect(SUPPORT_SOURCE).toContain('E2E_USERNAME');
    expect(SUPPORT_SOURCE).toContain('E2E_PASSWORD');
    expect(SUPPORT_SOURCE).toMatch(/credentials/);
  });
  it('specs still cannot read process.env themselves', async () => {
    const v = await validateSpec(CLEAN.replace('credentials.password', 'process.env.E2E_PASSWORD!'), { redactor });
    expect(v.ok).toBe(false);
  }, 30_000);
});

describe('RedactingLLM (AC-22)', () => {
  it('redacts system and prompt, drops images, leaves outputs untouched', async () => {
    const inner = new MockLLM(() => ({ code: `x ${PW}` }));
    const llm = new RedactingLLM(inner, redactor, { dropImages: true });
    const { codeSchema } = await import('../src/core/llm/schemas.js');
    const out = await llm.structured({ name: 'n', description: 'd', system: `sys ${PW}`, prompt: `user member@example.test pw ${PW}`, schema: codeSchema, images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(inner.calls[0].system).toBe('sys {{password}}');
    expect(inner.calls[0].prompt).toBe('user {{username}} pw {{password}}');
    expect(inner.calls[0].images).toBeUndefined();
    expect(out.code).toContain(PW); // output intact so codegen can detect-and-reject
  });
  it('keeps images when not dropping', async () => {
    const inner = new MockLLM(() => ({ code: 'c' }));
    const { codeSchema } = await import('../src/core/llm/schemas.js');
    await new RedactingLLM(inner, redactor, { dropImages: false }).structured({ name: 'n', description: 'd', system: 's', prompt: 'p', schema: codeSchema, images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(inner.calls[0].images).toHaveLength(1);
  });
});

describe('planner auth mode (AC-14)', () => {
  const proposal = { journeys: [{ name: 'View account', goal: 'g', priority: 'high', steps: ['open account'], requiresAuth: true, user: 'member' }, { name: 'Browse', goal: 'g', priority: 'low', steps: ['open home'] }] };
  it('auth mode: prompt names users, allows account journeys, keeps requiresAuth/user', async () => {
    const llm = new MockLLM(() => proposal);
    const js = await proposeJourneys(llm, [page], { auth: { user: 'member', userNames: ['member', 'admin'] } });
    const { system, prompt } = llm.calls[0];
    expect(system + prompt).toMatch(/requiresAuth/);
    expect(system + prompt).toMatch(/member, admin|member.*admin/);
    expect(system).not.toMatch(/avoid journeys that need real accounts/i);
    expect(js[0]).toMatchObject({ requiresAuth: true, user: 'member' });
    expect(js[1].requiresAuth).toBeUndefined();
  });
  it('unknown user names are corrected to the session user', async () => {
    const llm = new MockLLM(() => ({ journeys: [{ ...proposal.journeys[0], user: 'ghost' }] }));
    const js = await proposeJourneys(llm, [page], { auth: { user: 'member', userNames: ['member'] } });
    expect(js[0].user).toBe('member');
  });
  it('non-auth mode: unchanged prompt, requiresAuth ignored', async () => {
    const llm = new MockLLM(() => proposal);
    const js = await proposeJourneys(llm, [page]);
    expect(llm.calls[0].system).toMatch(/avoid journeys that need real accounts/i);
    expect(js.every((j) => j.requiresAuth === undefined && j.user === undefined)).toBe(true);
  });
});

describe('runner env (AC-17)', () => {
  it('never forwards a parent E2E_* credential; only explicit extras', () => {
    const parent = { PATH: '/bin', E2E_PASSWORD: 'parent-secret', E2E_USERNAME: 'parent-user' };
    const none = buildRunnerEnv(parent, {});
    expect(none.E2E_PASSWORD).toBeUndefined();
    expect(none.E2E_USERNAME).toBeUndefined();
    const some = buildRunnerEnv(parent, { E2E_USERNAME: 'u', E2E_PASSWORD: 'p' });
    expect(some).toMatchObject({ E2E_USERNAME: 'u', E2E_PASSWORD: 'p' });
  });
});
