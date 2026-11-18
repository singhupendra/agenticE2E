import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { packageRoot } from './paths.js';
import { Redactor } from './redact.js';
import type { Store } from './storage.js';
import type { FailureSnapshot, ProgressFn, RunRecord, ScreenshotMode, TestResult } from './types.js';
import type { ArtifactPolicy } from './scale/options.js';
import { artifactPolicy, buildProjects, projectDir, resolveTargets, type Target } from './scale/targets.js';

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
  /**
   * SPEC-009: tests in `journeyIds` run in a Playwright project with this storageState; `env` (E2E_USERNAME/E2E_PASSWORD)
   * is injected into the test process. Tracing is off because traces embed cookies and typed values.
   */
  auth?: { storageState: string; env: Record<string, string>; journeyIds: string[] };
  /** SPEC-012: browsers/devices (default: chromium), parallelism, retries, timeouts, artifacts. */
  targets?: Target[];
  workers?: number | string;
  retries?: number;
  globalTimeoutMs?: number;
  journeyTimeouts?: Record<string, number>;
  trace?: ArtifactPolicy;
  video?: ArtifactPolicy;
  /** SPEC-012: environment the run targets. `headers` are secrets: passed via an env var, never written to disk. */
  env?: { name: string; baseUrl: string; headers: Record<string, string> };
  /** SPEC-012: recorded on the run record as is */
  meta?: Pick<RunRecord, 'shard' | 'filters'>;
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

// eslint-disable-next-line no-control-regex -- matching the ESC byte of ANSI colour codes is the point
const ANSI = /\u001b\[[0-9;]*m/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface PwResult { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[]; attachments?: { name: string; path?: string }[] }
interface PwTest { projectName?: string; status?: string; results: PwResult[] }
interface PwSpec { file: string; tests: PwTest[] }
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

  const targets = opts.targets?.length ? opts.targets : resolveTargets({});
  const { projects, meta, projectsFor } = buildProjects({ targets, ids, auth: opts.auth });
  const perProject = targets.length > 1;
  const retries = opts.retries ?? 0;
  const auth = !!opts.auth;
  // Traces record request headers: with env headers (secrets) they are off, like logged-in runs (SPEC-009).
  const headerValues = Object.values(opts.env?.headers ?? {});
  const trace = artifactPolicy('trace', opts.trace ?? 'retain-on-failure', auth || headerValues.length > 0);
  if (!auth && headerValues.length && opts.trace !== 'off') opts.onProgress?.({ type: 'info', stage: 'run', message: `Tracing is off: environment "${opts.env!.name}" sends custom headers, which traces would record` });
  // The JSON report embeds the resolved config (incl. extraHTTPHeaders): scrub header values from everything we persist.
  // JSON is scrubbed value by value (never the raw text), so a short header value like `true` cannot corrupt it.
  const headerRedactor = new Redactor(headerValues.map((value) => ({ value, placeholder: '[env header]' })));
  const scrub = (x: string) => headerRedactor.redact(store.redact(x));
  const scrubJson = (raw: string): string => {
    const redacted = store.redact(raw);
    if (!headerRedactor.size) return redacted;
    try { return JSON.stringify(headerRedactor.redactDeep(JSON.parse(redacted)), null, 2); } catch { return headerRedactor.redact(redacted); }
  };
  const video = artifactPolicy('video', opts.video ?? 'off', auth);
  if (auth && ((opts.trace && opts.trace !== 'off') || (opts.video && opts.video !== 'off'))) {
    opts.onProgress?.({ type: 'info', stage: 'run', message: 'Trace and video recording are off for logged-in runs (they capture typed values and cookies)' });
  }
  const pwConfig = {
    testDir: store.testsDir(opts.site),
    testMatch: '**/*.spec.ts',
    projects,
    outputDir: artifacts,
    timeout: opts.testTimeoutMs,
    ...(opts.globalTimeoutMs ? { globalTimeout: opts.globalTimeoutMs } : {}),
    retries,
    expect: { timeout: Math.round(opts.testTimeoutMs / 3) },
    workers: opts.workers ?? 2,
    reporter: [['json', { outputFile: jsonFile }]],
    use: { baseURL: opts.baseUrl, headless: opts.headless, trace, video, actionTimeout: Math.round(opts.testTimeoutMs / 3), navigationTimeout: Math.round(opts.testTimeoutMs / 2) },
  };
  // Header values (SPEC-012 FR-10) come from the environment of the test process, so they never land in this file.
  fs.writeFileSync(configFile, `const config = ${JSON.stringify(pwConfig, null, 2)};\nconfig.use.extraHTTPHeaders = JSON.parse(process.env.AGENTIC_E2E_HTTP_HEADERS || '{}');\nexport default config;\n`);

  const cli = createRequire(path.join(rootDir, 'package.json')).resolve('@playwright/test/cli');
  const filters = ids.map((id) => `/${esc(id)}\\.spec\\.ts$`);
  opts.onProgress?.({ type: 'info', stage: 'run', message: `Running ${ids.length} test(s) on ${targets.map((t) => t.name).join(', ')}${opts.env ? ` against ${opts.env.name}` : ''} (screenshots: ${opts.screenshots}, workers: ${pwConfig.workers}, retries: ${retries})` });

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
        ...(perProject ? { AGENTIC_E2E_PER_PROJECT: '1' } : {}),
        ...(opts.journeyTimeouts && Object.keys(opts.journeyTimeouts).length ? { AGENTIC_E2E_TIMEOUTS: JSON.stringify(opts.journeyTimeouts) } : {}),
        ...(opts.env && Object.keys(opts.env.headers).length ? { AGENTIC_E2E_HTTP_HEADERS: JSON.stringify(opts.env.headers) } : {}),
        ...(opts.auth?.env ?? {}),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    const perTest = ids.reduce((sum, id) => sum + (opts.journeyTimeouts?.[id] ?? opts.testTimeoutMs), 0);
    const budget = perTest * projects.length * (retries + 1) + 120_000;
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.globalTimeoutMs ? Math.min(budget, opts.globalTimeoutMs + 60_000) : budget);
    child.on('error', reject);
    child.on('close', () => { clearTimeout(timer); resolve(buf); });
  });
  const redactedOutput = scrub(output);
  fs.writeFileSync(path.join(run.dir, 'output.log'), redactedOutput);

  let report: PwReport = {};
  if (fs.existsSync(jsonFile)) {
    try {
      const raw = scrubJson(fs.readFileSync(jsonFile, 'utf8'));
      fs.writeFileSync(jsonFile, raw);
      report = JSON.parse(raw) as PwReport;
    } catch { /* handled below */ }
  }
  const rel = (p: string) => path.relative(siteDir, p);
  const resultKey = (id: string, project: string) => `${id}\u0000${project}`;
  const byKey = new Map<string, TestResult>();
  const describe = (project: string) => {
    const t = meta[project]?.target;
    return { project, browser: t?.browser ?? 'chromium', ...(t?.device ? { device: t.device } : {}), ...(opts.env ? { env: opts.env.name } : {}) };
  };
  for (const suite of report.suites ?? []) {
    for (const sp of specs(suite)) {
      const id = path.basename(sp.file).replace(/\.spec\.ts$/, '');
      if (!ids.includes(id)) continue;
      for (const t of sp.tests) {
        const project = t.projectName ?? targets[0].name;
        const res = t.results.at(-1);
        if (!res) continue;
        const sub = perProject ? projectDir(project) : '';
        const status = res.status === 'passed' ? 'passed' : res.status === 'skipped' ? 'skipped' : res.status === 'timedOut' ? 'timedOut' : 'failed';
        const err = (res.error?.message ?? res.errors?.[0]?.message ?? '').replace(ANSI, '');
        const trace = res.attachments?.find((a) => a.name === 'trace' && a.path)?.path;
        const videoFile = res.attachments?.find((a) => a.name === 'video' && a.path)?.path;
        let failure: FailureSnapshot | undefined;
        const fj = path.join(failuresDir, sub, `${id}.json`);
        if (status !== 'passed' && fs.existsSync(fj)) {
          try {
            const rawFailure = scrubJson(fs.readFileSync(fj, 'utf8'));
            fs.writeFileSync(fj, rawFailure);
            const f = JSON.parse(rawFailure) as FailureSnapshot;
            failure = { ...f, screenshot: f.screenshot ? rel(f.screenshot) : undefined };
          } catch { /* unreadable dump: report the failure without a snapshot */ }
        }
        byKey.set(resultKey(id, project), {
          journeyId: id, file: `tests/${id}.spec.ts`, status, durationMs: res.duration,
          error: status === 'passed' ? undefined : err || undefined,
          tracePath: trace ? rel(trace) : undefined,
          ...(videoFile && fs.existsSync(videoFile) ? { videoPath: rel(videoFile) } : {}),
          screenshots: listPngs(path.join(run.screenshotsDir, sub, id)).map(rel),
          failure,
          ...describe(project),
          ...(t.results.length > 1 ? { retries: t.results.length - 1 } : {}),
          ...(status === 'passed' && (t.status === 'flaky' || t.results.length > 1) ? { flaky: true } : {}),
        });
      }
    }
  }
  const topErrors = (report.errors ?? []).map((e) => (e.message ?? '').replace(ANSI, '')).filter(Boolean);
  const results: TestResult[] = [];
  for (const id of ids) {
    for (const project of projectsFor(id)) {
      const found = byKey.get(resultKey(id, project));
      if (found) { results.push(found); continue; }
      const mine = topErrors.filter((m) => m.includes(`${id}.spec.ts`));
      const error = (mine.length ? mine : topErrors).join('\n') || redactedOutput.replace(ANSI, '').slice(-2000) || 'Test did not produce a result';
      results.push({ journeyId: id, file: `tests/${id}.spec.ts`, status: 'failed', durationMs: 0, error, screenshots: [], ...describe(project) });
    }
  }

  const record: RunRecord = {
    id: run.id, kind: opts.kind ?? 'run', startedAt, finishedAt: new Date().toISOString(),
    screenshots: opts.screenshots, fullPage: opts.fullPage, results,
    ...(opts.env ? { env: opts.env.name } : {}),
    baseUrl: opts.baseUrl,
    targets: targets.map((t) => ({ name: t.name, browser: t.browser, ...(t.device ? { device: t.device } : {}) })),
    workers: pwConfig.workers, retries,
    ...(opts.meta?.shard ? { shard: opts.meta.shard } : {}),
    ...(opts.meta?.filters ? { filters: opts.meta.filters } : {}),
  };
  store.saveRun(opts.site, record);
  const passed = record.results.filter((r) => r.status === 'passed').length;
  opts.onProgress?.({ type: 'info', stage: 'run', message: `Run ${run.id}: ${passed}/${record.results.length} passed` });
  return record;
}
