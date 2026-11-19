import { LLMTimeoutError } from './types.js';

/** SPEC-013 FR-18/19: retries with exponential backoff + full jitter for transient LLM failures. */
export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}
export interface RetryOptions extends Partial<BackoffPolicy> {
  maxRetries: number;
  /** per attempt; the attempt's AbortSignal is aborted when it elapses */
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: RetryInfo) => void;
}
export interface RetryInfo {
  attempt: number;
  delayMs: number;
  status?: number;
  error: string;
}

const RETRYABLE_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'LLMTimeoutError',
  'InternalServerError',
  'RateLimitError',
]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const MAX_RETRY_AFTER_MS = 60_000;

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown; statusCode?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' ? s : undefined;
};

export function isRetryable(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const status = statusOf(e);
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500;
  const { name, code } = e as { name?: string; code?: string };
  return (!!name && RETRYABLE_NAMES.has(name)) || (!!code && RETRYABLE_CODES.has(code));
}

/** `retry-after` (seconds) from an SDK error's headers (a `Headers` instance or a plain record), capped at 60 s. */
export function retryAfterMs(e: unknown): number | undefined {
  const h = (e as { headers?: unknown })?.headers;
  if (!h) return undefined;
  const raw =
    typeof (h as Headers).get === 'function'
      ? (h as Headers).get('retry-after')
      : (h as Record<string, string | undefined>)['retry-after'];
  const secs = raw === undefined || raw === null ? NaN : Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/** Full jitter: uniform in [0, min(maxDelay, base * 2^attempt)]. `attempt` is 0 for the first retry. */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function attemptWithTimeout<T>(
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  attempt: number,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new LLMTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac.signal, attempt), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `fn` until it succeeds, a non-retryable error occurs, or `maxRetries` is exhausted (the error gets `.retries`). */
export async function withRetry<T>(
  fn: (signal: AbortSignal, attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<{ value: T; retries: number }> {
  const policy = { baseDelayMs: opts.baseDelayMs ?? 500, maxDelayMs: opts.maxDelayMs ?? 20_000 };
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await attemptWithTimeout(fn, attempt, opts.timeoutMs), retries: attempt };
    } catch (e) {
      if (attempt >= opts.maxRetries || !isRetryable(e)) {
        if (e && typeof e === 'object') Object.assign(e, { retries: attempt });
        throw e;
      }
      const delayMs = Math.max(backoffDelay(attempt, policy, opts.random), retryAfterMs(e) ?? 0);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, status: statusOf(e), error: (e as Error).message });
      await sleep(delayMs);
    }
  }
}
