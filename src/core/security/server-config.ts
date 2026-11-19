import { z } from 'zod';

/** SPEC-014 FR-20: the `server` block of the config (never overridable per job). */
export const serverSchema = z
  .object({
    /** Extra hostnames accepted in the Host header (besides localhost/127.0.0.1/[::1] and the bind host). */
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .transform((h) => h.trim().toLowerCase()),
      )
      .default([]),
    /** File of hashed API tokens (`agentic-e2e token create --file …`). */
    tokensFile: z.string().min(1).optional(),
    bodyLimitBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    rateLimit: z
      .object({
        max: z.number().int().positive().default(300),
        timeWindowMs: z.number().int().positive().default(60_000),
        /** Login attempts (POST /api/session) per window and client. */
        loginMax: z.number().int().positive().default(10),
      })
      .strict()
      .prefault({}),
    sessionTtlMs: z
      .number()
      .int()
      .positive()
      .default(12 * 60 * 60 * 1000),
    shutdownTimeoutMs: z.number().int().min(0).default(30_000),
    /** Trust X-Forwarded-* from a reverse proxy (client IP for rate limiting, https detection for Secure cookies). */
    trustProxy: z.boolean().default(false),
  })
  .strict();

export type ServerSettings = z.infer<typeof serverSchema>;

/** Env overrides for the server block (comma lists for hosts). */
export function serverEnv(env: Record<string, string | undefined> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const hosts = env.AGENTIC_E2E_ALLOWED_HOSTS?.trim();
  if (hosts)
    out.allowedHosts = hosts
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
  const file = env.AGENTIC_E2E_API_TOKENS_FILE?.trim();
  if (file) out.tokensFile = file;
  if (env.AGENTIC_E2E_TRUST_PROXY)
    out.trustProxy = env.AGENTIC_E2E_TRUST_PROXY === 'true' || env.AGENTIC_E2E_TRUST_PROXY === '1';
  return out;
}
