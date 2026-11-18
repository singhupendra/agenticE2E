import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROVIDERS } from './llm/models.js';
import { REPORT_FORMATS } from './reporting/model.js';
import { NOTIFY_ON } from './reporting/notify.js';
import { scaleConfigShape } from './scale/options.js';
import { ConfigError, validateWith } from './config-check.js';
import { serverEnv, serverSchema } from './security/server-config.js';

export const SCREENSHOT_MODES = ['off', 'on-failure', 'every-step', 'end-of-journey'] as const;

export const configSchema = z.object({
  provider: z.enum(PROVIDERS).default('anthropic'),
  model: z.string().min(1).default('claude-sonnet-5-5'),
  /** Bedrock only. Interpolated into the endpoint host, so it must look like a region. */
  awsRegion: z.string().regex(/^[a-z]{2}(-[a-z0-9]+)+-\d+$/, 'must look like an AWS region, e.g. us-east-1').optional(),
  /** Bedrock only. Named profile from ~/.aws/credentials / ~/.aws/config that supplies the credentials; unset = AWS default chain. */
  awsProfile: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@:+=,/-]{0,127}$/, 'must be a valid AWS profile name, e.g. default or my-profile').optional(),
  maxTokens: z.number().int().positive().default(8000),
  screenshots: z.enum(SCREENSHOT_MODES).default('on-failure'),
  fullPage: z.boolean().default(false),
  dataDir: z.string().default('data'),
  headless: z.boolean().default(true),
  maxPages: z.number().int().positive().default(15),
  maxDepth: z.number().int().min(0).default(2),
  timeoutMs: z.number().int().positive().default(120_000),
  maxJourneys: z.number().int().positive().default(5),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  healAttempts: z.number().int().min(0).default(3),
  codegenRetries: z.number().int().min(0).default(2),
  requireApproval: z.boolean().default(false),
  testTimeoutMs: z.number().int().positive().default(30_000),
  /** SPEC-009: where the (never committed) credentials live; unset = `.agentic-e2e/credentials.json` if present. */
  credentialsFile: z.string().min(1).optional(),
  /** SPEC-009: logged-in testing. */
  auth: z.boolean().default(false),
  /** SPEC-009: which named user of the credentials file to use (names only; never a secret). */
  authUser: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'must be a user name from the credentials file').optional(),
  /** SPEC-011: report formats written per run (CLI run/heal/all/ci); [] disables. */
  reporters: z.array(z.enum(REPORT_FORMATS)).default([...REPORT_FORMATS]),
  /** SPEC-011: extra directory the reports are also written to (e.g. for CI artifact upload). */
  reportDir: z.string().min(1).optional(),
  /** SPEC-011: `ci` re-runs failing tests up to this many times (no LLM). */
  retries: z.number().int().min(0).max(10).default(0),
  /** SPEC-011: when to send webhook/Slack notifications (URLs come from env only). */
  notifyOn: z.enum(NOTIFY_ON).default('always'),
  /** SPEC-012: browsers/devices, workers/retries/shard, environments, grep/tag filters, global timeout, trace/video. */
  ...scaleConfigShape,
  /** SPEC-014: web server / API security settings (never overridable per job). */
  server: serverSchema.prefault({}),
}).strict(); // SPEC-014: unknown keys are errors (with a did-you-mean hint), not silently ignored

export type Config = z.infer<typeof configSchema>;
export type PartialConfig = Partial<Config>;

const ENV_MAP: Record<string, { key: keyof Config; parse: (v: string) => unknown }> = {
  AGENTIC_E2E_PROVIDER: { key: 'provider', parse: String },
  AGENTIC_E2E_MODEL: { key: 'model', parse: String },
  AGENTIC_E2E_AWS_REGION: { key: 'awsRegion', parse: String },
  AGENTIC_E2E_AWS_PROFILE: { key: 'awsProfile', parse: String },
  AGENTIC_E2E_SCREENSHOTS: { key: 'screenshots', parse: String },
  AGENTIC_E2E_FULL_PAGE: { key: 'fullPage', parse: (v) => v === 'true' || v === '1' },
  AGENTIC_E2E_DATA_DIR: { key: 'dataDir', parse: String },
  AGENTIC_E2E_CREDENTIALS: { key: 'credentialsFile', parse: String },
  AGENTIC_E2E_REPORT_DIR: { key: 'reportDir', parse: String },
  AGENTIC_E2E_ENV: { key: 'env', parse: String },
};

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolveConfig(opts: {
  file?: PartialConfig;
  env?: Record<string, string | undefined>;
  cli?: PartialConfig;
  cwd?: string;
  /** Shown in validation errors, e.g. `config file agentic-e2e.config.json`. */
  source?: string;
}): Config {
  const envCfg: Record<string, unknown> = {};
  for (const [name, { key, parse }] of Object.entries(ENV_MAP)) {
    const v = opts.env?.[name];
    if (v !== undefined && v !== '') envCfg[key] = parse(v);
  }
  const merged: Record<string, unknown> = { ...stripUndefined(opts.file), ...envCfg, ...stripUndefined(opts.cli) };
  // SPEC-004: Bedrock-specific model id; beats file/AGENTIC_E2E_MODEL, loses to an explicit CLI model.
  const bedrockModel = opts.env?.AGENTICQA_BEDROCK_MODEL_ID?.trim();
  if (bedrockModel && merged.provider === 'bedrock' && stripUndefined(opts.cli).model === undefined) merged.model = bedrockModel;
  const srvEnv = serverEnv(opts.env);
  if (Object.keys(srvEnv).length || merged.server !== undefined) merged.server = { ...(opts.file?.server ?? {}), ...srvEnv, ...(opts.cli?.server ?? {}) };
  const { issues, data } = validateWith(configSchema, merged, opts.source);
  if (!data) throw new ConfigError(issues);
  const cfg = data;
  cfg.dataDir = path.resolve(opts.cwd ?? process.cwd(), cfg.dataDir);
  if (cfg.reportDir) cfg.reportDir = path.resolve(opts.cwd ?? process.cwd(), cfg.reportDir);
  if (cfg.credentialsFile) cfg.credentialsFile = path.resolve(opts.cwd ?? process.cwd(), cfg.credentialsFile);
  if (cfg.server.tokensFile) cfg.server.tokensFile = path.resolve(opts.cwd ?? process.cwd(), cfg.server.tokensFile);
  return cfg;
}

const CONFIG_NAMES = ['agentic-e2e.config.ts', 'agentic-e2e.config.mjs', 'agentic-e2e.config.js', 'agentic-e2e.config.json'];

/** The config file that `loadConfigFile` would read (undefined = none, defaults only). */
export function findConfigFile(dir: string, explicit?: string): string | undefined {
  return explicit ? path.resolve(dir, explicit) : CONFIG_NAMES.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
}

export async function loadConfigFile(dir: string, explicit?: string): Promise<PartialConfig> {
  const file = findConfigFile(dir, explicit);
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`Config file not found: ${file}`);
  if (file.endsWith('.json')) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as PartialConfig; } catch { throw new ConfigError([`${path.basename(file)} is not valid JSON`]); }
  }
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(file, { default: true })) as PartialConfig;
  return mod ?? {};
}

export async function loadConfig(opts: { cwd?: string; configFile?: string; cli?: PartialConfig; env?: Record<string, string | undefined> } = {}): Promise<Config> {
  const cwd = opts.cwd ?? process.cwd();
  const file = await loadConfigFile(cwd, opts.configFile);
  const found = findConfigFile(cwd, opts.configFile);
  return resolveConfig({ file, env: opts.env ?? process.env, cli: opts.cli, cwd, source: found ? `config file ${path.basename(found)}` : undefined });
}
