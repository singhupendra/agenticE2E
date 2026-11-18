import { authUserFor, ensureSession } from '../auth.js';
import type { Config } from '../config.js';
import { CredentialsError } from '../credentials.js';
import { UnknownSiteError } from '../heal-selection.js';
import type { LLMProvider } from '../llm/types.js';
import { createContext, heal, run, type Context } from '../pipeline.js';
import { buildSiteReport, publishError, publishReport, type RunReport } from '../reporting/index.js';
import { normalizeSite } from '../storage.js';
import type { HealRecord, ProgressFn, RunRecord, TestResult } from '../types.js';

/** SPEC-011 FR-10: documented, deterministic exit codes of `agentic-e2e ci`. Precedence: 2 > 3 > 1. */
export const EXIT_CODES = { PASS: 0, TEST_FAILURES: 1, CONFIG_OR_AUTH: 2, LLM_OR_INFRA: 3 } as const;
export type CiExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** An error with a known CI exit code. */
export class CiError extends Error {
  constructor(message: string, public readonly exitCode: CiExitCode, public readonly cause?: unknown) { super(message); this.name = 'CiError'; }
}

export interface CiOptions {
  config: Config;
  url: string;
  /** heal tests that still fail after retries (may rewrite specs). Off = no LLM, no spec changes. */
  allowHeal?: boolean;
  env?: Record<string, string | undefined>;
  onProgress?: ProgressFn;
  llm?: LLMProvider;
  cwd?: string;
}
export interface CiResult { exitCode: CiExitCode; report?: RunReport; files: string[]; error?: string; heals: HealRecord[] }

const isFail = (r: TestResult) => r.status === 'failed' || r.status === 'timedOut';
const HEAL_ABORTED = 'Healing aborted by error:';
/** Errors from `run()` that are about configuration or the login rather than the infrastructure. */
const CONFIG_RUN_ERROR = /Login failed|requires a logged-in user|No runnable tests|No tests to run|No stored test|Invalid (?:URL|site id|id)/;

export function classifyRunError(e: unknown): CiExitCode {
  if (e instanceof CiError) return e.exitCode;
  if (e instanceof CredentialsError || e instanceof UnknownSiteError) return EXIT_CODES.CONFIG_OR_AUTH;
  return CONFIG_RUN_ERROR.test((e as Error)?.message ?? '') ? EXIT_CODES.CONFIG_OR_AUTH : EXIT_CODES.LLM_OR_INFRA;
}

/** Everything that must succeed before a single test runs; any failure is a config/auth error (exit 2). */
async function preflight(o: CiOptions): Promise<Context> {
  const meta = normalizeSite(o.url);
  const ctx = createContext({ config: o.config, llm: o.llm, onProgress: o.onProgress, cwd: o.cwd });
  if (!ctx.store.hasSite(meta.id)) throw new CiError(`Unknown site ${meta.id} in ${o.config.dataDir}. CI mode only runs stored tests; generate them first (agentic-e2e generate ${o.url}).`, EXIT_CODES.CONFIG_OR_AUTH);
  if (!ctx.store.listTests(meta.id).length) throw new CiError(`No stored tests for ${meta.id}. CI mode never generates tests; run: agentic-e2e generate ${o.url}`, EXIT_CODES.CONFIG_OR_AUTH);
  const user = authUserFor(ctx, o.url);
  if (user) await ensureSession(ctx, o.url, { user: user.name });
  if (o.allowHeal && o.config.healAttempts > 0) ctx.getLLM();
  return ctx;
}

/**
 * SPEC-011 FR-7..FR-11: non-interactive CI run of stored tests. Never discovers, generates or prompts.
 * Retries failing tests (`config.retries`), heals only with `allowHeal`, writes reports / step summary / notifications.
 */
export async function runCi(o: CiOptions): Promise<CiResult> {
  const env = o.env ?? process.env;
  const progress = o.onProgress ?? (() => {});
  let ctx: Context | undefined;
  const fail = async (exitCode: CiExitCode, e: unknown): Promise<CiResult> => {
    const message = ctx ? ctx.redact((e as Error).message) : (e as Error).message;
    await publishError({ exitCode, error: e, env, notifyOn: o.config.notifyOn, redactors: ctx ? [ctx.redactor] : [], onWarn: (m) => progress({ type: 'warn', stage: 'report', message: m }) });
    return { exitCode, files: [], error: message, heals: [] };
  };

  try { ctx = await preflight(o); } catch (e) { return fail(e instanceof CiError ? e.exitCode : EXIT_CODES.CONFIG_OR_AUTH, e); }

  const runs: RunRecord[] = [];
  let heals: HealRecord[] = [];
  let infra = false;
  try {
    runs.push(await run(ctx, o.url));
    const last = new Map(runs[0].results.map((r) => [r.journeyId, r]));
    const failing = () => [...last.values()].filter(isFail).map((r) => r.journeyId);
    for (let i = 1; i <= o.config.retries && failing().length; i++) {
      progress({ type: 'stage', stage: 'retry', message: `Retry ${i}/${o.config.retries}: re-running ${failing().length} failing test(s)` });
      const r = await run(ctx, o.url, { journeyIds: failing(), kind: 'retry' });
      runs.push(r);
      for (const x of r.results) last.set(x.journeyId, x);
    }
    const still = failing();
    if (still.length && o.allowHeal && o.config.healAttempts > 0) {
      heals = await heal(ctx, o.url, { ...runs[0], results: still.map((id) => last.get(id)!) });
      infra = heals.some((h) => h.outcome === 'failed' && h.reason.startsWith(HEAL_ABORTED));
    } else if (still.length && !o.allowHeal) {
      progress({ type: 'info', stage: 'ci', message: `${still.length} test(s) failing; not healing (CI mode never rewrites tests without --allow-heal)` });
    }
  } catch (e) {
    if (!runs.length) return fail(classifyRunError(e), e);
    infra = true;
    progress({ type: 'error', stage: 'ci', message: ctx.redact((e as Error).message) });
  }

  const report = buildSiteReport(ctx, o.url, { mode: 'ci', runs, heals, env });
  const exitCode: CiExitCode = infra ? EXIT_CODES.LLM_OR_INFRA : report.totals.failed ? EXIT_CODES.TEST_FAILURES : EXIT_CODES.PASS;
  const { files } = await publishReport(ctx, report, { exitCode, env });
  return { exitCode, report, files, heals };
}
