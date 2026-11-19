import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilesystemBackend } from '../src/core/storage/filesystem.js';
import { createStorageBackend, registerStorageBackend, storageBackendKinds } from '../src/core/storage/index.js';
import { describeStorageContract } from './helpers/storage-contract.js';

describeStorageContract('filesystem', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-'));
  return {
    backend: new FilesystemBackend(root),
    cleanup: async () => fs.rmSync(root, { recursive: true, force: true }),
  };
});

describe('SPEC-014 storage factory', () => {
  it('AC-26: filesystem is the default; unknown kinds list the known ones; custom kinds plug in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-'));
    const b = createStorageBackend({ kind: 'filesystem', root });
    expect(b).toBeInstanceOf(FilesystemBackend);
    expect(b.kind).toBe('filesystem');
    expect(() => createStorageBackend({ kind: 'nope' })).toThrow(/nope.*filesystem/);
    const custom = new FilesystemBackend(root);
    registerStorageBackend('mem-test', () => custom);
    expect(createStorageBackend({ kind: 'mem-test' })).toBe(custom);
    expect(storageBackendKinds()).toEqual(expect.arrayContaining(['filesystem', 'mem-test']));
    expect(() => registerStorageBackend('filesystem', () => custom)).toThrow(/already/);
  });

  it('filesystem writes can be private (0600) and the root is created lazily', async () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-')), 'not-yet');
    const b = new FilesystemBackend(root);
    expect(await b.list('')).toEqual([]);
    await b.write('auth/u.json', '{}', { mode: 0o600 });
    expect(fs.statSync(path.join(root, 'auth', 'u.json')).mode & 0o777).toBe(0o600);
  });

  it('does not follow keys out of the root through symlinks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'link'));
    const b = new FilesystemBackend(root);
    expect(await b.read('link/secret.txt')).toBeNull();
    expect(await b.createReadStream('link/secret.txt')).toBeNull();
  });
});
