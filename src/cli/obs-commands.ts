import path from 'node:path';
import type { Command } from 'commander';
import { loadConfig, type PartialConfig } from '../core/config.js';
import { formatUsageSummary } from '../core/llm/usage.js';
import { AUDIT_FILE, readAuditLog, verifyAuditLog } from '../core/obs/audit.js';
import { listUsageReports } from '../core/obs/usage-store.js';
import { normalizeSite } from '../core/storage.js';

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return n;
};

/** SPEC-013 options shared by every pipeline command. */
export function addObsOptions(cmd: Command): Command {
  return cmd
    .option(
      '--log-level <level>',
      'trace | debug | info | warn | error | fatal | silent (logs go to stderr; default warn)',
    )
    .option('--log-format <format>', 'pretty | json')
    .option('--llm-cache <mode>', 'deterministic LLM response cache: off | read-write | read-only')
    .option('--max-cost <usd>', 'stop LLM work when the estimated cost of this command exceeds this many USD', num)
    .option('--max-tokens-per-run <n>', 'stop LLM work when this command used more tokens than this', num);
}

export function obsCliConfig(o: Record<string, unknown>): PartialConfig {
  const budget =
    o.maxCost !== undefined || o.maxTokensPerRun !== undefined
      ? {
          ...(o.maxCost !== undefined ? { maxCostPerRun: o.maxCost as number } : {}),
          ...(o.maxTokensPerRun !== undefined ? { maxTokensPerRun: o.maxTokensPerRun as number } : {}),
        }
      : undefined;
  return {
    logLevel: o.logLevel as PartialConfig['logLevel'],
    logFormat: o.logFormat as PartialConfig['logFormat'],
    llmCache: o.llmCache as PartialConfig['llmCache'],
    llmBudget: budget,
  };
}

export function registerObsCommands(program: Command): void {
  program
    .command('usage <url>')
    .description('show stored LLM usage reports (tokens, estimated cost) of a site')
    .option('--json', 'print the reports as JSON')
    .option('--limit <n>', 'only the newest n reports', num)
    .option('--data-dir <dir>', 'where per-site data is stored (default: ./data)')
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .action(async (url: string, o) => {
      const site = normalizeSite(url).id;
      const config = await loadConfig({ configFile: o.config, cli: { dataDir: o.dataDir } });
      const reports = (await listUsageReports(config.dataDir, site)).slice(0, o.limit ?? undefined);
      if (o.json) return console.log(JSON.stringify(reports, null, 2));
      if (!reports.length) return console.log(`No LLM usage recorded for ${site} yet.`);
      for (const r of reports)
        console.log(
          `${r.startedAt}  ${r.action.padEnd(9)} ${r.status === 'ok' ? 'ok   ' : 'ERROR'} ${r.model}  ${formatUsageSummary(r.totals).replace(/^LLM: /, '')}`,
        );
    });

  program
    .command('audit')
    .description('show the append-only audit log (who discovered, generated, healed, approved — and when)')
    .option('--site <id>', 'only entries for this site id')
    .option('--limit <n>', 'only the newest n entries', num)
    .option('--json', 'print the entries as JSON')
    .option('--verify', 'verify the hash chain (detects edited or removed entries)')
    .option('--data-dir <dir>', 'where per-site data is stored (default: ./data)')
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .action(async (o) => {
      const config = await loadConfig({ configFile: o.config, cli: { dataDir: o.dataDir } });
      const file = path.join(config.dataDir, AUDIT_FILE);
      if (o.verify) {
        const v = verifyAuditLog(file);
        if (!v.ok) throw new Error(`Audit log ${file} is NOT intact: line ${v.brokenAt}: ${v.reason}`);
        return console.log(`Audit log intact: ${v.entries} ${v.entries === 1 ? 'entry' : 'entries'} (${file})`);
      }
      const entries = readAuditLog(file, { site: o.site, limit: o.limit });
      if (o.json) return console.log(JSON.stringify(entries, null, 2));
      if (!entries.length) return console.log('No audit entries yet.');
      for (const e of entries)
        console.log(
          `${e.at}  ${e.actor.padEnd(18)} ${e.action.padEnd(24)} ${e.site ?? '-'}  ${JSON.stringify(e.details)}`,
        );
    });
}
