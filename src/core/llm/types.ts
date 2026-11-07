import type { z } from 'zod';

export interface LLMImage { mediaType: 'image/png' | 'image/jpeg'; data: string /* base64 */ }

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
  constructor(message: string, public readonly raw?: unknown) {
    super(message);
    this.name = 'LLMOutputError';
  }
}
