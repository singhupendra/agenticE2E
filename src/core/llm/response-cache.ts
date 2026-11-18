import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Redactor } from '../redact.js';
import type { StructuredRequest } from './types.js';

export const LLM_CACHE_MODES = ['off', 'read-write', 'read-only'] as const;
export type LLMCacheMode = (typeof LLM_CACHE_MODES)[number];

export interface CacheEntry { key: string; name: string; model: string; createdAt: string; output: unknown }

const KEY_VERSION = 1;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with sorted object keys, so equal values always hash equally. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * SPEC-013 FR-21/22: deterministic, opt-in cache of *parsed* LLM outputs keyed by a hash of the (already redacted) request.
 * For re-runs and CI. `read-only` never writes.
 */
export class ResponseCache {
  readonly mode: LLMCacheMode;
  private readonly dir: string;
  private readonly redactor: Redactor;
  constructor(opts: { dir: string; mode: LLMCacheMode; redactor?: Redactor }) {
    this.dir = opts.dir;
    this.mode = opts.mode;
    this.redactor = opts.redactor ?? Redactor.empty();
  }
  get readable() { return this.mode !== 'off'; }
  get writable() { return this.mode === 'read-write'; }

  key(req: StructuredRequest<unknown>, target: { provider: string; model: string }): string {
    const { $schema: _s, ...schema } = z.toJSONSchema(req.schema) as Record<string, unknown>;
    return sha256(canonical({
      v: KEY_VERSION, provider: target.provider, model: target.model, name: req.name, description: req.description,
      system: req.system, prompt: req.prompt, schema, images: (req.images ?? []).map((i) => `${i.mediaType}:${sha256(i.data)}`),
    }));
  }

  private file(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid cache key');
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  /** The cached output if present and still valid for `schema`; anything else is a miss. */
  get<T>(key: string, schema: z.ZodType<T>): T | undefined {
    if (!this.readable) return undefined;
    try {
      const entry = JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as CacheEntry;
      const parsed = schema.safeParse(entry.output);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, e: { name: string; model: string; output: unknown }): void {
    if (!this.writable) return;
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const entry: CacheEntry = { key, name: e.name, model: e.model, createdAt: new Date().toISOString(), output: e.output };
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, this.redactor.redact(JSON.stringify(entry, null, 2)) + '\n');
    fs.renameSync(tmp, f);
  }
}
