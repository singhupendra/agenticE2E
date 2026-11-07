import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli/index.js';
import { Store } from '../src/core/storage.js';
import type { Journey } from '../src/core/types.js';
import { fakeAwsFiles, SAMPLE_CONFIG, SAMPLE_CREDENTIALS } from './helpers/aws-files.js';

const j = (id: string, status: Journey['status'] = 'selected'): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['a'], status });
let dir: string, out: string[], err: string[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
});
afterEach(() => vi.restoreAllMocks());
const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);

describe('cli', () => {
  it('AC-31: non-http url fails with message', async () => {
    expect(await cli('discover', 'ftp://example.com')).toBe(1);
    expect(err.join('\n')).toMatch(/http/);
  });
  it('AC-31: missing url exits non-zero', async () => {
    expect(await cli('discover')).not.toBe(0);
  });
  it('AC-3: invalid screenshots mode rejected', async () => {
    expect(await cli('run', 'https://example.com', '--screenshots', 'sometimes')).toBe(1);
    expect(err.join('\n')).toMatch(/screenshots/);
  });
  it('list shows known sites', async () => {
    const s = new Store(dir);
    s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    s.saveJourneys('example.com', [j('a')]);
    expect(await cli('list')).toBe(0);
    expect(out.join('\n')).toContain('example.com');
  });
  it('list with no sites', async () => {
    expect(await cli('list')).toBe(0);
    expect(out.join('\n')).toMatch(/no sites/i);
  });
  it('journeys --approve / --reject update stored statuses', async () => {
    const s = new Store(dir);
    s.saveJourneys('example.com', [j('a'), j('b'), j('c')]);
    expect(await cli('journeys', 'https://example.com', '--approve', 'a', '--reject', 'b')).toBe(0);
    expect(s.loadJourneys('example.com')!.map((x) => x.status)).toEqual(['approved', 'rejected', 'selected']);
    expect(await cli('journeys', 'https://example.com', '--approve-all')).toBe(0);
    expect(s.loadJourneys('example.com')!.map((x) => x.status)).toEqual(['approved', 'rejected', 'approved']);
    expect(await cli('journeys', 'https://example.com', '--approve', 'zzz')).toBe(1);
  });
  it('journeys without stored data explains next step', async () => {
    expect(await cli('journeys', 'https://nowhere.test')).toBe(1);
    expect(err.join('\n')).toMatch(/discover/);
  });
  it('journeys --edit applies a validated edit via $EDITOR', async () => {
    const s = new Store(dir);
    s.saveJourneys('example.com', [j('a')]);
    const editor = path.join(dir, 'ed.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nsed -i.bak "s/Journey a/Renamed/" "$1"\n', { mode: 0o755 });
    process.env.EDITOR = editor;
    expect(await cli('journeys', 'https://example.com', '--edit')).toBe(0);
    expect(s.loadJourneys('example.com')![0].name).toBe('Renamed');
  });

  it('SPEC-002 AC-9: models lists the catalog per provider', async () => {
    expect(await cli('models', '--provider', 'bedrock')).toBe(0);
    expect(out.join('\n')).toContain('anthropic.claude-sonnet-5-5');
    out.length = 0;
    expect(await cli('models')).toBe(0);
    expect(out.join('\n')).toContain('claude-sonnet-5-5');
    expect(out.join('\n')).not.toContain('anthropic.claude');
    expect(await cli('models', '--provider', 'nope')).toBe(1);
    expect(err.join('\n')).toMatch(/provider/);
  });

  describe('SPEC-003 aws-profiles', () => {
    const saved = { c: process.env.AWS_CONFIG_FILE, k: process.env.AWS_SHARED_CREDENTIALS_FILE };
    afterEach(() => {
      for (const [n, v] of [['AWS_CONFIG_FILE', saved.c], ['AWS_SHARED_CREDENTIALS_FILE', saved.k]] as const) {
        if (v === undefined) delete process.env[n]; else process.env[n] = v;
      }
    });

    it('AC-11: lists discovered profiles and marks the configured one', async () => {
      Object.assign(process.env, fakeAwsFiles(SAMPLE_CONFIG, SAMPLE_CREDENTIALS));
      expect(await cli('aws-profiles', '--aws-profile', 'dev')).toBe(0);
      const text = out.join('\n');
      for (const p of ['ci', 'default', 'dev']) expect(text).toContain(p);
      expect(text).toMatch(/dev.*<- selected/);
      expect(text).not.toMatch(/SUPERSECRET/);
    });

    it('AC-11: no profiles -> exit 0 with a hint', async () => {
      Object.assign(process.env, fakeAwsFiles());
      expect(await cli('aws-profiles')).toBe(0);
      expect(out.join('\n')).toMatch(/no aws profiles/i);
    });

    it('models --provider bedrock mentions --aws-profile', async () => {
      expect(await cli('models', '--provider', 'bedrock')).toBe(0);
      expect(out.join('\n')).toContain('--aws-profile');
    });
  });
});
