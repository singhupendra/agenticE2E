import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLM } from '../src/core/llm/mock.js';
import { Store } from '../src/core/storage.js';
import { healTest } from '../src/core/healer.js';
import type { RunRecord, TestResult } from '../src/core/types.js';
import { FAILING_SPEC, HEALED_SPEC } from './helpers/specs.js';

const SITE = 'h.test';
let store: Store;
const failure: TestResult = { journeyId: 'contact', file: 'contact.spec.ts', status: 'failed', durationMs: 1, error: 'locator not found: Your full name', screenshots: [], failure: { url: 'http://h/contact', title: 'Contact', ariaSnapshot: '- textbox "Name"', html: '<form></form>' } };
const rec = (status: TestResult['status'], error?: string): RunRecord => ({ id: 'r', kind: 'heal-rerun', startedAt: '', finishedAt: '', screenshots: 'off', fullPage: false, results: [{ ...failure, status, error, failure: status === 'failed' ? failure.failure : undefined }] });
const base = () => ({ site: SITE, baseUrl: 'http://h', journeyId: 'contact', failure, attempts: 2 });

beforeEach(() => {
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'heal-')));
  store.saveTest(SITE, 'contact', FAILING_SPEC);
});

describe('healTest', () => {
  it('AC-24: applies a valid patch, re-runs, keeps original + diff + reason', async () => {
    const llm = new MockLLM(() => ({ verdict: 'test_breakage', reason: 'label renamed to Name', code: HEALED_SPEC }));
    const reruns: string[] = [];
    const rec1 = await healTest(store, llm, { ...base(), runner: async () => { reruns.push(store.loadTest(SITE, 'contact')!); return rec('passed'); } });
    expect(rec1.outcome).toBe('healed');
    expect(reruns).toEqual([HEALED_SPEC]);
    expect(store.loadTest(SITE, 'contact')).toBe(HEALED_SPEC);
    expect(store.loadTestVersion(SITE, 'contact', 'original')).toBe(FAILING_SPEC);
    expect(rec1.diff).toMatch(/-.*Your full name/);
    expect(rec1.diff).toMatch(/\+.*getByLabel\('Name'\)/);
    expect(rec1.reason).toMatch(/renamed/);
    expect(rec1.attempts).toHaveLength(1);
    expect(store.loadHeals(SITE)).toHaveLength(1);
    expect(store.listTestVersions(SITE, 'contact').length).toBe(2);
    expect(llm.calls[0].prompt).toContain('textbox "Name"');
    expect(llm.calls[0].prompt).toContain('Your full name');
  });

  it('AC-25: rejects assertion-deleting patches without re-running, feeds back, keeps original', async () => {
    const stripped = HEALED_SPEC.replace(/\n\s*await expect\(page\.getByRole\('status'\)\).*\n/, '\n');
    expect(stripped).not.toBe(HEALED_SPEC);
    const llm = new MockLLM(() => ({ verdict: 'test_breakage', reason: 'x', code: stripped }));
    let ran = 0;
    const r = await healTest(store, llm, { ...base(), runner: async () => { ran++; return rec('passed'); } });
    expect(ran).toBe(0);
    expect(r.outcome).toBe('failed');
    expect(r.attempts.every((a) => !a.accepted && /fewer assertions/.test(a.rejection ?? ''))).toBe(true);
    expect(llm.calls[1].prompt).toMatch(/fewer assertions/);
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
  });

  it('AC-26: app_bug verdict does not patch or re-run', async () => {
    const llm = new MockLLM(() => ({ verdict: 'app_bug', reason: 'submit shows no confirmation', code: HEALED_SPEC }));
    let ran = 0;
    const r = await healTest(store, llm, { ...base(), runner: async () => { ran++; return rec('passed'); } });
    expect(r.outcome).toBe('app_bug');
    expect(ran).toBe(0);
    expect(llm.calls).toHaveLength(1);
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
    expect(store.loadHeals(SITE)[0].outcome).toBe('app_bug');
  });

  it('AC-27: limited attempts, restores original when patches never pass', async () => {
    const llm = new MockLLM((_r, i) => ({ verdict: 'test_breakage', reason: 'try ' + i, code: HEALED_SPEC + `\n// attempt ${i}\n` }));
    let ran = 0;
    const r = await healTest(store, llm, { ...base(), attempts: 2, runner: async () => { ran++; return rec('failed', 'still broken'); } });
    expect(r.attempts).toHaveLength(2);
    expect(ran).toBe(2);
    expect(r.outcome).toBe('failed');
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
    expect(llm.calls[1].prompt).toMatch(/still broken/);
  });

  it('rejects patches that fail validation', async () => {
    const llm = new MockLLM(() => ({ verdict: 'test_breakage', reason: 'x', code: HEALED_SPEC.replace('page.goto', 'page.gotoo') }));
    const r = await healTest(store, llm, { ...base(), attempts: 1, runner: async () => rec('passed') });
    expect(r.attempts[0].rejection).toMatch(/gotoo/);
    expect(r.outcome).toBe('failed');
  });

  it('flaky verdict: re-runs unchanged and reports flaky when it passes', async () => {
    const llm = new MockLLM(() => ({ verdict: 'flaky_or_environment', reason: 'timeout on slow load' }));
    const r = await healTest(store, llm, { ...base(), runner: async () => rec('passed') });
    expect(r.outcome).toBe('flaky_or_environment');
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
  });

  it('restores the original and records the failure when the runner throws', async () => {
    const llm = new MockLLM(() => ({ verdict: 'test_breakage', reason: 'x', code: HEALED_SPEC }));
    const r = await healTest(store, llm, { ...base(), runner: async () => { throw new Error('spawn EAGAIN'); } });
    expect(r.outcome).toBe('failed');
    expect(r.reason).toMatch(/spawn EAGAIN/);
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
    expect(store.loadHeals(SITE)).toHaveLength(1);
  });

  it('restores the original and records the failure when the LLM throws mid-heal', async () => {
    const llm = new MockLLM((_r, i) => { if (i === 1) throw new Error('API 529'); return { verdict: 'test_breakage', reason: 'x', code: HEALED_SPEC }; });
    const r = await healTest(store, llm, { ...base(), runner: async () => rec('failed', 'still broken') });
    expect(r.outcome).toBe('failed');
    expect(r.reason).toMatch(/API 529/);
    expect(r.attempts).toHaveLength(1);
    expect(store.loadTest(SITE, 'contact')).toBe(FAILING_SPEC);
  });

  it('includes the screenshot as an image when available', async () => {
    const siteDir = store.siteDir(SITE);
    fs.mkdirSync(path.join(siteDir, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(siteDir, 'screenshots/f.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const llm = new MockLLM(() => ({ verdict: 'app_bug', reason: 'x' }));
    await healTest(store, llm, { ...base(), failure: { ...failure, failure: { ...failure.failure!, screenshot: 'screenshots/f.png' } }, runner: async () => rec('passed') });
    expect(llm.calls[0].images).toHaveLength(1);
  });
});
