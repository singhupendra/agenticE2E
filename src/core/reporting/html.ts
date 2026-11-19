import { firstLine, type ReportTest, type RunReport } from './model.js';
import { formatUsageSummary, type UsageTotals } from '../llm/usage.js';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** SPEC-013: `$0.0123 · 3 calls` */
const fmtLlm = (u: UsageTotals | undefined) =>
  u ? `$${u.costUsd.toFixed(4)} · ${u.calls} call${u.calls === 1 ? '' : 's'}` : '';
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

const CSS = `
:root{color-scheme:light dark;--ok:#1a7f37;--bad:#cf222e;--heal:#8250df;--warn:#9a6700;--mut:#6e7781;--bg2:rgba(127,127,127,.08)}
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;max-width:1200px}
h1{font-size:20px;margin:0 0 4px}.meta{color:var(--mut);margin-bottom:16px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 20px}.tile{background:var(--bg2);border-radius:8px;padding:10px 14px;min-width:90px}
.tile b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.25);vertical-align:top}
.o{font-weight:600}.o-passed{color:var(--ok)}.o-failed{color:var(--bad)}.o-healed{color:var(--heal)}.o-skipped{color:var(--mut)}.flaky{color:var(--warn);font-weight:600}
details{margin:10px 0;padding:8px 12px;background:var(--bg2);border-radius:8px}summary{cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(127,127,127,.1);padding:8px;border-radius:6px;overflow:auto}
.add{color:var(--ok)}.del{color:var(--bad)}.hunk{color:var(--heal)}
.shots{display:flex;gap:8px;flex-wrap:wrap}.shots img{max-width:240px;max-height:160px;border:1px solid rgba(127,127,127,.4);border-radius:4px}
`;

function diffHtml(diff: string): string {
  return diff
    .split('\n')
    .map((l) => {
      const cls =
        l.startsWith('+++') || l.startsWith('---')
          ? ''
          : l.startsWith('+')
            ? 'add'
            : l.startsWith('-')
              ? 'del'
              : l.startsWith('@@')
                ? 'hunk'
                : '';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    })
    .join('\n');
}

function details(t: ReportTest, href: (rel: string) => string | null): string {
  const parts: string[] = [];
  if (t.error) parts.push(`<h4>Error</h4><pre>${esc(t.error)}</pre>`);
  if (t.flaky)
    parts.push(
      `<p class="flaky">Flaky: ${esc(t.flaky.reasons.join(', '))} (${t.flaky.transitions} pass/fail transitions in recent history)</p>`,
    );
  if (t.heal) {
    parts.push(
      `<h4>Heal: ${esc(t.heal.outcome)}${t.heal.verdict ? ` (${esc(t.heal.verdict)})` : ''}</h4><p>${esc(t.heal.reason)}</p>`,
    );
    if (t.heal.diff) parts.push(`<pre>${diffHtml(t.heal.diff)}</pre>`);
    if (t.heal.candidateDiff)
      parts.push(`<p>Candidate patch (not active):</p><pre>${diffHtml(t.heal.candidateDiff)}</pre>`);
  }
  const shots = t.screenshots.map((s) => [s, href(s)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  if (shots.length)
    parts.push(
      `<h4>Screenshots</h4><div class="shots">${shots.map(([s, h]) => `<a href="${esc(h)}"><img src="${esc(h)}" alt="${esc(s)}" loading="lazy"></a>`).join('')}</div>`,
    );
  if (t.trace) {
    const h = href(t.trace);
    if (h)
      parts.push(
        `<p>Trace: <a href="${esc(h)}">${esc(t.trace)}</a> (open with <code>npx playwright show-trace</code>)</p>`,
      );
  }
  if (!parts.length) return '';
  return `<details id="t-${esc(t.journeyId)}"${t.outcome === 'failed' ? ' open' : ''}><summary><span class="o o-${t.outcome}">${esc(t.outcome)}</span> ${esc(t.journeyId)} — ${esc(t.name)}</summary>${parts.join('\n')}</details>`;
}

/** SPEC-011 FR-3: self-contained HTML (inline CSS, no scripts, no external resources). `href` maps a site-relative path to a link (null = omit). */
export function renderHtml(r: RunReport, opts: { href: (rel: string) => string | null }): string {
  const { totals } = r;
  const status = totals.failed ? 'failed' : 'passed';
  const tiles = (
    [
      ['tests', totals.tests],
      ['passed', totals.passed],
      ['failed', totals.failed],
      ['healed', totals.healed],
      ['skipped', totals.skipped],
      ['flaky', totals.flaky],
    ] as const
  )
    .map(([k, v]) => `<div class="tile"><b>${v}</b>${k}</div>`)
    .join('');
  const rows = r.tests
    .map(
      (t) =>
        `<tr><td><a href="#t-${esc(t.journeyId)}">${esc(t.journeyId)}</a></td><td>${esc(t.name)}</td><td class="o o-${t.outcome}">${esc(t.outcome)}</td><td>${t.flaky ? `<span class="flaky">flaky</span>` : ''}</td><td>${fmtMs(t.durationMs)}</td><td>${t.attempts}</td><td>${esc(firstLine(t.error, 160))}</td>${r.llm ? `<td>${esc(fmtLlm(t.llm))}</td>` : ''}</tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentic-e2e ${esc(r.mode)} — ${esc(r.site.id)} — ${esc(status)}</title><style>${CSS}</style></head>
<body>
<h1>agentic-e2e report — ${esc(r.site.id)} <span class="o o-${status}">${esc(status)}</span></h1>
<div class="meta">${esc(r.mode)} · run <code>${esc(r.run.id)}</code> (${esc(r.run.kind)}) · started ${esc(r.run.startedAt)} · ${fmtMs(r.run.durationMs)} · ${esc(r.site.origin)}</div>
<div class="tiles">${tiles}</div>
${r.llm ? `<p class="meta">${esc(formatUsageSummary(r.llm.totals))} (estimated; planning/login: ${esc(fmtLlm(r.llm.unattributed) || 'none')}). Per-row LLM figures are per journey and shared by its browser/device rows.</p>` : ''}
<table><thead><tr><th>Test</th><th>Name</th><th>Outcome</th><th>Flaky</th><th>Duration</th><th>Attempts</th><th>Error</th>${r.llm ? '<th>LLM</th>' : ''}</tr></thead>
<tbody>
${rows}
</tbody></table>
${r.tests
  .map((t) => details(t, opts.href))
  .filter(Boolean)
  .join('\n')}
<p class="meta">Generated ${esc(r.generatedAt)}</p>
</body></html>
`;
}
