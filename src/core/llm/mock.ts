import type { LLMProvider, StructuredRequest } from './types.js';
import { LLMOutputError } from './types.js';

/** Scripted provider for tests/offline use. The handler returns the raw object the "model" would produce. */
export class MockLLM implements LLMProvider {
  calls: StructuredRequest<unknown>[] = [];
  constructor(private handler: (req: StructuredRequest<unknown>, callIndex: number) => unknown | Promise<unknown>) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    this.calls.push(req as StructuredRequest<unknown>);
    const raw = await this.handler(req as StructuredRequest<unknown>, this.calls.length - 1);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new LLMOutputError(`Invalid ${req.name} output (schema): ${parsed.error.message}`, raw);
    return parsed.data;
  }
  callsFor(name: string) { return this.calls.filter((c) => c.name === name); }
}
