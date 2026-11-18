# SPEC-012: Execution at scale (browsers/devices, workers/retries/sharding, environments, tags, timeouts, trace/video)

- **Status:** Implemented (v0.12)
- **Depends on:** SPEC-001 (runner, storage, pipeline), SPEC-007 (`listTestCases`), SPEC-008 (heal selection), SPEC-009 (auth + secret handling)
- **Stack:** new `src/core/scale/{options,targets,environments,tags,shard,results}.ts`, `src/cli/scale.ts`; minimal edits to `config`, `types`, `journeys`, `planner`, `runner`, `support`, `pipeline`, `test-cases`, `heal-selection`, `src/cli/index.ts`, `src/server/{app,jobs}.ts`, README

## 1. Problem / gaps found in the current code (d640cd7)

| # | Gap |
|---|-----|
| G-1 | `runner.ts` hard-codes one browser (default chromium, viewport 1280×800); no Firefox/WebKit, no device presets. |
| G-2 | `workers: 2` and `retries: 0` are hard-coded in the generated Playwright config; no sharding at all. |
| G-3 | The base URL is always the origin of the `<url>` argument, so stored journeys cannot be pointed at dev/staging/prod; no per-environment HTTP headers; no notion of a read-only environment. |
| G-4 | `Journey.tags` exists but the planner leaves it empty, nothing filters on it, and there is no command to edit tags (only `journeys --edit` of the whole JSON). |
| G-5 | No `--grep`/`--tag` filter on `run`, `heal` or `list-test-cases`. |
| G-6 | Only one per-test timeout (`testTimeoutMs`, not exposed on the CLI); no global run timeout; no per-journey override. |
| G-7 | Trace is hard-coded to `retain-on-failure` (off in auth mode); video is never recorded. |
| G-8 | `TestResult` has no browser/device/env; the runner keeps only `sp.tests[0]` of the JSON report, so with several projects results would be lost or overwritten. `_support.ts` writes screenshots and failure dumps per journey only, so two projects would clobber each other. |
| G-9 | `listTestCases`' "latest outcome" takes the last result per journey id, regardless of environment/browser; the healer takes `results[0]` of a re-run; `runAll().final` maps one result per journey. All break with several results per journey. |
| G-10 | `/api/config` returns the whole public config; job `options` accept every config key — environment header values (which may be tokens) must never be returned or accepted from web clients. |

## 2. Non-goals

- Web UI controls for browsers/envs/tags (the REST job API accepts the new options; UI work is a follow-up).
- Distributing shards across machines (we only select the shard's tests; orchestration is the CI's job).
- Installing browsers (`npx playwright install firefox webkit` stays a user step; a missing browser surfaces as the Playwright error).

## 3. Functional requirements

### 3.1 Browsers and devices

| ID | Requirement |
|----|-------------|
| FR-1 | Config `browsers: ('chromium'\|'firefox'\|'webkit')[]` and `devices: string[]` (Playwright device preset names, e.g. `iPhone 15`, `Pixel 7`); CLI `--browser <names...>`, `--device <names...>`. |
| FR-2 | Targets = browsers ∪ devices, in that order, de-duplicated. When neither is set the single target is `chromium` (unchanged behaviour). |
| FR-3 | An unknown browser or device name is a configuration error before anything runs; the message lists valid browsers / suggests close device names. |
| FR-4 | Each target is one Playwright project (`name` = browser or device name, `use` = `{ browserName }` + 1280×800 viewport, or the device preset). In auth mode each target is split into `<target>` (public) and `<target> [auth]` (storageState) projects. |

### 3.2 Workers, retries, sharding

| ID | Requirement |
|----|-------------|
| FR-5 | Config `workers` (positive int or `"N%"`, default 2) and `retries` (int 0..10, default 0; the key is shared with SPEC-011); CLI `--workers`, `--retries`. For `run`/`heal`/`all`, `retries` is Playwright's in-run retries. `ci` (SPEC-011) keeps its own separate `retry` runs and runs Playwright with 0 retries, so attempts never multiply. Heal verification re-runs always use 0 Playwright retries (a candidate fix must pass on its own). Retry and heal re-runs are never sharded. |
| FR-6 | Config/CLI `shard` = `"i/n"` (1 ≤ i ≤ n). The sorted list of test ids is split into n contiguous near-equal chunks and only chunk i runs (each on every target). Invalid values are errors; an empty shard runs nothing and is not an error (returns an empty run, not stored). |
| FR-7 | With retries, the result is the last attempt; `retries` (attempts − 1) and `flaky: true` (passed after a failed attempt) are recorded per result. |

### 3.3 Environments

| ID | Requirement |
|----|-------------|
| FR-8 | Config `environments: { <name>: { baseUrl, headers?, readOnly? } }` and `env` (CLI `--env <name>`, env var `AGENTIC_E2E_ENV`). Unknown env name → error listing env names. |
| FR-9 | With an env selected, `run`/`heal`/`all`'s run step use the env `baseUrl` for the stored journeys of the `<url>` site (site id and stored data still come from `<url>`). Without one, behaviour is unchanged. |
| FR-10 | `headers` become Playwright `extraHTTPHeaders`; tracing is forced off while env headers are sent (traces record request headers). Values may contain `${VAR}` (resolved from the environment when the env is used; unset → error naming the variable on the CLI, generic message to web clients). Header values are never written to disk (passed to the test process in an env var, not in `playwright.config.mjs`), are added to the redactor, and never appear in logs/progress/run records/API responses. |
| FR-11 | `readOnly` defaults to `true` for envs named `prod`/`production` (case-insensitive), else `false`. In a read-only env destructive journeys are skipped with a `warn` progress event and are not part of the run. |
| FR-12 | A journey is destructive when its tags include `destructive`; tags including `read-only` make it non-destructive; otherwise a heuristic on name/goal/steps (delete/remove/cancel subscription/deactivate/unsubscribe/purchase/pay/checkout/place order/refund/transfer/log out…) decides. |
| FR-13 | In auth mode with an env whose host differs from `<url>`, the login session is resolved for the env host (credentials file entry of that host). |

### 3.4 Tags, suites and filters

| ID | Requirement |
|----|-------------|
| FR-14 | Suite tags are `smoke`, `regression`, `critical`. The planner prompt asks the LLM for suite tags and `destructive`; after parsing, tags are lower-cased/de-duplicated and, when no suite tag was given, defaults are added by priority: high → `smoke, critical, regression`; medium/low → `regression`. |
| FR-15 | Tags are edited with the existing `journeys <url>` command: `--add-tags <id=tag,tag...>`, `--remove-tags <id=tag,...>`, `--set-tags <id=tag,...>` (`*` = every journey; repeatable / several pairs). Unknown ids and invalid tags (`/^[a-z0-9][a-z0-9_-]*$/` after lower-casing) are errors and nothing is saved. The journeys listing shows each journey's tags. In the web UI the journeys tab has an editable comma-separated tags field (saved via `PUT /api/sites/:site/journeys`, which normalises tags: lower-case, de-duplicated, invalid dropped); the tests tab shows tags. |
| FR-16 | `--grep <pattern>` (substring, case-insensitive, or `/regex/flags`) on `id name tags`, and `--tag <tags...>` (journey has any of them) filter `run`, `heal` and `list-test-cases` (config keys `grep`, `tag`). Filters combine (AND) with explicit ids. A filter that matches nothing is an error for run/heal and an empty listing for `list-test-cases`. |

### 3.5 Timeouts, trace, video

| ID | Requirement |
|----|-------------|
| FR-17 | `testTimeoutMs` (CLI `--timeout <ms>`) is the per-test timeout; optional `Journey.timeoutMs` overrides it for that journey (applied by `_support.ts`); `globalTimeoutMs` (CLI `--global-timeout <ms>`) becomes Playwright `globalTimeout`, and the runner's kill timer respects it. |
| FR-18 | Config `trace` / `video` ∈ `off \| on \| on-failure \| retain-on-failure` (CLI `--trace`, `--video`). Mapping to Playwright: trace `on-failure` → `retain-on-first-failure`, video `on-failure` → `retain-on-failure`; others identical. Defaults: trace `retain-on-failure` (unchanged), video `off`. |
| FR-19 | SPEC-009 preserved: in auth mode trace **and** video are forced off (with an info event if they were requested), because traces/videos capture typed values and cookies. |
| FR-20 | The video path is recorded per result (`videoPath`) and served by the files API (`video/webm`). |

### 3.6 Results, storage, history

| ID | Requirement |
|----|-------------|
| FR-21 | Every `TestResult` records `project`, `browser`, `device?` and `env?`; `RunRecord` records `env?`, `baseUrl`, `targets`, `workers`, `retries`, `shard?`, and the filters used. One result per (journey, project). Screenshots / failure dumps are stored per project when more than one project runs. |
| FR-22 | Healing heals each journey once (first failing result), and a re-run counts as passed only when every project of that journey passed. `runAll().final` has one entry per journey (failed if any project failed). |
| FR-25 | SPEC-011 integration: `ci` tracks each journey × project; a journey is failing (retried, reported, exit 1) while any project fails. Reports (JUnit/JSON/HTML) have one row per journey × project, with attempts matched per project, `project`/`browser`/`device`/`env` on the row, and ` [project]` in the name when several targets ran. Flaky detection (`detectFlaky`, used by reports, the CI summary and listings) sees one aggregated result per journey and run, so a stable browser-specific failure is not flaky. |
| FR-23 | `listTestCases` reports per test `tags` and `targets` (latest outcome per env × project); `lastRun` aggregates the latest run containing the test (failed if any project failed). `list-test-cases --env <name>` and heal `--failed --env <name>` consider only runs of that env. |
| FR-24 | Web clients cannot set `environments`: the key is ignored in job options (the UI round-trips `/api/config`); they pick one by name with `env`; `/api/config` returns environments as `{ baseUrl, readOnly, headers: <header names> }` without values. |

## 4. Acceptance criteria

- **AC-1** Given no browsers/devices, When targets resolve, Then they are `[chromium]`. Given `browsers: [firefox]` and `devices: ['iPhone 15']`, Then targets are `firefox` and `iPhone 15` (webkit) and the generated Playwright config has one project per target.
- **AC-2** Given `--device 'iPhone 99'` or `--browser edge`, When config resolves for a run, Then it fails with an error naming the bad value before anything runs.
- **AC-3** Given auth mode and two targets, When projects are built, Then there are `<t>` and `<t> [auth]` projects for each target, only the auth ones carry storageState, and trace/video are `off`.
- **AC-4** Given `--workers 4 --retries 2`, When the Playwright config is generated, Then it has `workers: 4, retries: 2`; given `workers: '50%'` it is passed through; `workers: 0` / `retries: -1` are rejected.
- **AC-5** Given ids `a..e` and `--shard 2/2`, Then only `d, e` run; shards 1..n of any list are disjoint and cover it; `0/2`, `3/2`, `x` are errors.
- **AC-6** Given a test that fails once then passes with `retries: 1`, When run, Then the result is `passed` with `retries: 1, flaky: true`.
- **AC-7** Given `environments.staging.baseUrl` pointing at a fixture server and stored tests for another site URL, When `run <url> --env staging`, Then the tests hit the staging server, and results/run record carry `env: 'staging'` and the staging `baseUrl`.
- **AC-8** Given env headers `{ 'x-env-token': '${TOKEN}' }` with `TOKEN=s3cr3t-token`, When the run executes, Then the server receives the header, and `s3cr3t-token` appears in no file under the data dir and in no progress event; with `TOKEN` unset the run fails naming `TOKEN` and the web error does not.
- **AC-9** Given env `prod` (no explicit readOnly) and journeys `browse` and `delete-account` (heuristic) and `buy` (tag `destructive`), When `run --env prod`, Then only `browse` runs and a warn event names each skipped journey; with `readOnly: false` all run.
- **AC-10** Given the planner returns a high-priority journey without tags and a low-priority one tagged `Smoke`, Then the first gets `smoke, critical, regression` and the second `smoke`.
- **AC-11** Given stored journeys, When `journeys <url> --add-tags a=critical --remove-tags a=regression`, Then only `a` changes and is persisted and the listing shows its tags; `--add-tags zz=x` fails listing valid ids; `--add-tags 'a=Bad Tag'` / `a=!!` fail; `--set-tags '*=smoke'` sets every journey; `PUT /api/sites/:site/journeys` with tags `[' Smoke ', 'smoke']` stores `['smoke']`.
- **AC-12** Given journeys tagged `smoke`/`regression`, When `run --tag smoke` / `--grep checkout` / `list-test-cases --tag smoke`, Then only matching tests run/are listed; a filter with no match fails for run/heal.
- **AC-13** Given `globalTimeoutMs: 60000`, `testTimeoutMs: 5000` and a journey with `timeoutMs: 1000` whose test waits 3 s, Then the config has `timeout: 5000, globalTimeout: 60000` and the journey's test times out.
- **AC-14** Given `trace: 'on-failure', video: 'retain-on-failure'`, Then the config `use` has `trace: 'retain-on-first-failure', video: 'retain-on-failure'`; a failing test records `videoPath`.
- **AC-15** Given two projects (`chromium`, `Pixel 7`), When a run with a failing test completes, Then there are two results for that journey with distinct `project`, failure dumps do not overwrite each other, and the stored run record keeps both.
- **AC-16** Given a run in which journey `x` failed only on `firefox`, When healing, Then `x` is healed once, and `runAll().final` reports `x` failed (single entry).
- **AC-17** Given a failing staging run and a later passing dev run of `x`, When `list-test-cases --env staging`, Then `x`'s last outcome is `failed`; without `--env` it is `passed`; `targets` lists both env×project entries.
- **AC-18** Given a job request with `options.environments`, Then it is ignored and the server's environments are used; `GET /api/config` never contains a header value.
- **AC-20** Given env headers with short/boolean values (`true`, `123`), When a run with a failing test completes, Then `report.json` and the failure dump still parse (header values are redacted value-by-value in JSON, never in the raw text).
- **AC-21** Given a web job with an unknown `env`/device, an invalid shard or an unset header `${VAR}`, Then `POST /api/jobs` returns 400 (no variable name in the body) and a later job for the same site is accepted (no job stuck in `running`).
- **AC-22** Given `a` fails on chromium only and `ci --retries 1`, Then `ci` re-runs `a` in a `retry` run with Playwright retries 0 and exits 1; a report over two projects has one row per project with attempts counted per project.
- **AC-19** All previous tests pass; `pnpm typecheck` passes.
