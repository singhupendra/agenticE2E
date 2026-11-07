import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LLMProvider, StructuredRequest } from './types.js';
import { LLMOutputError } from './types.js';
import { resolveModelId, supportsForcedToolChoice, type ProviderId } from './models.js';

export interface AnthropicOptions {
  apiKey?: string; model: string; maxTokens?: number; client?: Pick<Anthropic, 'messages'>;
  /** Which backend `client` talks to; decides how `model` is normalised. Default 'anthropic'. */
  provider?: ProviderId;
}

/**
 * Anthropic Messages-API provider (first-party or Bedrock): requests a single tool call whose input_schema is the
 * JSON Schema of the zod schema. The call is forced where the model allows it, otherwise requested in the system prompt.
 */
export class AnthropicProvider implements LLMProvider {
  private client: Pick<Anthropic, 'messages'>;
  readonly provider: ProviderId;
  /** Model id as sent to the backend. */
  readonly model: string;
  constructor(private opts: AnthropicOptions) {
    this.provider = opts.provider ?? 'anthropic';
    this.model = resolveModelId(this.provider, opts.model);
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
    const forced = supportsForcedToolChoice(this.model);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 8000,
      system: forced ? req.system : `${req.system}\n\nYou must respond by calling the \`${req.name}\` tool exactly once, with no other output.`,
      messages: [{ role: 'user', content }],
      tools: [{ name: req.name, description: req.description, input_schema: inputSchema as Anthropic.Tool.InputSchema }],
      tool_choice: forced ? { type: 'tool', name: req.name } : { type: 'auto' },
    });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.name);
    if (!block) throw new LLMOutputError(`Model did not call tool ${req.name} (stop_reason=${res.stop_reason})`);
    const parsed = req.schema.safeParse(block.input);
    if (!parsed.success) throw new LLMOutputError(`Invalid ${req.name} output (schema): ${parsed.error.message}`, block.input);
    return parsed.data;
  }
}
