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

### Prerequisites

- **Node.js 20+** and **[pnpm](https://pnpm.io/installation)**
- An LLM provider — one of:
  - **Anthropic API** key (`ANTHROPIC_API_KEY`), or
  - **Claude on Amazon Bedrock**: AWS credentials (env vars, profile/SSO, role, or `AWS_BEARER_TOKEN_BEDROCK`), a region, and Bedrock model access enabled for the model in your AWS account
- Network access to the site you want to test

### Install

```bash
git clone https://github.com/singhupendra/agenticE2E.git
cd agenticE2E
pnpm install
pnpm exec playwright install chromium     # browser used for crawling + tests
```

### Configure the LLM provider

```bash
# Anthropic (default)
export ANTHROPIC_API_KEY=sk-ant-...

# ...or Amazon Bedrock, using a named AWS profile (access key + secret in ~/.aws/credentials, or SSO / assume-role in ~/.aws/config)
agentic-e2e aws-profiles                  # list the profiles found on this machine
export AGENTIC_E2E_PROVIDER=bedrock
export AGENTIC_E2E_AWS_PROFILE=my-profile # or --aws-profile my-profile, or `awsProfile` in the config file
export AGENTIC_E2E_AWS_REGION=us-east-1   # optional if the profile sets `region`; else AWS_REGION
# (if the profile uses SSO: `aws sso login --profile my-profile` first)
```

```bash
# ...or Amazon Bedrock with a Bedrock API key (no profile / access keys needed)
export AGENTIC_E2E_PROVIDER=bedrock
export AWS_BEARER_TOKEN_BEDROCK=...       # the Bedrock API key (never stored in config or shown in the UI)
export AWS_REGION=us-east-1
export AGENTICQA_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5   # any Bedrock model / inference-profile id
```

`AGENTICQA_BEDROCK_MODEL_ID` sets the model when the provider is Bedrock (it beats `AGENTIC_E2E_MODEL` and the config file; `--model` beats it). The provider is not switched automatically: keep `AGENTIC_E2E_PROVIDER=bedrock` (or `--provider bedrock`).

The selected profile is loaded when the app runs and is used even if `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or `AWS_BEARER_TOKEN_BEDROCK` are set. With no profile selected, the standard AWS credential chain applies as before. In the web UI (`serve`), choose the provider *Amazon Bedrock* in **Settings** and pick the **AWS profile** from the dropdown (it lists the profiles on the machine running the server; only names are shown, never keys).

Credentials are only needed when something actually calls the LLM (new discovery, code generation, healing failures — i.e. `discover`, `generate`, `heal`, `all` and the matching UI jobs). `run`, `journeys`, `list`, `models` and `serve` itself start without them. Provider/model can also be set per command with `--provider`, `--model`, `--aws-region`, `--aws-profile` (see [Configuration](#configuration)).

### Build (optional)

```bash
pnpm build        # compiles the CLI to dist/ and the web UI to web/dist/
```

Only needed for `node bin/agentic-e2e.js …`, the `agentic-e2e` binary, and serving the web UI. `pnpm cli …` runs straight from source.

### Verify the install

```bash
pnpm typecheck
pnpm test:run     # no API key or network needed; requires Chromium from the step above
```

## Quick start

Run the whole pipeline (discover → generate → run → heal) against a site:

```bash
pnpm cli all https://example.com
```

Results land in `./data/sites/<host>/` (journeys, generated specs, run results, screenshots, heal logs — see [Data layout](#data-layout)). Re-run just the stored tests any time with `pnpm cli run https://example.com`.

Prefer a UI?

```bash
pnpm build
node bin/agentic-e2e.js serve             # open http://localhost:4173
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
| `models` | list known Claude models for `--provider anthropic\|bedrock` |
| `aws-profiles` | list AWS profiles from `~/.aws/config` / `~/.aws/credentials` for `--aws-profile` |
| `list` | known sites with journey/test/run counts |
| `serve` | web UI + REST API (`--port 4173`, `--host 127.0.0.1`) |

Common flags (all commands that take a URL): `--config <file>`, `--data-dir <dir>`, `--screenshots off|on-failure|every-step|end-of-journey`, `--full-page`, `--headed`, `--provider <anthropic|bedrock>`, `--model <id>`, `--aws-region <region>`, `--aws-profile <name>`, `--max-pages`, `--max-depth`, `--max-journeys`, `--include <pat…>`, `--exclude <pat…>`, `--heal-attempts <n>`, `--require-approval`. Patterns are case-insensitive substrings, or `/regex/flags`.

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
| `provider` | `anthropic` | `anthropic` \| `bedrock`; env `AGENTIC_E2E_PROVIDER`, flag `--provider` |
| `model` | `claude-sonnet-5-5` | env `AGENTIC_E2E_MODEL` (on Bedrock also `AGENTICQA_BEDROCK_MODEL_ID`, which wins). Pick from `agentic-e2e models` or the UI dropdown, or give any id; on Bedrock bare ids get the `anthropic.` prefix |
| `awsRegion` | – | Bedrock only; env `AGENTIC_E2E_AWS_REGION`, flag `--aws-region`, else the selected profile's `region`, else `AWS_REGION` / `AWS_DEFAULT_REGION` |
| `awsProfile` | – | Bedrock only; named AWS profile supplying credentials; env `AGENTIC_E2E_AWS_PROFILE`, flag `--aws-profile`, or the UI dropdown. Unset = AWS default credential chain. An unknown name fails fast with the list of available profiles |
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

REST API (all JSON): `GET /api/config`, `GET /api/aws-profiles`, `GET /api/models`, `GET /api/sites`, `GET /api/sites/:site`, `PUT /api/sites/:site/journeys`, `GET /api/sites/:site/tests/:id`, `GET /api/sites/:site/runs/:runId`, `GET /api/sites/:site/files/(screenshots|runs)/…`, `POST /api/jobs` `{action, url, options?, journeyIds?, rediscover?, regenerate?}`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE).

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
web/        Vite + React UI                     specs/      SPEC-001…003
```

- **LLM layer**: `LLMProvider.structured({name, schema, prompt, images})`. The Anthropic provider forces a tool call whose `input_schema` is the zod schema's JSON Schema and re-validates the result. Implement the interface to plug in another provider; `MockLLM` is used by all tests.
- **Generated tests** import `{ test, expect }` from `./_support`, which wraps Playwright and adds a `step(name, fn)` fixture plus auto-fixtures that implement the screenshot modes and dump a DOM/ARIA snapshot at failure (so the healer sees the page as it was).
- **Validation**: specs are type-checked in memory with the TypeScript compiler API against the real `@playwright/test` types, plus structural checks (has `test(` and `expect(`, no skip/only).
- **Security of generated code**: specs are LLM output steered by untrusted page content. Validation (also applied to healer patches) rejects any import other than `./_support` / `@playwright/test`, `require`, dynamic `import()`, `eval`, `Function`, `process`, `globalThis`. The test subprocess gets an env allowlist (PATH, HOME, locale/tmp vars, `PLAYWRIGHT_*`, `AGENTIC_E2E_*` set by the runner), so `ANTHROPIC_API_KEY` and other secrets never reach it. This is defence in depth, not a sandbox: run against untrusted sites in a container/VM.
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
