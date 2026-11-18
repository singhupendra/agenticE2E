import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { DetailedLLMProvider, LLMCallOptions, LLMResult, StructuredRequest } from './types.js';
import { LLMOutputError } from './types.js';
import { resolveModelId, supportsForcedToolChoice, type ProviderId } from './models.js';

export interface AnthropicOptions {
  apiKey?: string; model: string; maxTokens?: number; client?: Pick<Anthropic, 'messages'>;
  /** Which backend `client` talks to; decides how `model` is normalised. Default 'anthropic'. */
  provider?: ProviderId;
  /** SPEC-013 FR-20: explicit `cache_control` breakpoint on the system prompt (default off here; config default on). */
  promptCaching?: boolean;
  /** SPEC-013 FR-19: per-request timeout passed to the SDK (the governed layer also enforces it). */
  timeoutMs?: number;
}

/**
 * Anthropic Messages-API provider (first-party or Bedrock): requests a single tool call whose input_schema is the
 * JSON Schema of the zod schema. The call is forced where the model allows it, otherwise requested in the system prompt.
 */
export class AnthropicProvider implements DetailedLLMProvider {
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
    return (await this.structuredDetailed(req)).data;
  }

  async structuredDetailed<T>(req: StructuredRequest<T>, callOpts: LLMCallOptions = {}): Promise<LLMResult<T>> {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    const content: Anthropic.ContentBlockParam[] = [
      ...(req.images ?? []).map((i): Anthropic.ContentBlockParam => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
      { type: 'text', text: req.prompt },
    ];
    const forced = supportsForcedToolChoice(this.model);
    const systemText = forced ? req.system : `${req.system}\n\nYou must respond by calling the \`${req.name}\` tool exactly once, with no other output.`;
    // An explicit breakpoint (not top-level automatic caching, which the legacy Bedrock runtime rejects on older models).
    const system: string | Anthropic.TextBlockParam[] = this.opts.promptCaching ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] : systemText;
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.opts.maxTokens ?? 8000,
      system,
      messages: [{ role: 'user', content }],
      tools: [{ name: req.name, description: req.description, input_schema: inputSchema as Anthropic.Tool.InputSchema }],
      tool_choice: forced ? { type: 'tool', name: req.name } : { type: 'auto' },
    }, { maxRetries: 0, ...(callOpts.signal ? { signal: callOpts.signal } : {}), ...(this.opts.timeoutMs ? { timeout: this.opts.timeoutMs } : {}) });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.name);
    if (!block) throw new LLMOutputError(`Model did not call tool ${req.name} (stop_reason=${res.stop_reason})`);
    const parsed = req.schema.safeParse(block.input);
    if (!parsed.success) throw new LLMOutputError(`Invalid ${req.name} output (schema): ${parsed.error.message}`, block.input);
    const u = res.usage;
    return {
      data: parsed.data,
      model: this.model,
      usage: { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0, cacheReadTokens: u?.cache_read_input_tokens ?? 0, cacheWriteTokens: u?.cache_creation_input_tokens ?? 0 },
    };
  }
}
