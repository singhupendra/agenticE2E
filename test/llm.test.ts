import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../src/core/llm/anthropic.js';
import { LLMOutputError } from '../src/core/llm/types.js';

const schema = z.object({ code: z.string() });
const fake = (content: unknown[]) => {
  const calls: any[] = [];
  return { calls, client: { messages: { create: async (p: any) => { calls.push(p); return { content, stop_reason: 'tool_use' }; } } } as any };
};

describe('AnthropicProvider', () => {
  it('forces tool use and validates output', async () => {
    const f = fake([{ type: 'tool_use', name: 't', input: { code: 'x' } }]);
    const p = new AnthropicProvider({ model: 'm', client: f.client });
    const out = await p.structured({ name: 't', description: 'd', system: 's', prompt: 'p', schema, images: [{ mediaType: 'image/png', data: 'AAA' }] });
    expect(out).toEqual({ code: 'x' });
    expect(f.calls[0].tool_choice).toEqual({ type: 'tool', name: 't' });
    expect(f.calls[0].tools[0].input_schema.properties.code).toBeDefined();
    expect(f.calls[0].tools[0].input_schema.$schema).toBeUndefined();
    expect(f.calls[0].messages[0].content[0].type).toBe('image');
    expect(f.calls[0].model).toBe('m');
  });

  it('throws LLMOutputError on schema mismatch or missing tool call', async () => {
    const bad = new AnthropicProvider({ model: 'm', client: fake([{ type: 'tool_use', name: 't', input: { nope: 1 } }]).client });
    await expect(bad.structured({ name: 't', description: 'd', system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(LLMOutputError);
    const none = new AnthropicProvider({ model: 'm', client: fake([{ type: 'text', text: 'hi' }]).client });
    await expect(none.structured({ name: 't', description: 'd', system: 's', prompt: 'p', schema })).rejects.toThrow(/did not call tool/);
  });

  it('SPEC-002 AC-13: auto tool_choice for models that reject forced tool use', async () => {
    const f = fake([{ type: 'tool_use', name: 't', input: { code: 'x' } }]);
    await new AnthropicProvider({ model: 'claude-opus-5-5', client: f.client }).structured({ name: 't', description: 'd', system: 's', prompt: 'p', schema });
    expect(f.calls[0].tool_choice).toEqual({ type: 'auto' });
    expect(f.calls[0].system).toMatch(/calling the `t` tool/i);
  });

  it('requires an API key', () => {
    const old = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    expect(() => new AnthropicProvider({ model: 'm' })).toThrow(/ANTHROPIC_API_KEY/);
    if (old) process.env.ANTHROPIC_API_KEY = old;
  });
});
