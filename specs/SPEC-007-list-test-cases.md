# SPEC-007: `list-test-cases <url>` — list the stored generated tests of a site

- **Status:** Implemented (v0.7)
- **Depends on:** SPEC-001 (storage, journeys, runs, heals)
- **Stack:** `src/core/test-cases.ts` (new), `src/core/storage.ts`, `src/cli/index.ts`, README

## 1. Problem

`list` only shows per-site counts. To see *which* tests exist for a site, which journey each belongs to,
and how it last fared, you have to read `data/sites/<host>/` by hand (`tests/*.spec.ts`, `journeys.json`,
`runs/*/result.json`, `heals.json`).

## 2. Non-goals

- Web/REST API or UI changes (the core function is written so they can reuse it later).
- Running, generating or modifying anything: the command is read-only and needs no LLM credentials.
- Listing journeys that have no generated spec (use `journeys <url>` for those).

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | `list-test-cases <url>` resolves the site with `normalizeSite(url).id` (same host/port normalization as every other command) and reads from the data dir given by `--data-dir` / `--config` (same resolution as `list`). |
| FR-2 | A **test case** is a generated spec file `tests/<journeyId>.spec.ts` of the site. Every one is listed, sorted by journey id. `_support.ts` and `.versions/` are not test cases. |
| FR-3 | Each entry has: `journeyId`, `name` (journey name, or the id if the journey is no longer in `journeys.json`), `specFile` (absolute path), `journeyStatus` (`proposed\|selected\|approved\|rejected` as stored, or `unknown` when the journey is missing) and `lastRun`. |
| FR-4 | `lastRun` describes the most recent stored result for that journey across all runs (`run` and `heal-rerun`, ordered by run id = start time). Its `outcome` is: `passed`, `failed` (stored `failed` or `timedOut`), `skipped`, `healed`, or `never_run`. `healed` = that latest result is a passing `heal-rerun` and the journey's most recent heal record has outcome `healed`. With history it also has `runId`, `at` (the run's `finishedAt`), `durationMs` and, when not passing, `error` (first line). `never_run` has no other fields. |
| FR-5 | Default output is a readable table with columns `JOURNEY`, `NAME`, `STATUS`, `LAST RUN` (outcome + timestamp, `never run` when none) and `SPEC FILE`, preceded by a header line with the site id and test count. |
| FR-6 | `--json` prints exactly one JSON document to stdout and nothing else: `{ "site": {id, origin, url}, "dataDir": string, "tests": TestCase[] }`. |
| FR-7 | Unknown site (no `sites/<id>` directory in the data dir): message `Unknown site <id> in <dataDir>. Run: agentic-e2e discover <url>` on stderr, exit code 1. Applies with and without `--json`. |
| FR-8 | Known site with no generated tests: exit 0. Default mode prints `No generated tests for <id> yet. Run: agentic-e2e generate <url>`; `--json` prints the document with `"tests": []`. |
| FR-9 | Listing logic is a pure core function `listTestCases(store, siteId): SiteTestCases \| null` (`null` = unknown site) in `src/core/test-cases.ts`, with no console output and no CLI dependency. |
| FR-10 | Invalid URL or non-http(s) scheme fails like the other commands (message, exit 1). |
| FR-11 | README CLI table documents the command and its output. |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given a site with tests `a` (selected, last run passed), `b` (approved, last run failed) and `c` (never run), When `list-test-cases <url>` runs, Then exit is 0 and the output lists `a`, `b`, `c` with their names, statuses, outcomes `passed` / `failed` / `never run` and spec paths.
- **AC-2** Given two runs where `a` failed first and passed later, Then `a`'s last run is `passed` with the later run's `finishedAt`.
- **AC-3** Given a latest passing `heal-rerun` result for `a` and a heal record for `a` with outcome `healed`, Then `a`'s outcome is `healed`; with a plain passing `heal-rerun` but a latest heal record that is not `healed` (e.g. `flaky_or_environment`), it is `passed`.
- **AC-4** Given a result with status `timedOut`, Then outcome is `failed`.
- **AC-5** Given a known site (`site.json` present) with no spec files, Then exit 0 and the "No generated tests" message; with `--json`, `tests` is `[]`.
- **AC-6** Given an unknown site, Then exit 1 and stderr names the site and the data dir; stdout is empty, also with `--json`.
- **AC-7** Given `--json`, Then stdout parses as JSON with shape `{site:{id,origin,url}, dataDir, tests:[{journeyId,name,specFile,journeyStatus,lastRun}]}` and no extra text.
- **AC-8** Given `https://Example.com:443/path` and a site stored as `example.com`, Then the site resolves (same normalization as other commands).
- **AC-9** Given a spec file whose journey is absent from `journeys.json`, Then it is listed with `name` = id and `journeyStatus` `unknown`.
- **AC-10** Given `--data-dir <dir>` or a `--config` file with `dataDir`, Then that directory is read.
- **AC-11** Given `ftp://example.com`, Then exit 1 with a message mentioning http.
- **AC-12** `listTestCases` returns `null` for an unknown site and does not write to the data dir.
