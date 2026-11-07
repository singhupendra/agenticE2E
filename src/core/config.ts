import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const SCREENSHOT_MODES = ['off', 'on-failure', 'every-step', 'end-of-journey'] as const;

export const configSchema = z.object({
  model: z.string().min(1).default('claude-sonnet-5-5'),
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
  healAttempts: z.number().int().min(0).default(2),
  codegenRetries: z.number().int().min(0).default(2),
  requireApproval: z.boolean().default(false),
  testTimeoutMs: z.number().int().positive().default(30_000),
});

export type Config = z.infer<typeof configSchema>;
export type PartialConfig = Partial<Config>;

const ENV_MAP: Record<string, { key: keyof Config; parse: (v: string) => unknown }> = {
  AGENTIC_E2E_MODEL: { key: 'model', parse: String },
  AGENTIC_E2E_SCREENSHOTS: { key: 'screenshots', parse: String },
  AGENTIC_E2E_FULL_PAGE: { key: 'fullPage', parse: (v) => v === 'true' || v === '1' },
  AGENTIC_E2E_DATA_DIR: { key: 'dataDir', parse: String },
};

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function resolveConfig(opts: {
  file?: PartialConfig;
  env?: Record<string, string | undefined>;
  cli?: PartialConfig;
  cwd?: string;
}): Config {
  const envCfg: Record<string, unknown> = {};
  for (const [name, { key, parse }] of Object.entries(ENV_MAP)) {
    const v = opts.env?.[name];
    if (v !== undefined && v !== '') envCfg[key] = parse(v);
  }
  const merged = { ...stripUndefined(opts.file), ...envCfg, ...stripUndefined(opts.cli) };
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const cfg = parsed.data;
  cfg.dataDir = path.resolve(opts.cwd ?? process.cwd(), cfg.dataDir);
  return cfg;
}

const CONFIG_NAMES = ['agentic-e2e.config.ts', 'agentic-e2e.config.mjs', 'agentic-e2e.config.js', 'agentic-e2e.config.json'];

export async function loadConfigFile(dir: string, explicit?: string): Promise<PartialConfig> {
  const file = explicit ? path.resolve(dir, explicit) : CONFIG_NAMES.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`Config file not found: ${file}`);
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8')) as PartialConfig;
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(file, { default: true })) as PartialConfig;
  return mod ?? {};
}

export async function loadConfig(opts: { cwd?: string; configFile?: string; cli?: PartialConfig; env?: Record<string, string | undefined> } = {}): Promise<Config> {
  const cwd = opts.cwd ?? process.cwd();
  const file = await loadConfigFile(cwd, opts.configFile);
  return resolveConfig({ file, env: opts.env ?? process.env, cli: opts.cli, cwd });
}
