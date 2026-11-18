import type { Logger } from '../obs/logger.js';
import type { Span, Tracer } from '../obs/tracing.js';
import { estimateCostUsd } from './models.js';
import type { ResponseCache } from './response-cache.js';
import { withRetry, type RetryOptions } from './retry.js';
import { isDetailedProvider, type LLMProvider, type LLMTokenUsage, type StructuredRequest } from './types.js';
import type { UsageTracker } from './usage.js';

export interface GovernedOptions {
  /** what the run is configured with; a provider-reported model wins for pricing */
  provider: string;
  model: string;
  usage: UsageTracker;
  retry: Omit<RetryOptions, 'onRetry'>;
  cache?: ResponseCache;
  log?: Logger;
  tracer?: Tracer;
  /** span the LLM call spans are children of (e.g. the current pipeline stage) */
  parentSpan?: () => Span | undefined;
}

const ZERO: LLMTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * SPEC-013: wraps a provider with budget checks, the response cache, retries/timeouts, usage accounting, logs and spans.
 * Sits *inside* `RedactingLLM`, so everything it sees, caches and logs is already redacted.
 */
export class GovernedLLM implements LLMProvider {
  constructor(private inner: LLMProvider, private opts: GovernedOptions) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { usage, log, cache } = this.opts;
    try {
      usage.check('before');
    } catch (e) {
      log?.error({ call: usage.calls.length + 1, name: req.name, error: (e as Error).message }, 'llm.budget_exceeded');
      throw e;
    }
    const target = { provider: this.opts.provider, model: this.opts.model };
    const span = this.opts.tracer?.startSpan(`llm ${req.name}`, {
      parent: this.opts.parentSpan?.(),
      attributes: { 'gen_ai.system': target.provider, 'gen_ai.request.model': target.model, 'gen_ai.operation.name': req.name },
    });
    const started = Date.now();

    const key = cache?.readable ? cache.key(req as StructuredRequest<unknown>, target) : undefined;
    const hit = key ? cache!.get(key, req.schema) : undefined;
    if (hit !== undefined) {
      const rec = usage.record({ name: req.name, ...target, ...ZERO, latencyMs: Date.now() - started, costUsd: 0, retries: 0, cached: true, ok: true });
      log?.info({ call: rec.n, name: req.name, model: target.model, cached: true }, 'llm.call');
      span?.setAttributes({ 'agentic_e2e.cached': true, 'agentic_e2e.cost_usd': 0 });
      span?.end();
      return hit;
    }

    try {
      const { value, retries } = await withRetry(async (signal) => {
        if (isDetailedProvider(this.inner)) return this.inner.structuredDetailed(req, { signal });
        return { data: await this.inner.structured(req) };
      }, {
        ...this.opts.retry,
        onRetry: (i) => log?.warn({ call: usage.calls.length + 1, name: req.name, attempt: i.attempt, status: i.status, delayMs: i.delayMs, error: i.error }, 'llm.retry'),
      });
      const model = value.model ?? target.model;
      const u = value.usage ?? ZERO;
      const costUsd = estimateCostUsd(model, u);
      const rec = usage.record({ name: req.name, provider: target.provider, model, ...u, latencyMs: Date.now() - started, costUsd, retries, cached: false, ok: true });
      log?.info({ call: rec.n, name: req.name, model, ...u, latencyMs: rec.latencyMs, costUsd, retries }, 'llm.call');
      span?.setAttributes({
        'gen_ai.response.model': model, 'gen_ai.usage.input_tokens': u.inputTokens, 'gen_ai.usage.output_tokens': u.outputTokens,
        'gen_ai.usage.cache_read_input_tokens': u.cacheReadTokens, 'gen_ai.usage.cache_creation_input_tokens': u.cacheWriteTokens,
        'agentic_e2e.cost_usd': costUsd, 'agentic_e2e.cached': false, 'agentic_e2e.retries': retries,
      });
      if (key) cache!.set(key, { name: req.name, model, output: value.data });
      try {
        usage.check('after');
      } catch (e) {
        log?.error({ call: rec.n, name: req.name, error: (e as Error).message }, 'llm.budget_exceeded');
        span?.recordError(e);
        throw e;
      }
      return value.data;
    } catch (e) {
      const retries = (e as { retries?: number }).retries ?? 0;
      if ((e as Error)?.name !== 'LLMBudgetError') {
        // A response that arrived but was unusable (e.g. LLMOutputError) carries the usage it was billed for.
        const paid = (e as { usage?: LLMTokenUsage }).usage;
        const model = (e as { model?: string }).model ?? target.model;
        const u = paid ?? ZERO;
        const costUsd = paid ? estimateCostUsd(model, u) : 0;
        const rec = usage.record({ name: req.name, provider: target.provider, model, ...u, latencyMs: Date.now() - started, costUsd, retries, cached: false, ok: false, error: (e as Error).message });
        log?.error({ call: rec.n, name: req.name, model, retries, ...(paid ? { ...u, costUsd } : {}), error: (e as Error).message }, 'llm.failed');
        span?.setAttributes({ 'agentic_e2e.retries': retries, ...(paid ? { 'gen_ai.usage.input_tokens': u.inputTokens, 'gen_ai.usage.output_tokens': u.outputTokens, 'agentic_e2e.cost_usd': costUsd } : {}) });
        span?.recordError(e);
        if (paid) {
          try {
            usage.check('after'); // the budget applies to paid-for failures too
          } catch (b) {
            log?.error({ call: rec.n, name: req.name, error: (b as Error).message }, 'llm.budget_exceeded');
            throw b;
          }
        }
      }
      throw e;
    } finally {
      span?.end();
    }
  }
}
