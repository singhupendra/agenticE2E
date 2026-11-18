import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InvalidKeyError, type StorageBackend } from '../../src/core/storage/backend.js';

/**
 * SPEC-014 FR-23: the behaviour every StorageBackend must have. A new backend (S3, …) is done when
 * `describeStorageContract('s3', () => …)` passes.
 */
export function describeStorageContract(name: string, factory: () => Promise<{ backend: StorageBackend; cleanup?: () => Promise<void> }>) {
  describe(`StorageBackend contract: ${name}`, () => {
    let b: StorageBackend, cleanup: (() => Promise<void>) | undefined;
    beforeEach(async () => { ({ backend: b, cleanup } = await factory()); });
    afterEach(async () => { await cleanup?.(); });

    it('round-trips text and binary data', async () => {
      await b.write('sites/a/site.json', '{"id":"a"}');
      expect((await b.read('sites/a/site.json'))?.toString('utf8')).toBe('{"id":"a"}');
      const bin = Buffer.from([0, 255, 1, 254]);
      await b.write('sites/a/screenshots/r/x.png', bin);
      expect(await b.read('sites/a/screenshots/r/x.png')).toEqual(bin);
    });

    it('overwrites existing keys', async () => {
      await b.write('k.txt', 'one');
      await b.write('k.txt', 'two');
      expect((await b.read('k.txt'))?.toString()).toBe('two');
    });

    it('missing keys: read → null, exists → false, stat → null, stream → null', async () => {
      expect(await b.read('nope/x')).toBeNull();
      expect(await b.exists('nope/x')).toBe(false);
      expect(await b.stat('nope/x')).toBeNull();
      expect(await b.createReadStream('nope/x')).toBeNull();
    });

    it('exists and stat report written objects', async () => {
      await b.write('dir/f.bin', Buffer.alloc(10));
      expect(await b.exists('dir/f.bin')).toBe(true);
      const st = await b.stat('dir/f.bin');
      expect(st?.size).toBe(10);
      expect(st?.modifiedAt).toBeInstanceOf(Date);
    });

    it('a "directory" prefix is not an object', async () => {
      await b.write('dir/f.bin', 'x');
      expect(await b.exists('dir')).toBe(false);
      expect(await b.read('dir')).toBeNull();
      expect(await b.stat('dir')).toBeNull();
    });

    it('lists keys under a prefix recursively and sorted', async () => {
      await b.write('sites/b/2.json', '2');
      await b.write('sites/a/1.json', '1');
      await b.write('sites/a/deep/3.json', '3');
      await b.write('other/4.json', '4');
      expect(await b.list('sites/')).toEqual(['sites/a/1.json', 'sites/a/deep/3.json', 'sites/b/2.json']);
      expect(await b.list('sites/a')).toEqual(['sites/a/1.json', 'sites/a/deep/3.json']);
      expect(await b.list('')).toEqual(['other/4.json', 'sites/a/1.json', 'sites/a/deep/3.json', 'sites/b/2.json']);
      expect(await b.list('missing/')).toEqual([]);
    });

    it('delete is idempotent', async () => {
      await b.write('d/x', 'x');
      await b.delete('d/x');
      expect(await b.exists('d/x')).toBe(false);
      await expect(b.delete('d/x')).resolves.toBeUndefined();
    });

    it('streams objects', async () => {
      await b.write('s/big.txt', 'a'.repeat(100_000));
      const stream = await b.createReadStream('s/big.txt');
      const chunks: Buffer[] = [];
      for await (const c of stream!) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('a'.repeat(100_000));
    });

    it('rejects unsafe keys', async () => {
      for (const k of ['', '/abs', '../up', 'a/../b', 'a\\b', 'a//b', 'a/', 'nul\0x', '.']) {
        await expect(b.write(k, 'x'), JSON.stringify(k)).rejects.toBeInstanceOf(InvalidKeyError);
        await expect(b.read(k), JSON.stringify(k)).rejects.toBeInstanceOf(InvalidKeyError);
      }
      await expect(b.list('../')).rejects.toBeInstanceOf(InvalidKeyError);
    });

    it('writes are atomic: no temp leftovers are listed', async () => {
      await Promise.all(Array.from({ length: 10 }, (_, i) => b.write('atomic/k', `v${i}`)));
      expect(await b.list('atomic/')).toEqual(['atomic/k']);
      expect((await b.read('atomic/k'))?.toString()).toMatch(/^v\d$/);
    });

    it('healthCheck succeeds and leaves nothing behind', async () => {
      await expect(b.healthCheck()).resolves.toBeUndefined();
      expect(await b.list('')).toEqual([]);
    });
  });
}
