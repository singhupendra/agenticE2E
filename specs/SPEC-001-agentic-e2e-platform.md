# SPEC-001: agenticE2E — LLM-driven E2E discovery, generation and self-healing

- **Status:** Implemented (v0.1)
- **Owner:** agenticE2E
- **Stack:** TypeScript, Node 20+, pnpm, Playwright, Vitest, Fastify, Vite + React

## 1. Summary

Given a website URL, agenticE2E explores the site with Playwright, asks an LLM to propose
user journeys, selects which to automate, generates Playwright Test (TypeScript) specs,
runs them, and self-heals failing tests — while keeping everything persisted per site.
It is usable from a CLI and a web UI, both thin layers over one `core` library.

## 2. Non-goals

- Authenticated crawling beyond what the user scripts into a journey (no credential vault).
- Cross-browser matrix (Chromium only in v0.1).
- Replacing human review of generated tests: journeys can be edited/approved before codegen.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Input.** The target URL is a parameter of every CLI command and of the web UI / REST API. Only `http:`/`https:` URLs are accepted. |
| FR-2 | **Discovery.** Crawl same-origin pages with Playwright, bounded by `maxPages`, `maxDepth`, `timeoutMs`. For each page capture a compact *page model*: URL, title, ARIA snapshot, interactive elements (role, accessible name/label, test id, tag, href), forms (fields + submit), nav links. Send page models to the LLM, which proposes candidate journeys (`name`, `goal`, `priority`, ordered `steps`). |
| FR-3 | **Journey decision.** The LLM ranks/selects journeys to automate. `maxJourneys`, `include`, `exclude` (case-insensitive substrings/regex on name/goal/tags) are applied deterministically on top. Users can edit journeys (name, goal, priority, steps) and approve/reject them from CLI and web before codegen. |
| FR-4 | **Codegen.** The LLM generates one Playwright Test `.spec.ts` per journey, preferring `getByRole`/`getByLabel`/`getByTestId`, with assertions. Code is validated (TypeScript type-check against Playwright types + structural checks: has a `test(`, has `expect(`, no skipped tests) before it is saved; on failure the diagnostics are fed back and the LLM retries (bounded by `codegenRetries`). |
| FR-5 | **Execution.** Run generated tests with Playwright; collect per-test status, duration, error, trace path, and — on failure — a DOM/ARIA snapshot and screenshot. |
| FR-6 | **Healer.** For a failing test send code + error + failure DOM/ARIA snapshot + screenshot to the LLM; receive a verdict (`test_breakage` / `app_bug` / `flaky_or_environment`) and, for breakage, a patched test. Re-run, up to `healAttempts`. Keep original and healed versions and a heal log (diff, reason, verdict, attempts). Never accept a patch that removes/weakens assertions (fewer `expect` calls, skipped/fixme tests, or `expect(true)`-style tautologies). `app_bug` verdicts are reported and not healed. |
| FR-7 | **Storage.** Everything persists under `data/sites/<normalized-host>/`: `site.json`, `journeys.json`, `tests/*.spec.ts`, `tests/.versions/<id>/…`, `runs/<run-id>/…`, `screenshots/<run-id>/…`, `heals.json`. A known site reuses stored journeys/code unless `--rediscover` (journeys) / `--regenerate` (code). |
| FR-8 | **Screenshots.** `screenshots`: `off` \| `on-failure` \| `every-step` \| `end-of-journey`, plus `fullPage` boolean. Settable via config file (`agentic-e2e.config.json` / `.ts` / `.js`), CLI flags, and web UI. Precedence: defaults < config file < env < CLI/UI. |
| FR-9 | **LLM layer.** A pluggable `LLMProvider` interface using structured (tool-use JSON-schema) output. Default is Anthropic (`ANTHROPIC_API_KEY`, model configurable, default `claude-sonnet-5-5`). Fully mockable; all automated tests run without network or keys. |
| FR-10 | **CLI.** `agentic-e2e discover|journeys|generate|run|heal|all|list|serve`. |
| FR-11 | **Web/API.** Fastify REST API over core + SSE job progress; React UI to enter URL, view/edit/approve journeys, view code, trigger jobs, view results, heal logs and screenshot galleries. |

## 4. Acceptance criteria (Given / When / Then)

### Config (FR-8)
- **AC-1** Given no config file or flags, When config is resolved, Then `screenshots` is `"on-failure"` and `fullPage` is `false`.
- **AC-2** Given a config file sets `screenshots: "every-step"` and CLI flags set `--screenshots off`, When config is resolved, Then `screenshots` is `"off"` (CLI > file).
- **AC-3** Given `screenshots: "sometimes"`, When config is resolved, Then it fails with a validation error naming the field.
- **AC-4** Given an `agentic-e2e.config.json` / `.ts` in cwd, When config is loaded, Then its values are applied.

### Storage (FR-7)
- **AC-5** Given URL `https://WWW.Example.com:8443/a?b=1`, When normalized, Then the site key is `www.example.com_8443` (safe for filesystems); default ports are omitted.
- **AC-6** Given journeys are saved for a site, When loaded in a new process, Then they are identical; Given none saved, Then load returns `null`.
- **AC-7** Given a hostile site id such as `../../etc`, When resolved to a path, Then it is rejected.

### Discovery (FR-2)
- **AC-8** Given a fixture site with 4 linked pages and `maxPages: 3`, When crawled, Then exactly 3 pages are returned.
- **AC-9** Given a page links to another origin, When crawled, Then the external link is never visited.
- **AC-10** Given `maxDepth: 0`, When crawled, Then only the start page is returned.
- **AC-11** Given a page with a labelled form and a nav, When its model is captured, Then the model contains the form fields (with labels), submit button, nav links, a title and an ARIA snapshot.
- **AC-12** Given crawled pages, When the planner runs with a mocked LLM, Then journeys are returned with unique ids, name, goal, priority, ordered steps; invalid LLM output fails with a clear error.

### Selection (FR-3)
- **AC-13** Given 5 journeys and `maxJourneys: 2`, When selected, Then exactly the two highest-ranked are `selected`.
- **AC-14** Given `exclude: ["login"]`, When selected, Then no journey matching "login" is selected.
- **AC-15** Given `include: ["search"]`, When selected, Then only matching journeys are eligible.
- **AC-16** Given a user edits a journey and rejects another, When codegen runs, Then the edit is used and the rejected journey is skipped.

### Codegen (FR-4)
- **AC-17** Given the LLM returns valid code, When generated, Then it is saved at `tests/<id>.spec.ts`.
- **AC-18** Given the LLM first returns code with a type error and then valid code, When generated, Then the second call receives the diagnostics and the valid code is saved (2 calls).
- **AC-19** Given the LLM always returns invalid code, When retries are exhausted, Then nothing is saved for that journey and an error is reported.
- **AC-20** Given code without any `expect(`, When validated, Then it is rejected.
- **AC-21** Given stored code and no `--regenerate`, When `generate` runs, Then the LLM is not called for that journey.

### Execution (FR-5)
- **AC-22** Given a passing and a failing generated test against the fixture site, When run, Then results report one `passed` and one `failed` with error text, and the failure has a snapshot (URL, ARIA snapshot) and a screenshot (when mode ≠ `off`).
- **AC-23** Given `screenshots: "every-step"`, When a 2-step test passes, Then ≥2 step screenshots exist for the run; with `"off"` none exist; with `"on-failure"` none for passing tests; with `"end-of-journey"` exactly one per test.

### Healer (FR-6)
- **AC-24** Given a test failing due to a renamed label and an LLM verdict `test_breakage` with a valid patch, When healed, Then the test is re-run, passes, the original is preserved under `tests/.versions/`, and the heal log has diff + reason + attempts.
- **AC-25** Given a patch that deletes an assertion, When healing, Then it is rejected without re-running, feedback is sent on the next attempt, and the original stays active.
- **AC-26** Given verdict `app_bug`, When healing, Then no patch is applied, no re-run occurs, and the outcome is `app_bug`.
- **AC-27** Given `healAttempts: 2` and patches that never pass, When healing, Then exactly 2 attempts are logged and the original code is restored.

### Pipeline, CLI, Web
- **AC-28** Given a fixture site and a mocked LLM, When `all` runs on an unknown site, Then discovery → selection → codegen → run → heal executes, a broken test is healed, and the stored artifacts exist.
- **AC-29** Given the same site again, When `all` runs without `--rediscover`, Then the LLM is not asked to discover/generate again.
- **AC-30** Given `--rediscover`, Then discovery and selection run again.
- **AC-31** Given the CLI, When `discover` is invoked without a URL or with a non-http URL, Then it exits non-zero with a message.
- **AC-32** Given the API, When `POST /api/jobs` is sent with a valid URL, Then a job id is returned and `GET /api/jobs/:id/events` streams progress events (SSE) ending in a terminal event.
- **AC-33** Given the API, When `PUT /api/sites/:site/journeys` is sent with edits, Then they are persisted and visible via `GET`.
- **AC-34** Given the API file route, When a path-traversal request is made, Then it returns 4xx.

## 5. Architecture

```
src/core   config · llm (provider iface, anthropic, schemas) · storage · discovery · planner
           · codegen · validate · runner · healer · pipeline (events)
src/cli    commander front-end
src/server Fastify REST + SSE + static web
web/       Vite + React UI
```

Decisions:
- **Single package**, subpath modules, to keep the dev loop simple; web is built by Vite into `web/dist` and served by the Fastify server.
- **Generated tests import `./_support`** (written per site) which re-exports Playwright's `test`/`expect` and adds a `step()` fixture plus auto-fixtures that implement the screenshot modes and capture failure snapshots. This keeps generated code plain Playwright while giving the runner access to the live `page` at failure time.
- **Runner** spawns the Playwright Test CLI with a generated config (baseURL = site origin, JSON reporter, trace on failure) so the real test runner semantics are used.
- **LLM structured output** via forced tool-use with JSON Schema derived from zod schemas; responses re-validated with zod.
- **Server binds to 127.0.0.1** by default; it runs arbitrary generated tests, so it must not be exposed publicly.

## 6. Known limitations (v0.1)
- Chromium only; no auth-flow discovery; heuristics for app-bug vs test-breakage rely on the LLM verdict.
