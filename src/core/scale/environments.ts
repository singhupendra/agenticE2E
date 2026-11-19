import { CredentialsError } from '../credentials.js';
import type { SecretEntry } from '../redact.js';
import type { EnvironmentConfig } from './options.js';

/** SPEC-012 FR-8..11: named environments (dev/staging/prod) the stored journeys can run against. */
export interface ResolvedEnvironment {
  name: string;
  baseUrl: string;
  origin: string;
  /** Resolved header values: secrets. Never log, persist or return them. */
  headers: Record<string, string>;
  readOnly: boolean;
  /** values substituted for ${VAR}: also secrets */
  interpolated: string[];
}

/** Errors whose detail (env var names) stays on the CLI / server log; web clients get `publicMessage` (SPEC-009 FR). */
export class EnvironmentError extends CredentialsError {
  constructor(message: string, publicMessage: string) {
    super(message, publicMessage);
    this.name = 'EnvironmentError';
  }
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const READ_ONLY_NAMES = /^(prod|production)$/i;
/** Short header values (e.g. "1", "yes") would redact ordinary text everywhere; they are not secrets. */
const MIN_SECRET_LEN = 8;

export const isReadOnlyEnv = (name: string, readOnly?: boolean) => readOnly ?? READ_ONLY_NAMES.test(name);

export function resolveEnvironment(
  cfg: { environments?: Record<string, EnvironmentConfig>; env?: string },
  procEnv: Record<string, string | undefined> = process.env,
): ResolvedEnvironment | null {
  if (!cfg.env) return null;
  const all = cfg.environments ?? {};
  const e = all[cfg.env];
  if (!e) {
    const names = Object.keys(all);
    throw new Error(
      `Unknown environment "${cfg.env}". Configured environments: ${names.length ? names.join(', ') : '(none — add "environments" to the config file)'}`,
    );
  }
  const interpolated: string[] = [];
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(e.headers ?? {})) {
    headers[name] = raw.replace(VAR_RE, (_m, v: string) => {
      const val = procEnv[v];
      if (val === undefined || val === '') {
        throw new EnvironmentError(
          `Environment "${cfg.env}": header "${name}" references \${${v}}, which is not set`,
          `Environment "${cfg.env}" could not be resolved: a header references an unset environment variable (see the server log)`,
        );
      }
      interpolated.push(val);
      return val;
    });
  }
  return {
    name: cfg.env,
    baseUrl: e.baseUrl,
    origin: new URL(e.baseUrl).origin,
    headers,
    readOnly: isReadOnlyEnv(cfg.env, e.readOnly),
    interpolated,
  };
}

/** Values for the redactor (FR-10). */
export function environmentSecrets(e: ResolvedEnvironment | null): SecretEntry[] {
  if (!e) return [];
  const values = [...Object.values(e.headers), ...e.interpolated].filter((v) => v.length >= MIN_SECRET_LEN);
  return [...new Set(values)].map((value) => ({ value, placeholder: `[env:${e.name}:header]` }));
}

/** FR-24: what `/api/config` may show — header names, never values. */
export function publicEnvironments(
  all: Record<string, EnvironmentConfig> = {},
): Record<string, { baseUrl: string; readOnly: boolean; headers: string[] }> {
  return Object.fromEntries(
    Object.entries(all).map(([name, e]) => [
      name,
      { baseUrl: e.baseUrl, readOnly: isReadOnlyEnv(name, e.readOnly), headers: Object.keys(e.headers ?? {}) },
    ]),
  );
}
