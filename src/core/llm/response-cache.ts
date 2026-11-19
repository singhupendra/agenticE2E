import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Redactor } from '../redact.js';
import type { StorageBackend } from '../storage/backend.js';
import { FilesystemBackend } from '../storage/filesystem.js';
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
 * For re-runs and CI. `read-only` never writes. Entries live under `prefix` of a StorageBackend (SPEC-014 FR-30);
 * `dir` is shorthand for a filesystem backend rooted there.
 */
export class ResponseCache {
  readonly mode: LLMCacheMode;
  private readonly storage: StorageBackend;
  private readonly prefix: string;
  private readonly redactor: Redactor;
  constructor(opts: { mode: LLMCacheMode; redactor?: Redactor } & ({ dir: string } | { storage: StorageBackend; prefix?: string })) {
    if ('storage' in opts) { this.storage = opts.storage; this.prefix = opts.prefix ?? 'llm-cache/'; } else { this.storage = new FilesystemBackend(opts.dir); this.prefix = ''; }
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

  private keyPath(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid cache key');
    return `${this.prefix}${key.slice(0, 2)}/${key}.json`;
  }

  /** The cached output if present and still valid for `schema`; anything else is a miss. */
  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    if (!this.readable) return undefined;
    try {
      const buf = await this.storage.read(this.keyPath(key));
      if (!buf) return undefined;
      const parsed = schema.safeParse((JSON.parse(buf.toString('utf8')) as CacheEntry).output);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, e: { name: string; model: string; output: unknown }): Promise<void> {
    if (!this.writable) return;
    const entry: CacheEntry = { key, name: e.name, model: e.model, createdAt: new Date().toISOString(), output: e.output };
    await this.storage.write(this.keyPath(key), this.redactor.redact(JSON.stringify(entry, null, 2)) + '\n'); // atomic replace
  }
}
