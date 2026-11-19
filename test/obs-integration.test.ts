import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { MockLLM } from '../src/core/llm/mock.js';
import { LLMBudgetError, type LLMProvider, type StructuredRequest } from '../src/core/llm/types.js';
import { resolveConfig } from '../src/core/config.js';
import { Store, normalizeSite } from '../src/core/storage.js';
import { createContext, runAll } from '../src/core/pipeline.js';
import { generateTests } from '../src/core/codegen.js';
import { healTest } from '../src/core/healer.js';
import { readAuditLog } from '../src/core/obs/audit.js';
import { listUsageReports, saveUsageReport } from '../src/core/obs/usage-store.js';
import { buildApp } from '../src/server/app.js';
import { main } from '../src/cli/index.js';
import { startFixtureSite, type Fixture } from './helpers/fixture-site.js';
import { FAILING_SPEC, HEALED_SPEC } from './helpers/specs.js';
import type { Journey, TestResult } from '../src/core/types.js';

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

function mockLLM() {
  return new MockLLM((req) => {
    switch (req.name) {
      case 'propose_journeys':
        return {
          journeys: [
            {
              name: 'Search for a product',
              goal: 'find widgets',
              priority: 'high',
              steps: ['open home', 'search widget', 'see results'],
            },
            {
              name: 'Contact form',
              goal: 'send a message',
              priority: 'medium',
              steps: ['open contact', 'fill form', 'submit', 'see thanks'],
            },
          ],
        };
      case 'rank_journeys':
        return {
          ranked: [
            { id: 'search-for-a-product', rationale: 'core' },
            { id: 'contact-form', rationale: 'lead gen' },
          ],
        };
      case 'write_playwright_spec':
        return { code: req.prompt.includes('id: contact-form') ? FAILING_SPEC : SEARCH_SPEC };
      case 'heal_test':
        return { verdict: 'test_breakage', reason: 'label renamed', code: HEALED_SPEC };
      default:
        throw new Error('unexpected ' + req.name);
    }
  });
}

/** A "provider" that throws a budget error on a given request name (simulates the governed layer stopping work). */
const budgetStop = (name: string, inner: LLMProvider): LLMProvider => ({
  structured: <T>(r: StructuredRequest<T>) =>
    r.name === name ? Promise.reject(new LLMBudgetError('LLM budget exceeded: test')) : inner.structured(r),
});

let fx: Fixture;
beforeAll(async () => {
  fx = await startFixtureSite();
});
afterAll(async () => {
  await fx.close();
});
afterEach(() => vi.restoreAllMocks());

describe('SPEC-013 pipeline wiring', () => {
  it('AC-17: runAll audits discover/generate/heal with one correlation id and writes a usage report', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-all-'));
    const config = resolveConfig({
      cli: {
        dataDir,
        maxPages: 5,
        maxDepth: 1,
        maxJourneys: 2,
        screenshots: 'off',
        healAttempts: 1,
        logLevel: 'debug',
        logFormat: 'json',
      },
    });
    const lines: string[] = [];
    const ctx = createContext({
      config,
      llm: mockLLM(),
      obs: {
        actor: 'cli:tester',
        action: 'all',
        site: normalizeSite(fx.url).id,
        logStream: {
          write: (s) => {
            lines.push(s);
          },
        },
      },
    });
    const r = await runAll(ctx, fx.url);
    const report = await ctx.obs.finish({ action: 'all', site: r.site, status: 'ok' });

    const audit = readAuditLog(path.join(dataDir, 'audit.jsonl'));
    expect(audit.map((e) => e.action)).toEqual(['discover', 'generate', 'heal.patch_applied']);
    expect(new Set(audit.map((e) => e.correlationId))).toEqual(new Set([ctx.obs.correlationId]));
    expect(audit.every((e) => e.actor === 'cli:tester' && e.site === r.site)).toBe(true);
    expect(audit[0].details).toMatchObject({ journeys: ['search-for-a-product', 'contact-form'] });
    expect(audit[1].details).toMatchObject({ generated: ['search-for-a-product', 'contact-form'] });
    expect(audit[2].details).toMatchObject({ journeyId: 'contact-form' });
    expect((audit[2].details as { linesAdded: number }).linesAdded).toBeGreaterThan(0);

    expect(report).not.toBeNull();
    expect(report!.totals.calls).toBe(5); // propose, rank, 2x codegen, heal
    const stored = await listUsageReports(dataDir, r.site);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: ctx.obs.correlationId, action: 'all', status: 'ok', actor: 'cli:tester' });
    expect(stored[0].calls.map((c) => c.name)).toEqual([
      'propose_journeys',
      'rank_journeys',
      'write_playwright_spec',
      'write_playwright_spec',
      'heal_test',
    ]);
    // FR-31: codegen and heal calls are attributed to their journey; planning calls are not
    expect(stored[0].calls.map((c) => c.journeyId)).toEqual([
      undefined,
      undefined,
      'search-for-a-product',
      'contact-form',
      'contact-form',
    ]);

    const logs = lines.map((l) => JSON.parse(l));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.correlationId === ctx.obs.correlationId)).toBe(true);
    expect(logs.filter((l) => l.msg === 'llm.call')).toHaveLength(5);
    expect(logs.some((l) => l.msg === 'run.finished' && typeof l.runId === 'string')).toBe(true);
    expect(logs.some((l) => l.msg === 'progress' && l.level === 'debug')).toBe(true);
  });

  it('AC-9: a budget error is not swallowed by codegen', async () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cg-')));
    const journey: Journey = {
      id: 'a',
      name: 'A',
      goal: 'g',
      priority: 'high',
      tags: [],
      steps: ['s'],
      status: 'selected',
    };
    await expect(
      generateTests(store, budgetStop('write_playwright_spec', mockLLM()), [journey], {
        site: 'x.test',
        baseUrl: 'http://x.test',
        pages: [],
        retries: 1,
        requireApproval: false,
      }),
    ).rejects.toBeInstanceOf(LLMBudgetError);
  });

  it('AC-9: a budget error is not swallowed by the healer, which restores the original test', async () => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-heal-')));
    store.saveTest('h.test', 'contact', FAILING_SPEC);
    const failure: TestResult = {
      journeyId: 'contact',
      file: 'contact.spec.ts',
      status: 'failed',
      durationMs: 1,
      error: 'x',
      screenshots: [],
    };
    await expect(
      healTest(store, budgetStop('heal_test', mockLLM()), {
        site: 'h.test',
        baseUrl: 'http://h',
        journeyId: 'contact',
        failure,
        attempts: 2,
        runner: async () => {
          throw new Error('not reached');
        },
      }),
    ).rejects.toBeInstanceOf(LLMBudgetError);
    expect(store.loadTest('h.test', 'contact')).toBe(FAILING_SPEC);
    expect(store.loadHeals('h.test')).toEqual([]);
  });

  it('FR-16: the budget stops a pipeline with a clear error and the report is still written', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-budget-'));
    const config = resolveConfig({
      cli: { dataDir, maxPages: 3, maxDepth: 1, screenshots: 'off', llmBudget: { maxTokensPerRun: 1 } },
    });
    // MockLLM reports no usage, so use a provider that reports some.
    const inner = mockLLM();
    const withUsage = {
      structured: <T>(r: StructuredRequest<T>) => inner.structured(r),
      structuredDetailed: async <T>(r: StructuredRequest<T>) => ({
        data: await inner.structured(r),
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    };
    const ctx = createContext({ config, llm: withUsage, obs: { logStream: { write: () => {} } } });
    const site = normalizeSite(fx.url).id;
    const e = await runAll(ctx, fx.url).catch((x) => x);
    expect(e).toBeInstanceOf(LLMBudgetError);
    expect(e.message).toMatch(/maxTokensPerRun/);
    await ctx.obs.finish({ action: 'all', site, status: 'error', error: e.message });
    expect((await listUsageReports(dataDir, site))[0]).toMatchObject({ status: 'error', totals: { calls: 1 } });
  });
});

describe('SPEC-013 server', () => {
  let app: FastifyInstance, dataDir: string;
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-srv-'));
    const config = resolveConfig({ cli: { dataDir, maxPages: 3, maxDepth: 1, maxJourneys: 1, logLevel: 'silent' } });
    const llm = new MockLLM((req) =>
      req.name === 'propose_journeys'
        ? { journeys: [{ name: 'Browse', goal: 'g', priority: 'high', steps: ['open home'] }] }
        : { ranked: [{ id: 'browse', rationale: 'r' }] },
    );
    app = await buildApp({ config, llm, webDir: path.join(dataDir, 'no-web') });
  });
  afterAll(async () => {
    await app.close();
  });
  const sse = (body: string) =>
    body
      .split('\n\n')
      .filter(Boolean)
      .map((b) => JSON.parse(b.replace(/^data: /, '')));

  it('AC-19: jobs expose usage, stream an llm summary before done, and reports are listed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { action: 'discover', url: fx.url, options: { screenshots: 'off' } },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    const events = sse((await app.inject(`/api/jobs/${jobId}/events`)).body);
    const llmIdx = events.findIndex((e) => e.type === 'info' && e.stage === 'llm');
    expect(llmIdx).toBeGreaterThan(-1);
    expect(events[llmIdx].message).toMatch(/^LLM: 2 calls/);
    expect(events.at(-1).type).toBe('done');
    expect(llmIdx).toBeLessThan(events.length - 1);
    const job = (await app.inject(`/api/jobs/${jobId}`)).json();
    expect(job.usage).toMatchObject({ calls: 2 });
    const site = normalizeSite(fx.url).id;
    const usage = (await app.inject(`/api/sites/${site}/usage`)).json();
    expect(usage.reports[0]).toMatchObject({ id: jobId, action: 'discover', actor: 'web:local@127.0.0.1' });
    expect(usage.totals.calls).toBeGreaterThanOrEqual(2);
    expect((await app.inject('/api/sites/..%2Fetc/usage')).statusCode).toBe(400);
  });

  it('server-only settings are not exposed in /api/config, so the UI can echo it back as job options', async () => {
    const cfg = (await app.inject('/api/config')).json();
    for (const k of ['logLevel', 'logFormat', 'llmBudget', 'llmMaxRetries', 'llmTimeoutMs', 'promptCaching'])
      expect(cfg, k).not.toHaveProperty(k);
    expect(cfg.llmCache).toBe('off');
  });

  it('AC-19: a job asking to change the budget is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { action: 'discover', url: fx.url, options: { llmBudget: { maxCostPerRun: 999 } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('AC-16: PUT journeys audits status changes with a web actor', async () => {
    const site = normalizeSite(fx.url).id;
    const store = new Store(dataDir);
    const journeys = store.loadJourneys(site)!;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site}/journeys`,
      payload: journeys.map((j) => ({ ...j, status: 'rejected' })),
    });
    expect(res.statusCode).toBe(200);
    const entries = readAuditLog(path.join(dataDir, 'audit.jsonl'), { site });
    const last = entries.at(-1)!;
    expect(last).toMatchObject({ action: 'journeys.status_changed', actor: 'web:local@127.0.0.1' });
    expect(last.details).toMatchObject({ changes: [{ id: 'browse', from: 'selected', to: 'rejected' }] });
    expect(entries.some((e) => e.action === 'discover')).toBe(true);
  });
});

describe('SPEC-013 cli', () => {
  let dir: string, out: string[];
  const cli = (...args: string[]) => main(['node', 'agentic-e2e', ...args, '--data-dir', dir]);
  const setup = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cli-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => {
      out.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  it('AC-21: usage <url> lists reports, --json prints them', async () => {
    setup();
    const totals = {
      calls: 3,
      failed: 0,
      cached: 1,
      retries: 0,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      costUsd: 0.0123,
      unpricedCalls: 0,
      latencyMs: 10,
    };
    await saveUsageReport(dir, 'example.com', {
      id: 'c-1',
      action: 'generate',
      site: 'example.com',
      actor: 'cli:x',
      startedAt: '2026-11-18T00:00:00.000Z',
      finishedAt: '2026-11-18T00:01:00.000Z',
      status: 'ok',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      totals,
      calls: [],
    });
    expect(await cli('usage', 'https://example.com')).toBe(0);
    expect(out.join('\n')).toMatch(/generate.*3 calls.*\$0\.0123/);
    out.length = 0;
    expect(await cli('usage', 'https://example.com', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))[0]).toMatchObject({ id: 'c-1', totals: { calls: 3 } });
  });

  it('AC-16: journeys --approve is audited with a cli actor; audit --verify reports ok', async () => {
    setup();
    const s = new Store(dir);
    s.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    s.saveJourneys('example.com', [
      { id: 'a', name: 'A', goal: 'g', priority: 'high', tags: [], steps: ['s'], status: 'selected' },
    ]);
    expect(await cli('journeys', 'https://example.com', '--approve', 'a')).toBe(0);
    const [e] = readAuditLog(path.join(dir, 'audit.jsonl'));
    expect(e).toMatchObject({
      action: 'journeys.status_changed',
      site: 'example.com',
      details: { changes: [{ id: 'a', from: 'selected', to: 'approved' }] },
    });
    expect(e.actor).toMatch(/^cli:/);
    out.length = 0;
    expect(await cli('audit', '--verify')).toBe(0);
    expect(out.join('\n')).toMatch(/intact: 1 entry/i);
    out.length = 0;
    expect(await cli('audit', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toHaveLength(1);
  });

  it('rejects invalid --log-level', async () => {
    setup();
    expect(await cli('run', 'https://example.com', '--log-level', 'loud')).toBe(1);
  });
});
