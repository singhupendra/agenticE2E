import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLM } from '../src/core/llm/mock.js';
import { Store } from '../src/core/storage.js';
import { generateSpec, generateTests } from '../src/core/codegen.js';
import type { Journey, PageModel } from '../src/core/types.js';
import { GOOD_SPEC, TYPE_ERROR_SPEC } from './helpers/specs.js';

const pages: PageModel[] = [{ url: 'http://x/', path: '/', title: 'Home', depth: 0, headings: [], ariaSnapshot: '', elements: [], forms: [], navLinks: [] }];
const journey = (id: string, status: Journey['status'] = 'selected'): Journey => ({ id, name: id, goal: 'goal', priority: 'high', tags: [], steps: ['open', 'check'], status });

describe('generateSpec', () => {
  it('AC-18: retries with diagnostics until valid', async () => {
    const llm = new MockLLM((_r, i) => ({ code: i === 0 ? TYPE_ERROR_SPEC : GOOD_SPEC }));
    const res = await generateSpec(llm, { journey: journey('j'), pages, baseUrl: 'http://x' }, { retries: 2 });
    expect(res.code).toBe(GOOD_SPEC);
    expect(res.attempts).toBe(2);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].prompt).toMatch(/gotoo/);
    expect(llm.calls[1].prompt).toContain(TYPE_ERROR_SPEC.slice(0, 40));
  });

  it('AC-19: gives up after retries', async () => {
    const llm = new MockLLM(() => ({ code: TYPE_ERROR_SPEC }));
    await expect(generateSpec(llm, { journey: journey('j'), pages, baseUrl: 'http://x' }, { retries: 1 })).rejects.toThrow(/failed validation after 2 attempts/);
    expect(llm.calls).toHaveLength(2);
  });

  it('strips markdown fences', async () => {
    const llm = new MockLLM(() => ({ code: '```ts\n' + GOOD_SPEC + '```' }));
    expect((await generateSpec(llm, { journey: journey('j'), pages, baseUrl: 'http://x' }, { retries: 0 })).code.trim()).toBe(GOOD_SPEC.trim());
  });

  it('prompt mentions journey steps and locator guidance', async () => {
    const llm = new MockLLM(() => ({ code: GOOD_SPEC }));
    await generateSpec(llm, { journey: journey('j'), pages, baseUrl: 'http://x' }, { retries: 0 });
    expect(llm.calls[0].prompt).toContain('open');
    expect(llm.calls[0].system).toMatch(/getByRole/);
  });
});

describe('generateTests', () => {
  let store: Store;
  beforeEach(() => { store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'))); });
  const base = { site: 'x.test', baseUrl: 'http://x.test', pages, retries: 1, requireApproval: false };

  it('AC-17: saves code and an original version', async () => {
    const llm = new MockLLM(() => ({ code: GOOD_SPEC }));
    const r = await generateTests(store, llm, [journey('a')], base);
    expect(r.generated).toEqual(['a']);
    expect(store.loadTest('x.test', 'a')).toBe(GOOD_SPEC);
    expect(store.loadTestVersion('x.test', 'a', 'original')).toBe(GOOD_SPEC);
  });

  it('AC-16: skips rejected, honours requireApproval', async () => {
    const llm = new MockLLM(() => ({ code: GOOD_SPEC }));
    const js = [journey('a', 'selected'), journey('b', 'rejected'), journey('c', 'approved'), journey('d', 'proposed')];
    expect((await generateTests(store, llm, js, base)).generated.sort()).toEqual(['a', 'c']);
    const store2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-')));
    expect((await generateTests(store2, llm, js, { ...base, requireApproval: true })).generated).toEqual(['c']);
  });

  it('AC-21: reuses stored code unless regenerate', async () => {
    const llm = new MockLLM(() => ({ code: GOOD_SPEC }));
    await generateTests(store, llm, [journey('a')], base);
    const again = await generateTests(store, llm, [journey('a')], base);
    expect(again.skipped).toEqual(['a']);
    expect(llm.calls).toHaveLength(1);
    const regen = await generateTests(store, llm, [journey('a')], { ...base, regenerate: true });
    expect(regen.generated).toEqual(['a']);
    expect(llm.calls).toHaveLength(2);
  });

  it('AC-19: failed journeys are reported, others continue, nothing saved for failure', async () => {
    const llm = new MockLLM((req) => ({ code: req.prompt.includes('id: bad') ? TYPE_ERROR_SPEC : GOOD_SPEC }));
    const r = await generateTests(store, llm, [journey('bad'), journey('ok')], { ...base, retries: 0 });
    expect(r.generated).toEqual(['ok']);
    expect(r.failed.map((f) => f.id)).toEqual(['bad']);
    expect(store.hasTest('x.test', 'bad')).toBe(false);
  });
});
