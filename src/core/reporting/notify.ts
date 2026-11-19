import { firstLine, type ReportMode, type ReportTotals, type RunReport } from './model.js';
import { envSecretRedactor, redactReport } from './secrets.js';

export type NotifyOn = 'always' | 'failure' | 'never';
export const NOTIFY_ON = ['always', 'failure', 'never'] as const;
export const WEBHOOK_ENV = 'AGENTIC_E2E_WEBHOOK_URL';
export const SLACK_WEBHOOK_ENV = 'AGENTIC_E2E_SLACK_WEBHOOK_URL';

export interface NotificationPayload {
  event: 'run.completed';
  tool: 'agentic-e2e';
  status: 'passed' | 'failed' | 'error';
  exitCode: number;
  site?: string;
  runId?: string;
  mode?: ReportMode;
  totals?: ReportTotals;
  failed: { journeyId: string; error?: string }[];
  flaky: string[];
  error?: string;
}

/** SPEC-011 FR-13: compact summary (no paths, no config); errors are first lines only, ≤ 300 chars. */
export function buildNotification(o: { report?: RunReport; exitCode: number; error?: string }): NotificationPayload {
  const r = o.report;
  const status = o.exitCode >= 2 || !r ? 'error' : o.exitCode === 1 || r.totals.failed > 0 ? 'failed' : 'passed';
  return {
    event: 'run.completed',
    tool: 'agentic-e2e',
    status,
    exitCode: o.exitCode,
    ...(r ? { site: r.site.id, runId: r.run.id, mode: r.mode, totals: r.totals } : {}),
    failed: (r?.tests ?? [])
      .filter((t) => t.outcome === 'failed')
      .map((t) => ({ journeyId: t.journeyId, ...(t.error ? { error: firstLine(t.error, 300) } : {}) })),
    flaky: (r?.tests ?? []).filter((t) => t.flaky).map((t) => t.journeyId),
    ...(o.error ? { error: firstLine(o.error, 300) } : {}),
  };
}

export function slackText(p: NotificationPayload): string {
  if (p.status === 'error')
    return `:x: agentic-e2e error (exit ${p.exitCode})${p.site ? ` on ${p.site}` : ''}: ${p.error ?? 'unknown error'}`;
  const t = p.totals!;
  const head = `${p.status === 'passed' ? ':white_check_mark:' : ':x:'} agentic-e2e ${p.mode} on ${p.site}: ${t.passed}/${t.tests} passed, ${t.failed} failed, ${t.healed} healed, ${t.flaky} flaky (run ${p.runId})`;
  const lines = p.failed.slice(0, 10).map((f) => `• \`${f.journeyId}\`${f.error ? `: ${f.error}` : ''}`);
  if (p.failed.length > 10) lines.push(`…and ${p.failed.length - 10} more`);
  if (p.flaky.length) lines.push(`Flaky: ${p.flaky.map((x) => `\`${x}\``).join(', ')}`);
  return [head, ...lines].join('\n');
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function checkUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u;
    if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u;
    return null;
  } catch {
    return null;
  }
}

/**
 * Send the payload to the generic webhook and/or Slack (URLs from env only). Returns which were delivered.
 * Never throws; warnings never contain the URL.
 */
export async function sendNotifications(
  payload: NotificationPayload,
  opts: {
    env: Record<string, string | undefined>;
    notifyOn: NotifyOn;
    onWarn?: (m: string) => void;
    timeoutMs?: number;
  },
): Promise<string[]> {
  if (opts.notifyOn === 'never' || (opts.notifyOn === 'failure' && payload.status === 'passed')) return [];
  const safe = redactReport(payload, [envSecretRedactor(opts.env)]);
  const targets: { name: string; envVar: string; body: unknown }[] = [
    { name: 'webhook', envVar: WEBHOOK_ENV, body: safe },
    { name: 'slack', envVar: SLACK_WEBHOOK_ENV, body: { text: slackText(safe) } },
  ];
  const sent: string[] = [];
  for (const t of targets) {
    const raw = opts.env[t.envVar]?.trim();
    if (!raw) continue;
    const url = checkUrl(raw);
    if (!url) {
      opts.onWarn?.(`${t.name} notification skipped: ${t.envVar} must be an https URL (http only for localhost)`);
      continue;
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(t.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) sent.push(t.name);
      else opts.onWarn?.(`${t.name} notification failed: HTTP ${res.status}`);
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      opts.onWarn?.(`${t.name} notification failed: ${err.name}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
    }
  }
  return sent;
}
