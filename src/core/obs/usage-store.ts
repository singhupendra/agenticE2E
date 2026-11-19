import type { LLMBudget, LLMCallRecord, UsageTotals } from '../llm/usage.js';
import { Redactor } from '../redact.js';
import { FilesystemBackend } from '../storage/filesystem.js';
import type { StorageBackend } from '../storage/backend.js';
import { Store } from '../storage.js';

/** SPEC-013 FR-11: LLM usage of one CLI command / web job for one site. */
export interface UsageReport {
  id: string;
  action: string;
  site: string;
  actor: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'error';
  error?: string;
  provider: string;
  model: string;
  budget?: LLMBudget;
  totals: UsageTotals;
  calls: LLMCallRecord[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Validates the site id exactly like the Store does (no traversal, no odd characters). */
const prefixOf = (site: string) => { new Store('/').siteDir(site); return `sites/${site}/usage/`; };
/** SPEC-014 FR-30: reports go through a StorageBackend; a data dir path means the default filesystem backend. */
const backendOf = (s: StorageBackend | string): StorageBackend => (typeof s === 'string' ? new FilesystemBackend(s) : s);

export async function saveUsageReport(storage: StorageBackend | string, site: string, report: UsageReport, redactor: Redactor = Redactor.empty()): Promise<string> {
  if (!ID_RE.test(report.id)) throw new Error(`Invalid usage report id: ${JSON.stringify(report.id)}`);
  const key = `${prefixOf(site)}${report.id}.json`;
  await backendOf(storage).write(key, redactor.redact(JSON.stringify(report, null, 2)) + '\n');
  return key;
}

/** Reports of a site, newest first (by `startedAt`). Unreadable objects are skipped. */
export async function listUsageReports(storage: StorageBackend | string, site: string): Promise<UsageReport[]> {
  const backend = backendOf(storage);
  const prefix = prefixOf(site);
  const out: UsageReport[] = [];
  for (const key of (await backend.list(prefix)).filter((k) => k.endsWith('.json') && !k.slice(prefix.length).includes('/'))) {
    try { const b = await backend.read(key); if (b) out.push(JSON.parse(b.toString('utf8')) as UsageReport); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
