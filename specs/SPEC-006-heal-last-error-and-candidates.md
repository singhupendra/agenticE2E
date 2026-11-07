# SPEC-006: Heal reports the real last failure and keeps unverified candidate patches

- **Status:** Implemented (v0.6)
- **Depends on:** SPEC-001 (FR-6 Healer)
- **Stack:** `src/core/healer.ts`, `src/core/types.ts`, `src/cli/index.ts`, `src/server`, web UI heal log

## 1. Problem

Observed on `site-search-with-category-filter` (vhaan.in, 2026-11-07):

- **Wrong reason.** A heal that ends `failed` reports the LLM's explanation from its last attempt (the "ambiguous option locator" theory). The real error of the last re-run (a `toHaveURL` mismatch) is only inside `attempts[].error`. The CLI line and UI headline therefore point at the wrong problem.
- **Patch thrown away.** A patch that ran but didn't pass is discarded and the original is restored. The user has no patch to start from, so the patched test and its re-run result have to be reconstructed.
- **Too few attempts.** The test had three independent defects: an ambiguous option name, a dropdown whose accessible name changes after selection, and a URL regex that ignored the category query. With `healAttempts: 2` and one defect found per attempt, it could not finish.

## 2. Non-goals

- Changing the verdict rules, the weakened-assertion check, or the "never leave a worse test active" guarantee. The original stays active on every non-`healed` outcome.
- Auto-promoting a candidate patch to the active test, or a "promote" button in the UI.
- Changing `app_bug` or `flaky_or_environment` handling.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Last error.** `HealRecord` gets `lastError?: string` (≤ 4000 chars): the error of the final re-run for outcome `failed`, and for `flaky_or_environment` when the re-run still failed. It is absent for `healed` and `app_bug`. |
| FR-2 | **Headline.** For outcome `failed` the CLI line (`heal`, `all`), the `warn` progress event, and the web UI heal-log headline are `"<id>: failed — last error: <first line of lastError>"`, followed by the LLM's reason on a separate line prefixed `last diagnosis:`. For other outcomes the format is unchanged. |
| FR-3 | **Candidate patch.** When the heal ends `failed` and at least one patch was accepted and re-run, the last such patch is saved as a **non-active** test version named `candidate-<n>` (n = heal count so far, as for `healed-<n>`), and `HealRecord.candidateDiff` holds its diff against the original. The active test remains the original. When no patch was re-run, neither is set. |
| FR-4 | **Patch all findings.** The heal system prompt tells the model to review the whole test for other steps likely to fail for the same or related reasons (for example locators that depend on state the test itself changes, substring name matches, over-specific URL or query assertions) and fix every one it can justify from the snapshot in the same patch, without removing or weakening assertions. |
| FR-5 | **Attempts.** The `healAttempts` default is raised from 2 to 3. Explicit values, including `0`, are unchanged. |
| FR-6 | **Compatibility.** `lastError`, `candidateDiff` and the `candidate-*` versions are optional/additive. Existing `heals.json` records still load, and the UI shows them as before. |
| FR-7 | **Docs.** README documents the `healAttempts` default, the `candidate-*` versions and the new heal-log fields. SPEC-001 FR-6 gets an "extended by SPEC-006" note. |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given a heal where every patch is accepted but the re-run still fails with error E on the final attempt, When it ends, Then `outcome` is `failed` and `lastError` equals E (truncated to 4000 chars).
- **AC-2** Given an LLM `reason` R on the final attempt that differs from E, When the CLI prints the result, Then the line contains the first line of E and also R, with E first.
- **AC-3** Given outcome `healed` or `app_bug`, Then `lastError` and `candidateDiff` are absent.
- **AC-4** Given a flaky verdict whose plain re-run still fails, Then outcome is `failed`, `lastError` is that re-run's error, and no candidate is saved because no patch was applied.
- **AC-5** Given two patches that both fail on re-run, When the heal ends, Then `listTestVersions` contains `candidate-<n>` holding the second patch, `candidateDiff` is the diff original → second patch, and `loadTest` returns the original.
- **AC-6** Given every patch is rejected (identical, weakened, or invalid), Then no candidate version exists and `candidateDiff` is absent.
- **AC-7** Given the heal system prompt, Then it contains the FR-4 instruction to review the whole test and patch all justified findings, and still forbids deleting or weakening assertions.
- **AC-8** Given a config with no `healAttempts`, Then it resolves to 3; `0` stays 0; `2` stays 2.
- **AC-9** Given a stored `heals.json` record without the new fields, When loaded through the API, Then it is returned unchanged and the UI renders without error.
- **AC-10** Given an error thrown by the LLM (the "Healing aborted by error" path), Then outcome is `failed`, `lastError` is absent, and `reason` keeps the existing message.

## 5. Design notes

- `lastError` is set from the last `rerun.error` already tracked in the loop (`last.error`). Nothing new is run.
- The candidate is saved in the same `tests/.versions/<id>/` folder as `original` and `healed-<n>`, so the existing storage helpers apply.
- The attempts default of 3 raises the LLM cost of failing heals by about 50%. It can be overridden with `--heal-attempts` or the config file.
- Existing SPEC-001 AC-27 ("exactly 2 attempts are logged") assumes the old default and needs its fixture to pass `healAttempts: 2` explicitly.
