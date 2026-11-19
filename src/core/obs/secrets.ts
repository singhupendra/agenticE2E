import { Redactor, type SecretEntry } from '../redact.js';
import { REDACTED } from './logger.js';

/** SPEC-013 FR-5: env variables whose *values* are secrets and must never be logged, traced or stored. */
export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'E2E_PASSWORD',
  'E2E_USERNAME',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
] as const;
const HEADER_VARS = new Set(['OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_TRACES_HEADERS']);

export function envSecretEntries(env: Record<string, string | undefined> = process.env): SecretEntry[] {
  const out: SecretEntry[] = [];
  for (const name of SECRET_ENV_VARS) {
    const v = env[name]?.trim();
    if (!v) continue;
    out.push({ value: v, placeholder: REDACTED });
    // OTLP headers are `k=v,k=v`: each value is a secret on its own (e.g. a collector API key).
    if (HEADER_VARS.has(name))
      for (const pair of v.split(',')) {
        const val = pair.split('=').slice(1).join('=').trim();
        if (val) out.push({ value: val, placeholder: REDACTED });
      }
  }
  return out;
}

/** Credential values (from the SPEC-009 credentials file) + env secrets, in one `Redactor`. */
export function buildLogRedactor(
  credentialEntries: SecretEntry[],
  env: Record<string, string | undefined> = process.env,
): Redactor {
  return new Redactor([...credentialEntries, ...envSecretEntries(env)]);
}
