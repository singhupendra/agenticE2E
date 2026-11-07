import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, normalizeSite } from '../src/core/storage.js';
import type { Journey } from '../src/core/types.js';

const j = (id: string): Journey => ({ id, name: id, goal: 'g', priority: 'high', tags: [], steps: ['a'], status: 'selected' });

describe('storage', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-')); });

  it('AC-5: normalizes sites', () => {
    expect(normalizeSite('https://WWW.Example.com:8443/a?b=1').id).toBe('www.example.com_8443');
    expect(normalizeSite('https://example.com:443/').id).toBe('example.com');
    expect(normalizeSite('http://example.com:80').id).toBe('example.com');
    expect(normalizeSite('http://localhost:3000').origin).toBe('http://localhost:3000');
  });

  it('rejects non-http urls', () => {
    expect(() => normalizeSite('ftp://x.com')).toThrow(/http/);
    expect(() => normalizeSite('not a url')).toThrow();
  });

  it('AC-6: journeys round-trip and null when absent', () => {
    const s = new Store(dir);
    expect(s.loadJourneys('example.com')).toBeNull();
    s.saveJourneys('example.com', [j('a'), j('b')]);
    expect(new Store(dir).loadJourneys('example.com')).toEqual([j('a'), j('b')]);
  });

  it('AC-7: rejects hostile site ids', () => {
    const s = new Store(dir);
    expect(() => s.siteDir('../../etc')).toThrow();
    expect(() => s.siteDir('a/b')).toThrow();
    expect(() => s.siteDir('')).toThrow();
  });

  it('saves code, keeps versions, lists sites', () => {
    const s = new Store(dir);
    s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    s.saveTest('example.com', 'a', 'code1');
    expect(s.loadTest('example.com', 'a')).toBe('code1');
    s.saveTestVersion('example.com', 'a', 'original', 'code1');
    expect(s.loadTestVersion('example.com', 'a', 'original')).toBe('code1');
    expect(s.listTests('example.com')).toEqual(['a']);
    expect(s.listSites().map((x) => x.id)).toEqual(['example.com']);
    expect(fs.existsSync(path.join(dir, 'sites/example.com/tests/_support.ts'))).toBe(true);
  });

  it('rejects hostile test ids', () => {
    const s = new Store(dir);
    expect(() => s.saveTest('example.com', '../x', 'c')).toThrow();
  });

  it('appends heals and creates run dirs', () => {
    const s = new Store(dir);
    s.appendHeal('example.com', { journeyId: 'a' } as never);
    s.appendHeal('example.com', { journeyId: 'b' } as never);
    expect(s.loadHeals('example.com')).toHaveLength(2);
    const r = s.createRun('example.com');
    expect(fs.existsSync(r.dir)).toBe(true);
    s.saveRun('example.com', { id: r.id, startedAt: 'x', finishedAt: 'y', results: [] } as never);
    expect(s.listRuns('example.com')).toHaveLength(1);
    expect(s.loadRun('example.com', r.id)?.id).toBe(r.id);
  });
});
