import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { awsProfileRegion, listAwsProfiles } from '../aws-profiles.js';
import { AnthropicProvider } from './anthropic.js';

export type MessagesClient = Pick<Anthropic, 'messages'>;

export interface BedrockClientOptions { awsRegion: string; awsProfile?: string }

export interface BedrockOptions {
  model: string;
  maxTokens?: number;
  /** Region precedence: this, then the selected profile's `region`, then AWS_REGION, then AWS_DEFAULT_REGION. */
  awsRegion?: string;
  /** Named profile (~/.aws/credentials, ~/.aws/config) that supplies the credentials. Unset = AWS default chain. */
  awsProfile?: string;
  env?: Record<string, string | undefined>;
  /** Test seam. */
  createClient?: (o: BedrockClientOptions) => MessagesClient;
}

/**
 * Claude on Amazon Bedrock via the Messages-API ("Mantle") endpoint. Credentials come from the selected AWS profile, else the
 * standard AWS chain (env, SSO, instance role) or AWS_BEARER_TOKEN_BEDROCK; nothing is read from or written to config.
 */
export function createBedrockProvider(opts: BedrockOptions): AnthropicProvider {
  const env = opts.env ?? process.env;
  const awsProfile = opts.awsProfile || undefined;
  if (awsProfile) {
    const known = listAwsProfiles(env);
    if (!known.includes(awsProfile)) {
      throw new Error(`AWS profile "${awsProfile}" not found in the AWS config/credentials files. ${known.length ? `Available profiles: ${known.join(', ')}.` : 'No profiles were found (looked in ~/.aws/config and ~/.aws/credentials, or AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE).'}`);
    }
  }
  const awsRegion = opts.awsRegion
    ?? (awsProfile ? awsProfileRegion(awsProfile, env) : undefined)
    ?? (env.AWS_REGION || undefined)
    ?? (env.AWS_DEFAULT_REGION || undefined);
  if (!awsRegion) throw new Error(`No AWS region for Bedrock. Set \`awsRegion\` (--aws-region / AGENTIC_E2E_AWS_REGION), the AWS_REGION environment variable${awsProfile ? `, or a region in AWS profile "${awsProfile}"` : ''}.`);
  const make = opts.createClient ?? ((o: BedrockClientOptions) => new AnthropicBedrockMantle(o) as unknown as MessagesClient);
  const client = make(awsProfile ? { awsRegion, awsProfile } : { awsRegion });
  return new AnthropicProvider({ provider: 'bedrock', model: opts.model, maxTokens: opts.maxTokens, client });
}
