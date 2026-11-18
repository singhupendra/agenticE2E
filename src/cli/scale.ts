import type { Command } from 'commander';
import { loadConfig, type Config, type PartialConfig } from '../core/config.js';
import { editTags } from '../core/scale/tags.js';
import { Store, normalizeSite } from '../core/storage.js';

/** SPEC-012: CLI flags for execution at scale (kept out of index.ts so it stays small). */
const num = (v: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`); return n; };
const workers = (v: string) => (v.endsWith('%') ? v : num(v));

export function addScaleOptions(cmd: Command): Command {
  return cmd
    .option('--browser <names...>', 'browsers to run on: chromium | firefox | webkit (default: chromium)')
    .option('--device <names...>', "Playwright device presets to emulate, e.g. 'iPhone 15' 'Pixel 7'")
    .option('--workers <n>', 'parallel workers (number or percentage like 50%)', workers)
    .option('--retries <n>', 'retries per failing test', num)
    .option('--shard <i/n>', 'run only shard i of n (journey-level, deterministic)')
    .option('--env <name>', 'environment from config "environments" (base URL + headers; prod is read-only)')
    .option('--grep <pattern>', 'only tests whose id, name or a tag matches (substring or /regex/)')
    .option('--tag <tags...>', 'only tests with any of these tags (e.g. smoke critical)')
    .option('--timeout <ms>', 'per-test timeout in ms', num)
    .option('--global-timeout <ms>', 'timeout for the whole run in ms (0 = none)', num)
    .option('--trace <mode>', 'off | on | on-failure | retain-on-failure')
    .option('--video <mode>', 'off | on | on-failure | retain-on-failure');
}

export function scaleCliConfig(o: Record<string, unknown>): PartialConfig {
  return {
    browsers: o.browser as Config['browsers'],
    devices: o.device as string[] | undefined,
    workers: o.workers as Config['workers'] | undefined,
    retries: o.retries as number | undefined,
    shard: o.shard as string | undefined,
    env: o.env as string | undefined,
    grep: o.grep as string | undefined,
    tag: o.tag as string[] | undefined,
    testTimeoutMs: o.timeout as number | undefined,
    globalTimeoutMs: o.globalTimeout as number | undefined,
    trace: o.trace as Config['trace'] | undefined,
    video: o.video as Config['video'] | undefined,
  };
}

export function registerScaleCommands(program: Command) {
  program.command('tags <url> [ids...]').description('show or edit journey tags (smoke, regression, critical, destructive, ...); no ids = all journeys')
    .option('--add <tags...>', 'add tags')
    .option('--remove <tags...>', 'remove tags')
    .option('--set <tags...>', 'replace tags')
    .option('--data-dir <dir>', 'where per-site data is stored (default: ./data)')
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .action(async (url: string, ids: string[], o) => {
      const site = normalizeSite(url).id;
      const config = await loadConfig({ configFile: o.config, cli: { dataDir: o.dataDir } });
      const store = new Store(config.dataDir);
      let journeys = store.loadJourneys(site);
      if (!journeys) throw new Error(`No journeys stored for ${site}. Run: agentic-e2e discover ${url}`);
      const edited = editTags(journeys, ids ?? [], { add: o.add, remove: o.remove, set: o.set }); // also validates ids
      if (o.add || o.remove || o.set) store.saveJourneys(site, (journeys = edited));
      const shown = ids?.length ? journeys.filter((j) => ids.includes(j.id)) : journeys;
      const w = Math.max(...shown.map((j) => j.id.length), 7);
      for (const j of shown) console.log(`${j.id.padEnd(w)}  ${j.tags.join(', ') || '-'}`);
    });
}
