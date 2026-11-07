import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LLMProvider, StructuredRequest } from './types.js';
import { LLMOutputError } from './types.js';

export interface AnthropicOptions { apiKey?: string; model: string; maxTokens?: number; client?: Pick<Anthropic, 'messages'> }

/** Anthropic provider: forces a single tool call whose input_schema is the JSON Schema of the zod schema. */
export class AnthropicProvider implements LLMProvider {
  private client: Pick<Anthropic, 'messages'>;
  constructor(private opts: AnthropicOptions) {
    if (opts.client) this.client = opts.client;
    else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Export it, or use a different LLM provider.');
      this.client = new Anthropic({ apiKey });
    }
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    const content: Anthropic.ContentBlockParam[] = [
      ...(req.images ?? []).map((i): Anthropic.ContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
      { type: 'text', text: req.prompt },
    ];
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? 8000,
      system: req.system,
      messages: [{ role: 'user', content }],
      tools: [{ name: req.name, description: req.description, input_schema: inputSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: 'tool', name: req.name },
    });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.name);
    if (!block) throw new LLMOutputError(`Model did not call tool ${req.name} (stop_reason=${res.stop_reason})`);
    const parsed = req.schema.safeParse(block.input);
    if (!parsed.success) throw new LLMOutputError(`Invalid ${req.name} output (schema): ${parsed.error.message}`, block.input);
    return parsed.data;
  }
}
