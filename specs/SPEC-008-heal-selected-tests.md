# SPEC-008: Heal specific failing test cases (CLI, REST job, web UI)

- **Status:** Implemented (v0.8)
- **Depends on:** SPEC-001 (pipeline, healer), SPEC-006 (heal records), SPEC-007 (`listTestCases` / latest run outcome)
- **Stack:** `src/core/heal-selection.ts` (new), `src/core/pipeline.ts`, `src/cli/index.ts`, `src/server/{jobs,app}.ts`, `web/src/{App,api}.tsx`, README

## 1. Problem

`heal <url> [--journey ids]` re-runs and heals, but there is no way to say "heal exactly these tests" or "heal whatever
last failed" with validated ids, and the web UI only has a global *Heal* button. Healing costs LLM credits, so
targeting matters.

## 2. Non-goals

- Changing how a single test is healed (`healTest`, SPEC-006 semantics are unchanged).
- Selecting by anything other than journey/test id (the ids shown by `list-test-cases`).
- Healing tests that have no stored spec.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | CLI: `heal <url> [testIds...]`. Ids are positional; `--journey <ids...>` stays as an alias. Positional and `--journey` ids are merged (duplicates removed, order kept). |
| FR-2 | CLI: `--failed` selects only tests whose **latest stored run outcome is `failed`** (`listTestCases` semantics: `failed`/`timedOut`; `healed`, `passed`, `skipped`, `never_run` are not). Combined with ids it selects the given ids that are also failed. |
| FR-3 | With neither ids nor `--failed`, behaviour is unchanged: every stored test is re-run and failures are healed. |
| FR-4 | Selection + validation is one core function `resolveHealSelection(store, siteId, { ids?, failedOnly? })` returning the selected ids (`null` for "all"), plus the valid ids. Unknown ids throw `HealSelectionError` (message lists the unknown and the valid ids; `validIds` and `unknownIds` fields). An unknown site throws `UnknownSiteError`. Validation happens before any test is run or LLM called. |
| FR-5 | `--failed` with nothing failing: message `No failing tests to heal for <site>` on stdout, exit 0, nothing run, LLM never touched. |
| FR-6 | Unknown id(s): `Error: …` on stderr listing the valid ids (or `(none)`), exit 1, nothing run, nothing healed. |
| FR-7 | When a selection is given, **only** selected tests are re-run and healed — never the whole suite. |
| FR-8 | A selected test that passes on the re-run is reported `already passing, not healed` and the LLM is not called for it. Only tests failing on the re-run are healed. |
| FR-9 | Core function `healSelected(ctx, url, selection)` (in `pipeline.ts`) does selection → run → heal and returns `{ selected, noneFailing, run, results: [{journeyId, outcome}], heals }`, where `outcome` is `healed \| app_bug \| flaky_or_environment \| failed \| already_passing \| skipped`. CLI and server job both use it. |
| FR-10 | CLI prints one summary line per selected test (`healed`, `app_bug`, `flaky_or_environment`, `failed`, `already passing`) after the existing run output, then a count line. Exit code: 1 if any heal outcome is `failed` or `app_bug` (as before), else 0. |
| FR-11 | Server: heal job accepts `{ journeyIds?: string[]; failedOnly?: boolean }`. `failedOnly` must be a boolean and is only valid for `action: "heal"` (400 otherwise). Unknown ids → `400 { error, validIds, unknownIds }` synchronously from `POST /api/jobs`, no job created. Unknown site with a selection → 404. A `failedOnly` request with nothing failing starts a job that ends `done` with `result.noneFailing = true` and no LLM calls. |
| FR-12 | Server keeps the Host allowlist, JSON content-type and Origin checks (no new route is added; the payload extends `POST /api/jobs`). |
| FR-13 | Web: the site view has a **Tests** tab listing each test with name, latest outcome and a checkbox; buttons **Heal selected** (disabled with nothing ticked) and **Heal all failed** (disabled with no failed test). They start a heal job with `journeyIds` / `failedOnly`, stream progress like other jobs and refresh site data (Heals tab, outcomes) when it ends. The tests listing comes from a new read-only `GET /api/sites/:site/test-cases` backed by `listTestCases`. |
| FR-14 | README documents the CLI usage, the job payload and the web UI. |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given a site with tests `a`,`b`,`c`, When `resolveHealSelection(store, site, {ids:['b']})`, Then it returns `['b']`.
- **AC-2** Given `a` last passed, `b` last failed (timedOut counts), `c` never run, When `{failedOnly:true}`, Then it returns `['b']`; with `{ids:['a','b'], failedOnly:true}` it returns `['b']`.
- **AC-3** Given unknown id `zzz`, Then `HealSelectionError` with `unknownIds:['zzz']`, `validIds:['a','b','c']` and a message naming both.
- **AC-4** Given no failures and `failedOnly`, Then the selection is `[]`; `healSelected` returns `noneFailing: true`, runs nothing and makes no LLM call.
- **AC-5** Given selection `['b']` of 3 tests, When `healSelected`, Then the runner is invoked with exactly `['b']` and `a`/`c` are untouched.
- **AC-6** Given `b` selected and passing on re-run, Then its result is `already_passing`, no heal record is written and the mocked LLM is never called.
- **AC-7** Given `a` (passes on re-run) and `b` (still fails) selected, Then only `b` is healed (LLM called for `b` only) and results are `a: already_passing`, `b: <heal outcome>`.
- **AC-8** CLI `heal <url> a b` and `heal <url> --journey a b` resolve to the same selection; `heal <url> a --journey a b` de-duplicates to `[a, b]`.
- **AC-9** CLI `heal <url> zzz` exits 1, stderr lists the valid ids, nothing ran.
- **AC-10** CLI `heal <url> --failed` with nothing failing exits 0 with the "No failing tests" message and no LLM credentials needed.
- **AC-11** CLI prints a per-test summary containing each selected test's outcome word.
- **AC-12** `POST /api/jobs {action:'heal', journeyIds:['zzz']}` → 400 with `validIds`; no job is created. `{action:'run', failedOnly:true}` → 400; `failedOnly:'yes'` → 400.
- **AC-13** `POST /api/jobs {action:'heal', failedOnly:true}` with nothing failing → 202 and the job ends `done` with `result.noneFailing === true`. With `journeyIds:['a']` the job result has `selected: ['a']`.
- **AC-14** A POST with a foreign Host, a non-JSON content type or a mismatched Origin is still rejected (403/415).
- **AC-15** `GET /api/sites/:site/test-cases` returns the `listTestCases` document; unknown site → 404.
- **AC-16** Web: the Tests tab shows tests with outcomes and checkboxes; the two buttons start the heal job with the right payload (verified by typecheck + manual/demo, no browser test infra exists).
