import { z } from 'zod';
import { LLM_CACHE_MODES } from '../llm/response-cache.js';
import { LOG_FORMATS, LOG_LEVELS } from './logger.js';

/** SPEC-013 config keys, spread into `configSchema` (kept here so config.ts changes stay minimal). */
export const obsConfigShape = {
  logLevel: z.enum(LOG_LEVELS).default('warn'),
  logFormat: z.enum(LOG_FORMATS).default('pretty'),
  /** Per-run limits; a run = one CLI command / web job. */
  llmBudget: z
    .object({
      maxCostPerRun: z.number().positive().optional(),
      maxTokensPerRun: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  llmMaxRetries: z.number().int().min(0).max(10).default(3),
  llmTimeoutMs: z.number().int().positive().default(300_000),
  promptCaching: z.boolean().default(true),
  llmCache: z.enum(LLM_CACHE_MODES).default('off'),
  /** FR-23: append-only audit log at `<dataDir>/audit.jsonl` (default on). */
  auditLog: z.boolean().default(true),
  /** FR-26: `auto` = export spans when an OTLP endpoint env var is set; `off` = never (even with the env set). */
  tracing: z.enum(['auto', 'off']).default('auto'),
};

/** env var -> config key (parsed as strings; zod validates). */
export const OBS_ENV_MAP = {
  AGENTIC_E2E_LOG_LEVEL: { key: 'logLevel', parse: String },
  AGENTIC_E2E_LOG_FORMAT: { key: 'logFormat', parse: String },
  AGENTIC_E2E_LLM_CACHE: { key: 'llmCache', parse: String },
} as const;

/** Keys a web client must not override per job (the server's budget protects its credits; logging is the operator's). */
export const OBS_SERVER_ONLY_KEYS = [
  'logLevel',
  'logFormat',
  'llmBudget',
  'llmMaxRetries',
  'llmTimeoutMs',
  'promptCaching',
  'auditLog',
  'tracing',
] as const;
