import type { TestResult } from '../types.js';

/** SPEC-012 FR-22/23: several results per journey (one per project). */
const RANK: Record<TestResult['status'], number> = { failed: 3, timedOut: 3, skipped: 1, passed: 0 };

/** One result per journey (first-seen order): the first worst result, so a failure on any project wins. */
export function aggregateByJourney(results: TestResult[]): TestResult[] {
  const out = new Map<string, TestResult>();
  for (const r of results) {
    const prev = out.get(r.journeyId);
    if (!prev || RANK[r.status] > RANK[prev.status]) out.set(r.journeyId, r);
  }
  return [...out.values()];
}

/** The failing result to heal per journey (each journey is healed once). */
export function failuresToHeal(results: TestResult[]): TestResult[] {
  return aggregateByJourney(results).filter((r) => r.status === 'failed' || r.status === 'timedOut');
}
