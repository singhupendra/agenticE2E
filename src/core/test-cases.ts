import path from 'node:path';
import type { Store } from './storage.js';
import type { Journey, JourneyStatus, SiteMeta, TestResult } from './types.js';

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
}

export interface SiteTestCases {
  site: Pick<SiteMeta, 'id' | 'origin' | 'url'>;
  dataDir: string;
  tests: TestCase[];
}

const outcomeOf = (s: TestResult['status']): LastRunOutcome => (s === 'passed' ? 'passed' : s === 'skipped' ? 'skipped' : 'failed');

/** Stored generated tests of a site with journey info and latest run outcome. `null` = unknown site. Read-only. */
export function listTestCases(store: Store, siteId: string): SiteTestCases | null {
  if (!store.hasSite(siteId)) return null;
  const meta = store.loadSite(siteId);
  const journeys = new Map<string, Journey>((store.loadJourneys(siteId) ?? []).map((j) => [j.id, j]));
  const heals = store.loadHeals(siteId);

  // Latest stored result per journey; runs are ordered by id (= start time).
  const latest = new Map<string, { result: TestResult; run: ReturnType<Store['listRuns']>[number] }>();
  for (const run of store.listRuns(siteId)) for (const result of run.results) latest.set(result.journeyId, { result, run });

  const tests = store.listTests(siteId).map((journeyId): TestCase => {
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
    };
  });

  return {
    site: { id: siteId, origin: meta?.origin ?? '', url: meta?.url ?? '' },
    dataDir: store.dataDir,
    tests,
  };
}
