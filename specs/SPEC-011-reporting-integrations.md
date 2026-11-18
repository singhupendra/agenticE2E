# SPEC-011: Reporting & CI integrations

- **Status:** Implemented (v0.11)
- **Depends on:** SPEC-001 (pipeline, runner, healer), SPEC-006 (heal records), SPEC-007 (`listTestCases`), SPEC-008 (`healSelected`), SPEC-009 (redaction / secret handling)
- **Stack:** `src/core/reporting/*` (new), `src/core/ci/*` (new), `src/cli/ci.ts` (new); minimal edits to `src/cli/index.ts`, `src/core/config.ts`, `src/core/types.ts`, `src/core/test-cases.ts`, README

## 1. Problem / gaps in the current code

Reviewed `runner.ts`, `pipeline.ts`, `healer.ts`, `storage.ts`, `test-cases.ts`, `cli/index.ts`:

| # | Gap |
|---|-----|
| G-1 | The only per-run artifacts are `result.json` (internal `RunRecord`), Playwright's raw `report.json` and `output.log`. There is no JUnit XML a CI system can ingest, no stable machine-readable summary, and no human-readable report. |
| G-2 | Heal outcomes and diffs live in a site-wide `heals.json`, disconnected from the run that triggered them; nothing joins run results + heal diffs + screenshots into one view outside the web UI. |
| G-3 | Exit codes are 0/1 only. A config error, an expired login, a missing API key and a failing test all exit 1, so a pipeline cannot tell "the app is broken" from "the tool is broken". |
| G-4 | There is no non-interactive CI entry point: `all` may discover/generate (LLM spend, non-deterministic), `journeys --edit` opens an editor, and `heal`/`all` rewrite specs on disk with no opt-in. |
| G-5 | No GitHub Actions job summary, no completion notifications (webhook / Slack). |
| G-6 | No flaky-test signal: the runner uses `retries: 0`, a `flaky_or_environment` heal verdict is not surfaced in listings, and run history is never analysed for alternating results. `list-test-cases` shows only the latest outcome. |
| G-7 | Error strings come from Playwright/LLM SDKs and may contain environment secrets (API keys, AWS keys, webhook URLs) that the SPEC-009 credential redactor does not know about. |

## 2. Non-goals

- Changing how tests are generated, run (Playwright config) or healed.
- Web UI / REST changes (reports are files; the server is untouched).
- Uploading reports anywhere (CI artifact upload is the pipeline's job).
- Storing webhook URLs in config files (env only, so they are never committed).

## 3. Functional requirements

### Report writers

| ID | Requirement |
|----|-------------|
| FR-1 | A pure builder `buildRunReport(input)` produces a `RunReport` (schemaVersion 1): site (`id`, `origin`), mode (`run`\|`heal`\|`all`\|`ci`), run (`id`, `kind`, `startedAt`, `finishedAt`, `durationMs`), totals (`tests`, `passed`, `failed`, `skipped`, `healed`, `flaky`), and per test: `journeyId`, `name`, `outcome` (`passed`\|`failed`\|`skipped`\|`healed`), `durationMs` (sum over attempts), `attempts`, `error` (when not passing), `flaky` (FR-14), `heal` (`outcome`, `verdict`, `reason`, `diff`, `candidateDiff`) when a heal record exists, `screenshots[]` and `trace` as paths relative to the site dir. |
| FR-2 | Final outcome: the primary result, upgraded to `passed` if a later retry passed, to `healed` if a heal ended `healed`, to `passed` if a heal ended `flaky_or_environment` (its plain re-run passed). `timedOut` counts as `failed`. |
| FR-3 | Writers: `junit.xml` (JUnit XML: one `<testsuite>` per site, `<testcase classname=<site> name=<journeyId> time=…>`, `<failure>` for failed, `<skipped/>`, a `<properties>` block with `outcome`/`flaky`/`healed`, heal info in `<system-out>`; XML-escaped; XML-invalid control chars stripped), `summary.json` (the `RunReport`), `report.html` (self-contained: inline CSS, no scripts, no external URLs; summary, table, per-test details with error, heal diff with +/- colouring, screenshot thumbnails linking to the image). All text is HTML/XML-escaped. |
| FR-4 | Reports are written to `data/sites/<site>/runs/<runId>/reports/` of the primary run, and additionally to `reportDir` when set (config `reportDir`, flag `--report-dir`, env `AGENTIC_E2E_REPORT_DIR`). In `reportDir` screenshots are copied to `assets/` so the directory is portable; links in each HTML are relative to its own location. Screenshot paths are resolved through `Store.resolveFile` (no traversal). |
| FR-5 | Which formats: config `reporters` (array of `junit`\|`json`\|`html`, default all three), flag `--reporter <list>` (comma-separated; `none` disables). Applies to the CLI commands `run`, `heal`, `all` and `ci`. |
| FR-6 | Secret handling: the whole report is passed through (a) the context's SPEC-009 credential redactor, (b) a redactor built from the values of secret env vars (`ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN`, the webhook URL vars) and (c) pattern scrubbing (`sk-ant-…`, `AKIA/ASIA…`, Bedrock `ABSK…` keys, `Bearer …`, Slack hook URLs) **before** any writer renders it. Reports never contain the config, credentials file path or env var values. |

### CI mode

| ID | Requirement |
|----|-------------|
| FR-7 | `ci <url>` command (core: `runCi()`): runs **stored** tests only. Never discovers, generates, opens an editor or prompts for approval. |
| FR-8 | `--retries <n>` (config `retries`, default 0): failed tests are re-run up to n times (no LLM); each re-run is stored as a run with `kind: 'retry'`. |
| FR-9 | Without `--allow-heal` no LLM is called and no spec file is modified. With `--allow-heal` tests still failing after retries are healed with the normal healer (SPEC-006 guarantees). |
| FR-10 | Exit codes (documented): `0` all tests passed (incl. passed-on-retry and, with `--allow-heal`, healed); `1` at least one test failed; `2` config/auth error (invalid config/flags, unknown site, no stored tests, credentials file / unknown user, login failure, missing LLM credentials with `--allow-heal`); `3` LLM/infra error (runner crash, a heal aborted by an LLM/transport error). Precedence when several apply: 2 > 3 > 1. |
| FR-11 | Login (in `--auth` mode) and LLM provider creation (with `--allow-heal`) are performed in a preflight so that their failures map to 2 before any test runs. |

### Integrations

| ID | Requirement |
|----|-------------|
| FR-12 | When `GITHUB_STEP_SUMMARY` is set, a Markdown summary (totals, table of tests with outcome, flaky marker and first error line) is **appended** to that file. Also on exit 2/3 (status + redacted error). |
| FR-13 | Notifications on completion: `AGENTIC_E2E_WEBHOOK_URL` gets a JSON POST (`event: 'run.completed'`, site, runId, mode, status `passed`\|`failed`\|`error`, exitCode, totals, failed `[{journeyId, error (first line, ≤300 chars)}]`, flaky ids); `AGENTIC_E2E_SLACK_WEBHOOK_URL` gets a Slack incoming-webhook `{ text }`. Payloads are redacted (FR-6). URLs must be https (http allowed only for loopback hosts), redirects are not followed, timeout 10s. Failures emit a warning that never contains the URL and never change the exit code. `notifyOn` (`always`\|`failure`\|`never`, default `always`; flag `--notify-on`) gates sending. |

### Flaky detection

| ID | Requirement |
|----|-------------|
| FR-14 | `detectFlaky(runs, heals, { window = 10 })` returns per journey `{ flaky, reasons[], transitions }`. Reasons: `passed_on_retry` (a `retry` run passed right after a failed result, or a heal ended `flaky_or_environment`), `alternating` (≥ 2 pass↔fail transitions among the last `window` results of `kind: 'run'`). History before the latest `healed` heal of the journey is ignored (the code changed). Skipped results are ignored. |
| FR-15 | Flaky info is surfaced in all reports and in `list-test-cases` (`flaky` field in `--json` only when flaky; a `FLAKY` column only when any test is flaky). |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given a run with `a` passed, `b` failed (error "boom"), `c` timedOut and `d` skipped, When `buildRunReport`, Then totals are `{tests:4, passed:1, failed:2, skipped:1}` and `b.error === 'boom'`.
- **AC-2** Given `b` failed and a later `retry` run where `b` passed, Then `b.outcome === 'passed'`, `attempts === 2`, `flaky.reasons` contains `passed_on_retry`, durations are summed.
- **AC-3** Given `b` failed and a `healed` heal record with a diff, Then `b.outcome === 'healed'`, `heal.diff` is present, totals.healed is 1.
- **AC-4** Given a report, When rendered to JUnit, Then the XML has `tests="4" failures="2" skipped="1"`, a `<failure message=…>` for `b`, `<skipped/>` for `d`, and special characters (`<&"` and `\u0001`) are escaped/stripped.
- **AC-5** Given a report with an error containing `<script>`, When rendered to HTML, Then the output contains `&lt;script&gt;`, no `<script` tag, no `http(s)://` resource reference, diff lines are wrapped in add/del spans, and screenshot links are relative.
- **AC-6** Given a credential value, an `ANTHROPIC_API_KEY` env value and an `AKIA…` key appearing in an error, When reports are written, Then none of the three appears in any written file.
- **AC-7** Given `reportDir` set and a failing test with a screenshot, When reports are written, Then `junit.xml`, `summary.json`, `report.html` exist in both `runs/<id>/reports/` and `reportDir`, the screenshot is copied under `reportDir/assets/`, and the HTML in `reportDir` links to the copy.
- **AC-8** Given `reporters: ['junit']`, Then only `junit.xml` is written; `--reporter none` writes nothing.
- **AC-9** Given stored passing tests, When `ci <url>`, Then exit 0, no LLM call, reports written.
- **AC-10** Given a failing test and no `--allow-heal`, When `ci <url>`, Then exit 1, LLM never called, spec file byte-identical.
- **AC-11** Given a test failing once and `--retries 1`, When `ci`, Then exit 0 and the report marks it flaky (`passed_on_retry`); a `retry` run is stored.
- **AC-12** Given a failing test and `--allow-heal` with a healer that heals it, When `ci`, Then exit 0 and the outcome is `healed`.
- **AC-13** Given an unknown site / invalid config value / no stored tests / unknown `--user`, When `ci`, Then exit 2 and nothing runs.
- **AC-14** Given `--allow-heal` and an LLM that throws a transport error, When `ci`, Then exit 3; given the runner throws, exit 3.
- **AC-15** Given `GITHUB_STEP_SUMMARY` pointing to a file with existing content, When `ci` completes, Then the Markdown summary is appended (old content kept) and contains the site, totals and a row per test.
- **AC-16** Given both webhook env vars pointing to local servers, When a run with a failing test completes, Then the generic hook receives `status:'failed'` with the redacted error, Slack receives `{text}`; neither payload contains the secret; `notifyOn: 'failure'` sends nothing for a passing run; a 500 response yields a warning without the URL and does not change the exit code; a non-loopback `http://` URL is refused.
- **AC-17** Given run history pass, fail, pass (kind `run`), Then `alternating` flaky; given pass, fail, fail, Then not flaky; given a `healed` heal after the fail and a pass afterwards, Then not flaky.
- **AC-18** Given a flaky test, When `list-test-cases --json`, Then it has `flaky.flaky === true`; the table shows a `FLAKY` column; with no flaky test the column is absent and the JSON has no `flaky` key.
- **AC-19** `run`, `heal` and `all` write reports under the run's `reports/` dir by default.
- **AC-20** README documents the reports, `ci` command, exit codes, env vars and flaky detection.
