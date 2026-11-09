import type { Store } from './storage.js';
import { listTestCases } from './test-cases.js';

export interface HealSelectionRequest {
  /** Test (= journey) ids to heal. Empty/absent = no id filter. */
  ids?: string[];
  /** Only tests whose latest stored run outcome is `failed`. */
  failedOnly?: boolean;
}

export interface HealSelection {
  /** Selected ids in request order (or listing order for `failedOnly`); `null` = no selection, i.e. the whole suite. */
  ids: string[] | null;
  /** Every test id of the site, sorted. */
  validIds: string[];
}

export class UnknownSiteError extends Error {
  constructor(public site: string) { super(`Unknown site ${site}`); this.name = 'UnknownSiteError'; }
}

export class HealSelectionError extends Error {
  constructor(public unknownIds: string[], public validIds: string[]) {
    super(`Unknown test id${unknownIds.length === 1 ? '' : 's'}: ${unknownIds.join(', ')}. Valid ids: ${validIds.length ? validIds.join(', ') : '(none)'}`);
    this.name = 'HealSelectionError';
  }
}

/** Resolve and validate which tests to heal. Read-only; throws before anything is run or any LLM is called. */
export function resolveHealSelection(store: Store, siteId: string, req: HealSelectionRequest = {}): HealSelection {
  const listing = listTestCases(store, siteId);
  if (!listing) throw new UnknownSiteError(siteId);
  const validIds = listing.tests.map((t) => t.journeyId);
  const requested = [...new Set(req.ids ?? [])];
  const unknown = requested.filter((id) => !validIds.includes(id));
  if (unknown.length) throw new HealSelectionError(unknown, validIds);
  if (!requested.length && !req.failedOnly) return { ids: null, validIds };
  const failed = new Set(listing.tests.filter((t) => t.lastRun.outcome === 'failed').map((t) => t.journeyId));
  const base = requested.length ? requested : validIds;
  return { ids: req.failedOnly ? base.filter((id) => failed.has(id)) : base, validIds };
}
