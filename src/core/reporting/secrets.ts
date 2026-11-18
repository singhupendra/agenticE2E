import { Redactor } from '../redact.js';

/** Env vars whose values are secrets and must never appear in a report, summary or notification (SPEC-011 FR-6). */
export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN',
  'AGENTIC_E2E_WEBHOOK_URL', 'AGENTIC_E2E_SLACK_WEBHOOK_URL', 'E2E_PASSWORD',
] as const;

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_API_KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bABSK[A-Za-z0-9+/=]{16,}/g, '[REDACTED_BEDROCK_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/g, '[REDACTED_WEBHOOK]'],
];

/** Scrub well-known secret shapes (API keys, AWS keys, bearer tokens, Slack hook URLs). */
export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function envSecretRedactor(env: Record<string, string | undefined>): Redactor {
  return new Redactor(SECRET_ENV_VARS.map((k) => env[k]).filter((v): v is string => !!v && v.length >= 6).map((value) => ({ value, placeholder: '[REDACTED]' })));
}

/** Deep-apply every redactor, then the pattern scrubber, to all strings of `v` (keys included). */
export function redactReport<T>(v: T, redactors: Redactor[]): T {
  const one = (s: string) => scrubSecrets(redactors.reduce((acc, r) => r.redact(acc), s));
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return one(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [one(k), walk(y)]));
    return x;
  };
  return walk(v) as T;
}
