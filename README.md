# agenticE2E

LLM-driven end-to-end testing on Playwright. Point it at a URL and it will:

1. **Discover** — crawl the site (same-origin, bounded) and build a compact model of each page.
2. **Plan** — ask an LLM to propose user journeys (search, login, signup, add-to-cart, contact form…), then rank/select which to automate.
3. **Generate** — have the LLM write Playwright Test (TypeScript) specs, type-checked before they are saved (with error-feedback retries).
4. **Run** — execute them with the real Playwright runner; collect results, traces, screenshots, DOM snapshots at failure.
5. **Heal** — when a test fails, send code + error + page snapshot + screenshot to the LLM, get a verdict (`test_breakage` / `app_bug` / `flaky_or_environment`) and a patch, re-run, up to N attempts. Originals and healed versions + diffs are kept. Patches that remove or weaken assertions are rejected.

Everything is stored per site and reused on later runs. Use it from the **CLI** or the **web UI**.

Spec: [`specs/SPEC-001-agentic-e2e-platform.md`](specs/SPEC-001-agentic-e2e-platform.md)

## Setup

Requires Node 20+, pnpm.

```bash
pnpm install
pnpm exec playwright install chromium     # browser used for crawling + tests
export ANTHROPIC_API_KEY=sk-ant-...       # not needed for run / list / serve-without-LLM-jobs
pnpm build                                # compiles CLI + builds the web UI
```

## CLI

```bash
pnpm cli all https://example.com                 # dev runner (tsx), no build needed
node bin/agentic-e2e.js all https://example.com  # after `pnpm build`  (or: pnpm link --global → `agentic-e2e`)
```

| Command | What it does |
|---|---|
| `discover <url>` | crawl, propose + select journeys (reuses stored ones unless `--rediscover`) |
| `journeys <url>` | show stored journeys; `--approve <ids…>`, `--reject <ids…>`, `--approve-all`, `--edit` (opens `$EDITOR`, validated on save) |
| `generate <url>` | write specs for selected/approved journeys (`--regenerate` to overwrite stored code) |
| `run <url>` | run stored tests (`--journey <ids…>` for a subset). Exits 1 on any failure |
| `heal <url>` | run tests, then self-heal failures |
| `all <url>` | discover → select → generate → run → heal |
| `list` | known sites with journey/test/run counts |
| `serve` | web UI + REST API (`--port 4173`, `--host 127.0.0.1`) |

Common flags (all commands that take a URL): `--config <file>`, `--data-dir <dir>`, `--screenshots off|on-failure|every-step|end-of-journey`, `--full-page`, `--headed`, `--model <id>`, `--max-pages`, `--max-depth`, `--max-journeys`, `--include <pat…>`, `--exclude <pat…>`, `--heal-attempts <n>`, `--require-approval`. Patterns are case-insensitive substrings, or `/regex/flags`.

Typical review-before-codegen workflow:

```bash
agentic-e2e discover https://shop.example.com
agentic-e2e journeys https://shop.example.com --edit            # tweak steps/names
agentic-e2e journeys https://shop.example.com --approve search-products checkout
agentic-e2e generate https://shop.example.com --require-approval
agentic-e2e heal https://shop.example.com
```

## Configuration

Precedence: **defaults < config file < env < CLI flags / UI**. Config file: `agentic-e2e.config.ts` / `.mjs` / `.js` / `.json` in the cwd (or `--config`).

```ts
// agentic-e2e.config.ts
export default {
  screenshots: 'every-step',
  fullPage: true,
  maxJourneys: 4,
  exclude: ['login'],
};
```

| Option | Default | Notes |
|---|---|---|
| `model` | `claude-sonnet-5-5` | env `AGENTIC_E2E_MODEL` |
| `maxTokens` | `8000` | per LLM response |
| `screenshots` | `on-failure` | `off` \| `on-failure` \| `every-step` \| `end-of-journey`; env `AGENTIC_E2E_SCREENSHOTS` |
| `fullPage` | `false` | full-page screenshots; env `AGENTIC_E2E_FULL_PAGE` |
| `dataDir` | `data` | env `AGENTIC_E2E_DATA_DIR` |
| `headless` | `true` | |
| `maxPages` / `maxDepth` / `timeoutMs` | `15` / `2` / `120000` | crawl bounds (same-origin only) |
| `maxJourneys` | `5` | journeys to automate |
| `include` / `exclude` | `[]` | filters on journey name/goal/tags |
| `healAttempts` | `2` | `0` disables healing |
| `codegenRetries` | `2` | retries with compiler feedback |
| `requireApproval` | `false` | only generate journeys with status `approved` |
| `testTimeoutMs` | `30000` | per-test timeout (action/expect timeouts are a third of it) |

## Web UI

```bash
pnpm build && node bin/agentic-e2e.js serve        # http://localhost:4173
# or for UI development: pnpm dev:server  (API on :4173)  +  pnpm web:dev  (Vite on :5173, proxies /api)
```

Enter a URL, adjust settings (screenshot mode, full-page, limits, filters…), and trigger Discover / Generate / Run / Heal / Run all. Progress streams live (SSE). Per site you get tabs for **journeys** (inline edit, approve/reject, save), **code** (current + original/healed versions), **runs** (results, errors, traces, screenshots), **heals** (verdict, reason, attempts, diff) and **screenshots** (gallery).

> ⚠️ The server executes LLM-generated Playwright tests and spends API credits. It binds to `127.0.0.1` and rejects cross-origin mutating requests; do not expose it publicly or add auth-less port forwarding.

REST API (all JSON): `GET /api/config`, `GET /api/sites`, `GET /api/sites/:site`, `PUT /api/sites/:site/journeys`, `GET /api/sites/:site/tests/:id`, `GET /api/sites/:site/runs/:runId`, `GET /api/sites/:site/files/(screenshots|runs)/…`, `POST /api/jobs` `{action, url, options?, journeyIds?, rediscover?, regenerate?}`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE).

## Data layout

```
data/sites/<host[_port]>/
  site.json  journeys.json  pages.json  heals.json
  tests/<journey-id>.spec.ts        # plain Playwright Test; imports ./_support
  tests/_support.ts                 # step() fixture, screenshots, failure snapshots (managed by the tool)
  tests/.versions/<id>/{original,healed-N}.spec.ts
  runs/<timestamp>/{result.json, report.json, output.log, failures/, artifacts/ (traces)}
  screenshots/<timestamp>/<journey-id>/*.png   screenshots/discovery/*.png
```

## Architecture

```
src/core    config · llm/{types,anthropic,mock,schemas} · storage · discovery · planner · journeys
            · validate · codegen · runner · healer · pipeline
src/cli     commander front-end                 src/server  Fastify REST + SSE (+ serves web/dist)
web/        Vite + React UI                     specs/      SPEC-001
```

- **LLM layer**: `LLMProvider.structured({name, schema, prompt, images})`. The Anthropic provider forces a tool call whose `input_schema` is the zod schema's JSON Schema and re-validates the result. Implement the interface to plug in another provider; `MockLLM` is used by all tests.
- **Generated tests** import `{ test, expect }` from `./_support`, which wraps Playwright and adds a `step(name, fn)` fixture plus auto-fixtures that implement the screenshot modes and dump a DOM/ARIA snapshot at failure (so the healer sees the page as it was).
- **Validation**: specs are type-checked in memory with the TypeScript compiler API against the real `@playwright/test` types, plus structural checks (has `test(` and `expect(`, no skip/only).
- **Healer guardrails**: patch must pass validation and must not reduce the number of assertions, add tautologies or skip the test; `app_bug` verdicts are never patched; if no attempt passes, the original is restored.
- **Runner** spawns the Playwright Test CLI with a generated config (`baseURL` = site origin) and parses its JSON report.

## Development

```bash
pnpm test:run     # vitest (no network / API key needed; needs Chromium installed)
pnpm typecheck    # tsc for backend + web
```

Tests: unit tests per core module with a mocked LLM, plus an integration test that runs the full pipeline against a tiny in-test fixture site.

## Known limitations

- Chromium only. No authenticated crawling or credential handling; journeys needing real accounts/payments will usually be proposed as "stubbed" or fail.
- App-bug vs test-breakage classification is the LLM's judgement (guided by the snapshot); review heal logs.
- Discovery models are capped (elements/ARIA text are truncated) to bound prompt size; very large SPAs may need higher `maxPages` / manual journey edits.
- The web UI has no auth and a single in-memory job store (jobs are lost on restart; one job per site at a time).
