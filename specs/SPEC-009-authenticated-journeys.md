# SPEC-009: Logged-in user journey testing (credentials from a local file, never committed, never leaked)

- **Status:** Implemented (v0.9)
- **Depends on:** SPEC-001 (pipeline, storage, runner), SPEC-007 (`listTestCases`), SPEC-008 (job payloads)
- **Stack:** `src/core/{credentials,redact,auth}.ts` (new), `config`, `storage`, `discovery`, `planner`, `codegen`, `validate`, `healer`, `runner`, `support`, `pipeline`, `test-cases`, `src/cli`, `src/server`, `web/src`, `.gitignore`, `credentials.example.json`, README

## 1. Problem

Discovery, planning and generation only see what an anonymous visitor sees, and the planner is told to avoid journeys that
need accounts. Real products are mostly behind a login. We need logged-in journeys, **without** ever putting a real
credential into git, into an LLM prompt, into generated code, or into any stored/streamed/returned artifact.

## 2. Non-goals

- Signing up / creating accounts, 2FA/CAPTCHA/SSO flows, OAuth redirects to third-party IdPs.
- Several users inside one run (a run uses one user; run again with `--user other` for another role).
- A secrets manager. The credentials file (or env vars) is the source of truth.

## 3. Functional requirements

### 3.1 Credentials file

| ID | Requirement |
|----|-------------|
| FR-1 | Default path `.agentic-e2e/credentials.json` (relative to the cwd). Overridable by `--credentials <file>`, config `credentialsFile`, env `AGENTIC_E2E_CREDENTIALS` (precedence: CLI > env > config file > default). An explicit path that does not exist is an error; a missing *default* file means "auth not configured". |
| FR-2 | Format: a JSON object keyed by site (host, `host:port` or a full URL; normalised exactly like storage site ids). Each site is `{ "users": { "<name>": { "username", "password", ...extra string fields } }, "login"?: { loginUrl?, usernameSelector?, passwordSelector?, submitSelector?, successUrl?, successText?, checkUrl? }, "defaultUser"?: "<name>" }`. |
| FR-3 | Any string value may contain `${ENV_VAR}`; it is replaced from the environment when the file is loaded. An unset/empty variable is an error naming the variable (never a value). `login` hints are not secret and may also interpolate. |
| FR-4 | User selection: `--user`/`authUser`, else `defaultUser`, else the only user. Unknown site, unknown user, or ambiguous (several users, no default, none named) are clear errors that list *names only*. |
| FR-5 | **Refuse to load** a credentials file that is tracked by git (`git ls-files --error-unmatch`, run in the file's directory) with an error telling the user to `git rm --cached` it and rotate the secrets. A file outside any repo is fine. |
| FR-6 | Warn (progress `warn`, once per load) when the file's permissions allow group/other access (`mode & 0o077`), suggesting `chmod 600`. Not on Windows. |
| FR-7 | `credentials.example.json` (fake values only) is committed and documented in the README. |
| FR-8 | `.gitignore` ignores `.agentic-e2e/`, `credentials*.json` (but not `credentials.example.json`), `*.credentials.json`, `.auth/`, `**/storageState*.json`. A test runs `git check-ignore` on the default path, other credentials-ish paths and the example path. |

### 3.2 Login and session reuse

| ID | Requirement |
|----|-------------|
| FR-9 | `ensureSession` logs in as the selected user and saves Playwright `storageState` to `<dataDir>/sites/<host>/auth/<user>.json` (dir `0700`, file `0600`; `data/` is gitignored). |
| FR-10 | Login uses the hints when present (`loginUrl`, selectors). Without hints it finds the login page (hint → common paths `/login`, `/signin`, `/sign-in`, `/account/login`) and asks the LLM to locate the form. The LLM prompt contains the page model and the **placeholders** `{{username}}`/`{{password}}`; the real values are only typed locally by Playwright. |
| FR-11 | After submitting, the success condition is checked: `successUrl` (substring or `/regex/`) and/or `successText` (visible text); without either: no visible password field and no still-on-login-URL. Failure throws an error that never contains the credential values. |
| FR-12 | A stored session is **reused while valid**: file present, younger than 12 h, no expired cookies and, when a `checkUrl` (or `successText`) is configured, a live check passes. Otherwise it logs in again. `force` always logs in again. After a run in which an authenticated test failed with a reused session, the session is re-validated and, if dead, refreshed and the authenticated tests re-run once. |
| FR-13 | `auth-check <url> [--user]` always performs a fresh login, refreshes the storageState and reports success/failure and the saved path, never a credential. |

### 3.3 Discovery, planning, generation, running

| ID | Requirement |
|----|-------------|
| FR-14 | With `--auth`, discovery crawls with the stored session. The crawler never follows logout/destructive links (text or href matching log-out / sign-out / delete / remove / cancel (subscription) / deactivate / close account / unsubscribe) and never clicks anything. |
| FR-15 | With `--auth` the planner prompt allows journeys that need the logged-in user, names the available user *names*, and the schema lets it flag `requiresAuth: true` + `user`. Journeys keep these fields in `journeys.json`. Without `--auth` the planner prompt is unchanged and `requiresAuth` is ignored. |
| FR-16 | Generated specs for `requiresAuth` journeys run with the stored storageState (the page is already logged in) and may read the credentials at run time through a `credentials` fixture (`{ username, password }`) from `_support.ts`, backed by env `E2E_USERNAME`/`E2E_PASSWORD` injected by the runner. Specs never contain literal credential values. |
| FR-17 | Codegen/heal validation **rejects** any spec containing a real credential value (or the literal placeholder-free value in any encoding we redact); the retry prompt shows the spec with the value redacted. After the retries the journey is reported as failed generation. |
| FR-18 | The runner runs `requiresAuth` tests in a Playwright project with `storageState`; other tests run without it. Tests needing auth are skipped (with a warning) when `--auth` is off. Tracing is disabled for runs that use a session (traces embed cookies and typed values). |
| FR-19 | The runner env allowlist passes only `E2E_USERNAME`/`E2E_PASSWORD` of the selected user, and only when the run contains authenticated tests. A parent-env `E2E_*` is never forwarded implicitly. |
| FR-20 | A run uses one user; authenticated journeys whose `user` differs from the run's user are skipped with a message (run again with `--user`). |

### 3.4 Secret hygiene

| ID | Requirement |
|----|-------------|
| FR-21 | Every credential value (all fields of all users of all sites in the loaded file) is registered with a `Redactor`. `redact()` replaces an occurrence with its placeholder (`{{username}}`, `{{password}}`, `{{<field>}}`), also in URL-encoded and JSON-escaped form. Values shorter than 3 chars are ignored. |
| FR-22 | LLM requests (system, prompt) go through the redactor; images are not sent to the LLM while auth mode is on (screenshots can show account data). Discovery, planner, codegen, healer and login prompts therefore only ever contain placeholders. |
| FR-23 | The store redacts everything it persists: `journeys.json`, test sources and versions, `pages.json`, run records, heal records. The runner redacts `output.log`, `report.json`, failure snapshots and result errors. Progress events (CLI log and SSE) and job results/errors are redacted. |
| FR-24 | Password fields are masked in screenshots (browser behaviour; asserted on the fixture). storageState files are never served by the file route. |
| FR-25 | `GET /api/auth?url=<url>` returns only `{ configured, users: [names], error? }`. `GET /api/config` never includes `credentialsFile`. Job options accept `auth` (boolean) and `authUser` (name pattern) but never a credentials path. |

### 3.5 Interfaces

| ID | Requirement |
|----|-------------|
| FR-26 | CLI: `--auth`, `--user <name>` and `--credentials <file>` on `discover/generate/run/heal/all`; new `auth-check <url> [--user]`; `list-test-cases` shows an `AUTH` column (`user` name or `-`) and `requiresAuth`/`user` in `--json`. |
| FR-27 | Web: run settings have a **Logged-in testing** toggle and a user selector (names only; disabled with a hint when no credentials are configured for the URL's site); journeys and tests with `requiresAuth` show an **auth** badge. |
| FR-28 | README documents the credentials file, the secret-handling guarantees and the limitations. |

## 4. Secret handling (summary of guarantees and how each is enforced)

1. **Not in git** — `.gitignore` patterns + `git check-ignore` test + tracked-file refusal (FR-5, FR-8).
2. **Not in LLM prompts** — placeholders; `RedactingLLM` wrapper as defence in depth; images dropped (FR-10, FR-22).
3. **Not in generated code** — fixture indirection (env read lives in trusted `_support.ts`), codegen/heal rejection (FR-16, FR-17); specs still cannot touch `process`.
4. **Not in stored data** — store/runner redaction (FR-23). Scanned in the integration test over all of `data/`.
5. **Not in logs / SSE / API** — wrapped `onProgress`, redacted job result/error, names-only auth route (FR-23, FR-25).
6. **Not in the test subprocess unless needed** — allowlist + explicit injection of two variables (FR-19).
7. **Residual**: storageState files hold session cookies (gitignored, `0600`, not served); a spec could still `fill()` the password into a page that echoes it — that is caught by redaction in artifacts, not prevented.

## 5. Acceptance criteria (Given / When / Then)

- **AC-1** Given a valid file, When loaded, Then `userNames(site)` lists names only and `get(site, user)` returns username/password/extra.
- **AC-2** Given `"password": "${E2E_PW}"` and `E2E_PW=x`, Then the loaded password is `x`; with `E2E_PW` unset the error mentions `E2E_PW` and no value.
- **AC-3** Given an unknown site / unknown user / ambiguous user, Then a clear error listing names only.
- **AC-4** Given the file is tracked by git, Then loading throws a `CredentialsError` mentioning `git rm --cached`; untracked-in-repo and outside-repo files load.
- **AC-5** Given mode `0644`, Then a warning is emitted; with `0600` none.
- **AC-6** `--credentials`, env, config file and default resolve with the stated precedence; an explicit missing file errors, a missing default yields an empty store.
- **AC-7** `git check-ignore` ignores the default path, `credentials.json`, `credentials.prod.json`, `x.credentials.json`, `.auth/a.json`, `data/sites/h/auth/u.json`, `a/storageState.json`, and does **not** ignore `credentials.example.json`.
- **AC-8** `redact()` replaces plain, URL-encoded and JSON-escaped occurrences with placeholders, ignores short values, handles regex metacharacters, and `redactDeep` walks objects/arrays.
- **AC-9** Given the fixture site and hints, `ensureSession` logs in, writes `auth/<user>.json` with the session cookie and without the password.
- **AC-10** Given a fresh stored session, a second `ensureSession` performs no second login; after the server expires sessions (and a `checkUrl` is set) or cookies are expired in the file or `force` is set, it logs in again.
- **AC-11** Given wrong credentials, `ensureSession` throws and the message contains neither value.
- **AC-12** Given no hints, the LLM is asked to locate the form, its prompt contains `{{username}}`/`{{password}}` and no real value, and login succeeds with its selectors.
- **AC-13** `isDestructiveLink` flags logout/sign-out/delete/remove/cancel subscription/deactivate and not ordinary links; an authenticated crawl of the fixture never requests `/logout` or `/account/delete`, and sees the account page.
- **AC-14** With `--auth` the planner prompt mentions the user names and permits account journeys and `requiresAuth`/`user` survive into the journeys; without it the prompt keeps the "avoid accounts" rule and `requiresAuth` is dropped.
- **AC-15** A generated spec containing the real password is rejected by validation and by `generateSpec`; the retry prompt does not contain the password; the next clean attempt is accepted.
- **AC-16** The spec may use `credentials.password`; the `_support` fixture exposes env `E2E_USERNAME`/`E2E_PASSWORD`.
- **AC-17** `buildRunnerEnv` drops a parent `E2E_PASSWORD`; the runner passes only the selected user's two variables, and none when the run has no authenticated tests.
- **AC-18** Pipeline integration (mocked LLM, fixture site, real Playwright): `discover --auth → generate → run` yields a passing authenticated journey (which would fail without the storageState) plus a passing credentials-fixture journey; the password and the username appear in **no** file under `data/`, in **no** LLM request and in **no** progress event.
- **AC-19** Without `--auth`, authenticated journeys are not generated and are skipped on run with a warning.
- **AC-20** `GET /api/auth?url=` returns `{configured, users}` only; `/api/config` has no `credentialsFile`; a job with `options.credentialsFile` is rejected; `GET /api/sites/:s/files/auth/...` is 403; job results/events never contain the secrets.
- **AC-21** CLI parses `--auth/--user/--credentials`; `auth-check` succeeds against the fixture and prints no secret; `list-test-cases` shows the AUTH column.
- **AC-22** Web typecheck passes with the toggle, user selector and badge (no browser test infrastructure exists; verified by typecheck).
