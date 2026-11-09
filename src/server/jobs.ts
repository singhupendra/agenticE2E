import { randomUUID } from 'node:crypto';
import { configSchema, type Config } from '../core/config.js';
import { createContext, discover, generate, healSelected, run, runAll } from '../core/pipeline.js';
import type { LLMProvider } from '../core/llm/types.js';
import { normalizeSite } from '../core/storage.js';
import type { ProgressEvent } from '../core/types.js';

export const ACTIONS = ['discover', 'generate', 'run', 'heal', 'all'] as const;
export type Action = (typeof ACTIONS)[number];

/** Job options: any Config key a client may override; `awsProfile: null` clears a server-configured profile. */
export type JobOptions = Omit<Partial<Config>, 'awsProfile'> & { awsProfile?: string | null };

export interface JobRequest { action: Action; url: string; options?: JobOptions; journeyIds?: string[]; failedOnly?: boolean; rediscover?: boolean; regenerate?: boolean }
export interface Job {
  id: string; action: Action; url: string; site: string; status: 'running' | 'done' | 'error'; startedAt: string; finishedAt?: string;
  events: ProgressEvent[]; result?: unknown; error?: string;
}

/** Options a web client may override per job. dataDir/model-provider internals are deliberately excluded. */
const optionsSchema = configSchema.omit({ dataDir: true, maxTokens: true, awsRegion: true, awsProfile: true }).partial()
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
  const opts = optionsSchema.safeParse(b.options ?? {});
  if (!opts.success) throw new Error('Invalid options: ' + opts.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; '));
  const ids = b.journeyIds;
  if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === 'string'))) throw new Error('journeyIds must be a string array');
  if (b.failedOnly !== undefined && typeof b.failedOnly !== 'boolean') throw new Error('failedOnly must be a boolean');
  if (b.failedOnly !== undefined && b.action !== 'heal') throw new Error('failedOnly only applies to action "heal"');
  // zod fills in schema defaults for absent keys; keep only what the client sent, or an omitted `provider`/`model`/... would
  // silently reset the server's own configuration.
  const sent = (b.options ?? {}) as Record<string, unknown>;
  const options = Object.fromEntries(Object.entries(opts.data).filter(([k]) => k in sent)) as JobOptions;
  return { action: b.action as Action, url: b.url, options, journeyIds: ids as string[] | undefined, ...(b.failedOnly === undefined ? {} : { failedOnly: b.failedOnly }), rediscover: b.rediscover === true, regenerate: b.regenerate === true };
}

export class JobManager {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<(e: ProgressEvent) => void>>();
  constructor(private base: Config, private llm?: LLMProvider) {}

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

  start(req: JobRequest): Job {
    const site = normalizeSite(req.url).id;
    const busy = this.running(site);
    if (busy) throw Object.assign(new Error(`A job (${busy.id}) is already running for ${site}`), { statusCode: 409 });
    const job: Job = { id: randomUUID(), action: req.action, url: req.url, site, status: 'running', startedAt: new Date().toISOString(), events: [] };
    this.jobs.set(job.id, job);
    const config = mergeJobConfig(this.base, req.options);
    const ctx = createContext({ config, llm: this.llm, onProgress: (e) => this.emit(job, e) });
    void (async () => {
      try {
        switch (req.action) {
          case 'discover': { const d = await discover(ctx, req.url, { rediscover: req.rediscover }); job.result = { journeys: d.journeys.length, reused: d.reused }; break; }
          case 'generate': { const g = await generate(ctx, req.url, { regenerate: req.regenerate, rediscover: req.rediscover }); job.result = g.result; break; }
          case 'run': job.result = await run(ctx, req.url, { journeyIds: req.journeyIds }); break;
          case 'heal': job.result = await healSelected(ctx, req.url, { ids: req.journeyIds, failedOnly: req.failedOnly }); break;
          case 'all': job.result = await runAll(ctx, req.url, { rediscover: req.rediscover, regenerate: req.regenerate }); break;
        }
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        this.emit(job, { type: 'done', message: `${req.action} finished`, data: job.result });
      } catch (e) {
        job.status = 'error';
        job.error = (e as Error).message;
        job.finishedAt = new Date().toISOString();
        this.emit(job, { type: 'error', message: job.error });
      }
    })();
    return job;
  }
}
