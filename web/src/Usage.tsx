import { Fragment, useEffect, useState } from 'react';
import { api, type UsageListing, type UsageTotals } from './api';

const int = (n: number) => n.toLocaleString('en-US');
const usd = (n: number) => `$${n.toFixed(4)}`;

function TotalsRow({ t }: { t: UsageTotals }) {
  return (
    <>
      <td>{t.calls}{t.cached ? ` (${t.cached} cached)` : ''}{t.failed ? <span className="error"> · {t.failed} failed</span> : null}</td>
      <td>{int(t.inputTokens)}</td>
      <td>{int(t.outputTokens)}</td>
      <td>{int(t.cacheReadTokens)} / {int(t.cacheWriteTokens)}</td>
      <td>{usd(t.costUsd)}{t.unpricedCalls ? <small className="muted"> +{t.unpricedCalls} unpriced</small> : null}</td>
    </>
  );
}

/** SPEC-013 FR-13: LLM usage per command/job (tokens, estimated cost) for a site. */
export function Usage({ site, version }: { site: string; version: number }) {
  const [data, setData] = useState<UsageListing | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.usage(site).then(setData).catch((e) => setError(String(e.message))); }, [site, version]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.reports.length) return <p className="muted">No LLM usage recorded yet. Costs are estimates from Anthropic list prices.</p>;
  return (
    <div>
      <p className="muted">Estimated from Anthropic list prices (Bedrock is billed by AWS at its own rates).</p>
      <table className="usage">
        <thead><tr><th>Started</th><th>Action</th><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cache r/w</th><th>Est. cost</th></tr></thead>
        <tbody>
          {data.reports.map((r) => (
            <Fragment key={r.id}>
              <tr className={r.status === 'error' ? 'bad' : ''} onClick={() => setOpen(open === r.id ? null : r.id)} title={r.error ?? 'show calls'}>
                <td>{r.startedAt.replace('T', ' ').slice(0, 19)}</td><td>{r.action}{r.status === 'error' ? ' ✗' : ''}</td><td><code>{r.model}</code></td>
                <TotalsRow t={r.totals} />
              </tr>
              {open === r.id && (
                <tr><td colSpan={8}>
                  {r.error && <p className="error">{r.error}</p>}
                  <table className="usage calls"><tbody>{r.calls.map((c) => (
                    <tr key={c.n}><td>#{c.n}</td><td>{c.name}</td><td>{c.cached ? 'cache hit' : `${c.latencyMs} ms`}{c.retries ? ` · ${c.retries} retr${c.retries === 1 ? 'y' : 'ies'}` : ''}</td>
                      <td>{int(c.inputTokens)} in / {int(c.outputTokens)} out</td><td>{c.costUsd === undefined ? 'unpriced' : usd(c.costUsd)}</td><td>{c.ok ? '' : <span className="error">{c.error}</span>}</td></tr>
                  ))}</tbody></table>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
        <tfoot><tr><th colSpan={3}>Total ({data.reports.length} runs)</th><TotalsRow t={data.totals} /></tr></tfoot>
      </table>
    </div>
  );
}
