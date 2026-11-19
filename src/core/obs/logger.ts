import pino from 'pino';
import { Redactor } from '../redact.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export const LOG_FORMATS = ['pretty', 'json'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = (typeof LOG_FORMATS)[number];
export type Logger = pino.Logger;
export interface LogStream { write(line: string): void }

export const REDACTED = '[REDACTED]';

/** Field names whose values are always censored, wherever they appear (one or two levels deep). */
const SENSITIVE_KEYS = ['password', 'passwd', 'apiKey', 'api_key', 'authorization', 'Authorization', 'token', 'accessToken', 'secret', 'secretAccessKey', 'sessionToken', 'cookie', 'E2E_PASSWORD', 'x-api-key', 'X-Api-Key', 'X-API-Key', 'x-auth-token'];
/** pino/fast-redact paths: dot syntax for identifiers, bracket syntax for hyphenated keys (`*.*["x-api-key"]`). */
const segment = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => ['', '*', '*.*'].map((prefix) => `${prefix}${segment(k)}`.replace(/^\./, '')));

/** SPEC-013 FR-6: well-known secret shapes, scrubbed even when their value was never registered. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bABSK[A-Za-z0-9+/=]{16,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, `$1 ${REDACTED}`],
];
export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const LEVEL_LABEL_WIDTH = 5;
const fmtValue = (v: unknown): string => (typeof v === 'string' ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v));

/** `HH:MM:SS.mmm LEVEL msg key=value …` from one pino JSON line. */
function prettyLine(json: string): string {
  try {
    const { time, level, msg, ...rest } = JSON.parse(json) as Record<string, unknown>;
    const t = typeof time === 'string' ? time.slice(11, 23) : new Date().toISOString().slice(11, 23);
    const fields = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${fmtValue(v)}`);
    return `${t} ${String(level).toUpperCase().padEnd(LEVEL_LABEL_WIDTH)} ${msg ?? ''}${fields.length ? ' ' + fields.join(' ') : ''}\n`;
  } catch {
    return json;
  }
}

/**
 * SPEC-013 FR-1..6: pino logger writing to `stream` (default stderr). Every serialised line is passed through the
 * `Redactor` (credential + env secret values) and the secret-shape scrubber *before* it is written, so nothing nested
 * in an error message or object can leak.
 */
export function createLogger(opts: { level?: LogLevel; format?: LogFormat; redactor?: Redactor; stream?: LogStream; bindings?: Record<string, unknown> } = {}): Logger {
  const redactor = opts.redactor ?? Redactor.empty();
  const out = opts.stream ?? process.stderr;
  const format = opts.format ?? 'pretty';
  const destination = {
    write(line: string) {
      const safe = scrubSecrets(redactor.redact(line));
      out.write(format === 'json' ? safe : prettyLine(safe));
    },
  };
  const logger = pino({
    level: opts.level ?? 'warn',
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { err: pino.stdSerializers.err },
  }, destination);
  return opts.bindings ? logger.child(opts.bindings) : logger;
}
