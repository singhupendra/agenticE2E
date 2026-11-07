import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicProvider } from './anthropic.js';

export type MessagesClient = Pick<Anthropic, 'messages'>;

export interface BedrockOptions {
  model: string;
  maxTokens?: number;
  /** Falls back to AWS_REGION, then AWS_DEFAULT_REGION. */
  awsRegion?: string;
  env?: Record<string, string | undefined>;
  /** Test seam. */
  createClient?: (o: { awsRegion: string }) => MessagesClient;
}

/**
 * Claude on Amazon Bedrock via the Messages-API ("Mantle") endpoint. Credentials come from the standard AWS chain
 * (env, profile/SSO, instance role) or AWS_BEARER_TOKEN_BEDROCK; nothing is read from or written to config.
 */
export function createBedrockProvider(opts: BedrockOptions): AnthropicProvider {
  const env = opts.env ?? process.env;
  const awsRegion = opts.awsRegion ?? (env.AWS_REGION || undefined) ?? (env.AWS_DEFAULT_REGION || undefined);
  if (!awsRegion) throw new Error('No AWS region for Bedrock. Set `awsRegion` (--aws-region / AGENTIC_E2E_AWS_REGION) or the AWS_REGION environment variable.');
  const client = (opts.createClient ?? ((o) => new AnthropicBedrockMantle(o) as unknown as MessagesClient))({ awsRegion });
  return new AnthropicProvider({ provider: 'bedrock', model: opts.model, maxTokens: opts.maxTokens, client });
}
