import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRunReport } from '../src/core/reporting/model.js';
import { renderJUnit } from '../src/core/reporting/junit.js';
import { renderHtml } from '../src/core/reporting/html.js';
import { renderStepSummary } from '../src/core/reporting/markdown.js';
import { writeReports } from '../src/core/reporting/write.js';
import { envSecretRedactor, scrubSecrets, redactReport } from '../src/core/reporting/secrets.js';
import { detectFlaky } from '../src/core/reporting/flaky.js';
import { Store } from '../src/core/storage.js';
import { Redactor } from '../src/core/redact.js';
import type { HealRecord, Journey, RunRecord, TestResult } from '../src/core/types.js';

const SITE = { id: 'example.com', origin: 'https://example.com' };
const res = (journeyId: string, status: TestResult['status'], extra: Partial<TestResult> = {}): TestResult => ({ journeyId, file: `tests/${journeyId}.spec.ts`, status, durationMs: 10, screenshots: [], ...(status === 'passed' ? {} : { error: 'boom' }), ...extra });
let seq = 0;
const runOf = (results: TestResult[], kind: RunRecord['kind'] = 'run', id?: string): RunRecord => {
  seq++;
  const ts = `2026-01-01T00-00-${String(seq).padStart(2, '0')}-000Z`;
  return { id: id ?? ts, kind, startedAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, finishedAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.500Z`, screenshots: 'on-failure', fullPage: false, results };
};
const heal = (journeyId: string, outcome: HealRecord['outcome'], extra: Partial<HealRecord> = {}): HealRecord => ({ id: `${journeyId}-h`, journeyId, at: '2026-01-01T00:00:30.000Z', outcome, reason: 'r', originalError: 'boom', attempts: [], ...extra });
const j = (id: string): Journey => ({ id, name: `Journey ${id}`, goal: 'g', priority: 'high', tags: [], steps: ['s'], status: 'selected' });

describe('buildRunReport (SPEC-011 FR-1/FR-2)', () => {
  it('AC-1: totals and per-test outcomes', () => {
    const r = buildRunReport({ site: SITE, mode: 'run', runs: [runOf([res('a', 'passed'), res('b', 'failed'), res('c', 'timedOut'), res('d', 'skipped', { error: undefined })])], heals: [], journeys: [j('a')] });
    expect(r.schemaVersion).toBe(1);
    expect(r.totals).toEqual({ tests: 4, passed: 1, failed: 2, skipped: 1, healed: 0, flaky: 0 });
    const b = r.tests.find((t) => t.journeyId === 'b')!;
    expect(b.outcome).toBe('failed');
    expect(b.error).toBe('boom');
    expect(r.tests.find((t) => t.journeyId === 'c')!.outcome).toBe('failed');
    expect(r.tests.find((t) => t.journeyId === 'a')!.name).toBe('Journey a');
    expect(r.tests.find((t) => t.journeyId === 'a')!.error).toBeUndefined();
  });
  it('AC-2: a later retry pass upgrades to passed, sums durations, counts attempts', () => {
    const first = runOf([res('a', 'passed'), res('b', 'failed')]);
    const retry = runOf([res('b', 'passed')], 'retry');
    const flaky = detectFlaky([first, retry], []);
    const r = buildRunReport({ site: SITE, mode: 'ci', runs: [first, retry], heals: [], flaky });
    const b = r.tests.find((t) => t.journeyId === 'b')!;
    expect(b.outcome).toBe('passed');
    expect(b.attempts).toBe(2);
    expect(b.durationMs).toBe(20);
    expect(b.flaky?.reasons).toContain('passed_on_retry');
    expect(r.totals.flaky).toBe(1);
    expect(r.totals.passed).toBe(2);
  });
  it('AC-3: healed heal record → healed with diff; flaky_or_environment → passed', () => {
    const r = buildRunReport({ site: SITE, mode: 'heal', runs: [runOf([res('b', 'failed'), res('c', 'failed')])], heals: [heal('b', 'healed', { diff: '--- a\n+++ b\n-x\n+y', verdict: 'test_breakage' }), heal('c', 'flaky_or_environment')] });
    const b = r.tests.find((t) => t.journeyId === 'b')!;
    expect(b.outcome).toBe('healed');
    expect(b.heal?.diff).toContain('+y');
    expect(r.tests.find((t) => t.journeyId === 'c')!.outcome).toBe('passed');
    expect(r.totals.healed).toBe(1);
    expect(r.totals.failed).toBe(0);
  });
  it('collects screenshots and failure screenshot as site-relative paths', () => {
    const r = buildRunReport({ site: SITE, mode: 'run', runs: [runOf([res('b', 'failed', { screenshots: ['screenshots/r/b/01.png'], failure: { url: 'u', title: 't', ariaSnapshot: '', html: '', screenshot: 'runs/r/failures/b.png' } })])], heals: [] });
    expect(r.tests[0].screenshots).toEqual(['screenshots/r/b/01.png', 'runs/r/failures/b.png']);
  });
});

describe('JUnit (FR-3)', () => {
  it('AC-4: counts, failure/skipped elements, escaping and control chars', () => {
    const r = buildRunReport({ site: SITE, mode: 'run', runs: [runOf([res('a', 'passed'), res('b', 'failed', { error: 'expected <a> & "b"\u0001 done' }), res('c', 'timedOut'), res('d', 'skipped', { error: undefined })])], heals: [] });
    const xml = renderJUnit(r);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toMatch(/<testsuites [^>]*tests="4" failures="2"[^>]*skipped="1"/);
    expect(xml).toMatch(/<testcase classname="example.com" name="b"[^>]*>\s*<properties>[\s\S]*<failure message="expected &lt;a&gt; &amp; &quot;b&quot; done"/);
    expect(xml).toMatch(/<testcase classname="example.com" name="d"[^>]*>[\s\S]*?<skipped\/>/);
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toMatch(/<a>/);
  });
  it('marks flaky and healed tests in properties', () => {
    const first = runOf([res('b', 'failed')]);
    const retry = runOf([res('b', 'passed')], 'retry');
    const xml = renderJUnit(buildRunReport({ site: SITE, mode: 'ci', runs: [first, retry], heals: [], flaky: detectFlaky([first, retry], []) }));
    expect(xml).toContain('<property name="flaky" value="true"/>');
    expect(xml).not.toContain('<failure');
  });
});

describe('HTML (FR-3)', () => {
  it('AC-5: escapes, self-contained, diff colouring, relative links', () => {
    const r = buildRunReport({ site: SITE, mode: 'heal', runs: [runOf([res('b', 'failed', { error: '<script>alert(1)</script>', screenshots: ['screenshots/r/b/01.png'] }), res('c', 'failed')])], heals: [heal('c', 'healed', { diff: '--- o\n+++ h\n-old\n+new' })] });
    const html = renderHtml(r, { href: (rel) => `../../../${rel}` });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).toMatch(/<span class="add">\+new<\/span>/);
    expect(html).toMatch(/<span class="del">-old<\/span>/);
    expect(html).toContain('href="../../../screenshots/r/b/01.png"');
    expect(html).toContain('<img');
  });
});

describe('step summary markdown (FR-12)', () => {
  it('has totals and a row per test', () => {
    const r = buildRunReport({ site: SITE, mode: 'ci', runs: [runOf([res('a', 'passed'), res('b', 'failed', { error: 'line1 | pipe\nline2' })])], heals: [] });
    const md = renderStepSummary({ report: r, exitCode: 1 });
    expect(md).toContain('example.com');
    expect(md).toContain('1 passed');
    expect(md).toContain('1 failed');
    expect(md).toMatch(/\| `a` \|/);
    expect(md).toMatch(/line1 \\\| pipe/);
    expect(md).not.toContain('line2');
  });
  it('renders an error summary without a report', () => {
    expect(renderStepSummary({ exitCode: 2, error: 'Invalid configuration: x' })).toMatch(/exit code 2[\s\S]*Invalid configuration/);
  });
});

describe('secret redaction (FR-6)', () => {
  it('scrubs known key shapes', () => {
    const s = scrubSecrets('k=sk-ant-api03-abcdefghijklmnop AKIAABCDEFGHIJKLMNOP Bearer abcdefghijklmnopqrstuvwxyz https://hooks.slack.com/services/T0/B0/xyz ABSKQmVkcm9ja0FQSUtleS1hYmNkZWZn');
    expect(s).not.toMatch(/sk-ant-api03|AKIAABCDEFGHIJKLMNOP|abcdefghijklmnopqrstuvwxyz|hooks\.slack\.com\/services\/T0|ABSKQmVkcm9j/);
  });
  it('redacts env secret values but not unrelated env', () => {
    const r = envSecretRedactor({ ANTHROPIC_API_KEY: 'my-anthropic-secret', HOME: '/home/me', AGENTIC_E2E_WEBHOOK_URL: 'https://hook.example/abc' });
    expect(r.redact('x my-anthropic-secret y https://hook.example/abc /home/me')).toBe('x [REDACTED] y [REDACTED] /home/me');
  });
  it('redactReport applies every redactor deeply', () => {
    const rep = buildRunReport({ site: SITE, mode: 'run', runs: [runOf([res('b', 'failed', { error: 'pw=hunter22 key=my-anthropic-secret' })])], heals: [] });
    const out = redactReport(rep, [new Redactor([{ value: 'hunter22', placeholder: '{{password}}' }]), envSecretRedactor({ ANTHROPIC_API_KEY: 'my-anthropic-secret' })]);
    expect(out.tests[0].error).toBe('pw={{password}} key=[REDACTED]');
  });
});

describe('writeReports (FR-4/FR-5)', () => {
  let dir: string, store: Store, run: RunRecord;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
    store = new Store(dir);
    store.saveSite({ id: SITE.id, origin: SITE.origin, url: SITE.origin });
    run = runOf([res('b', 'failed', { screenshots: ['screenshots/r1/b/01.png'] })], 'run', 'r1');
    store.saveRun(SITE.id, run);
    const shot = path.join(store.siteDir(SITE.id), 'screenshots/r1/b/01.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    fs.writeFileSync(shot, 'PNG');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('AC-7: writes all formats to run dir and reportDir, copying screenshots', () => {
    const report = buildRunReport({ site: SITE, mode: 'run', runs: [run], heals: [] });
    const reportDir = path.join(dir, 'out');
    const w = writeReports(store, report, { formats: ['junit', 'json', 'html'], reportDir });
    const runReports = path.join(store.runDir(SITE.id, 'r1'), 'reports');
    for (const f of ['junit.xml', 'summary.json', 'report.html']) {
      expect(fs.existsSync(path.join(runReports, f))).toBe(true);
      expect(fs.existsSync(path.join(reportDir, f))).toBe(true);
    }
    expect(w.files.length).toBe(6);
    expect(JSON.parse(fs.readFileSync(path.join(runReports, 'summary.json'), 'utf8')).run.id).toBe('r1');
    expect(fs.readFileSync(path.join(runReports, 'report.html'), 'utf8')).toContain('href="../../../screenshots/r1/b/01.png"');
    const copied = fs.readFileSync(path.join(reportDir, 'report.html'), 'utf8');
    const m = copied.match(/href="(assets\/[^"]+\.png)"/);
    expect(m).toBeTruthy();
    expect(fs.readFileSync(path.join(reportDir, m![1]), 'utf8')).toBe('PNG');
  });
  it('AC-8: honours the format list', () => {
    const report = buildRunReport({ site: SITE, mode: 'run', runs: [run], heals: [] });
    writeReports(store, report, { formats: ['junit'] });
    expect(fs.readdirSync(path.join(store.runDir(SITE.id, 'r1'), 'reports'))).toEqual(['junit.xml']);
    expect(writeReports(store, report, { formats: [] }).files).toEqual([]);
  });
  it('ignores screenshot paths that escape the site dir', () => {
    const evil = runOf([res('b', 'failed', { screenshots: ['../../../../etc/passwd'] })], 'run', 'r2');
    store.saveRun(SITE.id, evil);
    const w = writeReports(store, buildRunReport({ site: SITE, mode: 'run', runs: [evil], heals: [] }), { formats: ['html'], reportDir: path.join(dir, 'o2') });
    expect(w.files.length).toBe(2);
    expect(fs.existsSync(path.join(dir, 'o2', 'assets'))).toBe(false);
  });
});

describe('detectFlaky (FR-14)', () => {
  it('AC-17: pass, fail, pass is alternating', () => {
    const f = detectFlaky([runOf([res('a', 'passed')]), runOf([res('a', 'failed')]), runOf([res('a', 'passed')])], []);
    expect(f.a.flaky).toBe(true);
    expect(f.a.reasons).toEqual(['alternating']);
    expect(f.a.transitions).toBe(2);
  });
  it('AC-17: pass, fail, fail is not flaky (a real break)', () => {
    expect(detectFlaky([runOf([res('a', 'passed')]), runOf([res('a', 'failed')]), runOf([res('a', 'failed')])], []).a.flaky).toBe(false);
  });
  it('AC-17: history before a healed heal is ignored', () => {
    const runs = [runOf([res('a', 'passed')]), runOf([res('a', 'failed')]), runOf([res('a', 'passed')], 'heal-rerun'), runOf([res('a', 'passed')])];
    const h = heal('a', 'healed', { at: runs[2].finishedAt });
    expect(detectFlaky(runs, [h]).a.flaky).toBe(false);
  });
  it('heal flaky_or_environment counts as passed_on_retry; skipped is ignored; window bounds history', () => {
    const runs = [runOf([res('a', 'failed')])];
    expect(detectFlaky(runs, [heal('a', 'flaky_or_environment', { at: '2026-01-01T00:59:00.000Z' })]).a.reasons).toEqual(['passed_on_retry']);
    const skip = [runOf([res('b', 'passed')]), runOf([res('b', 'skipped', { error: undefined })]), runOf([res('b', 'passed')])];
    expect(detectFlaky(skip, []).b.flaky).toBe(false);
    const old = [runOf([res('c', 'passed')]), runOf([res('c', 'failed')]), runOf([res('c', 'passed')]), ...Array.from({ length: 10 }, () => runOf([res('c', 'passed')]))];
    expect(detectFlaky(old, [], { window: 10 }).c.flaky).toBe(false);
  });
});
