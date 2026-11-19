import type { Command } from 'commander';
import type { Config, PartialConfig } from '../core/config.js';
import { applyTagEdits } from '../core/scale/tags.js';
import type { Journey } from '../core/types.js';

/** SPEC-012: CLI flags for execution at scale (kept out of index.ts so it stays small). */
const num = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return n;
};
const workers = (v: string) => (v.endsWith('%') ? v : num(v));

export function addScaleOptions(cmd: Command): Command {
  return cmd
    .option('--browser <names...>', 'browsers to run on: chromium | firefox | webkit (default: chromium)')
    .option('--device <names...>', "Playwright device presets to emulate, e.g. 'iPhone 15' 'Pixel 7'")
    .option('--workers <n>', 'parallel workers (number or percentage like 50%)', workers)
    .option(
      '--retries <n>',
      'retry failing tests up to n times (run/heal/all: Playwright retries; ci: separate retry runs without the LLM, passing on retry = flaky)',
      num,
    )
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

/** FR-15: tag editing on the existing `journeys <url>` command. */
export function addJourneyTagOptions(cmd: Command): Command {
  return cmd
    .option('--add-tags <id=tags...>', "add tags, e.g. checkout=critical,smoke ('*' = every journey)")
    .option('--remove-tags <id=tags...>', 'remove tags, e.g. checkout=regression')
    .option('--set-tags <id=tags...>', "replace tags, e.g. '*=regression' home=smoke,critical");
}

/** Returns the edited journeys, or null when no tag option was given. */
export function applyJourneyTagOptions(journeys: Journey[], o: Record<string, unknown>): Journey[] | null {
  const add = o.addTags as string[] | undefined,
    remove = o.removeTags as string[] | undefined,
    set = o.setTags as string[] | undefined;
  return add || remove || set ? applyTagEdits(journeys, { add, remove, set }) : null;
}
