import type { Readable } from 'node:stream';

/**
 * SPEC-014 FR-21: a pluggable object store for everything under the data dir. Keys are relative POSIX paths
 * (`sites/<site>/runs/<id>/result.json`). The filesystem backend is the default; S3 etc. implement the same interface and
 * must pass `test/helpers/storage-contract.ts`.
 */
export interface StorageBackend {
  readonly kind: string;
  /** null when the key does not exist. */
  read(key: string): Promise<Buffer | null>;
  /** Atomic replace (readers never see a partial object). `mode` is a hint for backends with POSIX permissions. */
  write(key: string, data: Buffer | string, opts?: { mode?: number }): Promise<void>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<{ size: number; modifiedAt: Date } | null>;
  /** All keys starting with `prefix` (recursive), sorted. `''` lists everything. */
  list(prefix: string): Promise<string[]>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  createReadStream(key: string): Promise<Readable | null>;
  /** Resolves when the store is reachable and writable; rejects otherwise. Leaves nothing behind. */
  healthCheck(): Promise<void>;
}

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key ${JSON.stringify(key)}`);
    this.name = 'InvalidKeyError';
  }
}

/** Validate an object key: relative, POSIX, no empty / `.` / `..` segments, no backslash or NUL. */
export function assertKey(key: string): string {
  if (typeof key !== 'string' || key === '' || key.includes('\0') || key.includes('\\') || key.startsWith('/'))
    throw new InvalidKeyError(key);
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new InvalidKeyError(key);
  return key;
}

/** Prefixes may be '' or end with '/'; otherwise they follow key rules. */
export function assertPrefix(prefix: string): string {
  if (prefix === '') return prefix;
  assertKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
  return prefix;
}
