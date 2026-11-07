import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crawl } from '../src/core/discovery.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';

let fx: Fixture;
beforeAll(async () => { fx = await startFixtureSite(); });
afterAll(async () => { await fx.close(); });

describe('discovery crawl', () => {
  it('AC-8: respects maxPages', async () => {
    const pages = await crawl(fx.url, { maxPages: 3, maxDepth: 3, timeoutMs: 60_000, headless: true });
    expect(pages).toHaveLength(3);
  });

  it('AC-9: never visits other origins or binary files', async () => {
    fx.hits.length = 0;
    const pages = await crawl(fx.url, { maxPages: 30, maxDepth: 3, timeoutMs: 60_000, headless: true });
    expect(fx.otherHits).toHaveLength(0);
    expect(pages.every((p) => p.url.startsWith(fx.url))).toBe(true);
    expect(fx.hits.some((h) => h.endsWith('.pdf'))).toBe(false);
    expect(pages.map((p) => p.path)).toContain('/team');
  });

  it('AC-10: maxDepth 0 returns only the start page', async () => {
    const pages = await crawl(fx.url, { maxPages: 10, maxDepth: 0, timeoutMs: 60_000, headless: true });
    expect(pages.map((p) => p.path)).toEqual(['/']);
  });

  it('AC-11: captures a compact page model', async () => {
    const pages = await crawl(fx.url, { maxPages: 10, maxDepth: 1, timeoutMs: 60_000, headless: true });
    const home = pages.find((p) => p.path === '/')!;
    expect(home.title).toBe('Fixture Shop - Home');
    expect(home.ariaSnapshot).toContain('link "About"');
    expect(home.navLinks.map((l) => l.text)).toEqual(expect.arrayContaining(['About', 'Contact']));
    expect(home.elements.find((e) => e.testId === 'search-input')).toMatchObject({ role: 'textbox', name: 'Search' });
    const contact = pages.find((p) => p.path === '/contact')!;
    expect(contact.forms).toHaveLength(1);
    expect(contact.forms[0].fields.map((f) => f.label)).toEqual(['Name', 'Email', 'Message']);
    expect(contact.forms[0].submit).toBe('Send message');
  });

  it('survives unreachable start url with a clear error', async () => {
    await expect(crawl('http://127.0.0.1:1', { maxPages: 1, maxDepth: 0, timeoutMs: 5000, headless: true })).rejects.toThrow(/reach|load|navigate/i);
  });
});
