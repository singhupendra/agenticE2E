import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { createBedrockProvider, type BedrockClientOptions, type MessagesClient } from './bedrock.js';
import type { LLMProvider } from './types.js';

export * from './types.js';
export * from './schemas.js';
export * from './models.js';
export { MockLLM } from './mock.js';
export { GovernedLLM } from './governed.js';
export { ResponseCache, LLM_CACHE_MODES, type LLMCacheMode } from './response-cache.js';
export { UsageTracker, formatUsageSummary, type LLMBudget, type LLMCallRecord, type UsageTotals } from './usage.js';
export { AnthropicProvider } from './anthropic.js';
export { createBedrockProvider } from './bedrock.js';

export interface LLMFactoryDeps {
  apiKey?: string;
  env?: Record<string, string | undefined>;
  createBedrockClient?: (o: BedrockClientOptions) => MessagesClient;
}

/** Builds the configured provider. Throws on missing credentials/region (nothing is called over the network). */
export function createLLMProvider(config: Pick<Config, 'provider' | 'model' | 'maxTokens' | 'awsRegion' | 'awsProfile'> & Partial<Pick<Config, 'promptCaching' | 'llmTimeoutMs'>>, deps: LLMFactoryDeps = {}): AnthropicProvider & LLMProvider {
  if (config.provider === 'bedrock') {
    return createBedrockProvider({ model: config.model, maxTokens: config.maxTokens, awsRegion: config.awsRegion, awsProfile: config.awsProfile, promptCaching: config.promptCaching, timeoutMs: config.llmTimeoutMs, env: deps.env, createClient: deps.createBedrockClient });
  }
  return new AnthropicProvider({ provider: 'anthropic', model: config.model, maxTokens: config.maxTokens, promptCaching: config.promptCaching, timeoutMs: config.llmTimeoutMs, apiKey: deps.apiKey });
}
