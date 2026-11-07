import path from 'node:path';
import { generateTests, type GenerateResult } from './codegen.js';
import type { Config } from './config.js';
import { crawl } from './discovery.js';
import { healTest } from './healer.js';
import { createLLMProvider } from './llm/index.js';
import type { LLMProvider } from './llm/types.js';
import { proposeJourneys, selectJourneys } from './planner.js';
import { runTests } from './runner.js';
import { Store, normalizeSite } from './storage.js';
import type { HealRecord, Journey, PageModel, ProgressFn, RunRecord } from './types.js';

export interface Context {
  config: Config;
  store: Store;
  onProgress: ProgressFn;
  getLLM: () => LLMProvider;
}

export function createContext(opts: { config: Config; llm?: LLMProvider; onProgress?: ProgressFn }): Context {
  let llm = opts.llm;
  return {
    config: opts.config,
    store: new Store(opts.config.dataDir),
    onProgress: opts.onProgress ?? (() => {}),
    getLLM: () => (llm ??= createLLMProvider(opts.config)),
  };
}

const stage = (ctx: Context, s: string, message: string) => ctx.onProgress({ type: 'stage', stage: s, message });

export interface DiscoverResult { site: string; journeys: Journey[]; pages: PageModel[] | null; reused: boolean }

/** Discover + select journeys; reuses stored journeys unless `rediscover`. */
export async function discover(ctx: Context, url: string, opts: { rediscover?: boolean } = {}): Promise<DiscoverResult> {
  const meta = normalizeSite(url);
  const { store, config } = ctx;
  const stored = store.loadJourneys(meta.id);
  if (stored && !opts.rediscover) {
    ctx.onProgress({ type: 'info', stage: 'discover', message: `Using ${stored.length} stored journeys for ${meta.id} (use rediscover to refresh)` });
    return { site: meta.id, journeys: stored, pages: store.loadPages(meta.id), reused: true };
  }
  stage(ctx, 'discover', `Crawling ${meta.url || meta.origin} (max ${config.maxPages} pages, depth ${config.maxDepth})`);
  store.saveSite({ id: meta.id, origin: meta.origin, url: meta.url || meta.origin });
  const siteDir = store.siteDir(meta.id);
  const pages = await crawl(meta.url || meta.origin, {
    maxPages: config.maxPages, maxDepth: config.maxDepth, timeoutMs: config.timeoutMs, headless: config.headless,
    screenshotDir: config.screenshots === 'off' ? undefined : path.join(siteDir, 'screenshots', 'discovery'),
    fullPage: config.fullPage,
    onPage: (p) => ctx.onProgress({ type: 'info', stage: 'discover', message: `Captured ${p.path} — ${p.title}` }),
  });
  for (const p of pages) if (p.screenshot) p.screenshot = path.relative(siteDir, p.screenshot);
  store.savePages(meta.id, pages);
  stage(ctx, 'plan', `Asking the LLM to propose journeys from ${pages.length} pages`);
  const proposed = await proposeJourneys(ctx.getLLM(), pages);
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
  stage(ctx, 'generate', 'Generating Playwright tests');
  const result = await generateTests(ctx.store, ctx.getLLM(), d.journeys, {
    site: d.site, baseUrl: meta.origin, pages: d.pages ?? [], retries: ctx.config.codegenRetries,
    requireApproval: ctx.config.requireApproval, regenerate: opts.regenerate, onProgress: ctx.onProgress,
  });
  return { site: d.site, journeys: d.journeys, result, reusedJourneys: d.reused };
}

export async function run(ctx: Context, url: string, opts: { journeyIds?: string[]; kind?: RunRecord['kind'] } = {}): Promise<RunRecord> {
  const meta = normalizeSite(url);
  stage(ctx, 'run', 'Running tests');
  return runTests(ctx.store, {
    site: meta.id, baseUrl: meta.origin, journeyIds: opts.journeyIds, screenshots: ctx.config.screenshots, fullPage: ctx.config.fullPage,
    headless: ctx.config.headless, testTimeoutMs: ctx.config.testTimeoutMs, kind: opts.kind, onProgress: ctx.onProgress,
  });
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
      runner: (ids) => run(ctx, url, { journeyIds: ids, kind: 'heal-rerun' }), onProgress: ctx.onProgress,
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
