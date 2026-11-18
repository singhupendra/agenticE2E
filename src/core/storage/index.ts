import type { StorageBackend } from './backend.js';
import { FilesystemBackend } from './filesystem.js';

export { assertKey, InvalidKeyError, type StorageBackend } from './backend.js';
export { FilesystemBackend } from './filesystem.js';

export interface StorageOptions { kind: string; root?: string; [option: string]: unknown }
type Factory = (opts: StorageOptions) => StorageBackend;

const factories = new Map<string, Factory>([
  ['filesystem', (o) => {
    if (!o.root) throw new Error('filesystem storage needs a root directory');
    return new FilesystemBackend(o.root);
  }],
]);

/** SPEC-014 FR-22: plug in another backend (e.g. S3) without touching callers. */
export function registerStorageBackend(kind: string, factory: Factory) {
  if (factories.has(kind)) throw new Error(`Storage backend "${kind}" is already registered`);
  factories.set(kind, factory);
}
export function storageBackendKinds(): string[] { return [...factories.keys()]; }

export function createStorageBackend(opts: StorageOptions): StorageBackend {
  const f = factories.get(opts.kind);
  if (!f) throw new Error(`Unknown storage backend "${opts.kind}" (known: ${storageBackendKinds().join(', ')})`);
  return f(opts);
}
