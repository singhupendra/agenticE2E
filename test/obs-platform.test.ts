/**
 * SPEC-013 §3.10: integration with SPEC-011 (reports), SPEC-012 (browser/device projects) and SPEC-014 (strict config,
 * roles, StorageBackend).
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildApp } from '../src/server/app.js';
import { resolveConfig } from '../src/core/config.js';
import { ConfigError } from '../src/core/config-check.js';
import { generateToken, hashToken, TokenRegistry } from '../src/core/security/tokens.js';
import { FilesystemBackend } from '../src/core/storage/filesystem.js';
import type { StorageBackend } from '../src/core/storage/backend.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { GovernedLLM } from '../src/core/llm/governed.js';
import { UsageTracker, type LLMCallRecord } from '../src/core/llm/usage.js';
import { withLLMScope } from '../src/core/llm/scope.js';
import { buildRunReport } from '../src/core/reporting/model.js';
import { renderHtml } from '../src/core/reporting/html.js';
import { createObservability } from '../src/core/obs/index.js';
import { listUsageReports, saveUsageReport } from '../src/core/obs/usage-store.js';
import { Store } from '../src/core/storage.js';
import { main } from '../src/cli/index.js';
import type { RunRecord, TestResult } from '../src/core/types.js';

const T = { viewer: generateToken(), operator: generateToken(), admin: generateToken() };
const registry = new TokenRegistry(Object.entries(T).map(([role, t]) => ({ name: `${role}-user`, role: role as 'viewer', hash: hashToken(t) })));
const bearer = (role: keyof typeof T) => ({ authorization: `Bearer ${T[role]}` });
const json = { 'content-type': 'application/json' };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const totals = (calls = 1, costUsd = 0.01) => ({ calls, failed: 0, cached: 0, retries: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, costUsd, unpricedCalls: 0, latencyMs: 5 });
const report = (id: string, site = 'example.com') => ({ id, action: 'generate', site, actor: 'cli:x', startedAt: `2026-11-18T00:00:0${id.slice(-1)}.000Z`, finishedAt: '2026-11-18T00:01:00.000Z', status: 'ok' as const, provider: 'anthropic', model: 'claude-sonnet-5-5', totals: totals(), calls: [] });

/** A StorageBackend that records writes (filesystem underneath). */
const spyStorage = (root: string) => {
  const fsb = new FilesystemBackend(root);
  const writes: string[] = [];
  const s: StorageBackend = Object.assign(Object.create(Object.getPrototypeOf(fsb)), fsb, {
    write: async (key: string, data: Buffer | string, o?: { mode?: number }) => { writes.push(key); return fsb.write(key, data, o); },
  });
  return { storage: s, writes };
};

describe('SPEC-014 strict config accepts the SPEC-013 keys (FR-28)', () => {
  it('every SPEC-013 key validates; typos are rejected with a hint', () => {
    const c = resolveConfig({ file: { logLevel: 'info', logFormat: 'json', llmBudget: { maxCostPerRun: 1.5, maxTokensPerRun: 100_000 }, llmMaxRetries: 2, llmTimeoutMs: 60_000, promptCaching: false, llmCache: 'read-only', auditLog: false, tracing: 'off' } });
    expect(c).toMatchObject({ logLevel: 'info', llmCache: 'read-only', auditLog: false, tracing: 'off' });
    expect(resolveConfig({})).toMatchObject({ auditLog: true, tracing: 'auto' });
    let err: unknown;
    try { resolveConfig({ file: { logLevl: 'info' } as never }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).toMatch(/logLevel/);
    expect(() => resolveConfig({ file: { llmBudget: { maxCost: 1 } } as never })).toThrow(/llmBudget/);
    expect(() => resolveConfig({ file: { tracing: 'on' } as never })).toThrow(/tracing/);
  });

  it('`config validate` passes for a file using them', async () => {
    const dir = tmp('cfgv-');
    const file = path.join(dir, 'agentic-e2e.config.json');
    fs.writeFileSync(file, JSON.stringify({ logLevel: 'debug', llmBudget: { maxCostPerRun: 2 }, llmCache: 'read-write', auditLog: true, tracing: 'auto' }));
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { out.push(a.join(' ')); });
    expect(await main(['node', 'agentic-e2e', 'config', 'validate', '--config', file])).toBe(0);
    vi.restoreAllMocks();
  });

  it('auditLog: false disables the audit log; tracing: off disables export even with an endpoint', async () => {
    const dataDir = tmp('noaudit-');
    const fetchCalls: string[] = [];
    const obs = createObservability(resolveConfig({ cli: { dataDir, auditLog: false, tracing: 'off' } }), [], { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, fetch: (async (u: string) => { fetchCalls.push(u); return new Response('{}'); }) as never, logStream: { write: () => {} } });
    obs.audit.append('discover', { site: 'example.com' });
    expect(fs.existsSync(path.join(dataDir, 'audit.jsonl'))).toBe(false);
    expect(obs.tracer.enabled).toBe(false);
    await obs.finish({ status: 'ok' });
    expect(fetchCalls).toEqual([]);
  });
});

describe('SPEC-014 roles for the SPEC-013 endpoints (FR-29)', () => {
  let app: FastifyInstance, dataDir: string;
  beforeAll(async () => {
    dataDir = tmp('obsroles-');
    const store = new Store(dataDir);
    store.saveSite({ id: 'example.com', origin: 'https://example.com', url: 'https://example.com' });
    store.saveJourneys('example.com', [{ id: 'a', name: 'A', goal: 'g', priority: 'high', tags: [], steps: ['s'], status: 'selected' }]);
    await saveUsageReport(new FilesystemBackend(dataDir), 'example.com', report('c-1'));
    app = await buildApp({ config: resolveConfig({ cli: { dataDir, logLevel: 'silent' } }), webDir: path.join(dataDir, 'no-web'), auth: { mode: 'tokens', tokens: registry } });
  });
  afterAll(async () => { await app.close(); });

  it('usage and audit are readable by a viewer, not anonymously', async () => {
    expect((await app.inject('/api/sites/example.com/usage')).statusCode).toBe(401);
    const u = await app.inject({ url: '/api/sites/example.com/usage', headers: bearer('viewer') });
    expect(u.statusCode).toBe(200);
    expect(u.json().reports[0].id).toBe('c-1');
    expect((await app.inject('/api/audit')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/audit', headers: bearer('viewer') })).statusCode).toBe(200);
  });

  it('journey edits need admin and are audited with the principal and ip', async () => {
    const body = JSON.stringify([{ id: 'a', name: 'A', goal: 'g', priority: 'high', tags: [], steps: ['s'], status: 'approved' }]);
    expect((await app.inject({ method: 'PUT', url: '/api/sites/example.com/journeys', headers: { ...json, ...bearer('viewer') }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/sites/example.com/journeys', headers: { ...json, ...bearer('admin') }, payload: body })).statusCode).toBe(200);
    const a = (await app.inject({ url: '/api/audit?site=example.com', headers: bearer('viewer') })).json();
    expect(a.entries.at(-1)).toMatchObject({ action: 'journeys.status_changed', actor: 'web:admin-user@127.0.0.1', details: { changes: [{ id: 'a', from: 'selected', to: 'approved' }] } });
    expect((await app.inject({ url: '/api/audit?limit=abc', headers: bearer('viewer') })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/audit?site=..%2Fx', headers: bearer('viewer') })).statusCode).toBe(400);
  });

  it('an operator cannot change server-only SPEC-013 settings or opt into the response cache', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...json, ...bearer('operator') }, payload: JSON.stringify({ action: 'run', url: 'https://example.com', options: { llmCache: 'read-write' } }) });
    expect(res.statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/jobs', headers: { ...json, ...bearer('admin') }, payload: JSON.stringify({ action: 'run', url: 'https://example.com', options: { llmBudget: { maxCostPerRun: 1e6 } } }) });
    expect(bad.statusCode).toBe(400);
  });
});

describe('SPEC-014 StorageBackend for usage reports and the response cache (FR-30)', () => {
  it('usage reports are written and listed through the backend', async () => {
    const { storage, writes } = spyStorage(tmp('usb-'));
    await saveUsageReport(storage, 'example.com', report('c-1'));
    await saveUsageReport(storage, 'example.com', report('c-2'));
    expect(writes).toEqual(['sites/example.com/usage/c-1.json', 'sites/example.com/usage/c-2.json']);
    expect((await listUsageReports(storage, 'example.com')).map((r) => r.id)).toEqual(['c-2', 'c-1']);
    await expect(saveUsageReport(storage, '../evil', report('c-3'))).rejects.toThrow();
    await expect(saveUsageReport(storage, 'example.com', { ...report('c-3'), id: '../x' })).rejects.toThrow(/Invalid usage report id/);
  });

  it('obs.finish and the response cache use the backend passed in', async () => {
    const dataDir = tmp('obsb-');
    const { storage, writes } = spyStorage(dataDir);
    const obs = createObservability(resolveConfig({ cli: { dataDir, llmCache: 'read-write', logLevel: 'silent' } }), [], { storage, site: 'example.com', action: 'generate', env: {} });
    const llm = obs.governLLM(new MockLLM(() => ({ code: 'x' })));
    const req = { name: 'write_playwright_spec', description: 'd', system: 's', prompt: 'p', schema: z.object({ code: z.string() }) };
    await llm.structured(req);
    await llm.structured(req);
    expect(obs.usage.totals()).toMatchObject({ calls: 2, cached: 1 });
    await obs.finish({ status: 'ok' });
    expect(writes.some((k) => /^llm-cache\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/.test(k))).toBe(true);
    expect(writes).toContain(`sites/example.com/usage/${obs.correlationId}.json`);
  });
});

describe('SPEC-011 reports include LLM usage per journey × project (FR-31)', () => {
  const call = (n: number, name: string, costUsd: number, journeyId?: string): LLMCallRecord => ({ n, name, provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 100 * n, outputTokens: 10 * n, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 1, costUsd, retries: 0, cached: false, ok: true, at: 'x', ...(journeyId ? { journeyId } : {}) });
  const res = (journeyId: string, project: string, status: TestResult['status']): TestResult => ({ journeyId, file: `${journeyId}.spec.ts`, status, durationMs: 1, screenshots: [], project, browser: project });
  const run: RunRecord = { id: 'r1', kind: 'run', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', screenshots: 'off', fullPage: false, results: [res('a', 'chromium', 'passed'), res('a', 'firefox', 'failed'), res('b', 'chromium', 'passed'), res('b', 'firefox', 'passed')], targets: [{ name: 'chromium', browser: 'chromium' }, { name: 'firefox', browser: 'firefox' }] } as RunRecord;

  it('per-row usage of the row journey, report totals and unattributed (planning) usage', () => {
    const calls = [call(1, 'propose_journeys', 0.01), call(2, 'write_playwright_spec', 0.02, 'a'), call(3, 'heal_test', 0.03, 'a'), call(4, 'write_playwright_spec', 0.04, 'b')];
    const r = buildRunReport({ site: { id: 's', origin: 'https://s' }, mode: 'all', runs: [run], heals: [], llm: calls });
    expect(r.llm?.totals).toMatchObject({ calls: 4, inputTokens: 1000 });
    expect(r.llm?.totals.costUsd).toBeCloseTo(0.1, 10);
    expect(r.llm?.unattributed).toMatchObject({ calls: 1 });
    const rows = r.tests.map((t) => [t.journeyId, t.project, t.llm?.calls, Number(t.llm?.costUsd.toFixed(2))]);
    expect(rows).toEqual([['a', 'chromium', 2, 0.05], ['a', 'firefox', 2, 0.05], ['b', 'chromium', 1, 0.04], ['b', 'firefox', 1, 0.04]]);
    const html = renderHtml(r, { href: () => null });
    expect(html).toMatch(/<th>LLM<\/th>/);
    expect(html).toContain('$0.0500');
    expect(html).toMatch(/LLM: 4 calls/);
  });

  it('no LLM calls → no llm fields (reports unchanged for pure test runs)', () => {
    const r = buildRunReport({ site: { id: 's', origin: 'https://s' }, mode: 'run', runs: [run], heals: [], llm: [] });
    expect(r.llm).toBeUndefined();
    expect(r.tests.every((t) => t.llm === undefined)).toBe(true);
    expect(renderHtml(r, { href: () => null })).not.toMatch(/<th>LLM<\/th>/);
  });

  it('GovernedLLM attributes calls to the journey of the current scope', async () => {
    const usage = new UsageTracker();
    const llm = new GovernedLLM(new MockLLM(() => ({ code: 'x' })), { provider: 'anthropic', model: 'claude-sonnet-5-5', usage, retry: { maxRetries: 0, timeoutMs: 1000 } });
    const req = { name: 'n', description: 'd', system: 's', prompt: 'p', schema: z.object({ code: z.string() }) };
    await llm.structured(req);
    await withLLMScope({ journeyId: 'a' }, () => llm.structured(req));
    await Promise.all([withLLMScope({ journeyId: 'b' }, () => llm.structured(req)), withLLMScope({ journeyId: 'c' }, () => llm.structured(req))]);
    expect(usage.calls.map((c) => c.journeyId)).toEqual([undefined, 'a', 'b', 'c']);
  });
});

afterEach(() => vi.restoreAllMocks());
