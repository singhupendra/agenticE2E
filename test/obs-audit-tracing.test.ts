import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, journeyStatusChanges, readAuditLog, verifyAuditLog } from '../src/core/obs/audit.js';
import { createTracer } from '../src/core/obs/tracing.js';
import { createLogger } from '../src/core/obs/logger.js';
import { resolveConfig } from '../src/core/config.js';
import { parseJobRequest } from '../src/server/jobs.js';
import { Redactor } from '../src/core/redact.js';
import type { Journey } from '../src/core/types.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit.jsonl');

describe('SPEC-013 audit log', () => {
  it('AC-15: appends hash-chained entries that verify; edits and deletions are detected', () => {
    const file = tmpFile();
    const redactor = new Redactor([{ value: 'pa55word!', placeholder: '{{password}}' }]);
    const a = new AuditLog({ file, actor: 'cli:ada', correlationId: 'c-1', redactor });
    a.append('discover', { site: 'example.com', details: { journeys: ['a', 'b'] } });
    a.append('generate', { site: 'example.com', details: { generated: ['a'], note: 'typed pa55word!' } });
    new AuditLog({ file, actor: 'web:127.0.0.1' }).append('journeys.status_changed', { site: 'other.org', details: { changes: [{ id: 'a', from: 'selected', to: 'approved' }] } });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('pa55word!');
    const entries = readAuditLog(file);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ actor: 'cli:ada', action: 'discover', site: 'example.com', correlationId: 'c-1', prev: '0'.repeat(64) });
    expect(entries[1].prev).toBe(entries[0].hash);
    expect(new Date(entries[0].at).toISOString()).toBe(entries[0].at);
    expect(readAuditLog(file, { site: 'other.org' })).toHaveLength(1);
    expect(readAuditLog(file, { limit: 1 })[0].action).toBe('journeys.status_changed');
    expect(verifyAuditLog(file)).toMatchObject({ ok: true, entries: 3 });

    const lines = raw.trimEnd().split('\n');
    fs.writeFileSync(file, [lines[0], lines[1].replace('"generated":["a"]', '"generated":["zzz"]'), lines[2]].join('\n') + '\n');
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 2 });
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('missing file reads as empty and verifies', () => {
    const file = tmpFile();
    expect(readAuditLog(file)).toEqual([]);
    expect(verifyAuditLog(file)).toMatchObject({ ok: true, entries: 0 });
  });

  it('journeyStatusChanges lists only changed statuses (and added/removed ids)', () => {
    const j = (id: string, status: Journey['status']): Journey => ({ id, name: id, goal: 'g', priority: 'high', tags: [], steps: ['s'], status });
    expect(journeyStatusChanges([j('a', 'selected'), j('b', 'proposed'), j('c', 'selected')], [j('a', 'approved'), j('b', 'proposed'), j('d', 'proposed')])).toEqual([
      { id: 'a', from: 'selected', to: 'approved' }, { id: 'c', from: 'selected', to: null }, { id: 'd', from: null, to: 'proposed' },
    ]);
  });
});

describe('SPEC-013 OpenTelemetry tracing', () => {
  const fakeFetch = (fail = false) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); if (fail) throw new Error('ECONNREFUSED'); return new Response('{}'); }) as unknown as typeof fetch;
    return { calls, fn };
  };

  it('AC-18: no endpoint → no-op tracer, nothing exported', async () => {
    const f = fakeFetch();
    const t = createTracer({ env: {}, fetch: f.fn });
    expect(t.enabled).toBe(false);
    t.startSpan('x').end();
    await t.flush();
    expect(f.calls).toHaveLength(0);
    expect(createTracer({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' }, fetch: f.fn }).enabled).toBe(false);
  });

  it('AC-18: exports OTLP/HTTP JSON with parent links, gen_ai attributes, headers; values redacted', async () => {
    const f = fakeFetch();
    const redactor = new Redactor([{ value: 'pa55word!', placeholder: '{{password}}' }]);
    const t = createTracer({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc,  x-team = t1', OTEL_SERVICE_NAME: 'svc' }, fetch: f.fn, redactor });
    expect(t.enabled).toBe(true);
    const traceId = '0123456789abcdef0123456789abcdef';
    const root = t.startSpan('agentic-e2e.generate', { traceId, attributes: { 'agentic_e2e.site': 'example.com' } });
    const llm = t.startSpan('llm write_playwright_spec', { parent: root, attributes: { 'gen_ai.system': 'anthropic', 'gen_ai.usage.input_tokens': 10, 'agentic_e2e.cached': false, note: 'pw pa55word!' } });
    llm.recordError(new Error('boom pa55word!'));
    llm.end();
    root.end();
    await t.flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://collector:4318/v1/traces');
    expect(f.calls[0].init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'abc', 'x-team': 't1' });
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(String(f.calls[0].init.body)).not.toContain('pa55word!');
    const rs = body.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'svc' } });
    const spans = rs.scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    const [s1, s2] = spans;
    expect(s1.name).toBe('llm write_playwright_spec');
    expect(s1.traceId).toBe(traceId);
    expect(s1.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s1.parentSpanId).toBe(s2.spanId);
    expect(s2.parentSpanId).toBeUndefined();
    expect(s1.attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } });
    expect(s1.attributes).toContainEqual({ key: 'agentic_e2e.cached', value: { boolValue: false } });
    expect(s1.status).toMatchObject({ code: 2 });
    expect(BigInt(s1.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(s1.startTimeUnixNano));
    await t.flush();
    expect(f.calls).toHaveLength(1); // nothing new to send
  });

  it('uses the traces-specific endpoint as-is and swallows export failures (warn logged)', async () => {
    const f = fakeFetch(true);
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', format: 'json', stream: { write: (s) => { lines.push(s); } } });
    const t = createTracer({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://c:4318/custom/traces' }, fetch: f.fn, log });
    t.startSpan('a').end();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(f.calls[0].url).toBe('http://c:4318/custom/traces');
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'warn', msg: 'otel.export_failed' });
  });
});

describe('SPEC-013 config', () => {
  it('AC-20: defaults, env and CLI precedence, validation', () => {
    const d = resolveConfig({});
    expect(d).toMatchObject({ logLevel: 'warn', logFormat: 'pretty', llmCache: 'off', promptCaching: true, llmMaxRetries: 3, llmTimeoutMs: 300_000 });
    expect(d.llmBudget).toBeUndefined();
    const c = resolveConfig({
      file: { logLevel: 'error', llmBudget: { maxCostPerRun: 2 } },
      env: { AGENTIC_E2E_LOG_LEVEL: 'debug', AGENTIC_E2E_LOG_FORMAT: 'json', AGENTIC_E2E_LLM_CACHE: 'read-only' },
      cli: { logLevel: 'info' },
    });
    expect(c).toMatchObject({ logLevel: 'info', logFormat: 'json', llmCache: 'read-only', llmBudget: { maxCostPerRun: 2 } });
    expect(() => resolveConfig({ cli: { logLevel: 'loud' as never } })).toThrow(/logLevel/);
    expect(() => resolveConfig({ cli: { llmBudget: { maxCostPerRun: -1 } } })).toThrow(/llmBudget/);
    expect(() => resolveConfig({ cli: { llmCache: 'yes' as never } })).toThrow(/llmCache/);
  });

  it('FR-17: web clients cannot change the budget or logging, may opt into the cache', () => {
    expect(() => parseJobRequest({ action: 'discover', url: 'https://example.com', options: { llmBudget: { maxCostPerRun: 100 } } })).toThrow(/llmBudget/);
    expect(() => parseJobRequest({ action: 'discover', url: 'https://example.com', options: { logLevel: 'trace' } })).toThrow(/logLevel/);
    expect(parseJobRequest({ action: 'discover', url: 'https://example.com', options: { llmCache: 'read-write' } }).options).toEqual({ llmCache: 'read-write' });
  });
});
