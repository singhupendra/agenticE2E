import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { isDestructiveLink } from './safety.js';
import type { PageModel } from './types.js';

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  headless: boolean;
  /** when set, a (viewport) screenshot of every page is saved here */
  screenshotDir?: string;
  fullPage?: boolean;
  onPage?: (p: PageModel) => void;
  browser?: Browser;
  /** SPEC-009: Playwright storageState file of a logged-in user; the crawl then runs as that user. */
  storageState?: string;
}

const SKIP_EXT = /\.(pdf|zip|gz|tar|png|jpe?g|gif|svg|webp|ico|mp4|mp3|mov|avi|css|js|json|xml|txt|woff2?|ttf|dmg|exe)$/i;

/**
 * Runs inside the page. Kept as a plain-JS string (not a function) so bundler helpers such as
 * esbuild's `__name` are never injected into the browser context.
 */
const EXTRACT_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '); if (clean(t)) return clean(t); }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.textContent); }
    const wrap = el.closest('label'); if (wrap) return clean(wrap.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
    if (tag === 'img') return clean(el.alt);
    const txt = clean(el.innerText || el.textContent); if (txt) return txt;
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider'; if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  };
  const testId = (el) => el.getAttribute('data-testid') || undefined;
  const els = [];
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [data-testid]';
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    els.push({ role: roleOf(el), name: labelFor(el), tag: el.tagName.toLowerCase(), testId: testId(el), href: el.tagName === 'A' ? el.getAttribute('href') || undefined : undefined, type: el.type || undefined });
    if (els.length >= 80) break;
  }
  const forms = [...document.forms].filter(visible).slice(0, 8).map((f) => {
    const fields = [...f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter(visible).map((el) => ({
      label: labelFor(el), role: roleOf(el), type: el.type || undefined, name: el.getAttribute('name') || undefined, testId: testId(el), required: el.required || undefined,
    }));
    const btn = f.querySelector('button[type=submit], button:not([type]), input[type=submit]');
    return { name: f.getAttribute('aria-label') || f.getAttribute('name') || f.id || undefined, action: f.getAttribute('action') || undefined, method: (f.method || 'get').toLowerCase(), fields, submit: btn ? labelFor(btn) : undefined };
  });
  const seen = new Set(); const navLinks = [];
  for (const a of document.querySelectorAll('nav a[href], header a[href], [role=navigation] a[href]')) {
    const text = clean(a.textContent), href = a.getAttribute('href') || '';
    const key = text + '|' + href; if (!text || seen.has(key)) continue; seen.add(key); navLinks.push({ text, href });
    if (navLinks.length >= 30) break;
  }
  const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => clean(h.textContent)).filter(Boolean).slice(0, 12);
  const linkItems = [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: clean(a.getAttribute('aria-label') || a.textContent) }));
  const links = linkItems.map((l) => l.href);
  return { title: document.title, elements: els, forms, navLinks, headings, links, linkItems };
})()`;

interface Extracted {
  title: string; elements: PageModel['elements']; forms: PageModel['forms']; navLinks: PageModel['navLinks']; headings: string[]; links: string[]; linkItems: { href: string; text: string }[];
}

function canonical(href: string, origin: string): string | null {
  try {
    const u = new URL(href);
    if (u.origin !== origin || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
    if (SKIP_EXT.test(u.pathname)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

export async function capture(page: Page, url: string, depth: number): Promise<{ model: PageModel; links: string[] }> {
  const ex = (await page.evaluate(EXTRACT_SCRIPT)) as Extracted;
  let aria = '';
  try { aria = (await page.locator('body').ariaSnapshot({ timeout: 5000 })).slice(0, 6000); } catch { /* best effort */ }
  const u = new URL(page.url());
  return {
    model: { url: url, path: u.pathname + u.search, title: ex.title, depth, headings: ex.headings, ariaSnapshot: aria, elements: ex.elements, forms: ex.forms, navLinks: ex.navLinks },
    links: ex.linkItems.filter((l) => !isDestructiveLink(l.text, l.href)).map((l) => l.href),
  };
}

/** BFS crawl, same-origin, bounded by pages/depth/time. */
export async function crawl(startUrl: string, opts: CrawlOptions): Promise<PageModel[]> {
  const start = new URL(startUrl);
  const origin = start.origin;
  const deadline = Date.now() + opts.timeoutMs;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(opts.storageState ? { storageState: opts.storageState } : {}) });
  const pages: PageModel[] = [];
  const seen = new Set<string>([canonical(start.href, origin) ?? start.href]);
  const queue: { url: string; depth: number }[] = [{ url: start.href, depth: 0 }];
  let firstError: Error | undefined;
  try {
    const page = await context.newPage();
    while (queue.length && pages.length < opts.maxPages && Date.now() < deadline) {
      const { url, depth } = queue.shift()!;
      try {
        const resp = await page.goto(url, { waitUntil: 'load', timeout: Math.max(1000, Math.min(20_000, deadline - Date.now())) });
        if (resp && resp.status() >= 400 && pages.length > 0) continue; // skip broken sub-pages
        const { model, links } = await capture(page, url, depth);
        if (opts.screenshotDir) {
          fs.mkdirSync(opts.screenshotDir, { recursive: true });
          const f = path.join(opts.screenshotDir, `${String(pages.length + 1).padStart(2, '0')}-${(model.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home').slice(0, 40)}.png`);
          await page.screenshot({ path: f, fullPage: opts.fullPage ?? false }).then(() => { model.screenshot = f; }).catch(() => {});
        }
        pages.push(model);
        opts.onPage?.(model);
        if (depth < opts.maxDepth) {
          for (const l of links) {
            const c = canonical(l, origin);
            if (c && !seen.has(c)) { seen.add(c); queue.push({ url: c, depth: depth + 1 }); }
          }
        }
      } catch (e) {
        firstError ??= e as Error;
        if (pages.length === 0 && url === start.href) break;
      }
    }
  } finally {
    await context.close().catch(() => {});
    if (!opts.browser) await browser.close().catch(() => {});
  }
  if (pages.length === 0) throw new Error(`Could not reach or load ${startUrl}: ${firstError?.message.split('\n')[0] ?? 'no pages loaded'}`);
  return pages;
}
