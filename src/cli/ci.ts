import { Command, InvalidArgumentError } from 'commander';
import { loadConfig, type Config, type PartialConfig } from '../core/config.js';
import { EXIT_CODES, runCi } from '../core/ci/run-ci.js';
import { buildSiteReport, parseReporterList, publishError, publishReport, type ReportMode } from '../core/reporting/index.js';
import type { Context } from '../core/pipeline.js';
import type { HealRecord, ProgressEvent, RunRecord } from '../core/types.js';

/** SPEC-011: report flags for run/heal/all/ci. */
export function addReportOptions(cmd: Command): Command {
  return cmd
    .option('--reporter <list>', 'report formats, comma-separated: junit,json,html (default: all) or none')
    .option('--report-dir <dir>', 'also write the reports (with screenshots) to this directory')
    .option('--notify-on <when>', 'webhook/Slack notifications: always | failure | never (URLs from AGENTIC_E2E_WEBHOOK_URL / AGENTIC_E2E_SLACK_WEBHOOK_URL)');
}
export function reportCliConfig(o: Record<string, unknown>): PartialConfig {
  return {
    reporters: parseReporterList(o.reporter as string | undefined) as Config['reporters'] | undefined,
    reportDir: o.reportDir as string | undefined,
    notifyOn: o.notifyOn as Config['notifyOn'] | undefined,
  };
}

/** Reports + step summary + notifications after `run` / `heal` / `all`. */
export async function reportRun(ctx: Context, url: string, o: { mode: ReportMode; runs: RunRecord[]; heals?: HealRecord[]; exitCode: number }) {
  if (!o.runs.length) return;
  await publishReport(ctx, buildSiteReport(ctx, url, o), { exitCode: o.exitCode });
}

const intArg = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('must be a non-negative integer'); return n; };

/** `ci` errors raised by commander itself (unknown flag, bad value) are config errors (exit 2). */
export function commanderExitCode(argv: string[], err: { code?: string; exitCode?: number }): number {
  const isCi = argv.slice(2).find((a) => !a.startsWith('-')) === 'ci';
  if (isCi && (err.exitCode ?? 1) !== 0) return EXIT_CODES.CONFIG_OR_AUTH;
  return err.exitCode ?? 1;
}

export function registerCiCommand(program: Command, h: {
  addCommon: (c: Command) => Command;
  cliConfig: (o: Record<string, unknown>) => PartialConfig;
  logEvent: (e: ProgressEvent) => void;
  setExit: (code: number) => void;
}) {
  addReportOptions(h.addCommon(program.command('ci <url>')
    .description('non-interactive CI run of stored tests; exit 0 pass, 1 test failures, 2 config/auth error, 3 LLM/infra error')))
    .option('--retries <n>', 're-run failing tests up to n times without the LLM (passing on retry = flaky)', intArg)
    .option('--allow-heal', 'heal tests that still fail (calls the LLM and may rewrite specs); off by default in CI')
    .action(async (url: string, o) => {
      let config: Config;
      try {
        config = await loadConfig({ configFile: o.config, cli: { ...h.cliConfig(o), retries: o.retries } });
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        await publishError({ exitCode: EXIT_CODES.CONFIG_OR_AUTH, error: e });
        return h.setExit(EXIT_CODES.CONFIG_OR_AUTH);
      }
      const r = await runCi({ config, url, allowHeal: !!o.allowHeal, onProgress: h.logEvent });
      if (r.error) console.error(`Error: ${r.error}`);
      if (r.report) {
        console.log('\nCI result:');
        for (const t of r.report.tests) console.log(`  ${t.outcome === 'passed' || t.outcome === 'healed' ? '✔' : t.outcome === 'skipped' ? '-' : '✗'} ${t.journeyId} ${t.outcome}${t.flaky ? ` (flaky: ${t.flaky.reasons.join(', ')})` : ''}${t.attempts > 1 ? ` [${t.attempts} attempts]` : ''}`);
        const x = r.report.totals;
        console.log(`${x.tests} test(s): ${x.passed} passed, ${x.failed} failed, ${x.healed} healed, ${x.skipped} skipped, ${x.flaky} flaky`);
      }
      const meaning = ['pass', 'test failures', 'config/auth error', 'LLM/infra error'][r.exitCode];
      console.log(`exit code ${r.exitCode} (${meaning})`);
      h.setExit(r.exitCode);
    });
}
