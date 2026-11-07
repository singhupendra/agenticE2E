import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageRoot } from './paths.js';
import type { Store } from './storage.js';
import type { FailureSnapshot, ProgressFn, RunRecord, ScreenshotMode, TestResult } from './types.js';

export interface RunOptions {
  site: string;
  baseUrl: string;
  journeyIds?: string[];
  screenshots: ScreenshotMode;
  fullPage: boolean;
  headless: boolean;
  testTimeoutMs: number;
  kind?: RunRecord['kind'];
  onProgress?: ProgressFn;
}

const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LANGUAGE|TZ|SystemRoot|SYSTEMROOT|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_[A-Z_]+|LC_[A-Z_]+|PLAYWRIGHT_[A-Z_]+|DISPLAY)$/;

/**
 * Minimal environment for the test subprocess. Generated specs are LLM output derived from untrusted
 * page content, so secrets such as ANTHROPIC_API_KEY must never reach them.
 */
export function buildRunnerEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && ENV_ALLOW.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface PwResult { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[]; attachments?: { name: string; path?: string }[] }
interface PwSpec { file: string; tests: { results: PwResult[] }[] }
interface PwSuite { file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { suites?: PwSuite[]; errors?: { message?: string }[] }

function* specs(s: PwSuite): Generator<PwSpec> {
  for (const sp of s.specs ?? []) yield sp;
  for (const c of s.suites ?? []) yield* specs(c);
}

function listPngs(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f)) : [];
}

/** Run generated tests through the real Playwright Test runner and collect structured results. */
export async function runTests(store: Store, opts: RunOptions): Promise<RunRecord> {
  const ids = opts.journeyIds ?? store.listTests(opts.site);
  if (!ids.length) throw new Error(`No tests to run for site ${opts.site}. Generate tests first.`);
  for (const id of ids) if (!store.hasTest(opts.site, id)) throw new Error(`No stored test for journey "${id}"`);
  store.ensureSite(opts.site);

  const startedAt = new Date().toISOString();
  const run = store.createRun(opts.site);
  const siteDir = store.siteDir(opts.site);
  const artifacts = path.join(run.dir, 'artifacts');
  const failuresDir = path.join(run.dir, 'failures');
  const jsonFile = path.join(run.dir, 'report.json');
  const configFile = path.join(run.dir, 'playwright.config.mjs');
  const rootDir = packageRoot();

  fs.writeFileSync(configFile, `export default ${JSON.stringify({
    testDir: store.testsDir(opts.site),
    testMatch: '**/*.spec.ts',
    outputDir: artifacts,
    timeout: opts.testTimeoutMs,
    retries: 0,
    expect: { timeout: Math.round(opts.testTimeoutMs / 3) },
    workers: 2,
    reporter: [['json', { outputFile: jsonFile }]],
    use: { baseURL: opts.baseUrl, headless: opts.headless, trace: 'retain-on-failure', actionTimeout: Math.round(opts.testTimeoutMs / 3), navigationTimeout: Math.round(opts.testTimeoutMs / 2), viewport: { width: 1280, height: 800 } },
  }, null, 2)};\n`);

  const cli = createRequire(path.join(rootDir, 'package.json')).resolve('@playwright/test/cli');
  const filters = ids.map((id) => `/${esc(id)}\\.spec\\.ts$`);
  opts.onProgress?.({ type: 'info', stage: 'run', message: `Running ${ids.length} test(s) (screenshots: ${opts.screenshots})` });

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', '-c', configFile, ...filters], {
      cwd: rootDir,
      env: buildRunnerEnv(process.env, {
        NODE_PATH: path.join(rootDir, 'node_modules'),
        AGENTIC_E2E_SCREENSHOTS: opts.screenshots,
        AGENTIC_E2E_FULL_PAGE: String(opts.fullPage),
        AGENTIC_E2E_SHOT_DIR: run.screenshotsDir,
        AGENTIC_E2E_FAILURE_DIR: failuresDir,
        FORCE_COLOR: '0',
        CI: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), ids.length * opts.testTimeoutMs + 120_000);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  fs.writeFileSync(path.join(run.dir, 'output.log'), output);

  let report: PwReport = {};
  if (fs.existsSync(jsonFile)) {
    try { report = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as PwReport; } catch { /* handled below */ }
  }
  const rel = (p: string) => path.relative(siteDir, p);
  const byId = new Map<string, TestResult>();
  for (const suite of report.suites ?? []) {
    for (const sp of specs(suite)) {
      const id = path.basename(sp.file).replace(/\.spec\.ts$/, '');
      const res = sp.tests[0]?.results.at(-1);
      if (!res || !ids.includes(id)) continue;
      const status = res.status === 'passed' ? 'passed' : res.status === 'skipped' ? 'skipped' : res.status === 'timedOut' ? 'timedOut' : 'failed';
      const err = (res.error?.message ?? res.errors?.[0]?.message ?? '').replace(ANSI, '');
      const trace = res.attachments?.find((a) => a.name === 'trace' && a.path)?.path;
      let failure: FailureSnapshot | undefined;
      const fj = path.join(failuresDir, `${id}.json`);
      if (status !== 'passed' && fs.existsSync(fj)) {
        const f = JSON.parse(fs.readFileSync(fj, 'utf8')) as FailureSnapshot;
        failure = { ...f, screenshot: f.screenshot ? rel(f.screenshot) : undefined };
      }
      byId.set(id, {
        journeyId: id, file: `tests/${id}.spec.ts`, status, durationMs: res.duration,
        error: status === 'passed' ? undefined : err || undefined,
        tracePath: trace ? rel(trace) : undefined,
        screenshots: listPngs(path.join(run.screenshotsDir, id)).map(rel),
        failure,
      });
    }
  }
  const topErrors = (report.errors ?? []).map((e) => (e.message ?? '').replace(ANSI, '')).filter(Boolean);
  for (const id of ids) {
    if (byId.has(id)) continue;
    const mine = topErrors.filter((m) => m.includes(`${id}.spec.ts`));
    const error = (mine.length ? mine : topErrors).join('\n') || output.replace(ANSI, '').slice(-2000) || 'Test did not produce a result';
    byId.set(id, { journeyId: id, file: `tests/${id}.spec.ts`, status: 'failed', durationMs: 0, error, screenshots: [] });
  }

  const record: RunRecord = {
    id: run.id, kind: opts.kind ?? 'run', startedAt, finishedAt: new Date().toISOString(),
    screenshots: opts.screenshots, fullPage: opts.fullPage, results: ids.map((id) => byId.get(id)!),
  };
  store.saveRun(opts.site, record);
  const passed = record.results.filter((r) => r.status === 'passed').length;
  opts.onProgress?.({ type: 'info', stage: 'run', message: `Run ${run.id}: ${passed}/${record.results.length} passed` });
  return record;
}
