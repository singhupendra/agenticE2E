import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { awsProfileRegion, listAwsProfiles } from '../aws-profiles.js';
import { AnthropicProvider } from './anthropic.js';

export type MessagesClient = Pick<Anthropic, 'messages'>;

type CredentialProvider = ReturnType<typeof fromNodeProviderChain>;

/**
 * `apiKey` is a Bedrock API key (Bearer token); it is only set when no profile is selected. `providerChainResolver` is only set
 * when a profile is selected: the classic client has no profile option and would otherwise read the shell's AWS_PROFILE.
 */
export interface BedrockClientOptions { awsRegion: string; providerChainResolver?: () => Promise<CredentialProvider>; apiKey?: string }

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
  /** Test seam: loads credentials for a named profile (default: the AWS SDK's Node provider chain). */
  fromProfile?: (o: { profile: string }) => CredentialProvider;
}

/**
 * Claude on Amazon Bedrock via the classic `bedrock-runtime` endpoint (SPEC-005). Credentials come from the selected AWS profile, else a Bedrock
 * API key in AWS_BEARER_TOKEN_BEDROCK, else the standard AWS chain (env, SSO, instance role); nothing is read from or written to config.
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
  const make = opts.createClient ?? ((o: BedrockClientOptions) => new AnthropicBedrock(o) as unknown as MessagesClient);
  const apiKey = awsProfile ? undefined : env.AWS_BEARER_TOKEN_BEDROCK?.trim() || undefined;
  const fromProfile = opts.fromProfile ?? fromNodeProviderChain;
  // SPEC-005 FR-2: lazy, so nothing is loaded (or refreshed, for SSO) until a request needs credentials.
  const client = make(awsProfile ? { awsRegion, providerChainResolver: async () => fromProfile({ profile: awsProfile }) } : apiKey ? { awsRegion, apiKey } : { awsRegion });
  return new AnthropicProvider({ provider: 'bedrock', model: opts.model, maxTokens: opts.maxTokens, client });
}
