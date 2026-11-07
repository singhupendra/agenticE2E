import { describe, it, expect } from 'vitest';
import { MockLLM } from '../src/core/llm/mock.js';
import { proposeJourneys, selectJourneys, applyFilters, slugify } from '../src/core/planner.js';
import type { Journey, PageModel } from '../src/core/types.js';

const page: PageModel = { url: 'http://x/', path: '/', title: 'Home', depth: 0, headings: ['Hi'], ariaSnapshot: '- link "About"', elements: [], forms: [], navLinks: [] };
const mk = (name: string, priority: Journey['priority'] = 'medium', status: Journey['status'] = 'proposed'): Journey => ({ id: slugify(name), name, goal: `goal of ${name}`, priority, tags: [], steps: ['s'], status });

describe('planner', () => {
  it('AC-12: proposes journeys with unique ids', async () => {
    const llm = new MockLLM(() => ({ journeys: [
      { name: 'Search for product', goal: 'g', priority: 'high', steps: ['a', 'b'] },
      { name: 'Search for product', goal: 'dup name', priority: 'low', steps: ['a'] },
    ] }));
    const js = await proposeJourneys(llm, [page]);
    expect(js.map((j) => j.id)).toEqual(['search-for-product', 'search-for-product-2']);
    expect(js[0]).toMatchObject({ priority: 'high', status: 'proposed', steps: ['a', 'b'] });
    expect(llm.calls[0].prompt).toContain('Home');
  });

  it('AC-12: invalid LLM output fails clearly', async () => {
    const llm = new MockLLM(() => ({ journeys: [{ name: 'x' }] }));
    await expect(proposeJourneys(llm, [page])).rejects.toThrow(/invalid|schema/i);
  });

  it('rejects empty page lists', async () => {
    await expect(proposeJourneys(new MockLLM(() => ({})), [])).rejects.toThrow(/no pages/i);
  });

  it('AC-13: selects top maxJourneys per LLM ranking', async () => {
    const js = ['a', 'b', 'c', 'd', 'e'].map((n) => mk(n));
    const llm = new MockLLM(() => ({ ranked: [{ id: 'c', rationale: 'r1' }, { id: 'a', rationale: 'r2' }, { id: 'e', rationale: 'r3' }] }));
    const out = await selectJourneys(llm, js, { maxJourneys: 2, include: [], exclude: [] });
    expect(out.filter((j) => j.status === 'selected').sort((x, y) => x.rank! - y.rank!).map((j) => j.id)).toEqual(['c', 'a']);
    expect(out.find((j) => j.id === 'c')).toMatchObject({ rank: 1, rationale: 'r1' });
    expect(out.find((j) => j.id === 'e')!.status).toBe('proposed');
  });

  it('AC-14/15: include/exclude filters', () => {
    const js = [mk('User login'), mk('Search products'), mk('Contact form')];
    expect(applyFilters(js, [], ['login']).map((j) => j.name)).toEqual(['Search products', 'Contact form']);
    expect(applyFilters(js, ['search'], []).map((j) => j.name)).toEqual(['Search products']);
    expect(applyFilters(js, ['/^contact/i'], []).map((j) => j.name)).toEqual(['Contact form']);
  });

  it('AC-14: excluded journeys are never selected even if LLM ranks them', async () => {
    const js = [mk('User login'), mk('Search')];
    const llm = new MockLLM((req) => ({ ranked: [{ id: 'user-login', rationale: 'x' }, { id: 'search', rationale: 'y' }] }));
    const out = await selectJourneys(llm, js, { maxJourneys: 5, include: [], exclude: ['login'] });
    expect(out.find((j) => j.id === 'user-login')!.status).toBe('proposed');
    expect(out.find((j) => j.id === 'search')!.status).toBe('selected');
  });

  it('keeps user-approved journeys and skips rejected ones', async () => {
    const js = [mk('a', 'low', 'approved'), mk('b'), mk('c', 'medium', 'rejected')];
    const llm = new MockLLM(() => ({ ranked: [{ id: 'c', rationale: '' }, { id: 'b', rationale: '' }] }));
    const out = await selectJourneys(llm, js, { maxJourneys: 2, include: [], exclude: [] });
    expect(out.find((j) => j.id === 'a')!.status).toBe('approved');
    expect(out.find((j) => j.id === 'b')!.status).toBe('selected');
    expect(out.find((j) => j.id === 'c')!.status).toBe('rejected');
  });

  it('falls back to priority order when the LLM ranks nothing valid', async () => {
    const js = [mk('lo', 'low'), mk('hi', 'high')];
    const out = await selectJourneys(new MockLLM(() => ({ ranked: [{ id: 'nope', rationale: '' }] })), js, { maxJourneys: 1, include: [], exclude: [] });
    expect(out.find((j) => j.id === 'hi')!.status).toBe('selected');
  });

  it('slugify', () => { expect(slugify('Add to Cart!')).toBe('add-to-cart'); expect(slugify('   ')).toBe('journey'); });
});
