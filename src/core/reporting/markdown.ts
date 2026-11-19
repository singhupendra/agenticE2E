import { firstLine, type RunReport } from './model.js';

const ICON: Record<string, string> = { passed: '✅', failed: '❌', healed: '🩹', skipped: '⏭️' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'");
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** SPEC-011 FR-12: GitHub Actions job summary (Markdown). Inputs must already be redacted. */
export function renderStepSummary(o: { report?: RunReport; exitCode: number; error?: string }): string {
  if (!o.report) {
    return `## agentic-e2e — ❗ error\n\nexit code ${o.exitCode}: ${cell(firstLine(o.error, 500) || 'unknown error')}\n\n`;
  }
  const r = o.report;
  const t = r.totals;
  const head = `## agentic-e2e — ${cell(r.site.id)} ${t.failed ? '❌' : '✅'}\n\n**${r.mode}** run \`${cell(r.run.id)}\` · exit code ${o.exitCode} · ${t.passed} passed, ${t.failed} failed, ${t.healed} healed, ${t.skipped} skipped, ${t.flaky} flaky · ${fmtMs(r.run.durationMs)}\n`;
  const rows = r.tests.map(
    (x) =>
      `| \`${cell(x.journeyId)}\` | ${ICON[x.outcome] ?? ''} ${x.outcome} | ${x.flaky ? `⚠️ ${x.flaky.reasons.join(', ')}` : ''} | ${fmtMs(x.durationMs)} | ${cell(firstLine(x.error))} |`,
  );
  const err = o.error ? `\n${cell(firstLine(o.error, 500))}\n` : '';
  return `${head}${err}\n| Test | Outcome | Flaky | Duration | Error |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n`;
}
