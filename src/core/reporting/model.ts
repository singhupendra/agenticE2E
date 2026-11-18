import type { HealRecord, Journey, RunRecord, TestResult } from '../types.js';
import type { FlakyInfo } from './flaky.js';

/** SPEC-011 FR-1 */
export type ReportMode = 'run' | 'heal' | 'all' | 'ci';
export type ReportOutcome = 'passed' | 'failed' | 'skipped' | 'healed';
export const REPORT_FORMATS = ['junit', 'json', 'html'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportHeal {
  outcome: HealRecord['outcome'];
  verdict?: HealRecord['verdict'];
  reason: string;
  diff?: string;
  candidateDiff?: string;
}
export interface ReportTest {
  journeyId: string;
  name: string;
  outcome: ReportOutcome;
  /** raw status of the last attempt */
  status: TestResult['status'];
  durationMs: number;
  attempts: number;
  error?: string;
  flaky?: FlakyInfo;
  heal?: ReportHeal;
  /** paths relative to the site dir */
  screenshots: string[];
  trace?: string;
}
export interface ReportTotals { tests: number; passed: number; failed: number; skipped: number; healed: number; flaky: number }
export interface RunReport {
  schemaVersion: 1;
  tool: 'agentic-e2e';
  generatedAt: string;
  site: { id: string; origin: string };
  mode: ReportMode;
  run: { id: string; kind: RunRecord['kind']; startedAt: string; finishedAt: string; durationMs: number };
  totals: ReportTotals;
  tests: ReportTest[];
}

export interface BuildReportInput {
  site: { id: string; origin: string };
  mode: ReportMode;
  /** primary run first, then retries (in order) */
  runs: RunRecord[];
  heals: HealRecord[];
  journeys?: Journey[];
  flaky?: Record<string, FlakyInfo>;
  generatedAt?: string;
}

const ms = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? t : NaN; };

export function buildRunReport(input: BuildReportInput): RunReport {
  const [primary, ...later] = input.runs;
  if (!primary) throw new Error('buildRunReport needs at least one run');
  const names = new Map((input.journeys ?? []).map((j) => [j.id, j.name]));
  const tests = primary.results.map((first): ReportTest => {
    const attempts = [first, ...later.flatMap((r) => r.results.filter((x) => x.journeyId === first.journeyId))];
    const last = attempts.at(-1)!;
    const h = input.heals.filter((x) => x.journeyId === first.journeyId).at(-1);
    let outcome: ReportOutcome = last.status === 'passed' ? 'passed' : last.status === 'skipped' ? 'skipped' : 'failed';
    if (outcome === 'failed' && h?.outcome === 'healed') outcome = 'healed';
    else if (outcome === 'failed' && h?.outcome === 'flaky_or_environment') outcome = 'passed';
    const screenshots = [...new Set(attempts.flatMap((a) => [...a.screenshots, ...(a.failure?.screenshot ? [a.failure.screenshot] : [])]))];
    const trace = attempts.map((a) => a.tracePath).filter(Boolean).at(-1);
    const flaky = input.flaky?.[first.journeyId];
    const errorOf = [...attempts].reverse().find((a) => a.error)?.error;
    return {
      journeyId: first.journeyId,
      name: names.get(first.journeyId) ?? first.journeyId,
      outcome,
      status: last.status,
      durationMs: attempts.reduce((s, a) => s + (a.durationMs || 0), 0),
      attempts: attempts.length,
      ...(outcome === 'failed' || outcome === 'skipped' ? (errorOf ? { error: errorOf } : {}) : {}),
      ...(flaky?.flaky ? { flaky } : {}),
      ...(h ? { heal: { outcome: h.outcome, verdict: h.verdict, reason: h.reason, diff: h.diff, candidateDiff: h.candidateDiff } } : {}),
      screenshots,
      ...(trace ? { trace } : {}),
    };
  });
  const count = (o: ReportOutcome) => tests.filter((t) => t.outcome === o).length;
  const finishedAt = input.runs.at(-1)!.finishedAt || primary.finishedAt;
  const dur = ms(finishedAt) - ms(primary.startedAt);
  return {
    schemaVersion: 1,
    tool: 'agentic-e2e',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    site: { id: input.site.id, origin: input.site.origin },
    mode: input.mode,
    run: { id: primary.id, kind: primary.kind, startedAt: primary.startedAt, finishedAt, durationMs: Number.isFinite(dur) && dur > 0 ? dur : 0 },
    totals: { tests: tests.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), healed: count('healed'), flaky: tests.filter((t) => t.flaky).length },
    tests,
  };
}

/** First non-empty line, trimmed and bounded. */
export function firstLine(s: string | undefined, max = 200): string {
  const l = (s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}
