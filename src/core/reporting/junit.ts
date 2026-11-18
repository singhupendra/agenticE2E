import { firstLine, type RunReport } from './model.js';

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export const xml = (s: unknown) => String(s ?? '').replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const secs = (ms: number) => (ms / 1000).toFixed(3);

/** SPEC-011 FR-3: JUnit XML (one suite per site). */
export function renderJUnit(r: RunReport): string {
  const { totals } = r;
  const cases = r.tests.map((t) => {
    const props = [
      ['title', t.name], ['outcome', t.outcome], ['attempts', String(t.attempts)], ['flaky', String(!!t.flaky)],
      ...(t.flaky ? [['flakyReasons', t.flaky.reasons.join(',')]] : []),
      ...(t.outcome === 'healed' ? [['healed', 'true']] : []),
    ].map(([n, v]) => `        <property name="${xml(n)}" value="${xml(v)}"/>`).join('\n');
    const body: string[] = [`      <properties>\n${props}\n      </properties>`];
    if (t.outcome === 'failed') body.push(`      <failure message="${xml(firstLine(t.error, 500))}" type="${xml(t.status)}">${xml(t.error ?? '')}</failure>`);
    if (t.outcome === 'skipped') body.push('      <skipped/>');
    if (t.heal) body.push(`      <system-out>${xml(`heal: ${t.heal.outcome}${t.heal.verdict ? ` (${t.heal.verdict})` : ''} — ${t.heal.reason}${t.heal.diff ? `\n\n${t.heal.diff}` : ''}`)}</system-out>`);
    return `    <testcase classname="${xml(r.site.id)}" name="${xml(t.journeyId)}" time="${secs(t.durationMs)}">\n${body.join('\n')}\n    </testcase>`;
  }).join('\n');
  const counts = `tests="${totals.tests}" failures="${totals.failed}" errors="0" skipped="${totals.skipped}" time="${secs(r.run.durationMs)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="agentic-e2e" ${counts}>`,
    `  <testsuite name="${xml(r.site.id)}" ${counts} timestamp="${xml(r.run.startedAt)}">`,
    cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}
