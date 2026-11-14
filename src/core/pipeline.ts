import path from 'node:path';
import { authUserFor, ensureSession, isSessionValid } from './auth.js';
import { generateTests, type GenerateResult } from './codegen.js';
import type { Config } from './config.js';
import { crawl } from './discovery.js';
import { resolveHealSelection, type HealSelectionRequest } from './heal-selection.js';
import { healTest } from './healer.js';
import { CredentialStore, DEFAULT_CREDENTIALS_FILE, loadCredentials, type ResolvedUser } from './credentials.js';
import { createLLMProvider } from './llm/index.js';
import { RedactingLLM } from './llm/redacting.js';
import type { LLMProvider } from './llm/types.js';
import { Redactor } from './redact.js';
import { proposeJourneys, selectJourneys } from './planner.js';
import { runTests } from './runner.js';
import { Store, normalizeSite } from './storage.js';
import type { HealRecord, Journey, PageModel, ProgressFn, RunRecord } from './types.js';

export interface Context {
  config: Config;
  store: Store;
  onProgress: ProgressFn;
  getLLM: () => LLMProvider;
  /** SPEC-009: loaded only in auth mode (empty otherwise) */
  credentials: CredentialStore;
  /** knows every credential value of the loaded file; everything persisted/streamed/prompted passes through it */
  redactor: Redactor;
  redact: (s: string) => string;
}

export function createContext(opts: { config: Config; llm?: LLMProvider; onProgress?: ProgressFn; cwd?: string }): Context {
  const raw: ProgressFn = opts.onProgress ?? (() => {});
  const { config } = opts;
  const credentials = config.auth
    ? loadCredentials({
      file: config.credentialsFile ?? path.resolve(opts.cwd ?? process.cwd(), DEFAULT_CREDENTIALS_FILE),
      explicit: !!config.credentialsFile,
      onWarn: (message) => raw({ type: 'warn', stage: 'auth', message }),
    })
    : CredentialStore.empty();
  const redactor = new Redactor(credentials.secretEntries());
  let llm: LLMProvider | undefined;
  return {
    config,
    store: new Store(config.dataDir, redactor),
    onProgress: (e) => raw(redactor.size ? redactor.redactDeep(e) : e),
    getLLM: () => {
      if (!llm) {
        const inner = opts.llm ?? createLLMProvider(config);
        llm = config.auth ? new RedactingLLM(inner, redactor, { dropImages: true }) : inner;
      }
      return llm;
    },
    credentials,
    redactor,
    redact: (s) => redactor.redact(s),
  };
}

/** The user this run is logged in as (`null` = anonymous). Throws before anything expensive when the user is unknown. */
const authUser = (ctx: Context, url: string): ResolvedUser | null => authUserFor(ctx, url);

const stage = (ctx: Context, s: string, message: string) => ctx.onProgress({ type: 'stage', stage: s, message });

export interface DiscoverResult { site: string; journeys: Journey[]; pages: PageModel[] | null; reused: boolean }

/** Discover + select journeys; reuses stored journeys unless `rediscover`. */
export async function discover(ctx: Context, url: string, opts: { rediscover?: boolean } = {}): Promise<DiscoverResult> {
  const meta = normalizeSite(url);
  const { store, config } = ctx;
  const user = authUser(ctx, url);
  const stored = store.loadJourneys(meta.id);
  if (stored && !opts.rediscover) {
    if (user && !stored.some((j) => j.requiresAuth)) ctx.onProgress({ type: 'info', stage: 'discover', message: `Stored journeys for ${meta.id} include no logged-in journeys; use rediscover to crawl as "${user.name}"` });
    ctx.onProgress({ type: 'info', stage: 'discover', message: `Using ${stored.length} stored journeys for ${meta.id} (use rediscover to refresh)` });
    return { site: meta.id, journeys: stored, pages: store.loadPages(meta.id), reused: true };
  }
  stage(ctx, 'discover', `Crawling ${meta.url || meta.origin} (max ${config.maxPages} pages, depth ${config.maxDepth})`);
  store.saveSite({ id: meta.id, origin: meta.origin, url: meta.url || meta.origin });
  const siteDir = store.siteDir(meta.id);
  const session = user ? await ensureSession(ctx, url, { user: user.name }) : undefined;
  const pages = await crawl(meta.url || meta.origin, {
    maxPages: config.maxPages, maxDepth: config.maxDepth, timeoutMs: config.timeoutMs, headless: config.headless,
    screenshotDir: config.screenshots === 'off' ? undefined : path.join(siteDir, 'screenshots', 'discovery'),
    fullPage: config.fullPage,
    storageState: session?.storageState,
    onPage: (p) => ctx.onProgress({ type: 'info', stage: 'discover', message: `Captured ${p.path} — ${p.title}` }),
  });
  for (const p of pages) if (p.screenshot) p.screenshot = path.relative(siteDir, p.screenshot);
  store.savePages(meta.id, pages);
  stage(ctx, 'plan', `Asking the LLM to propose journeys from ${pages.length} pages`);
  const proposed = await proposeJourneys(ctx.getLLM(), pages, user ? { auth: { user: user.name, userNames: ctx.credentials.userNames(meta.id) } } : {});
  ctx.onProgress({ type: 'info', stage: 'plan', message: `Proposed ${proposed.length} journeys; selecting up to ${config.maxJourneys}` });
  const journeys = await selectJourneys(ctx.getLLM(), proposed, { maxJourneys: config.maxJourneys, include: config.include, exclude: config.exclude });
  store.saveJourneys(meta.id, journeys);
  store.saveSite({ id: meta.id, origin: meta.origin, url: meta.url || meta.origin, discoveredAt: new Date().toISOString() });
  return { site: meta.id, journeys, pages, reused: false };
}

/** Re-run the LLM selection over stored journeys (e.g. after changing maxJourneys / filters). */
export async function reselect(ctx: Context, url: string): Promise<Journey[]> {
  const meta = normalizeSite(url);
  const stored = ctx.store.loadJourneys(meta.id);
  if (!stored) throw new Error(`No journeys stored for ${meta.id}; run discover first`);
  const { config } = ctx;
  const journeys = await selectJourneys(ctx.getLLM(), stored, { maxJourneys: config.maxJourneys, include: config.include, exclude: config.exclude });
  ctx.store.saveJourneys(meta.id, journeys);
  return journeys;
}

export async function generate(ctx: Context, url: string, opts: { regenerate?: boolean; rediscover?: boolean } = {}): Promise<{ site: string; journeys: Journey[]; result: GenerateResult; reusedJourneys: boolean }> {
  const d = await discover(ctx, url, { rediscover: opts.rediscover });
  const meta = normalizeSite(url);
  const user = authUser(ctx, url);
  const anonymous = d.journeys.filter((j) => !j.requiresAuth);
  if (!user && anonymous.length < d.journeys.length) ctx.onProgress({ type: 'info', stage: 'generate', message: `Skipping ${d.journeys.length - anonymous.length} journey(ies) that require a logged-in user (enable logged-in mode with --auth)` });
  stage(ctx, 'generate', 'Generating Playwright tests');
  const result = await generateTests(ctx.store, ctx.getLLM(), user ? d.journeys : anonymous, {
    redactor: ctx.redactor, authUser: user?.name,
    site: d.site, baseUrl: meta.origin, pages: d.pages ?? [], retries: ctx.config.codegenRetries,
    requireApproval: ctx.config.requireApproval, regenerate: opts.regenerate, onProgress: ctx.onProgress,
  });
  return { site: d.site, journeys: d.journeys, result, reusedJourneys: d.reused };
}

export async function run(ctx: Context, url: string, opts: { journeyIds?: string[]; kind?: RunRecord['kind'] } = {}): Promise<RunRecord> {
  const meta = normalizeSite(url);
  const user = authUser(ctx, url);
  const { store } = ctx;
  let ids = opts.journeyIds ?? store.listTests(meta.id);
  const journeys = new Map((store.loadJourneys(meta.id) ?? []).map((j) => [j.id, j]));
  const needsAuth = (id: string) => !!journeys.get(id)?.requiresAuth;
  if (!user) {
    for (const id of ids.filter(needsAuth)) ctx.onProgress({ type: 'warn', stage: 'run', message: `Skipping "${id}": it requires a logged-in user (enable logged-in mode with --auth)` });
    const before = ids.length;
    ids = ids.filter((id) => !needsAuth(id));
    if (before && !ids.length) throw new Error(`No runnable tests for site ${meta.id}: the stored tests all require a logged-in user. Pass --auth.`);
  } else {
    for (const id of ids.filter((x) => needsAuth(x) && journeys.get(x)!.user && journeys.get(x)!.user !== user.name)) ctx.onProgress({ type: 'info', stage: 'run', message: `Skipping "${id}": it belongs to user "${journeys.get(id)!.user}" (this run is "${user.name}"; run again with --user)` });
    ids = ids.filter((id) => !(needsAuth(id) && journeys.get(id)!.user && journeys.get(id)!.user !== user.name));
  }
  const authIds = user ? ids.filter(needsAuth) : [];
  const exec = async (storageState?: string) => {
    stage(ctx, 'run', 'Running tests');
    return runTests(store, {
      site: meta.id, baseUrl: meta.origin, journeyIds: ids, screenshots: ctx.config.screenshots, fullPage: ctx.config.fullPage,
      headless: ctx.config.headless, testTimeoutMs: ctx.config.testTimeoutMs, kind: opts.kind, onProgress: ctx.onProgress,
      ...(user && storageState ? { auth: { storageState, journeyIds: authIds, env: { E2E_USERNAME: user.username, E2E_PASSWORD: user.password } } } : {}),
    });
  };
  if (!user || !authIds.length) return exec();
  const session = await ensureSession(ctx, url, { user: user.name });
  const first = await exec(session.storageState);
  const failedAuth = first.results.some((r) => authIds.includes(r.journeyId) && r.status !== 'passed');
  if (session.reused && failedAuth && !(await isSessionValid(ctx, url, user.name))) {
    ctx.onProgress({ type: 'info', stage: 'auth', message: 'Stored session expired during the run; logging in again and re-running once' });
    const fresh = await ensureSession(ctx, url, { user: user.name, force: true });
    return exec(fresh.storageState);
  }
  return first;
}

export async function heal(ctx: Context, url: string, failedRun: RunRecord): Promise<HealRecord[]> {
  const meta = normalizeSite(url);
  const failures = failedRun.results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
  const records: HealRecord[] = [];
  if (!failures.length) return records;
  stage(ctx, 'heal', `Healing ${failures.length} failing test(s) (up to ${ctx.config.healAttempts} attempts each)`);
  for (const f of failures) {
    records.push(await healTest(ctx.store, ctx.getLLM(), {
      site: meta.id, baseUrl: meta.origin, journeyId: f.journeyId, failure: f, attempts: ctx.config.healAttempts,
      runner: (ids) => run(ctx, url, { journeyIds: ids, kind: 'heal-rerun' }), onProgress: ctx.onProgress, redactor: ctx.redactor,
    }));
  }
  return records;
}

export interface FinalStatus { journeyId: string; status: string; healed: boolean }
export interface AllResult {
  site: string; journeys: Journey[]; reusedJourneys: boolean; generate: GenerateResult; run: RunRecord; heals: HealRecord[]; final: FinalStatus[];
}

export async function runAll(ctx: Context, url: string, opts: { rediscover?: boolean; regenerate?: boolean } = {}): Promise<AllResult> {
  const g = await generate(ctx, url, opts);
  const first = await run(ctx, url);
  const heals = ctx.config.healAttempts > 0 ? await heal(ctx, url, first) : [];
  const healedIds = new Set(heals.filter((h) => h.outcome === 'healed').map((h) => h.journeyId));
  const final = first.results.map((r) => {
    const h = heals.find((x) => x.journeyId === r.journeyId);
    const status = healedIds.has(r.journeyId) ? 'passed' : h?.outcome === 'flaky_or_environment' ? 'passed' : r.status;
    return { journeyId: r.journeyId, status, healed: healedIds.has(r.journeyId) };
  });
  const summary = `${final.filter((f) => f.status === 'passed').length}/${final.length} passing (${healedIds.size} healed)`;
  ctx.onProgress({ type: 'done', stage: 'all', message: summary });
  return { site: g.site, journeys: g.journeys, reusedJourneys: g.reusedJourneys, generate: g.result, run: first, heals, final };
}

export type HealTestOutcome = HealRecord['outcome'] | 'already_passing' | 'skipped';
export interface HealSelectedResult {
  /** Ids that were re-run (empty when `noneFailing`). */
  selected: string[];
  /** `failedOnly` was requested and no test's latest outcome is failed: nothing ran. */
  noneFailing: boolean;
  /** The re-run of the selected tests; `null` when nothing ran. */
  run: RunRecord | null;
  results: { journeyId: string; outcome: HealTestOutcome }[];
  heals: HealRecord[];
}

/** Select (and validate) tests, re-run only those, and heal only the ones that still fail. Passing ones never reach the LLM. */
export async function healSelected(ctx: Context, url: string, selection: HealSelectionRequest = {}): Promise<HealSelectedResult> {
  const meta = normalizeSite(url);
  authUser(ctx, url);
  const sel = resolveHealSelection(ctx.store, meta.id, selection);
  if (sel.ids && !sel.ids.length) {
    ctx.onProgress({ type: 'info', stage: 'heal', message: `No failing tests to heal for ${meta.id}` });
    return { selected: [], noneFailing: true, run: null, results: [], heals: [] };
  }
  const r = await run(ctx, url, { journeyIds: sel.ids ?? undefined });
  const heals = await heal(ctx, url, r);
  const results = r.results.map(({ journeyId, status }): { journeyId: string; outcome: HealTestOutcome } => {
    const h = heals.find((x) => x.journeyId === journeyId);
    return { journeyId, outcome: h ? h.outcome : status === 'passed' ? 'already_passing' : 'skipped' };
  });
  return { selected: r.results.map((x) => x.journeyId), noneFailing: false, run: r, results, heals };
}
