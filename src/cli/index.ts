import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { loadConfig, type PartialConfig, type Config } from '../core/config.js';
import { parseJourneys, setStatus } from '../core/journeys.js';
import { createContext, discover, generate, heal, run, runAll, type Context } from '../core/pipeline.js';
import { Store, normalizeSite } from '../core/storage.js';
import type { Journey, ProgressEvent, RunRecord } from '../core/types.js';

const num = (v: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`); return n; };

function addCommon(cmd: Command): Command {
  return cmd
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .option('--data-dir <dir>', 'where per-site data is stored (default: ./data)')
    .option('--screenshots <mode>', 'off | on-failure | every-step | end-of-journey')
    .option('--full-page', 'take full-page screenshots')
    .option('--headed', 'run browsers headed')
    .option('--model <id>', 'LLM model id')
    .option('--max-pages <n>', 'max pages to crawl', num)
    .option('--max-depth <n>', 'max crawl depth', num)
    .option('--max-journeys <n>', 'max journeys to automate', num)
    .option('--include <pattern...>', 'only journeys matching these (substring or /regex/)')
    .option('--exclude <pattern...>', 'skip journeys matching these')
    .option('--heal-attempts <n>', 'max heal attempts per failing test', num)
    .option('--require-approval', 'only generate tests for journeys you approved');
}

function cliConfig(o: Record<string, unknown>): PartialConfig {
  return {
    dataDir: o.dataDir as string | undefined,
    screenshots: o.screenshots as Config['screenshots'] | undefined,
    fullPage: o.fullPage ? true : undefined,
    headless: o.headed ? false : undefined,
    model: o.model as string | undefined,
    maxPages: o.maxPages as number | undefined,
    maxDepth: o.maxDepth as number | undefined,
    maxJourneys: o.maxJourneys as number | undefined,
    include: o.include as string[] | undefined,
    exclude: o.exclude as string[] | undefined,
    healAttempts: o.healAttempts as number | undefined,
    requireApproval: o.requireApproval ? true : undefined,
  };
}

export function logEvent(e: ProgressEvent) {
  const tag = e.type === 'stage' ? '\n▶' : e.type === 'warn' ? '  !' : e.type === 'error' ? '  ✗' : e.type === 'done' ? '✔' : ' ';
  console.log(`${tag} ${e.message}`);
}

async function ctxFrom(o: Record<string, unknown>): Promise<Context> {
  const config = await loadConfig({ configFile: o.config as string | undefined, cli: cliConfig(o) });
  return createContext({ config, onProgress: logEvent });
}

function printJourneys(journeys: Journey[]) {
  for (const j of journeys) {
    console.log(`  [${j.status.padEnd(8)}] ${j.id}  (${j.priority}${j.rank ? `, rank ${j.rank}` : ''})\n      ${j.name} — ${j.goal}`);
    j.steps.forEach((s, i) => console.log(`        ${i + 1}. ${s}`));
  }
}
function printRun(r: RunRecord) {
  for (const t of r.results) console.log(`  ${t.status === 'passed' ? '✔' : '✗'} ${t.journeyId} [${t.status}] ${t.durationMs}ms${t.error ? `\n      ${t.error.split('\n')[0]}` : ''}`);
}

function editJourneys(store: Store, site: string, journeys: Journey[]): Journey[] {
  const tmp = path.join(os.tmpdir(), `journeys-${site}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(journeys, null, 2));
  try {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const r = spawnSync(`${editor} "${tmp}"`, { stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error(`Editor exited with status ${r.status}`);
    const edited = parseJourneys(JSON.parse(fs.readFileSync(tmp, 'utf8')));
    store.saveJourneys(site, edited);
    return edited;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + '.bak', { force: true });
  }
}

export function buildProgram(setExit: (code: number) => void): Command {
  const program = new Command('agentic-e2e').description('LLM-driven E2E test discovery, generation and self-healing on Playwright').exitOverride();
  program.configureOutput({ writeErr: (s) => process.stderr.write(s) });

  addCommon(program.command('discover <url>').description('crawl a site and propose + select user journeys'))
    .option('--rediscover', 'ignore stored journeys and discover again')
    .action(async (url: string, o) => {
      normalizeSite(url);
      const d = await discover(await ctxFrom(o), url, { rediscover: o.rediscover });
      console.log(`\nSite ${d.site}: ${d.journeys.length} journeys${d.reused ? ' (stored)' : ''}`);
      printJourneys(d.journeys);
    });

  addCommon(program.command('journeys <url>').description('show, approve, reject or edit stored journeys'))
    .option('--approve <ids...>', 'approve journeys by id')
    .option('--reject <ids...>', 'reject journeys by id')
    .option('--approve-all', 'approve every non-rejected journey')
    .option('--edit', 'edit journeys.json in $EDITOR (validated on save)')
    .action(async (url: string, o) => {
      const site = normalizeSite(url).id;
      const config = await loadConfig({ configFile: o.config, cli: cliConfig(o) });
      const store = new Store(config.dataDir);
      let journeys = store.loadJourneys(site);
      if (!journeys) throw new Error(`No journeys stored for ${site}. Run: agentic-e2e discover ${url}`);
      if (o.approve) journeys = setStatus(journeys, o.approve, 'approved');
      if (o.reject) journeys = setStatus(journeys, o.reject, 'rejected');
      if (o.approveAll) journeys = journeys.map((j) => (j.status === 'rejected' ? j : { ...j, status: 'approved' as const }));
      if (o.approve || o.reject || o.approveAll) store.saveJourneys(site, journeys);
      if (o.edit) journeys = editJourneys(store, site, journeys);
      printJourneys(journeys);
    });

  addCommon(program.command('generate <url>').description('generate Playwright specs for selected/approved journeys'))
    .option('--rediscover', 'discover journeys again first')
    .option('--regenerate', 'regenerate code even if stored')
    .action(async (url: string, o) => {
      normalizeSite(url);
      const g = await generate(await ctxFrom(o), url, { regenerate: o.regenerate, rediscover: o.rediscover });
      console.log(`\nGenerated: ${g.result.generated.join(', ') || '-'} | reused: ${g.result.skipped.join(', ') || '-'} | failed: ${g.result.failed.map((f) => f.id).join(', ') || '-'}`);
      if (g.result.failed.length) setExit(1);
    });

  addCommon(program.command('run <url>').description('run stored tests'))
    .option('--journey <ids...>', 'only these journey ids')
    .action(async (url: string, o) => {
      normalizeSite(url);
      const r = await run(await ctxFrom(o), url, { journeyIds: o.journey });
      printRun(r);
      if (r.results.some((t) => t.status !== 'passed')) setExit(1);
    });

  addCommon(program.command('heal <url>').description('run tests and self-heal the failing ones'))
    .option('--journey <ids...>', 'only these journey ids')
    .action(async (url: string, o) => {
      normalizeSite(url);
      const ctx = await ctxFrom(o);
      const r = await run(ctx, url, { journeyIds: o.journey });
      printRun(r);
      const heals = await heal(ctx, url, r);
      for (const h of heals) console.log(`  ${h.journeyId}: ${h.outcome} — ${h.reason}`);
      if (heals.some((h) => h.outcome !== 'healed' && h.outcome !== 'flaky_or_environment')) setExit(1);
    });

  addCommon(program.command('all <url>').description('discover → select → generate → run → heal'))
    .option('--rediscover', 'ignore stored journeys and discover again')
    .option('--regenerate', 'regenerate code even if stored')
    .action(async (url: string, o) => {
      normalizeSite(url);
      const r = await runAll(await ctxFrom(o), url, { rediscover: o.rediscover, regenerate: o.regenerate });
      console.log('\nFinal:');
      for (const f of r.final) console.log(`  ${f.status === 'passed' ? '✔' : '✗'} ${f.journeyId} ${f.status}${f.healed ? ' (healed)' : ''}`);
      if (r.final.some((f) => f.status !== 'passed')) setExit(1);
    });

  program.command('list').description('list known sites').option('--data-dir <dir>').option('--config <file>').action(async (o) => {
    const config = await loadConfig({ configFile: o.config, cli: { dataDir: o.dataDir } });
    const store = new Store(config.dataDir);
    const sites = store.listSites();
    if (!sites.length) return console.log(`No sites yet in ${config.dataDir}`);
    for (const s of sites) {
      const runs = store.listRuns(s.id);
      const last = runs.at(-1);
      console.log(`${s.id}  journeys=${store.loadJourneys(s.id)?.length ?? 0} tests=${store.listTests(s.id).length} runs=${runs.length}${last ? ` last=${last.results.filter((r) => r.status === 'passed').length}/${last.results.length} passed` : ''}`);
    }
  });

  addCommon(program.command('serve').description('start the web UI + REST API'))
    .option('--port <n>', 'port', num, 4173)
    .option('--host <host>', 'bind address (default 127.0.0.1; the server executes generated tests — do not expose publicly)', '127.0.0.1')
    .action(async (o) => {
      const config = await loadConfig({ configFile: o.config, cli: cliConfig(o) });
      const { startServer } = await import('../server/index.js');
      const { url } = await startServer({ config, port: o.port, host: o.host });
      console.log(`agentic-e2e UI: ${url}`);
      await new Promise(() => {}); // run until killed
    });

  return program;
}

export async function main(argv: string[]): Promise<number> {
  let exit = 0;
  const program = buildProgram((c) => { exit = c; });
  try {
    await program.parseAsync(argv);
    return exit;
  } catch (e) {
    const err = e as { code?: string; exitCode?: number; message: string };
    if (err.code?.startsWith('commander.')) return err.exitCode ?? 1;
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv).then((c) => process.exit(c));
}
