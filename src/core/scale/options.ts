import { z } from 'zod';

/** SPEC-012: config keys for execution at scale. Merged into `configSchema` (no import of config.ts here: no cycles). */
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

export const ARTIFACT_POLICIES = ['off', 'on', 'on-failure', 'retain-on-failure'] as const;
export type ArtifactPolicy = (typeof ARTIFACT_POLICIES)[number];

export const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TAG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const SHARD_RE = /^\d+\/\d+$/;

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');

export const environmentSchema = z.object({
  baseUrl: httpUrl,
  /** Sent as Playwright extraHTTPHeaders. Values may contain ${ENV_VAR}; they are treated as secrets. */
  headers: z.record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'must be a valid HTTP header name'), z.string()).optional(),
  /** Destructive journeys are skipped. Default: true for `prod` / `production`. */
  readOnly: z.boolean().optional(),
}).strict();
export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export const scaleConfigShape = {
  browsers: z.array(z.enum(BROWSERS)).optional(),
  devices: z.array(z.string().min(1)).optional(),
  workers: z.union([z.number().int().positive(), z.string().regex(/^([1-9]\d?|100)%$/, 'must be a positive integer or a percentage like "50%"')]).default(2),
  // `retries` is shared with SPEC-011 (config.ts): Playwright retries for run/heal/all; `ci` uses its own re-run loop.
  shard: z.string().regex(SHARD_RE, 'must look like "1/4"').optional(),
  environments: z.record(z.string().regex(ENV_NAME_RE, 'invalid environment name'), environmentSchema).default({}),
  env: z.string().regex(ENV_NAME_RE, 'invalid environment name').optional(),
  grep: z.string().min(1).optional(),
  tag: z.array(z.string().min(1)).optional(),
  /** 0/unset = no global timeout. */
  globalTimeoutMs: z.number().int().min(0).optional(),
  trace: z.enum(ARTIFACT_POLICIES).default('retain-on-failure'),
  video: z.enum(ARTIFACT_POLICIES).default('off'),
};

/** Keys web clients may not override per job (header values may be secrets; environments come from the server config). */
export const SERVER_ONLY_SCALE_KEYS = { environments: true } as const;
