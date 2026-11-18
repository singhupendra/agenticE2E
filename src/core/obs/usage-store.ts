import fs from 'node:fs';
import path from 'node:path';
import type { LLMBudget, LLMCallRecord, UsageTotals } from '../llm/usage.js';
import { Redactor } from '../redact.js';
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
const usageDir = (dataDir: string, site: string) => path.join(new Store(dataDir).siteDir(site), 'usage');

export function saveUsageReport(dataDir: string, site: string, report: UsageReport, redactor: Redactor = Redactor.empty()): string {
  if (!ID_RE.test(report.id)) throw new Error(`Invalid usage report id: ${JSON.stringify(report.id)}`);
  const dir = usageDir(dataDir, site);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.id}.json`);
  fs.writeFileSync(file, redactor.redact(JSON.stringify(report, null, 2)) + '\n');
  return file;
}

/** Reports of a site, newest first (by `startedAt`). Unreadable files are skipped. */
export function listUsageReports(dataDir: string, site: string): UsageReport[] {
  const dir = usageDir(dataDir, site);
  if (!fs.existsSync(dir)) return [];
  const out: UsageReport[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as UsageReport); } catch { /* skip */ }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
