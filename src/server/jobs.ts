import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { authUserFor } from '../core/auth.js';
import { configSchema, type Config } from '../core/config.js';
import { DEFAULT_CREDENTIALS_FILE, loadCredentials, publicError } from '../core/credentials.js';
import { createContext, discover, generate, healSelected, run, runAll } from '../core/pipeline.js';
import type { LLMProvider } from '../core/llm/types.js';
import { normalizeSite } from '../core/storage.js';
import { OBS_SERVER_ONLY_KEYS } from '../core/obs/config.js';
import type { StorageBackend } from '../core/storage/backend.js';
import { formatUsageSummary, type UsageTotals } from '../core/llm/usage.js';
import type { ProgressEvent } from '../core/types.js';

export const ACTIONS = ['discover', 'generate', 'run', 'heal', 'all'] as const;
export type Action = (typeof ACTIONS)[number];

/** Job options: any Config key a client may override; `awsProfile: null` clears a server-configured profile. */
export type JobOptions = Omit<Partial<Config>, 'awsProfile'> & { awsProfile?: string | null };

export interface JobRequest { action: Action; url: string; options?: JobOptions; journeyIds?: string[]; failedOnly?: boolean; rediscover?: boolean; regenerate?: boolean }
export interface Job {
  id: string; action: Action; url: string; site: string; status: 'running' | 'done' | 'error'; startedAt: string; finishedAt?: string;
  events: ProgressEvent[]; result?: unknown; error?: string;
  /** SPEC-013: LLM usage totals of the job (once finished) */
  usage?: UsageTotals;
}

/** Options a web client may override per job. dataDir/model-provider internals are deliberately excluded. */
// SPEC-012: `environments` (header values may be secrets) is server-only; clients pick one by name with `env`.
// SPEC-013: logging, budget and LLM retry settings are server-only too.
const optionsSchema = configSchema.omit({ dataDir: true, maxTokens: true, awsRegion: true, awsProfile: true, credentialsFile: true, environments: true, server: true, ...Object.fromEntries(OBS_SERVER_ONLY_KEYS.map((k) => [k, true as const])) as Record<(typeof OBS_SERVER_ONLY_KEYS)[number], true> }).partial()
  .extend({ awsProfile: configSchema.shape.awsProfile.unwrap().nullable().optional() }).strict();

/** Effective config for a job: server config overlaid with the client's options. */
export function mergeJobConfig(base: Config, options: JobOptions = {}): Config {
  const { awsProfile, ...rest } = options;
  const merged: Record<string, unknown> = { ...base, ...rest };
  if (awsProfile === null) delete merged.awsProfile;
  else if (awsProfile !== undefined) merged.awsProfile = awsProfile;
  return configSchema.parse(merged);
}

export function parseJobRequest(body: unknown): JobRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!ACTIONS.includes(b.action as Action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  if (typeof b.url !== 'string') throw new Error('url is required');
  normalizeSite(b.url);
  // SPEC-012: `environments` is server-only. The UI round-trips /api/config (which shows env header *names*) as options,
  // so it is dropped, never applied.
  const { environments: _serverOnly, ...clientOptions } = (b.options ?? {}) as Record<string, unknown>;
  const opts = optionsSchema.safeParse(clientOptions);
  if (!opts.success) throw new Error('Invalid options: ' + opts.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; '));
  const ids = b.journeyIds;
  if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) throw new Error('journeyIds must be a string array');
  if (b.failedOnly !== undefined && typeof b.failedOnly !== 'boolean') throw new Error('failedOnly must be a boolean');
  if (b.failedOnly !== undefined && b.action !== 'heal') throw new Error('failedOnly only applies to action "heal"');
  // zod fills in schema defaults for absent keys; keep only what the client sent, or an omitted `provider`/`model`/... would
  // silently reset the server's own configuration.
  const sent = clientOptions;
  const options = Object.fromEntries(Object.entries(opts.data).filter(([k]) => k in sent)) as JobOptions;
  return { action: b.action as Action, url: b.url, options, journeyIds: ids as string[] | undefined, ...(b.failedOnly === undefined ? {} : { failedOnly: b.failedOnly }), rediscover: b.rediscover === true, regenerate: b.regenerate === true };
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<(e: ProgressEvent) => void>>();
  constructor(private base: Config, private llm?: LLMProvider, private storage?: StorageBackend) {}

  get(id: string) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].map(({ events: _e, ...j }) => j).reverse(); }
  running(site: string) { return [...this.jobs.values()].find((j) => j.site === site && j.status === 'running'); }

  subscribe(id: string, fn: (e: ProgressEvent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }
  private emit(job: Job, e: ProgressEvent) {
    job.events.push(e);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    this.listeners.get(job.id)?.forEach((fn) => fn(e));
  }

  start(req: JobRequest, meta: { actor?: string } = {}): Job {
    const site = normalizeSite(req.url).id;
    const busy = this.running(site);
    if (busy) throw Object.assign(new Error(`A job (${busy.id}) is already running for ${site}`), { statusCode: 409 });
    const config = mergeJobConfig(this.base, req.options);
    if (config.auth) { // fail fast (400) on a missing/unsafe credentials file or an unknown user, before a job exists
      const credentials = loadCredentials({ file: config.credentialsFile ?? path.resolve(DEFAULT_CREDENTIALS_FILE), explicit: !!config.credentialsFile });
      authUserFor({ config, credentials }, req.url);
    }
    // SPEC-012: createContext validates targets, shard and the env (incl. ${VAR} headers). Build it before the job is
    // registered so a bad option is a 400 and never leaves a job stuck in `running` (which would 409 the site forever).
    // `let` on purpose: onProgress (below) may read `job` while createContext runs, before it is assigned; a `const`
    // declared later would be in its temporal dead zone and throw.
    // eslint-disable-next-line prefer-const
    let job: Job | undefined;
    const early: ProgressEvent[] = [];
    let ctx: ReturnType<typeof createContext>;
    const id = randomUUID(); // SPEC-013: the job id is the run's correlation id
    try {
      ctx = createContext({ config, llm: this.llm, onProgress: (e) => (job ? this.emit(job, e) : early.push(e)), obs: { correlationId: id, actor: meta.actor ?? 'web:unknown', action: req.action, site, storage: this.storage } });
    } catch (e) {
      throw (e as { statusCode?: number }).statusCode ? e : Object.assign(e as Error, { statusCode: 400 });
    }
    job = { id, action: req.action, url: req.url, site, status: 'running', startedAt: new Date().toISOString(), events: [] };
    this.jobs.set(job.id, job);
    for (const e of early) this.emit(job, e);
    const j = job;
    const finish = async (status: 'ok' | 'error') => { // SPEC-013 FR-13: usage report + summary event before the terminal event
      const report = await ctx.obs.finish({ action: req.action, site, status, error: j.error });
      j.usage = report?.totals ?? ctx.obs.usage.totals();
      if (j.usage.calls) this.emit(j, { type: 'info', stage: 'llm', message: formatUsageSummary(j.usage), data: { usage: j.usage } });
    };
    void (async () => {
      const job = j;
      try {
        switch (req.action) {
          case 'discover': { const d = await discover(ctx, req.url, { rediscover: req.rediscover }); job.result = { journeys: d.journeys.length, reused: d.reused }; break; }
          case 'generate': { const g = await generate(ctx, req.url, { regenerate: req.regenerate, rediscover: req.rediscover }); job.result = g.result; break; }
          case 'run': job.result = await run(ctx, req.url, { journeyIds: req.journeyIds }); break;
          case 'heal': job.result = await healSelected(ctx, req.url, { ids: req.journeyIds, failedOnly: req.failedOnly }); break;
          case 'all': job.result = await runAll(ctx, req.url, { rediscover: req.rediscover, regenerate: req.regenerate }); break;
        }
        job.result = ctx.redactor.redactDeep(job.result);
        await finish('ok');
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        this.emit(job, { type: 'done', message: `${req.action} finished`, data: job.result });
      } catch (e) {
        job.status = 'error';
        job.error = ctx.redact(publicError(e));
        ctx.obs.log.error({ error: job.error }, 'job.failed');
        await finish('error');
        job.finishedAt = new Date().toISOString();
        this.emit(job, { type: 'error', message: job.error });
      }
    })();
    return j;
  }
}
