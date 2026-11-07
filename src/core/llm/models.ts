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

export function resolveModelId(provider: ProviderId, model: string): string {
  if (provider === 'bedrock') return BEDROCK_PREFIXED.test(model) ? model : `anthropic.${model}`;
  return model.startsWith('anthropic.') ? model.slice('anthropic.'.length) : model;
}

export function listModels(provider: ProviderId): ModelInfo[] {
  return CATALOG.map((m) => ({ ...m, id: resolveModelId(provider, m.id) }));
}

/** Models that reject `tool_choice: {type: "tool" | "any"}` with a 400. */
const NO_FORCED_TOOL_CHOICE = /(^|[.\/])(anthropic\.)?claude-(sonnet-5-5|opus-5-5|fable-5-1|mythos-5-1)(\b|$|[-:@])/;

export function supportsForcedToolChoice(model: string): boolean {
  return !NO_FORCED_TOOL_CHOICE.test(model);
}
