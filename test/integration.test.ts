import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockLLM } from '../src/core/llm/mock.js';
import { resolveConfig } from '../src/core/config.js';
import { Store, normalizeSite } from '../src/core/storage.js';
import { createContext, runAll } from '../src/core/pipeline.js';
import type { ProgressEvent } from '../src/core/types.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';
import { FAILING_SPEC, HEALED_SPEC } from './helpers/specs.js';

const SEARCH_SPEC = `import { test, expect } from './_support';

test('search for a product', async ({ page, step }) => {
  await step('open home', async () => { await page.goto('/'); });
  await step('search', async () => {
    await page.getByLabel('Search').fill('widget');
    await page.getByRole('button', { name: 'Search' }).click();
  });
  await expect(page.getByRole('heading', { name: /Results for widget/ })).toBeVisible();
});
`;

let fx: Fixture;
beforeAll(async () => { fx = await startFixtureSite(); });
afterAll(async () => { await fx.close(); });

function mockLLM() {
  return new MockLLM((req) => {
    switch (req.name) {
      case 'propose_journeys':
        return { journeys: [
          { name: 'Search for a product', goal: 'find widgets', priority: 'high', steps: ['open home', 'search widget', 'see results'] },
          { name: 'Contact form', goal: 'send a message', priority: 'medium', steps: ['open contact', 'fill form', 'submit', 'see thanks'] },
          { name: 'Login', goal: 'sign in', priority: 'low', steps: ['open login'] },
        ] };
      case 'rank_journeys':
        return { ranked: [{ id: 'search-for-a-product', rationale: 'core' }, { id: 'contact-form', rationale: 'lead gen' }, { id: 'login', rationale: 'meh' }] };
      case 'write_playwright_spec':
        return { code: req.prompt.includes('id: contact-form') ? FAILING_SPEC : SEARCH_SPEC };
      case 'heal_test':
        return { verdict: 'test_breakage', reason: 'Label "Your full name" was renamed to "Name"; email is now required', code: HEALED_SPEC };
      default:
        throw new Error('unexpected ' + req.name);
    }
  });
}

describe('full pipeline (fixture site, mocked LLM)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-int-'));
  const config = resolveConfig({ cli: { dataDir, maxPages: 8, maxDepth: 1, maxJourneys: 2, healAttempts: 2, testTimeoutMs: 15_000, screenshots: 'on-failure' } });
  const events: ProgressEvent[] = [];
  const llm = mockLLM();
  const ctx = createContext({ config, llm, onProgress: (e) => events.push(e) });
  let site = '';
  const store = new Store(dataDir);

  it('AC-28: discover → select → generate → run → heal on an unknown site', async () => {
    site = normalizeSite(fx.url).id;
    const res = await runAll(ctx, fx.url, {});
    expect(res.journeys.filter((j) => j.status === 'selected').map((j) => j.id).sort()).toEqual(['contact-form', 'search-for-a-product']);
    expect(res.generate.generated.sort()).toEqual(['contact-form', 'search-for-a-product']);
    expect(res.run.results.find((r) => r.journeyId === 'contact-form')!.status).toBe('failed');
    expect(res.heals).toHaveLength(1);
    expect(res.heals[0].outcome).toBe('healed');
    expect(res.final.sort((a, b) => a.journeyId.localeCompare(b.journeyId))).toEqual([
      { journeyId: 'contact-form', status: 'passed', healed: true },
      { journeyId: 'search-for-a-product', status: 'passed', healed: false },
    ]);

    const sd = store.siteDir(site);
    expect(fs.existsSync(path.join(sd, 'journeys.json'))).toBe(true);
    expect(fs.existsSync(path.join(sd, 'tests/contact-form.spec.ts'))).toBe(true);
    expect(fs.existsSync(path.join(sd, 'tests/.versions/contact-form/original.spec.ts'))).toBe(true);
    expect(store.loadTest(site, 'contact-form')).toBe(HEALED_SPEC);
    expect(store.listRuns(site).length).toBeGreaterThanOrEqual(2); // initial run + heal re-run
    expect(store.loadHeals(site)[0].diff).toContain('getByLabel');
    const shots = fs.readdirSync(path.join(sd, 'screenshots'), { recursive: true }).map(String).filter((f) => f.endsWith('failure.png'));
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'stage' && e.stage === 'discover')).toBe(true);
    expect(events.some((e) => e.type === 'stage' && e.stage === 'heal')).toBe(true);
  });

  it('AC-29: second run reuses stored journeys and code (no discover/generate LLM calls)', async () => {
    const before = llm.calls.length;
    const res = await runAll(ctx, fx.url, {});
    expect(llm.calls.length).toBe(before);
    expect(res.reusedJourneys).toBe(true);
    expect(res.final.every((f) => f.status === 'passed')).toBe(true);
  });

  it('AC-30: --rediscover runs discovery and selection again', async () => {
    const before = llm.callsFor('propose_journeys').length;
    const res = await runAll(ctx, fx.url, { rediscover: true });
    expect(llm.callsFor('propose_journeys').length).toBe(before + 1);
    expect(res.reusedJourneys).toBe(false);
  });
});
