import type { Redactor } from '../redact.js';
import type { LLMProvider, StructuredRequest } from './types.js';

/**
 * Defence in depth (SPEC-009): prompts are built from placeholders, but anything that slipped through (page text echoing
 * the username, an error message, ...) is replaced before it reaches the provider. Outputs are returned untouched so
 * codegen/heal can *detect and reject* a generated secret instead of silently turning it into a placeholder.
 */
export class RedactingLLM implements LLMProvider {
  constructor(private inner: LLMProvider, private redactor: Redactor, private opts: { dropImages: boolean }) {}
  structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { images, ...rest } = req;
    return this.inner.structured({
      ...rest,
      system: this.redactor.redact(req.system),
      prompt: this.redactor.redact(req.prompt),
      ...(images && !this.opts.dropImages ? { images } : {}),
    });
  }
}
