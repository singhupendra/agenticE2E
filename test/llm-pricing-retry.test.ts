import { describe, it, expect } from 'vitest';
import { estimateCostUsd, modelPricing } from '../src/core/llm/models.js';
import { backoffDelay, isRetryable, retryAfterMs, withRetry } from '../src/core/llm/retry.js';
import { LLMBudgetError, LLMOutputError, LLMTimeoutError } from '../src/core/llm/types.js';

const httpErr = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, headers });

describe('SPEC-013 pricing table', () => {
  it('AC-6: resolves bare, prefixed and suffixed ids', () => {
    expect(modelPricing('claude-opus-5-5')).toMatchObject({ input: 4, output: 20, cacheRead: 0.2 });
    expect(modelPricing('global.anthropic.claude-opus-5-5')).toEqual(modelPricing('claude-opus-5-5'));
    expect(modelPricing('us.anthropic.claude-sonnet-5-5')).toEqual(modelPricing('claude-sonnet-5-5'));
    expect(modelPricing('anthropic.claude-haiku-4-5-20251001-v1:0')).toMatchObject({ input: 1, output: 5 });
    expect(modelPricing('claude-opus-5')).toMatchObject({ input: 5 }); // not confused with opus-5-5
    expect(modelPricing('my-custom-model')).toBeUndefined();
  });

  it('AC-5: estimates cost per token kind', () => {
    const cost = estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 });
    expect(cost).toBeCloseTo((1000 * 2 + 500 * 10 + 2000 * 0.1 + 100 * 2.5) / 1e6, 10);
    expect(estimateCostUsd('my-custom-model', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined();
  });

  it('every catalog model has a price', async () => {
    const { listModels } = await import('../src/core/llm/models.js');
    for (const m of listModels('bedrock')) expect(modelPricing(m.id), m.id).toBeDefined();
  });
});

describe('SPEC-013 retry with backoff + jitter', () => {
  it('classifies retryable errors', () => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) expect(isRetryable(httpErr(s)), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isRetryable(httpErr(s)), String(s)).toBe(false);
    expect(isRetryable(Object.assign(new Error('x'), { name: 'APIConnectionError' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(new LLMTimeoutError(10))).toBe(true);
    expect(isRetryable(new LLMOutputError('bad'))).toBe(false);
    expect(isRetryable(new LLMBudgetError('over'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('full jitter exponential delay, capped', () => {
    const p = { baseDelayMs: 500, maxDelayMs: 20_000 };
    expect(backoffDelay(0, p, () => 1)).toBe(500);
    expect(backoffDelay(1, p, () => 1)).toBe(1000);
    expect(backoffDelay(3, p, () => 0.5)).toBe(2000);
    expect(backoffDelay(10, p, () => 1)).toBe(20_000);
    expect(backoffDelay(2, p, () => 0)).toBe(0);
  });

  it('reads retry-after (seconds), from a record or Headers, capped at 60s', () => {
    expect(retryAfterMs(httpErr(429, { 'retry-after': '3' }))).toBe(3000);
    expect(retryAfterMs(Object.assign(new Error(), { status: 429, headers: new Headers({ 'retry-after': '2' }) }))).toBe(2000);
    expect(retryAfterMs(httpErr(429, { 'retry-after': '9999' }))).toBe(60_000);
    expect(retryAfterMs(httpErr(429))).toBeUndefined();
  });

  it('AC-10: retries 429 then 500, then succeeds', async () => {
    const sleeps: number[] = [];
    const retries: { attempt: number; delayMs: number; status?: number }[] = [];
    let n = 0;
    const r = await withRetry(async () => { n++; if (n === 1) throw httpErr(429); if (n === 2) throw httpErr(500); return 'ok'; }, {
      maxRetries: 3, timeoutMs: 1000, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, onRetry: (i) => retries.push(i),
    });
    expect(r).toEqual({ value: 'ok', retries: 2 });
    expect(sleeps).toEqual([250, 500]);
    expect(retries.map((x) => x.status)).toEqual([429, 500]);
  });

  it('AC-11: no retry for 400 / schema errors; gives up after maxRetries', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw httpErr(400); }, { maxRetries: 3, timeoutMs: 1000, sleep: async () => {} })).rejects.toThrow('HTTP 400');
    expect(n).toBe(1);
    n = 0;
    await expect(withRetry(async () => { n++; throw new LLMOutputError('schema'); }, { maxRetries: 3, timeoutMs: 1000, sleep: async () => {} })).rejects.toBeInstanceOf(LLMOutputError);
    expect(n).toBe(1);
    n = 0;
    const err = await withRetry(async () => { n++; throw httpErr(503); }, { maxRetries: 2, timeoutMs: 1000, sleep: async () => {} }).catch((e) => e);
    expect(n).toBe(3);
    expect(err.status).toBe(503);
    expect(err.retries).toBe(2);
  });

  it('AC-12: honours retry-after and aborts a hanging attempt on timeout', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(async () => { n++; if (n === 1) throw httpErr(429, { 'retry-after': '3' }); return 1; }, { maxRetries: 1, timeoutMs: 1000, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.1 });
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);

    const signals: AbortSignal[] = [];
    let m = 0;
    const r = await withRetry(async (signal) => {
      signals.push(signal); m++;
      if (m === 1) return new Promise<never>(() => {}); // hangs forever
      return 'second';
    }, { maxRetries: 1, timeoutMs: 30, sleep: async () => {} });
    expect(r.value).toBe('second');
    expect(signals[0].aborted).toBe(true);
    const e = await withRetry(() => new Promise<never>(() => {}), { maxRetries: 0, timeoutMs: 20, sleep: async () => {} }).catch((x) => x);
    expect(e).toBeInstanceOf(LLMTimeoutError);
  });
});
