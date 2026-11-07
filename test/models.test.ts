import { describe, it, expect } from 'vitest';
import { listModels, resolveModelId, supportsForcedToolChoice, PROVIDERS } from '../src/core/llm/models.js';

describe('model ids (SPEC-002)', () => {
  it('AC-5: bedrock maps bare ids and passes prefixed ones through', () => {
    expect(resolveModelId('bedrock', 'claude-sonnet-5-5')).toBe('global.anthropic.claude-sonnet-5-5');
    for (const id of ['anthropic.x', 'us.anthropic.x', 'eu.anthropic.x', 'apac.anthropic.x', 'global.anthropic.x', 'arn:aws:bedrock:us-east-1:1:inference-profile/x']) {
      expect(resolveModelId('bedrock', id)).toBe(id);
    }
  });

  it('AC-6: anthropic strips the bedrock prefix, leaves bare ids', () => {
    expect(resolveModelId('anthropic', 'anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModelId('anthropic', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('AC-7: catalog is provider-shaped and contains the default model', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'bedrock']);
    const a = listModels('anthropic');
    const b = listModels('bedrock');
    expect(a.length).toBeGreaterThan(2);
    expect(a.map((m) => m.id)).toContain('claude-sonnet-5-5');
    expect(b.map((m) => m.id)).toContain('global.anthropic.claude-sonnet-5-5');
    expect(a.every((m) => !m.id.startsWith('anthropic.'))).toBe(true);
    expect(b.every((m) => m.id.startsWith('global.anthropic.'))).toBe(true);
    expect(a.every((m) => m.label.length > 0)).toBe(true);
  });

  it('AC-13 helper: forced tool choice support by model (bare or bedrock id)', () => {
    for (const m of ['claude-sonnet-5-5', 'anthropic.claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5-5', 'us.anthropic.claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
      expect(supportsForcedToolChoice(m)).toBe(false);
    }
    for (const m of ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5', 'm']) {
      expect(supportsForcedToolChoice(m)).toBe(true);
    }
  });
});
