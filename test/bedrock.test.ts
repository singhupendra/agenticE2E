import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createBedrockProvider } from '../src/core/llm/bedrock.js';
import { createLLMProvider } from '../src/core/llm/index.js';
import { resolveConfig } from '../src/core/config.js';
import { fakeAwsFiles, SAMPLE_CONFIG, SAMPLE_CREDENTIALS } from './helpers/aws-files.js';

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

  describe('AWS profile (SPEC-003)', () => {
    const aws = () => fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS);
    const seen = () => {
      const calls: { awsRegion: string; awsProfile?: string }[] = [];
      return { calls, createClient: (o: { awsRegion: string; awsProfile?: string }) => { calls.push(o); return fakeClient().client; } };
    };

    it('AC-7: passes the selected profile to the client; none -> undefined', () => {
      const s = seen();
      createBedrockProvider({ model: 'm', awsProfile: 'dev', env: aws(), createClient: s.createClient });
      createBedrockProvider({ model: 'm', awsRegion: 'us-east-1', env: aws(), createClient: s.createClient });
      expect(s.calls[0]).toEqual({ awsRegion: 'eu-west-1', awsProfile: 'dev' });
      expect(s.calls[1].awsProfile).toBeUndefined();
    });

    it('AC-8: region precedence awsRegion > profile region > AWS_REGION > AWS_DEFAULT_REGION', () => {
      const s = seen();
      const e = (extra: Record<string, string> = {}) => ({ ...aws(), ...extra });
      createBedrockProvider({ model: 'm', awsProfile: 'dev', awsRegion: 'ap-south-1', env: e(), createClient: s.createClient });
      createBedrockProvider({ model: 'm', awsProfile: 'dev', env: e({ AWS_REGION: 'us-west-2' }), createClient: s.createClient });
      createBedrockProvider({ model: 'm', env: e({ AWS_REGION: 'us-west-2' }), createClient: s.createClient });
      createBedrockProvider({ model: 'm', awsProfile: 'ci', env: e({ AWS_DEFAULT_REGION: 'ca-central-1' }), createClient: s.createClient });
      expect(s.calls.map((c) => c.awsRegion)).toEqual(['ap-south-1', 'eu-west-1', 'us-west-2', 'ca-central-1']);
    });

    it('AC-9: unknown profile -> error naming it and the available ones', () => {
      expect(() => createBedrockProvider({ model: 'm', awsProfile: 'ghost', awsRegion: 'us-east-1', env: aws(), createClient: seen().createClient }))
        .toThrow(/ghost.*(ci, default, dev|available)/is);
      expect(() => createBedrockProvider({ model: 'm', awsProfile: 'ghost', awsRegion: 'us-east-1', env: fakeAwsFiles(), createClient: seen().createClient }))
        .toThrow(/ghost/);
    });

    it('missing region error mentions the profile region', () => {
      expect(() => createBedrockProvider({ model: 'm', awsProfile: 'ci', env: aws(), createClient: seen().createClient })).toThrow(/AWS_REGION/);
    });

    it('AC-10: anthropic provider ignores awsProfile and never reads AWS files', () => {
      const cfg = resolveConfig({ cli: { provider: 'anthropic', awsProfile: 'ghost' } });
      expect(createLLMProvider(cfg, { apiKey: 'k', env: fakeAwsFiles() })).toMatchObject({ provider: 'anthropic' });
    });

    it('factory passes awsProfile through from config', () => {
      const s = seen();
      const cfg = resolveConfig({ cli: { provider: 'bedrock', awsProfile: 'dev', awsRegion: 'us-east-1' } });
      createLLMProvider(cfg, { env: aws(), createBedrockClient: s.createClient });
      expect(s.calls[0]).toEqual({ awsRegion: 'us-east-1', awsProfile: 'dev' });
    });
  });

  it('AC-14: factory picks the provider from config', () => {
    const a = createLLMProvider(resolveConfig({ cli: { provider: 'anthropic', model: 'anthropic.claude-opus-5-5' } }), { apiKey: 'k' });
    expect(a).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    const b = createLLMProvider(resolveConfig({ cli: { provider: 'bedrock', awsRegion: 'us-east-1' } }), { createBedrockClient: () => fakeClient().client });
    expect(b).toMatchObject({ provider: 'bedrock', model: 'anthropic.claude-sonnet-5-5' });
  });
});
