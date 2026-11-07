import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createBedrockProvider } from '../src/core/llm/bedrock.js';
import { createLLMProvider } from '../src/core/llm/index.js';
import { resolveConfig } from '../src/core/config.js';

const schema = z.object({ code: z.string() });
const fakeClient = () => {
  const calls: any[] = [];
  return { calls, client: { messages: { create: async (p: any) => { calls.push(p); return { content: [{ type: 'tool_use', name: 't', input: { code: 'ok' } }], stop_reason: 'tool_use' }; } } } as any };
};
const req = { name: 't', description: 'd', system: 's', prompt: 'p', schema };

describe('Bedrock provider (SPEC-002)', () => {
  it('AC-10: uses the bedrock model id and returns validated output', async () => {
    const f = fakeClient();
    const p = createBedrockProvider({ model: 'claude-haiku-4-5', awsRegion: 'us-east-1', createClient: () => f.client });
    expect(await p.structured(req)).toEqual({ code: 'ok' });
    expect(f.calls[0].model).toBe('anthropic.claude-haiku-4-5');
  });

  it('AC-11: no region anywhere -> clear error', () => {
    expect(() => createBedrockProvider({ model: 'm', env: {}, createClient: () => fakeClient().client })).toThrow(/AWS_REGION/);
  });

  it('AC-12: region from AWS_REGION / AWS_DEFAULT_REGION; explicit wins', () => {
    const seen: string[] = [];
    const createClient = (o: { awsRegion: string }) => { seen.push(o.awsRegion); return fakeClient().client; };
    createBedrockProvider({ model: 'm', env: { AWS_REGION: 'eu-west-1' }, createClient });
    createBedrockProvider({ model: 'm', env: { AWS_DEFAULT_REGION: 'ap-south-1' }, createClient });
    createBedrockProvider({ model: 'm', awsRegion: 'us-west-2', env: { AWS_REGION: 'eu-west-1' }, createClient });
    expect(seen).toEqual(['eu-west-1', 'ap-south-1', 'us-west-2']);
  });

  it('AC-13: auto tool_choice + instruction for models that reject forced tool use', async () => {
    const f = fakeClient();
    await createBedrockProvider({ model: 'claude-sonnet-5-5', awsRegion: 'us-east-1', createClient: () => f.client }).structured(req);
    expect(f.calls[0].tool_choice).toEqual({ type: 'auto' });
    expect(f.calls[0].system).toContain('s');
    expect(f.calls[0].system).toMatch(/calling the `t` tool/i);
    const g = fakeClient();
    await createBedrockProvider({ model: 'claude-haiku-4-5', awsRegion: 'us-east-1', createClient: () => g.client }).structured(req);
    expect(g.calls[0].tool_choice).toEqual({ type: 'tool', name: 't' });
    expect(g.calls[0].system).toBe('s');
  });

  it('AC-14: factory picks the provider from config', () => {
    const a = createLLMProvider(resolveConfig({ cli: { provider: 'anthropic', model: 'anthropic.claude-opus-5-5' } }), { apiKey: 'k' });
    expect(a).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    const b = createLLMProvider(resolveConfig({ cli: { provider: 'bedrock', awsRegion: 'us-east-1' } }), { createBedrockClient: () => fakeClient().client });
    expect(b).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5' });
  });
});
