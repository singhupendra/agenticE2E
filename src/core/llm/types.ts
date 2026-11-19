import type { z } from 'zod';

export interface LLMImage {
  mediaType: 'image/png' | 'image/jpeg';
  data: string; /* base64 */
}

export interface StructuredRequest<T = unknown> {
  /** tool / schema name, e.g. "propose_journeys" */
  name: string;
  description: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  images?: LLMImage[];
}

/**
 * Pluggable LLM provider. Implementations return output already validated against
 * `req.schema` (throwing LLMOutputError otherwise).
 */
export interface LLMProvider {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

export class LLMOutputError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'LLMOutputError';
  }
}

/** SPEC-013: tokens reported by the provider for one call. */
export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface LLMCallOptions {
  signal?: AbortSignal;
}
export interface LLMResult<T> {
  data: T;
  usage?: LLMTokenUsage;
  /** model id as sent to the backend */ model?: string;
}
/** SPEC-013: providers that can report usage implement this in addition to `structured`. */
export interface DetailedLLMProvider extends LLMProvider {
  structuredDetailed<T>(req: StructuredRequest<T>, opts?: LLMCallOptions): Promise<LLMResult<T>>;
}
export const isDetailedProvider = (p: LLMProvider): p is DetailedLLMProvider =>
  typeof (p as Partial<DetailedLLMProvider>).structuredDetailed === 'function';

/** SPEC-013 FR-15: the per-run LLM budget is exhausted. Never swallowed by per-item error handling. */
export class LLMBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMBudgetError';
  }
}

/** SPEC-013 FR-19: one attempt took longer than `llmTimeoutMs`. Retryable. */
export class LLMTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs} ms`);
    this.name = 'LLMTimeoutError';
  }
}
