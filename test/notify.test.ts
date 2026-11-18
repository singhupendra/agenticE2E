import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildNotification, sendNotifications } from '../src/core/reporting/notify.js';
import { buildRunReport } from '../src/core/reporting/model.js';
import type { RunRecord } from '../src/core/types.js';

const run = (status: 'passed' | 'failed', error?: string): RunRecord => ({ id: 'r1', kind: 'run', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', screenshots: 'off', fullPage: false, results: [{ journeyId: 'a', file: 'tests/a.spec.ts', status, durationMs: 5, screenshots: [], error }] });
const report = (status: 'passed' | 'failed', error?: string) => buildRunReport({ site: { id: 'example.com', origin: 'https://example.com' }, mode: 'ci', runs: [run(status, error)], heals: [] });

let servers: http.Server[] = [];
async function hook(statusCode = 200): Promise<{ url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { bodies.push(JSON.parse(b)); res.statusCode = statusCode; res.end('ok'); });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook/secret-token`, bodies };
}
beforeEach(() => { servers = []; });
afterEach(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

describe('notifications (SPEC-011 FR-13)', () => {
  it('builds a redacted, truncated payload', () => {
    const p = buildNotification({ report: report('failed', `boom ${'x'.repeat(400)}\nsecond line`), exitCode: 1 });
    expect(p).toMatchObject({ event: 'run.completed', site: 'example.com', runId: 'r1', mode: 'ci', status: 'failed', exitCode: 1, totals: { tests: 1, failed: 1 } });
    expect(p.failed[0].journeyId).toBe('a');
    expect(p.failed[0].error!.length).toBeLessThanOrEqual(300);
    expect(p.failed[0].error).not.toContain('second line');
    expect(buildNotification({ exitCode: 2, error: 'Invalid configuration' }).status).toBe('error');
  });

  it('AC-16: posts to generic + slack hooks with redacted payloads', async () => {
    const g = await hook();
    const s = await hook();
    const warns: string[] = [];
    const sent = await sendNotifications(buildNotification({ report: report('failed', 'key sk-ant-api03-supersecretvalue1 leaked'), exitCode: 1 }), {
      env: { AGENTIC_E2E_WEBHOOK_URL: g.url, AGENTIC_E2E_SLACK_WEBHOOK_URL: s.url }, notifyOn: 'always', onWarn: (m) => warns.push(m),
    });
    expect(sent).toEqual(['webhook', 'slack']);
    expect(warns).toEqual([]);
    expect(g.bodies[0]).toMatchObject({ status: 'failed', site: 'example.com' });
    expect(typeof (s.bodies[0] as { text: string }).text).toBe('string');
    expect((s.bodies[0] as { text: string }).text).toContain('example.com');
    expect(JSON.stringify([g.bodies, s.bodies])).not.toContain('supersecretvalue1');
  });

  it('AC-16: notifyOn failure skips passing runs; never sends nothing', async () => {
    const g = await hook();
    expect(await sendNotifications(buildNotification({ report: report('passed'), exitCode: 0 }), { env: { AGENTIC_E2E_WEBHOOK_URL: g.url }, notifyOn: 'failure' })).toEqual([]);
    expect(await sendNotifications(buildNotification({ report: report('failed', 'x'), exitCode: 1 }), { env: { AGENTIC_E2E_WEBHOOK_URL: g.url }, notifyOn: 'never' })).toEqual([]);
    expect(g.bodies).toEqual([]);
    expect(await sendNotifications(buildNotification({ report: report('failed', 'x'), exitCode: 1 }), { env: { AGENTIC_E2E_WEBHOOK_URL: g.url }, notifyOn: 'failure' })).toEqual(['webhook']);
  });

  it('AC-16: a 500 warns without the URL; non-loopback http is refused', async () => {
    const g = await hook(500);
    const warns: string[] = [];
    const sent = await sendNotifications(buildNotification({ report: report('passed'), exitCode: 0 }), {
      env: { AGENTIC_E2E_WEBHOOK_URL: g.url, AGENTIC_E2E_SLACK_WEBHOOK_URL: 'http://hooks.example.com/services/abc' }, notifyOn: 'always', onWarn: (m) => warns.push(m),
    });
    expect(sent).toEqual([]);
    expect(warns.length).toBe(2);
    expect(warns.join('\n')).toMatch(/500/);
    expect(warns.join('\n')).not.toMatch(/secret-token|127\.0\.0\.1|hooks\.example\.com/);
    expect(warns.join('\n')).toMatch(/AGENTIC_E2E_SLACK_WEBHOOK_URL/);
  });
});
