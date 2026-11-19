import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage.js';
import { renderHtml } from './html.js';
import { renderJUnit } from './junit.js';
import type { ReportFormat, RunReport } from './model.js';

const FILE: Record<ReportFormat, string> = { junit: 'junit.xml', json: 'summary.json', html: 'report.html' };
const posix = (p: string) => p.split(path.sep).join('/');

export interface WriteResult {
  files: string[];
  runReportsDir: string;
}

/**
 * SPEC-011 FR-4: write reports to `runs/<id>/reports/` and optionally `reportDir` (with screenshots copied to `assets/`).
 * The report must already be redacted; the store's credential redactor is applied once more to every file.
 */
export function writeReports(
  store: Store,
  report: RunReport,
  opts: { formats: readonly ReportFormat[]; reportDir?: string },
): WriteResult {
  const site = report.site.id;
  const runReportsDir = path.join(store.runDir(site, report.run.id), 'reports');
  const files: string[] = [];
  if (!opts.formats.length) return { files, runReportsDir };
  const siteDir = store.siteDir(site);
  const safe = (rel: string): string | null => {
    try {
      const abs = store.resolveFile(site, rel);
      return abs !== siteDir && fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  };
  const emit = (dir: string, href: (rel: string) => string | null) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of opts.formats) {
      const body =
        f === 'junit'
          ? renderJUnit(report)
          : f === 'json'
            ? `${JSON.stringify(report, null, 2)}\n`
            : renderHtml(report, { href });
      const file = path.join(dir, FILE[f]);
      fs.writeFileSync(file, store.redact(body));
      files.push(file);
    }
  };
  emit(runReportsDir, (rel) => {
    const abs = safe(rel);
    return abs ? posix(path.relative(runReportsDir, abs)) : null;
  });
  if (opts.reportDir) {
    const out = path.resolve(opts.reportDir);
    const wantsAssets = opts.formats.includes('html');
    emit(out, (rel) => {
      const abs = safe(rel);
      if (!abs || !wantsAssets) return null;
      const target = path.join(out, 'assets', path.relative(siteDir, abs));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(abs, target);
      return posix(path.relative(out, target));
    });
  }
  return { files, runReportsDir };
}
