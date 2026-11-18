import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { assertKey, assertPrefix, type StorageBackend } from './backend.js';

const TMP_SUFFIX = '.ae2e-tmp';

/** SPEC-014 FR-22: StorageBackend on a local directory (the default). */
export class FilesystemBackend implements StorageBackend {
  readonly kind = 'filesystem';
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }

  /** Absolute path of a key, or null when it resolves (through symlinks) outside the root. */
  private async inside(key: string): Promise<string | null> {
    const abs = path.join(this.root, ...assertKey(key).split('/'));
    try {
      const [real, rootReal] = await Promise.all([fsp.realpath(abs), fsp.realpath(this.root)]);
      return real === rootReal || real.startsWith(rootReal + path.sep) ? real : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  private async file(key: string): Promise<string | null> {
    const p = await this.inside(key);
    if (!p) return null;
    const st = await fsp.stat(p).catch(() => null);
    return st?.isFile() ? p : null;
  }

  async read(key: string) { const f = await this.file(key); return f ? fsp.readFile(f) : null; }

  async write(key: string, data: Buffer | string, opts: { mode?: number } = {}) {
    const abs = path.join(this.root, ...assertKey(key).split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const dirReal = await fsp.realpath(path.dirname(abs));
    const rootReal = await fsp.realpath(this.root);
    if (dirReal !== rootReal && !dirReal.startsWith(rootReal + path.sep)) throw new Error('Storage key escapes the data directory');
    const tmp = `${abs}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`;
    try {
      await fsp.writeFile(tmp, data, { mode: opts.mode ?? 0o644 });
      if (opts.mode !== undefined) await fsp.chmod(tmp, opts.mode);
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async exists(key: string) { return (await this.file(key)) !== null; }

  async stat(key: string) {
    const f = await this.file(key);
    if (!f) return null;
    const st = await fsp.stat(f);
    return { size: st.size, modifiedAt: st.mtime };
  }

  async list(prefix: string) {
    assertPrefix(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        const k = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), k);
        else if (e.isFile() && !e.name.endsWith(TMP_SUFFIX)) out.push(k);
      }
    };
    // Walk only the deepest directory fully named by the prefix.
    const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    const start = dirPart ? await this.inside(dirPart) : (fs.existsSync(this.root) ? await fsp.realpath(this.root) : null);
    if (start) await walk(start, dirPart);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  async delete(key: string) {
    const f = await this.file(key);
    if (f) await fsp.rm(f, { force: true });
  }

  async createReadStream(key: string): Promise<Readable | null> {
    const f = await this.file(key);
    return f ? fs.createReadStream(f) : null;
  }

  async healthCheck() {
    const key = `.healthcheck-${randomBytes(6).toString('hex')}`;
    await this.write(key, 'ok');
    const back = await this.read(key);
    await this.delete(key);
    if (back?.toString() !== 'ok') throw new Error('storage health check read-back mismatch');
  }
}
