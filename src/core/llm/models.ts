export const PROVIDERS = ['anthropic', 'bedrock'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ModelInfo { id: string; label: string }

/** Known Claude models, by bare (Anthropic API) id. Static: anything else can still be typed in as a custom id. */
const CATALOG: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (default)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

/** Bedrock ids already carrying a vendor / inference-profile / ARN prefix are passed through untouched. */
const BEDROCK_PREFIXED = /^(anthropic\.|(us|eu|apac|global|us-gov|jp|au|ca)\.anthropic\.|arn:)/;

/**
 * SPEC-005 FR-5: the catalog models are inference-profile-only on bedrock-runtime (the bare `anthropic.<id>` is rejected with
 * "on-demand throughput isn't supported"), so bare ids get the `global.` cross-region profile prefix.
 */
export function resolveModelId(provider: ProviderId, model: string): string {
  if (provider === 'bedrock') return BEDROCK_PREFIXED.test(model) ? model : `global.anthropic.${model}`;
  return model.startsWith('anthropic.') ? model.slice('anthropic.'.length) : model;
}

export function listModels(provider: ProviderId): ModelInfo[] {
  return CATALOG.map((m) => ({ ...m, id: resolveModelId(provider, m.id) }));
}

/** Models that reject `tool_choice: {type: "tool" | "any"}` with a 400. */
const NO_FORCED_TOOL_CHOICE = /(^|[./])(anthropic\.)?claude-(sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)(\b|$|[-:@])/;

export function supportsForcedToolChoice(model: string): boolean {
  return !NO_FORCED_TOOL_CHOICE.test(model);
}

/** SPEC-013: USD per million tokens. `cacheWrite` is the 5-minute TTL write price. */
export interface ModelPricing { input: number; output: number; cacheWrite: number; cacheRead: number }

/**
 * Anthropic first-party list prices (Claude API, November 2026). Bedrock is billed by AWS at its own rates, so costs
 * computed from this table are *estimates*. Keys are bare model ids; longest matching key wins.
 */
export const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/** Strips Bedrock vendor / inference-profile prefixes and `-YYYYMMDD` / `-v1:0` / `@date` suffixes. */
function bareModelId(id: string): string {
  return id.toLowerCase()
    .replace(/^(arn:.*\/)?/, '')
    .replace(/^((us|eu|apac|global|us-gov|jp|au|ca)\.)?anthropic\./, '')
    .replace(/(-v\d+(:\d+)?)$/, '')
    .replace(/[-@]\d{8}$/, '');
}

export function modelPricing(model: string): ModelPricing | undefined {
  const bare = bareModelId(model);
  const key = PRICING_KEYS.find((k) => bare === k || (bare.startsWith(k) && /^[-@:]/.test(bare.slice(k.length)) && !/^-\d+(-|$)/.test(bare.slice(k.length))));
  return key ? PRICING[key] : undefined;
}

export function estimateCostUsd(model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | undefined {
  const p = modelPricing(model);
  if (!p) return undefined;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}
