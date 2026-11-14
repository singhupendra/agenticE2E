# agenticE2E

LLM-driven end-to-end testing on Playwright. Point it at a URL and it will:

1. **Discover** — crawl the site (same-origin, bounded) and build a compact model of each page.
2. **Plan** — ask an LLM to propose user journeys (search, login, signup, add-to-cart, contact form…), then rank/select which to automate.
3. **Generate** — have the LLM write Playwright Test (TypeScript) specs, type-checked before they are saved (with error-feedback retries).
4. **Run** — execute them with the real Playwright runner; collect results, traces, screenshots, DOM snapshots at failure.
5. **Heal** — when a test fails, send code + error + page snapshot + screenshot to the LLM, get a verdict (`test_breakage` / `app_bug` / `flaky_or_environment`) and a patch, re-run, up to N attempts. Originals and healed versions + diffs are kept; when every attempt fails, the last patch that was re-run is kept as a non-active `candidate-<n>` version (with its diff and the final error in the heal log) for you to review. Patches that remove or weaken assertions are rejected.

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
export AGENTICQA_BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-5-5   # any Bedrock inference-profile id (global., us., apac. …) or ARN
```

`AGENTICQA_BEDROCK_MODEL_ID` sets the model when the provider is Bedrock (it beats `AGENTIC_E2E_MODEL` and the config file; `--model` beats it). The provider is not switched automatically: keep `AGENTIC_E2E_PROVIDER=bedrock` (or `--provider bedrock`).

The selected profile is loaded when the app runs and is used even if `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or `AWS_BEARER_TOKEN_BEDROCK` are set. With no profile selected, the standard AWS credential chain applies as before. In the web UI (`serve`), choose the provider *Amazon Bedrock* in **Settings** and pick the **AWS profile** from the dropdown (it lists the profiles on the machine running the server; only names are shown, never keys).

Credentials are only needed when something actually calls the LLM (new discovery, code generation, healing failures — i.e. `discover`, `generate`, `heal`, `all` and the matching UI jobs). `run`, `journeys`, `list`, `list-test-cases`, `models` and `serve` itself start without them. Provider/model can also be set per command with `--provider`, `--model`, `--aws-region`, `--aws-profile` (see [Configuration](#configuration)).

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
| `heal <url> [testIds…]` | re-run tests, then self-heal the failing ones. With no selection: every stored test. `testIds…` (positional; `--journey <ids…>` is an alias) heal only those tests — ids as shown by `list-test-cases`; `--failed` selects only tests whose **latest stored run** failed (combined with ids: those of them that failed). Only selected tests are re-run; one that now passes is reported `already passing, not healed` and never reaches the LLM. Unknown ids → error listing the valid ids, exit 1, nothing run. `--failed` with nothing failing → message, exit 0. Prints a per-test summary (`healed` / `app_bug` / `flaky_or_environment` / `failed` / `already passing`); exits 1 if any heal ended `failed` or `app_bug` |
| `all <url>` | discover → select → generate → run → heal |
| `auth-check <url>` | log in with the credentials file and refresh the stored session for a site (`--user`, `--credentials`). Always performs a fresh login; prints success and where the session was saved, never a credential. See [Logged-in testing](#logged-in-testing) |
| `models` | list known Claude models for `--provider anthropic\|bedrock` |
| `aws-profiles` | list AWS profiles from `~/.aws/config` / `~/.aws/credentials` for `--aws-profile` |
| `list` | known sites with journey/test/run counts |
| `list-test-cases <url>` | the stored generated tests of one site: journey id, name, journey status (as stored), latest run outcome (`passed`/`failed`/`healed`/`skipped`/`never run`, with timestamp) and spec file path, and an `AUTH` column (the user a logged-in journey runs as, `-` otherwise). `--json` for machine-readable output (`{site, dataDir, tests[]}`; tests carry `requiresAuth`/`user`). Exits 1 for an unknown site; exits 0 with a message when the site has no generated tests yet. Read-only, no LLM credentials needed |
| `serve` | web UI + REST API (`--port 4173`, `--host 127.0.0.1`) |

Common flags (all commands that take a URL): `--config <file>`, `--data-dir <dir>`, `--screenshots off|on-failure|every-step|end-of-journey`, `--full-page`, `--headed`, `--provider <anthropic|bedrock>`, `--model <id>`, `--aws-region <region>`, `--aws-profile <name>`, `--max-pages`, `--max-depth`, `--max-journeys`, `--include <pat…>`, `--exclude <pat…>`, `--heal-attempts <n>`, `--require-approval`, and for logged-in testing `--auth`, `--user <name>`, `--credentials <file>`. Patterns are case-insensitive substrings, or `/regex/flags`.

Typical review-before-codegen workflow:

```bash
agentic-e2e discover https://shop.example.com
agentic-e2e journeys https://shop.example.com --edit            # tweak steps/names
agentic-e2e journeys https://shop.example.com --approve search-products checkout
agentic-e2e generate https://shop.example.com --require-approval
agentic-e2e heal https://shop.example.com
agentic-e2e heal https://shop.example.com checkout login   # only these tests
agentic-e2e heal https://shop.example.com --failed        # only tests whose latest run failed
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
| `model` | `claude-sonnet-5-5` | env `AGENTIC_E2E_MODEL` (on Bedrock also `AGENTICQA_BEDROCK_MODEL_ID`, which wins). Pick from `agentic-e2e models` or the UI dropdown, or give any id; on Bedrock bare ids get the `global.anthropic.` inference-profile prefix (SPEC-005), so the default is `global.anthropic.claude-sonnet-5-5`; ids with a vendor/profile prefix (`us.`, `apac.`, `anthropic.`, ARNs) pass through |
| `awsRegion` | – | Bedrock only; env `AGENTIC_E2E_AWS_REGION`, flag `--aws-region`, else the selected profile's `region`, else `AWS_REGION` / `AWS_DEFAULT_REGION` |
| `awsProfile` | – | Bedrock only; named AWS profile supplying credentials (loaded through the AWS SDK provider chain for that profile, so it wins over the shell's `AWS_PROFILE`; static keys, SSO, assume-role all work); env `AGENTIC_E2E_AWS_PROFILE`, flag `--aws-profile`, or the UI dropdown. Unset = AWS default credential chain. An unknown name fails fast with the list of available profiles |
| `maxTokens` | `8000` | per LLM response |
| `screenshots` | `on-failure` | `off` \| `on-failure` \| `every-step` \| `end-of-journey`; env `AGENTIC_E2E_SCREENSHOTS` |
| `fullPage` | `false` | full-page screenshots; env `AGENTIC_E2E_FULL_PAGE` |
| `dataDir` | `data` | env `AGENTIC_E2E_DATA_DIR` |
| `headless` | `true` | |
| `maxPages` / `maxDepth` / `timeoutMs` | `15` / `2` / `120000` | crawl bounds (same-origin only) |
| `maxJourneys` | `5` | journeys to automate |
| `include` / `exclude` | `[]` | filters on journey name/goal/tags |
| `healAttempts` | `3` | `0` disables healing |
| `codegenRetries` | `2` | retries with compiler feedback |
| `requireApproval` | `false` | only generate journeys with status `approved` |
| `testTimeoutMs` | `30000` | per-test timeout (action/expect timeouts are a third of it) |
| `credentialsFile` | `.agentic-e2e/credentials.json` | logged-in testing; env `AGENTIC_E2E_CREDENTIALS`, flag `--credentials` (flag > env > config file > default). Never exposed by the API |
| `auth` / `authUser` | `false` / – | logged-in mode and which named user to use; flags `--auth` / `--user` |

## Logged-in testing

Discovery, planning, generation, running and healing can work as a **logged-in user** (SPEC-009). Credentials come from a **local file that is never committed** and never reach the LLM, generated code, stored data, logs or API responses.

```bash
mkdir -p .agentic-e2e && cp credentials.example.json .agentic-e2e/credentials.json && chmod 600 .agentic-e2e/credentials.json
$EDITOR .agentic-e2e/credentials.json                 # real values go here (this path is gitignored)
agentic-e2e auth-check https://shop.example.com        # does the login work? saves the session
agentic-e2e all https://shop.example.com --auth --rediscover [--user admin]
```

**Credentials file** — default `.agentic-e2e/credentials.json` (or `--credentials`, config `credentialsFile`, env `AGENTIC_E2E_CREDENTIALS`). A JSON object keyed by site (host, `host:port` or URL; normalised like the data dir), each with one or more named users and optional login hints; see [`credentials.example.json`](credentials.example.json) (fake values only):

```json
{
  "shop.example.com": {
    "defaultUser": "member",
    "users": {
      "member": { "username": "demo.member@example.com", "password": "…" },
      "admin":  { "username": "${SHOP_ADMIN_USER}", "password": "${SHOP_ADMIN_PASSWORD}" }
    },
    "login": { "loginUrl": "/login", "usernameSelector": "input[name=email]", "passwordSelector": "input[name=password]",
               "submitSelector": "button[type=submit]", "successUrl": "/account", "successText": "Welcome back", "checkUrl": "/account" }
  }
}
```

- Any string may use `${ENV_VAR}`; the value is read from the environment when the file is loaded (an unset variable is an error naming the variable). Extra string fields next to `username`/`password` (an OTP seed, a PIN…) are allowed and treated as secrets too.
- **Login hints are optional.** Without selectors an LLM locates the form — it sees the page and the placeholders `{{username}}`/`{{password}}`, never the real values, which Playwright types locally. `successUrl` (substring or `/regex/`) / `successText` define "logged in"; without them the check is "no password field visible and not still on the login URL". `checkUrl` (a protected page) lets a stored session be validated live.
- User selection: `--user`, else `defaultUser`, else the only user. Unknown site/user → error listing names only.

**Sessions.** A successful login saves Playwright `storageState` to `data/sites/<host>/auth/<user>.json` (`0600`, gitignored, never served by the API) and reuses it for up to 12 h while its cookies are unexpired and the `checkUrl`/`successText` check passes; otherwise it logs in again. If an authenticated test fails with a reused session that turns out dead, the session is refreshed and the tests re-run once.

**What happens in `--auth` mode.** Discovery crawls as the user (it never follows logout / delete / remove / cancel-subscription / deactivate / unsubscribe links and never clicks anything). The planner may flag journeys `requiresAuth: true` + `user`; they are shown with an `auth` badge in the UI and in `list-test-cases`. Their specs run pre-authenticated (a Playwright `authenticated` project with the storageState; tracing is off for such runs because traces embed cookies) and can read the credentials through the `credentials` fixture (`async ({ page, step, credentials }) => … credentials.password`), backed by `E2E_USERNAME`/`E2E_PASSWORD` that the runner injects into the test process — only for the selected user and only when the run contains authenticated tests. Without `--auth`, authenticated journeys are not generated and are skipped on `run` with a warning. A run uses one user; run again with `--user other` for another role.

### Secret handling

| Guarantee | How |
|---|---|
| never committed | `.gitignore` covers `.agentic-e2e/`, `credentials*.json` (except `credentials.example.json`), `*.credentials.json`, `.auth/`, `**/storageState*.json` and `data/`; a test runs `git check-ignore` on them. A credentials file **tracked by git is refused** (`git rm --cached` it and rotate the secrets); a file readable by group/other triggers a `chmod 600` warning |
| never sent to the LLM | prompts are built from placeholders; every request also passes a redactor (plain, URL-encoded, JSON/HTML-escaped forms → `{{password}}`…). Screenshots are not sent to the LLM in `--auth` mode |
| never in generated code | specs cannot touch `process`; credentials come via the `credentials` fixture. Codegen and the healer **reject** a spec containing a real value and regenerate (the retry prompt has it redacted) |
| never in stored data / logs / API | the store redacts `journeys.json`, specs and their versions, pages, run and heal records; the runner redacts `output.log`, `report.json`, failure snapshots and errors; progress events (CLI and SSE) and job results/errors are redacted. `GET /api/auth?url=` returns only `{configured, users: [names]}`; `/api/config` omits the credentials path; job options cannot set it |
| minimal exposure at run time | the test subprocess env is an allowlist; only the selected user's `E2E_USERNAME`/`E2E_PASSWORD` are added, and only for authenticated runs |

Limits: storageState files contain live session cookies (protect `data/` like the credentials file); a page that echoes a password into the DOM is caught by redaction in artifacts, not prevented; values shorter than 3 characters are not redacted; no 2FA/CAPTCHA/SSO flows, no sign-up; one user per run.

## Web UI

```bash
pnpm build && node bin/agentic-e2e.js serve        # http://localhost:4173
# or for UI development: pnpm dev:server  (API on :4173)  +  pnpm web:dev  (Vite on :5173, proxies /api)
```

With **Logged-in testing** ticked (enabled only when the credentials file has the URL's site) and a user picked (names only), every action runs as that user. Enter a URL, adjust settings (screenshot mode, full-page, limits, filters…), and trigger Discover / Generate / Run / Heal / Run all. Progress streams live (SSE). Per site you get tabs for **journeys** (inline edit, approve/reject, save), **code** (current + original/healed versions), **runs** (results, errors, traces, screenshots), **tests** (every stored test with its latest outcome and a checkbox; **Heal selected** and **Heal all failed** start a heal job for just those tests and refresh the heals tab when done), **heals** (verdict, reason, attempts, diff; for failed heals the last error and the candidate patch) and **screenshots** (gallery).

> ⚠️ The server executes LLM-generated Playwright tests and spends API credits. It binds to `127.0.0.1` and rejects cross-origin mutating requests; do not expose it publicly or add auth-less port forwarding.

REST API (all JSON): `GET /api/config`, `GET /api/aws-profiles`, `GET /api/auth?url=` (`{configured, users[]}`: names only), `GET /api/models`, `GET /api/sites`, `GET /api/sites/:site`, `PUT /api/sites/:site/journeys`, `GET /api/sites/:site/test-cases`, `GET /api/sites/:site/tests/:id`, `GET /api/sites/:site/runs/:runId`, `GET /api/sites/:site/files/(screenshots|runs)/…`, `POST /api/jobs` `{action, url, options?, journeyIds?, failedOnly?, rediscover?, regenerate?}` (for `heal`, `journeyIds` / `failedOnly` select the tests to heal; unknown ids → `400 {error, validIds, unknownIds}`, `failedOnly` with nothing failing → a job that finishes with `result.noneFailing: true`), `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE).

## Data layout

```
data/sites/<host[_port]>/
  site.json  journeys.json  pages.json  heals.json
  auth/<user>.json                  # Playwright storageState of a logged-in user (0600; session cookies; never served)
  tests/<journey-id>.spec.ts        # plain Playwright Test; imports ./_support
  tests/_support.ts                 # step() fixture, screenshots, failure snapshots (managed by the tool)
  tests/.versions/<id>/{original,healed-N}.spec.ts
  runs/<timestamp>/{result.json, report.json, output.log, failures/, artifacts/ (traces)}
  screenshots/<timestamp>/<journey-id>/*.png   screenshots/discovery/*.png
```

## Architecture

```
src/core    config · credentials · redact · auth · safety · llm/{types,anthropic,mock,schemas,redacting} · storage · discovery · planner · journeys
            · validate · codegen · runner · healer · pipeline
src/cli     commander front-end                 src/server  Fastify REST + SSE (+ serves web/dist)
web/        Vite + React UI                     specs/      SPEC-001…009
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

- Chromium only. Logged-in testing (see above) covers username/password logins with one user per run; no 2FA/CAPTCHA/SSO/sign-up. Without `--auth`, journeys needing accounts/payments are avoided or fail.
- App-bug vs test-breakage classification is the LLM's judgement (guided by the snapshot); review heal logs.
- Discovery models are capped (elements/ARIA text are truncated) to bound prompt size; very large SPAs may need higher `maxPages` / manual journey edits.
- The web UI has no auth and a single in-memory job store (jobs are lost on restart; one job per site at a time).
