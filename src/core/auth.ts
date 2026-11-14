import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.js';
import { CredentialsError, type CredentialStore, type LoginHints, type ResolvedUser } from './credentials.js';
import { capture } from './discovery.js';
import { loginFormSchema } from './llm/schemas.js';
import type { LLMProvider } from './llm/types.js';
import { pageToPrompt } from './planner.js';
import type { Redactor } from './redact.js';
import { normalizeSite, type Store } from './storage.js';
import type { ProgressFn } from './types.js';

export { isDestructiveLink } from './safety.js';

/** What auth needs from a pipeline Context. */
export interface AuthDeps {
  config: Pick<Config, 'headless' | 'timeoutMs' | 'authUser'>;
  store: Store;
  credentials: CredentialStore;
  redactor: Redactor;
  getLLM: () => LLMProvider;
  onProgress: ProgressFn;
}
export interface Session { user: string; storageState: string; reused: boolean }

export const SESSION_MAX_AGE_MS = 12 * 3600_000;
const COMMON_LOGIN_PATHS = ['/login', '/signin', '/sign-in', '/account/login', '/users/sign_in'];

/** Resolve the user a run uses (throws CredentialsError); `null` when auth mode is off. */
export function authUserFor(deps: { config: Pick<Config, 'authUser'> & { auth?: boolean }; credentials: CredentialStore }, url: string, explicit?: string): ResolvedUser | null {
  if (!deps.config.auth && explicit === undefined) return null;
  return deps.credentials.getUser(normalizeSite(url).id, explicit ?? deps.config.authUser);
}

/** A stored state is usable when it exists, parses, is younger than `maxAgeMs` and still has an unexpired cookie. */
export function isStateFresh(file: string, opts: { now?: number; maxAgeMs?: number } = {}): boolean {
  const now = opts.now ?? Date.now();
  try {
    if (now - fs.statSync(file).mtimeMs > (opts.maxAgeMs ?? SESSION_MAX_AGE_MS)) return false;
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { cookies?: { expires?: number }[]; origins?: unknown[] };
    const cookies = state.cookies ?? [];
    if (!cookies.length) return (state.origins?.length ?? 0) > 0; // token-in-localStorage sessions
    return cookies.some((c) => c.expires === undefined || c.expires < 0 || c.expires * 1000 > now);
  } catch {
    return false;
  }
}

function urlMatcher(pattern: string): (url: URL) => boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try { const re = new RegExp(m[1], m[2]); return (u) => re.test(u.pathname + u.search) || re.test(u.href); } catch { /* substring */ }
  }
  return (u) => (u.pathname + u.search).includes(pattern) || u.href.includes(pattern);
}

const passwordVisible = async (page: Page) => (await page.locator('input[type=password]:visible').count().catch(() => 0)) > 0;
const textVisible = async (page: Page, text: string) => page.getByText(text, { exact: false }).first().isVisible().catch(() => false);

/** Is the page in a logged-in state? Used after submitting the form (`login`) and to re-validate a stored session. */
async function loggedIn(page: Page, hints: LoginHints, loginPath: string | undefined, mode: 'login' | 'check'): Promise<boolean> {
  const u = new URL(page.url());
  if (hints.successUrl && !urlMatcher(hints.successUrl)(u) && mode === 'login') return false;
  if (hints.successText && !(await textVisible(page, hints.successText))) return false;
  if (await passwordVisible(page)) return false;
  if (loginPath && u.pathname === loginPath && !(mode === 'login' && (hints.successUrl || hints.successText))) return false;
  return true;
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

const resolveUrl = (target: string, origin: string) => new URL(target, origin).href;

async function findLoginPage(page: Page, origin: string, hints: LoginHints, timeoutMs: number): Promise<string> {
  const candidates: string[] = [];
  if (hints.loginUrl) candidates.push(resolveUrl(hints.loginUrl, origin));
  else {
    await page.goto(origin, { waitUntil: 'load', timeout: timeoutMs }).catch(() => {});
    const links = await page.evaluate(`[...document.querySelectorAll('a[href]')].filter((a) => /\\b(log\\s?-?in|sign\\s?-?in)\\b/i.test(a.textContent || '')).map((a) => a.href)`).catch(() => []) as string[];
    candidates.push(...links.filter((l) => l.startsWith(origin)), ...COMMON_LOGIN_PATHS.map((p) => origin + p));
  }
  for (const c of [...new Set(candidates)]) {
    await page.goto(c, { waitUntil: 'load', timeout: timeoutMs }).catch(() => {});
    if (await passwordVisible(page)) return c;
  }
  throw new CredentialsError(`Could not find a login form for ${origin}. Set "login.loginUrl" for this site in the credentials file.`);
}

interface Selectors { usernameSelector: string; passwordSelector: string; submitSelector: string }

async function locateForm(page: Page, hints: LoginHints, deps: AuthDeps): Promise<Selectors> {
  if (hints.usernameSelector && hints.passwordSelector && hints.submitSelector) return { usernameSelector: hints.usernameSelector, passwordSelector: hints.passwordSelector, submitSelector: hints.submitSelector };
  const { model } = await capture(page, page.url(), 0);
  // The model sees the page and *placeholders*; the real values are typed locally below.
  const found = await deps.getLLM().structured({
    name: 'locate_login_form',
    description: 'Return Playwright selectors for the login form fields.',
    system: 'You locate the login form on a web page. Return Playwright-compatible selectors (CSS, or role=/text= selectors) for the username/e-mail field, the password field and the submit button. The credentials are {{username}} and {{password}}; you never need real values.',
    prompt: `Login page:\n\n${pageToPrompt(model)}\n\nThe test will type {{username}} into the username field and {{password}} into the password field, then click submit.`,
    schema: loginFormSchema,
  });
  return {
    usernameSelector: hints.usernameSelector ?? found.usernameSelector,
    passwordSelector: hints.passwordSelector ?? found.passwordSelector,
    submitSelector: hints.submitSelector ?? found.submitSelector,
  };
}

async function launch(deps: AuthDeps, storageState?: string): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ headless: deps.config.headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(storageState ? { storageState } : {}) });
  return { browser, context, page: await context.newPage() };
}

/** Live check that a stored session still works. With no `checkUrl`/`successText` hint there is nothing to check: trust freshness. */
export async function isSessionValid(deps: AuthDeps, url: string, userName?: string): Promise<boolean> {
  const meta = normalizeSite(url);
  const user = deps.credentials.getUser(meta.id, userName ?? deps.config.authUser);
  const file = deps.store.authStatePath(meta.id, user.name);
  if (!isStateFresh(file)) return false;
  const hints = deps.credentials.loginHints(meta.id);
  if (!hints.checkUrl && !hints.successText) return true;
  const { browser, page } = await launch(deps, file);
  try {
    await page.goto(resolveUrl(hints.checkUrl ?? meta.origin, meta.origin), { waitUntil: 'load', timeout: deps.config.timeoutMs }).catch(() => {});
    const loginPath = hints.loginUrl ? new URL(hints.loginUrl, meta.origin).pathname : undefined;
    return await loggedIn(page, hints, loginPath, 'check');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function login(deps: AuthDeps, url: string, user: ResolvedUser, file: string): Promise<void> {
  const meta = normalizeSite(url);
  const hints = deps.credentials.loginHints(meta.id);
  const { browser, context, page } = await launch(deps);
  try {
    const loginUrl = await findLoginPage(page, meta.origin, hints, deps.config.timeoutMs);
    const sel = await locateForm(page, hints, deps);
    for (const s of Object.values(sel)) {
      if ((await page.locator(s).count().catch(() => 0)) < 1) throw new Error(`login selector ${JSON.stringify(s)} matched nothing on ${new URL(loginUrl).pathname}`);
    }
    await page.locator(sel.usernameSelector).first().fill(user.username, { timeout: 10_000 });
    await page.locator(sel.passwordSelector).first().fill(user.password, { timeout: 10_000 });
    await page.locator(sel.submitSelector).first().click({ timeout: 10_000 });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    const loginPath = new URL(loginUrl).pathname;
    const ok = await waitFor(() => loggedIn(page, hints, loginPath, 'login'), Math.min(10_000, deps.config.timeoutMs));
    if (!ok) throw new Error(`success condition not met (still on ${new URL(page.url()).pathname})`);
    fs.mkdirSync(deps.store.authDir(meta.id), { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(deps.store.authDir(meta.id), 0o700);
    await context.storageState({ path: file });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Log in (or reuse a still-valid stored session) and return the storageState path. Errors never contain credential values. */
export async function ensureSession(deps: AuthDeps, url: string, opts: { user?: string; force?: boolean } = {}): Promise<Session> {
  const meta = normalizeSite(url);
  const user = deps.credentials.getUser(meta.id, opts.user ?? deps.config.authUser);
  const file = deps.store.authStatePath(meta.id, user.name);
  if (!opts.force && (await isSessionValid(deps, url, user.name))) {
    deps.onProgress({ type: 'info', stage: 'auth', message: `Reusing stored session for user "${user.name}"` });
    return { user: user.name, storageState: file, reused: true };
  }
  deps.onProgress({ type: 'info', stage: 'auth', message: `Logging in as "${user.name}" on ${meta.id}` });
  try {
    await login(deps, url, user, file);
  } catch (e) {
    if (e instanceof CredentialsError) throw e;
    const reason = deps.redactor.redact((e as Error).message.split('\n')[0]);
    throw new Error(`Login failed for user "${user.name}" on ${meta.id}: ${reason}`);
  }
  deps.onProgress({ type: 'info', stage: 'auth', message: `Logged in as "${user.name}"; session saved` });
  return { user: user.name, storageState: file, reused: false };
}
