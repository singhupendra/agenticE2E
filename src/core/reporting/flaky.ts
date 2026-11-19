import type { HealRecord, RunRecord, TestResult } from '../types.js';
import { aggregateByJourney } from '../scale/results.js';

/** SPEC-011 FR-14 */
export type FlakyReason = 'passed_on_retry' | 'alternating';
export interface FlakyInfo {
  flaky: boolean;
  reasons: FlakyReason[];
  /** pass↔fail transitions among the `run`-kind results in the window */ transitions: number;
}

const failed = (s: TestResult['status']) => s === 'failed' || s === 'timedOut';
const ALTERNATING_MIN_TRANSITIONS = 2;

/**
 * Flakiness per journey from stored history. Heal re-runs are ignored (the code under test changed), as is everything
 * before the latest `healed` heal of a journey. Only the last `window` non-skipped results count.
 */
export function detectFlaky(
  runs: RunRecord[],
  heals: HealRecord[],
  opts: { window?: number } = {},
): Record<string, FlakyInfo> {
  const window = opts.window ?? 10;
  // SPEC-012: one aggregated result per journey and run (failed if any browser/device failed), so a stable
  // browser-specific failure is never read as pass↔fail alternation.
  const ordered = [...runs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({ ...r, results: aggregateByJourney(r.results) }));
  const seq = new Map<string, { kind: RunRecord['kind']; status: TestResult['status']; at: string }[]>();
  for (const run of ordered) {
    for (const r of run.results) {
      if (!seq.has(r.journeyId)) seq.set(r.journeyId, []);
      seq.get(r.journeyId)!.push({ kind: run.kind, status: r.status, at: run.finishedAt || run.startedAt });
    }
  }
  const out: Record<string, FlakyInfo> = {};
  for (const [id, all] of seq) {
    const mine = heals.filter((h) => h.journeyId === id);
    const healedAt = mine
      .filter((h) => h.outcome === 'healed')
      .map((h) => h.at)
      .sort()
      .at(-1);
    const entries = all
      .filter((e) => e.kind !== 'heal-rerun' && e.status !== 'skipped' && (!healedAt || e.at > healedAt))
      .slice(-window);
    const reasons = new Set<FlakyReason>();
    for (let i = 1; i < entries.length; i++)
      if (entries[i].kind === 'retry' && entries[i].status === 'passed' && failed(entries[i - 1].status))
        reasons.add('passed_on_retry');
    const since = entries[0]?.at;
    if (
      mine.some(
        (h) => h.outcome === 'flaky_or_environment' && (!healedAt || h.at > healedAt) && (!since || h.at >= since),
      )
    )
      reasons.add('passed_on_retry');
    const plain = entries.filter((e) => e.kind === 'run').map((e) => e.status === 'passed');
    let transitions = 0;
    for (let i = 1; i < plain.length; i++) if (plain[i] !== plain[i - 1]) transitions++;
    if (transitions >= ALTERNATING_MIN_TRANSITIONS) reasons.add('alternating');
    const list = (['passed_on_retry', 'alternating'] as const).filter((r) => reasons.has(r));
    out[id] = { flaky: list.length > 0, reasons: list, transitions };
  }
  return out;
}
