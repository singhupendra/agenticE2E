import fs from 'node:fs';
import { publicError } from '../credentials.js';
import type { Context } from '../pipeline.js';
import type { Redactor } from '../redact.js';
import { normalizeSite } from '../storage.js';
import type { HealRecord, RunRecord } from '../types.js';
import { detectFlaky } from './flaky.js';
import { renderStepSummary } from './markdown.js';
import { buildRunReport, REPORT_FORMATS, type ReportFormat, type ReportMode, type RunReport } from './model.js';
import { buildNotification, sendNotifications, type NotifyOn } from './notify.js';
import { envSecretRedactor, redactReport } from './secrets.js';
import { writeReports } from './write.js';

export { detectFlaky, type FlakyInfo } from './flaky.js';
export * from './model.js';

type Env = Record<string, string | undefined>;

/** `--reporter junit,json` → ['junit','json']; `none` → []. Unknown names are left for config validation to reject. */
export function parseReporterList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return list.length === 1 && list[0] === 'none' ? [] : list;
}
export const isReportFormat = (x: string): x is ReportFormat => (REPORT_FORMATS as readonly string[]).includes(x);

/** Build the (redacted) report for one run of a site, with flaky info from the stored history. */
export function buildSiteReport(ctx: Context, url: string, o: { mode: ReportMode; runs: RunRecord[]; heals?: HealRecord[]; env?: Env }): RunReport {
  const meta = normalizeSite(url);
  const site = ctx.store.loadSite(meta.id);
  const report = buildRunReport({
    site: { id: meta.id, origin: site?.origin ?? meta.origin }, mode: o.mode, runs: o.runs, heals: o.heals ?? [],
    journeys: ctx.store.loadJourneys(meta.id) ?? [],
    flaky: detectFlaky(ctx.store.listRuns(meta.id), ctx.store.loadHeals(meta.id)),
  });
  return redactReport(report, [ctx.redactor, envSecretRedactor(o.env ?? process.env)]);
}

function appendStepSummary(env: Env, md: string, warn: (m: string) => void) {
  const f = env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { fs.appendFileSync(f, md); } catch (e) { warn(`Could not write the GitHub step summary: ${(e as NodeJS.ErrnoException).code ?? (e as Error).name}`); }
}

/** Write report files, the GitHub step summary and notifications for a finished run (SPEC-011). Never throws for integrations. */
export async function publishReport(ctx: Context, report: RunReport, o: { exitCode: number; env?: Env }): Promise<{ files: string[] }> {
  const env = o.env ?? process.env;
  const warn = (message: string) => ctx.onProgress({ type: 'warn', stage: 'report', message });
  const formats = ctx.config.reporters.filter(isReportFormat);
  let files: string[] = [];
  try {
    files = writeReports(ctx.store, report, { formats, reportDir: ctx.config.reportDir }).files;
    if (files.length) ctx.onProgress({ type: 'info', stage: 'report', message: `Reports: ${[...new Set(files.map((f) => f.replace(/[\\/][^\\/]+$/, '')))].join(', ')}` });
  } catch (e) { warn(`Could not write reports: ${(e as Error).message}`); }
  appendStepSummary(env, renderStepSummary({ report, exitCode: o.exitCode }), warn);
  await sendNotifications(buildNotification({ report, exitCode: o.exitCode }), { env, notifyOn: ctx.config.notifyOn, onWarn: warn });
  return { files };
}

/** Step summary + notification for a run that could not complete (exit 2/3). External text uses the public error message. */
export async function publishError(o: { exitCode: number; error: unknown; env?: Env; notifyOn?: NotifyOn; redactors?: Redactor[]; onWarn?: (m: string) => void }): Promise<void> {
  const env = o.env ?? process.env;
  const warn = o.onWarn ?? (() => {});
  const message = redactReport(publicError(o.error), [...(o.redactors ?? []), envSecretRedactor(env)]);
  appendStepSummary(env, renderStepSummary({ exitCode: o.exitCode, error: message }), warn);
  await sendNotifications(buildNotification({ exitCode: o.exitCode, error: message }), { env, notifyOn: o.notifyOn ?? 'always', onWarn: warn });
}
