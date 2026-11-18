import path from 'node:path';
import { detectFlaky, type FlakyInfo } from './reporting/flaky.js';
import type { Store } from './storage.js';
import type { Journey, JourneyStatus, SiteMeta, TestResult } from './types.js';
import { aggregateByJourney } from './scale/results.js';
import { filterJourneyIds, type JourneyFilter } from './scale/tags.js';

export type LastRunOutcome = 'passed' | 'failed' | 'skipped' | 'healed' | 'never_run';

export interface LastRun {
  outcome: LastRunOutcome;
  runId?: string;
  /** finishedAt of the run that produced the result */
  at?: string;
  durationMs?: number;
  /** first line of the error, when the result was not a pass */
  error?: string;
}

export interface TestCase {
  journeyId: string;
  name: string;
  specFile: string;
  journeyStatus: JourneyStatus | 'unknown';
  lastRun: LastRun;
  /** SPEC-009 */
  requiresAuth?: boolean;
  user?: string;
  /** SPEC-011: present only when the run history marks the test flaky */
  flaky?: FlakyInfo;
  /** SPEC-012: journey tags (only when non-empty) */
  tags?: string[];
  /** SPEC-012: latest outcome per environment × project (only when runs recorded projects) */
  targets?: TargetOutcome[];
}

export interface TargetOutcome { env?: string; project: string; browser?: string; device?: string; outcome: LastRunOutcome; runId: string; at: string }
export interface ListTestCasesOptions extends JourneyFilter {
  /** only runs of this environment count for `lastRun` / `targets` */
  env?: string;
}

export interface SiteTestCases {
  site: Pick<SiteMeta, 'id' | 'origin' | 'url'>;
  dataDir: string;
  tests: TestCase[];
}

const outcomeOf = (s: TestResult['status']): LastRunOutcome => (s === 'passed' ? 'passed' : s === 'skipped' ? 'skipped' : 'failed');

/** Stored generated tests of a site with journey info and latest run outcome. `null` = unknown site. Read-only. */
export function listTestCases(store: Store, siteId: string, opts: ListTestCasesOptions = {}): SiteTestCases | null {
  if (!store.hasSite(siteId)) return null;
  const meta = store.loadSite(siteId);
  const journeys = new Map<string, Journey>((store.loadJourneys(siteId) ?? []).map((j) => [j.id, j]));
  const heals = store.loadHeals(siteId);

  // Latest stored result per journey; runs are ordered by id (= start time).
  // SPEC-012: one run may hold several results per journey (one per project): aggregate them (failed if any failed).
  type Run = ReturnType<Store['listRuns']>[number];
  const latest = new Map<string, { result: TestResult; run: Run }>();
  const targets = new Map<string, Map<string, TargetOutcome>>();
  // SPEC-011 flaky detection sees one (aggregated) result per journey and run, and only the selected env's runs.
  const runs = store.listRuns(siteId).filter((run) => !opts.env || run.env === opts.env);
  const flaky = detectFlaky(runs.map((run) => ({ ...run, results: aggregateByJourney(run.results) })), heals);
  for (const run of runs) {
    for (const result of aggregateByJourney(run.results)) latest.set(result.journeyId, { result, run });
    for (const r of run.results) {
      if (!r.project) continue;
      const per = targets.get(r.journeyId) ?? new Map<string, TargetOutcome>();
      per.set(`${run.env ?? ''}\u0000${r.project}`, { ...(run.env ? { env: run.env } : {}), project: r.project, ...(r.browser ? { browser: r.browser } : {}), ...(r.device ? { device: r.device } : {}), outcome: outcomeOf(r.status), runId: run.id, at: run.finishedAt });
      targets.set(r.journeyId, per);
    }
  }

  const allIds = store.listTests(siteId);
  const ids = filterJourneyIds(allIds, [...journeys.values()], opts);
  const tests = ids.map((journeyId): TestCase => {
    const j = journeys.get(journeyId);
    const l = latest.get(journeyId);
    let lastRun: LastRun = { outcome: 'never_run' };
    if (l) {
      let outcome = outcomeOf(l.result.status);
      const lastHeal = heals.filter((h) => h.journeyId === journeyId).at(-1);
      if (outcome === 'passed' && l.run.kind === 'heal-rerun' && lastHeal?.outcome === 'healed') outcome = 'healed';
      lastRun = { outcome, runId: l.run.id, at: l.run.finishedAt, durationMs: l.result.durationMs };
      if (outcome === 'failed' || outcome === 'skipped') {
        const first = l.result.error?.split('\n')[0];
        if (first) lastRun.error = first;
      }
    }
    return {
      journeyId,
      name: j?.name ?? journeyId,
      // Not store.testFile(): it rejects stray names like `My Test.spec.ts`.
      specFile: path.resolve(store.testsDir(siteId), `${journeyId}.spec.ts`),
      journeyStatus: j?.status ?? 'unknown',
      lastRun,
      ...(j?.requiresAuth ? { requiresAuth: true, ...(j.user ? { user: j.user } : {}) } : {}),
      ...(flaky[journeyId]?.flaky ? { flaky: flaky[journeyId] } : {}),
      ...(j?.tags?.length ? { tags: j.tags } : {}),
      ...(targets.get(journeyId)?.size ? { targets: [...targets.get(journeyId)!.values()] } : {}),
    };
  });

  return {
    site: { id: siteId, origin: meta?.origin ?? '', url: meta?.url ?? '' },
    dataDir: store.dataDir,
    tests,
  };
}
