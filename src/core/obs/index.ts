import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';
import { GovernedLLM } from '../llm/governed.js';
import { ResponseCache } from '../llm/response-cache.js';
import type { LLMProvider } from '../llm/types.js';
import { UsageTracker, formatUsageSummary } from '../llm/usage.js';
import type { SecretEntry } from '../redact.js';
import type { ProgressEvent } from '../types.js';
import { AUDIT_FILE, AuditLog, cliActor } from './audit.js';
import { createLogger, type LogStream, type Logger } from './logger.js';
import { buildLogRedactor } from './secrets.js';
import { createTracer, type Span, type Tracer } from './tracing.js';
import { saveUsageReport, type UsageReport } from './usage-store.js';
import type { StorageBackend } from '../storage/backend.js';
import { FilesystemBackend } from '../storage/filesystem.js';

export { formatUsageSummary };
export type { Logger, Span, Tracer, UsageReport };

export interface ObservabilityOptions {
  /** default: a fresh UUID (web jobs pass the job id) */
  correlationId?: string;
  /** `cli:<user>` / `web:<ip>`; default `cli:<os user>` */
  actor?: string;
  action?: string;
  site?: string;
  /** log destination (default stderr) */
  logStream?: LogStream;
  /** secrets + OTLP config (default process.env) */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** SPEC-014 FR-30: where usage reports and the response cache are stored (default: filesystem on `dataDir`) */
  storage?: StorageBackend;
}

export interface Observability {
  readonly correlationId: string;
  readonly actor: string;
  readonly log: Logger;
  readonly usage: UsageTracker;
  readonly audit: AuditLog;
  readonly tracer: Tracer;
  /** Wraps a provider with budgets, retries, the response cache, usage accounting, logs and spans. */
  governLLM(inner: LLMProvider): LLMProvider;
  /** Mirrors a (redacted) progress event to the log at debug and opens a span per pipeline stage. */
  progress(e: ProgressEvent): void;
  /** Ends spans, flushes the exporter, persists the usage report (when there were LLM calls). Never throws. */
  finish(o: { action?: string; site?: string; status: 'ok' | 'error'; error?: string }): Promise<UsageReport | null>;
}

const providerInfo = (inner: LLMProvider, config: Config) => ({
  provider: (inner as { provider?: string }).provider ?? config.provider,
  model: (inner as { model?: string }).model ?? config.model,
});

export function createObservability(config: Config, credentialSecrets: SecretEntry[], opts: ObservabilityOptions = {}): Observability {
  const env = opts.env ?? process.env;
  const correlationId = opts.correlationId ?? randomUUID();
  const actor = opts.actor ?? cliActor();
  const redactor = buildLogRedactor(credentialSecrets, env);
  const startedAt = new Date().toISOString();
  const log = createLogger({
    level: config.logLevel, format: config.logFormat, redactor, stream: opts.logStream,
    bindings: { correlationId, ...(opts.action ? { action: opts.action } : {}), ...(opts.site ? { site: opts.site } : {}) },
  });
  const usage = new UsageTracker({ budget: config.llmBudget, onWarn: (m) => log.warn(m) });
  const storage = opts.storage ?? new FilesystemBackend(config.dataDir);
  const audit = new AuditLog({ file: path.join(config.dataDir, AUDIT_FILE), actor, correlationId, redactor, enabled: config.auditLog });
  const tracer = config.tracing === 'off' ? createTracer({ env: {} }) : createTracer({ env, fetch: opts.fetch, redactor, log });
  const root = tracer.startSpan(`agentic-e2e.${opts.action ?? 'run'}`, {
    traceId: correlationId.replace(/-/g, '').toLowerCase(),
    attributes: { 'agentic_e2e.correlation_id': correlationId, 'agentic_e2e.site': opts.site, 'agentic_e2e.actor': actor },
  });
  let stageSpan: Span | undefined;
  let provider = { provider: config.provider as string, model: config.model };
  let finished = false;

  return {
    correlationId, actor, log, usage, audit, tracer,
    governLLM(inner) {
      provider = providerInfo(inner, config);
      return new GovernedLLM(inner, {
        ...provider, usage, log, tracer,
        parentSpan: () => stageSpan ?? root,
        retry: { maxRetries: config.llmMaxRetries, timeoutMs: config.llmTimeoutMs },
        cache: config.llmCache === 'off' ? undefined : new ResponseCache({ storage, prefix: 'llm-cache/', mode: config.llmCache, redactor }),
      });
    },
    progress(e) {
      log.debug({ type: e.type, stage: e.stage, message: e.message }, 'progress');
      if (e.type === 'stage' && e.stage) {
        stageSpan?.end();
        stageSpan = tracer.startSpan(`stage ${e.stage}`, { parent: root, attributes: { 'agentic_e2e.stage': e.stage } });
      } else if (e.type === 'error') stageSpan?.recordError(new Error(e.message));
    },
    async finish(o) {
      if (finished) return null;
      finished = true;
      try {
        const totals = usage.totals();
        const site = o.site ?? opts.site;
        const action = o.action ?? opts.action ?? 'run';
        (o.status === 'error' ? log.warn.bind(log) : log.info.bind(log))({ action, status: o.status, ...(o.error ? { error: o.error } : {}), ...totals }, 'command.finished');
        stageSpan?.end();
        root.setAttributes({ 'agentic_e2e.llm.calls': totals.calls, 'agentic_e2e.llm.total_tokens': totals.totalTokens, 'agentic_e2e.cost_usd': totals.costUsd, 'agentic_e2e.site': site });
        if (o.status === 'error') root.recordError(new Error(o.error ?? 'failed'));
        root.end();
        await tracer.flush();
        if (!site || !totals.calls) return null;
        const report: UsageReport = {
          id: correlationId, action, site, actor, startedAt, finishedAt: new Date().toISOString(), status: o.status,
          ...(o.error ? { error: o.error } : {}), ...provider, ...(config.llmBudget ? { budget: config.llmBudget } : {}), totals, calls: usage.calls,
        };
        await saveUsageReport(storage, site, report, redactor);
        return report;
      } catch (e) {
        log.warn({ error: (e as Error).message }, 'obs.finish_failed');
        return null;
      }
    },
  };
}
