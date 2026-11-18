# SPEC-014: Deployment & security (API auth, roles, hardening, Docker, config validation, storage interface)

- **Status:** Implemented (v0.14)
- **Depends on:** SPEC-001 (server, storage), SPEC-008 (job payloads), SPEC-009 (secret hygiene)
- **Stack:** `src/core/security/*` (new), `src/core/storage/*` (new), `src/core/config-check.ts` (new), `src/server/{security,lifecycle}.ts` (new),
  `src/cli/commands/*` (new), `web/src/{AuthGate,auth}.tsx` (new), `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` (new);
  minimal edits to `src/server/{app,index,jobs}.ts`, `src/core/config.ts`, `src/cli/index.ts`, `web/src/{api,main}.ts(x)`, README

## 1. Problem: gaps in the current code (reviewed at d640cd7)

| # | Gap | Where |
|---|-----|-------|
| G-1 | **No authentication.** Anyone who reaches the port can discover/generate/run/heal (runs generated code, spends LLM credits) and rewrite journeys. The only defences are a Host allowlist and JSON content type, which are fine against browsers but not against a network client. | `src/server/app.ts` |
| G-2 | **No authorisation / roles.** Every caller can do everything. | `src/server/app.ts` |
| G-3 | **Cannot be deployed.** With `--host 0.0.0.0` the Host allowlist only accepts `localhost`/`127.0.0.1`/`[::1]`, so a container behind a hostname answers 403 to everything. There is no way to configure allowed hosts. | `app.ts` host hook |
| G-4 | No rate limiting (job creation and token guessing are unbounded). | server |
| G-5 | No security headers (CSP, frame-ancestors, nosniff (only on files), referrer policy, …). | server |
| G-6 | Request body size relies on Fastify's implicit 1 MiB default; not configurable, not documented. | server |
| G-7 | No graceful shutdown: `serve` waits on a never-resolving promise; SIGTERM kills running jobs mid-write. | `src/cli/index.ts`, `src/server/index.ts` |
| G-8 | Only `/api/health` (always ok); no liveness/readiness split for orchestrators (readiness should fail while draining or when the data dir is not writable). | `app.ts` |
| G-9 | No container image, compose file or `.dockerignore`; nothing prevents `data/` or credentials being baked into an image. | repo root |
| G-10 | Config is not strict: unknown keys (typos like `maxPage`) are silently ignored, errors don't say what was expected, and there is no command to validate or print the effective config. | `src/core/config.ts` |
| G-11 | Storage is a concrete synchronous filesystem class used everywhere; there is no seam for S3 or another backend. | `src/core/storage.ts` |
| G-12 | Web UI has no notion of a login; `EventSource`, `<img src>` and `<a href>` cannot send an `Authorization` header. | `web/src` |

## 2. Non-goals

- Users/passwords, OAuth/OIDC/SSO, per-site permissions, token expiry dates (tokens are revoked by removing their hash).
- TLS termination (put a reverse proxy in front; `Secure` cookies are set when the request arrives over https / `x-forwarded-proto: https` with `trustProxy`).
- An S3 implementation, and migrating the synchronous `Store` onto the async backend (follow-up; the interface + contract tests make that mechanical).
- Distributed rate limiting (in-memory per process).

## 3. Functional requirements

### 3.1 API tokens (`src/core/security/tokens.ts`)

| ID | Requirement |
|----|-------------|
| FR-1 | A token is `ae2e_` + 43 chars of base64url (32 random bytes). `agentic-e2e token create --name <n> --role <r> [--file <tokens.json>]` prints the raw token **once**; with `--file` it appends the hashed entry (file created `0600`), otherwise it prints the env-var line. `token hash` reads a token on stdin and prints its hash. `token list --file` prints names and roles only. |
| FR-2 | **Hashed at rest:** only `sha256:<64 hex>` hashes are stored. Tokens file: `{ "tokens": [{ "name", "role", "hash" }] }`. Env: `AGENTIC_E2E_API_TOKENS="name:role:sha256:<hex>,…"`. File path: `server.tokensFile` / env `AGENTIC_E2E_API_TOKENS_FILE` / `serve --tokens-file`. Both sources are merged. |
| FR-3 | Loading rejects: a raw token (`ae2e_…`) where a hash is expected (error tells you to run `token hash`), a malformed hash, an unknown role, a bad/duplicate name, duplicate hashes. Errors never contain a token or hash value. A group/other-readable tokens file produces a warning. |
| FR-4 | Verification hashes the presented token and compares with `crypto.timingSafeEqual` against every entry (constant work per entry). |
| FR-5 | Names: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Roles: `viewer` < `operator` < `admin`. |

### 3.2 Roles & permissions (`src/core/security/roles.ts`, `src/server/security.ts`)

| Route | Required role |
|-------|---------------|
| `GET /healthz`, `GET /readyz`, `GET /api/health`, `GET/POST/DELETE /api/session`, static UI assets (non-`/api`) | public |
| any other `GET /api/*` | viewer |
| `POST /api/jobs` with `action` `run` or `heal` | operator |
| `POST /api/jobs` with `discover`, `generate`, `all` | admin |
| `POST /api/jobs` whose `options` *change* a setting (any key other than the run-time keys `screenshots, fullPage, headless, healAttempts, include, exclude, testTimeoutMs, timeoutMs, auth, authUser`, with a value different from the server config) | admin |
| `PUT /api/sites/:site/journeys` (approve / reject / edit) | admin |
| any other mutating `/api/*` request (secure default) | admin |

| ID | Requirement |
|----|-------------|
| FR-6 | Missing/invalid credentials → `401 {"error":"Authentication required"}` with `WWW-Authenticate: Bearer`. Insufficient role → `403 {"error":"Requires role <r>"}`. Neither response nor any log line contains the presented token. |
| FR-7 | Credentials: `Authorization: Bearer <token>` **or** the session cookie (FR-8). |
| FR-8 | `POST /api/session` with a Bearer token (or `{ "token" }` body) creates an in-memory session (random 32-byte id, TTL `server.sessionTtlMs`, default 12 h) and sets cookie `ae2e_session` `HttpOnly; SameSite=Strict; Path=/` (+`Secure` over https). `GET /api/session` → `{ authRequired, authenticated, name?, role? }`. `DELETE /api/session` revokes it. This is how the web UI authenticates `EventSource`, images and downloads. CSRF stays covered by SameSite=Strict + the existing JSON content type + Origin checks. |
| FR-9 | **Insecure local mode** is explicit: `serve --insecure-local` (or `startServer({ auth: { mode: 'insecure-local' } })`). It is refused unless the bind host is loopback (`127.0.0.1`, `localhost`, `::1`). Every request is then treated as `admin`; startup prints a warning. Without tokens and without `--insecure-local`, `serve` refuses to start with an error explaining both options. |
| FR-10 | `buildApp()` without an `auth` option keeps the previous behaviour (no auth) **only** for loopback hosts, so in-process callers/tests are unaffected; with a non-loopback host it throws. `startServer` always passes an explicit mode. |

### 3.3 Hardening (`src/server/security.ts`)

| ID | Requirement |
|----|-------------|
| FR-11 | Existing Host allowlist, JSON content-type and Origin checks are kept. New `server.allowedHosts` (env `AGENTIC_E2E_ALLOWED_HOSTS`, comma-separated) adds hostnames so a deployment behind `e2e.example.com` works. |
| FR-12 | `@fastify/helmet`: CSP `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options`, HSTS only when https. |
| FR-13 | `@fastify/rate-limit`: global `server.rateLimit.max` (default 300) per `timeWindowMs` (default 60 000) per client IP; `POST /api/session` limited to `server.rateLimit.loginMax` (default 10) per window; `/healthz` and `/readyz` exempt. Over the limit → 429 JSON. |
| FR-14 | Request size: `server.bodyLimitBytes` (default 1 MiB) → 413 JSON when exceeded. |
| FR-15 | `GET /healthz` → `200 {"status":"ok"}` (liveness, no I/O). `GET /readyz` → `200 {"status":"ready"}` when not draining and the storage backend health check (write/read/delete a probe) passes; otherwise `503 {"status":"draining"|"unavailable"}` (no paths/errors leaked). |
| FR-16 | Graceful shutdown on SIGTERM/SIGINT: mark draining (readyz 503, new `POST /api/jobs` → 503), wait for running jobs up to `server.shutdownTimeoutMs` (default 30 s), close the server, exit 0. A second signal exits immediately. |

### 3.4 Config validation (`src/core/config-check.ts`)

| ID | Requirement |
|----|-------------|
| FR-17 | The config file is strict: unknown keys (top level and in `server`) are errors with a "did you mean `<closest>`?" suggestion (Levenshtein ≤ 3). |
| FR-18 | Errors list every issue as `<path>: <message> (expected …, got <type>)` with the source (`config file <name>`), never the value of a key (values can be secrets). |
| FR-19 | `agentic-e2e config validate [--config f]` prints `Configuration OK (<file or defaults>)` and exits 0, or the error list and exits 1. `agentic-e2e config show` prints the effective merged config as JSON (env + file + CLI), with `server.tokens*` elided and never a token, hash or credential. |
| FR-20 | `server` block: `{ allowedHosts: string[], tokensFile?, bodyLimitBytes, rateLimit: { max, timeWindowMs, loginMax }, sessionTtlMs, shutdownTimeoutMs, trustProxy }`, all with defaults. It is **not** overridable per job. |

### 3.5 Storage interface (`src/core/storage/`)

| ID | Requirement |
|----|-------------|
| FR-21 | `StorageBackend` (async): `read`, `write` (atomic), `exists`, `stat`, `list(prefix)` (recursive, sorted, relative keys), `delete` (idempotent), `createReadStream`, `healthCheck`. Keys are relative POSIX paths; absolute paths, `..`, `\`, empty segments and NUL are rejected (`InvalidKeyError`). |
| FR-22 | `FilesystemBackend(root)` implements it (tmp-file + rename writes, `0600` optional mode). `createStorageBackend({ kind, ... })` + `registerStorageBackend(kind, factory)` let other backends plug in; `filesystem` is the default and only built-in. |
| FR-23 | A reusable contract suite (`test/helpers/storage-contract.ts`) defines the behaviour every backend must pass; it runs against `FilesystemBackend`. |
| FR-24 | The server uses the backend for `/readyz` and for streaming `/api/sites/:site/files/*` (traversal checks unchanged). |

### 3.6 Container (`Dockerfile`, `docker-compose.yml`, `.dockerignore`)

| ID | Requirement |
|----|-------------|
| FR-25 | Multi-stage `Dockerfile`: `build` stage from `mcr.microsoft.com/playwright:v<playwright version>-noble` (pnpm via corepack, frozen lockfile, `pnpm build`), runtime stage from the same image with prod deps only, `dist/`, `web/dist/`, `bin/`; runs as the non-root `pwuser`; `HEALTHCHECK` on `/healthz`; `CMD serve --host 0.0.0.0`. No `COPY` of credentials, tokens or data. |
| FR-26 | `docker-compose.yml`: named volume for `/app/data`, `env_file: .env`, credentials and the tokens file mounted as compose **secrets** (read-only under `/run/secrets`), pointing `AGENTIC_E2E_CREDENTIALS` / `AGENTIC_E2E_API_TOKENS_FILE` at them; `read_only` root fs + tmpfs `/tmp`, `no-new-privileges`. `.env.example` documents the variables with fake values. |
| FR-27 | `.dockerignore` excludes `data/`, `.agentic-e2e/`, `credentials*.json` (except the example), `*.credentials.json`, `tokens*.json`, `.env*` (except `.env.example`), `node_modules`, `dist`, `web/dist`, `.git`. `.gitignore` also ignores `tokens*.json` and `.env`. |

### 3.7 Web UI

| ID | Requirement |
|----|-------------|
| FR-28 | On load the UI calls `GET /api/session`. If auth is required and there is no session it shows a token-entry screen (password-type input, never persisted to localStorage/sessionStorage; sent once to `POST /api/session`). A bar shows `<name> (<role>)` and a "Sign out" button. Any 401 from the API returns to the token screen. |

## 4. Secret handling (preserving SPEC-009)

- Raw API tokens exist only in the `token create` stdout and in the client. Hashes are stored; tokens/hashes are never logged, returned, or included in errors.
- The `Authorization` header and `ae2e_session` cookie are never logged (`logger: false` stays; error handlers don't echo headers).
- `config show` and `GET /api/config` never include `server`, tokens, credentials paths, or env var names.
- The image never contains credentials/tokens/data (`.dockerignore` + test), and they are mounted read-only at runtime.

## 5. Acceptance criteria (Given / When / Then)

**Tokens**
- AC-1: Given `generateToken()`, when called twice, then both match `^ae2e_[A-Za-z0-9_-]{43}$` and differ; `hashToken(t)` matches `^sha256:[0-9a-f]{64}$`.
- AC-2: Given a token registry with a hashed entry, when `verify(token)` is called with the right token, then `{ name, role }` is returned; with a wrong/empty token, `null`.
- AC-3: Given an env value containing a raw `ae2e_…` token, when parsed, then it throws mentioning `token hash` and the error does not contain the token.
- AC-4: Given an unknown role / malformed hash / duplicate name, when loaded, then a helpful error naming the entry (not the hash) is thrown.
- AC-5: Given a tokens file with mode 0644, when loaded, then a warning is emitted.

**Roles**
- AC-6: Given role viewer, when `GET /api/sites`, then 200; when `POST /api/jobs {action:"run"}`, then 403.
- AC-7: Given role operator, when `POST /api/jobs {action:"run"}` with options equal to `/api/config`, then 202; when `{action:"discover"}`, then 403; when `{action:"run", options:{model:"other"}}`, then 403; when `PUT …/journeys`, then 403.
- AC-8: Given role admin, when `POST /api/jobs {action:"discover"}` or `PUT …/journeys`, then not 401/403.
- AC-9: Given auth mode tokens, when a request has no / an invalid Bearer token, then 401 with `WWW-Authenticate: Bearer` and the body does not echo the token.
- AC-10: Given a valid token, when `POST /api/session`, then a `HttpOnly; SameSite=Strict` `ae2e_session` cookie is set and a subsequent cookie-only `GET /api/sites` is 200 and `GET /api/session` reports name and role; after `DELETE /api/session` the cookie is rejected (401).
- AC-11: Given auth mode tokens, when `GET /healthz`, `/readyz`, `/api/health`, `GET /api/session`, then no auth is required.

**Modes**
- AC-12: Given no tokens and no `--insecure-local`, when the server starts, then it fails with a message naming `--insecure-local` and `token create`.
- AC-13: Given `--insecure-local` with host `0.0.0.0`, when the server starts, then it fails (loopback only); with `127.0.0.1`, any request is admin and `GET /api/session` reports `authRequired:false`.
- AC-14: Given `buildApp` without `auth` and host `0.0.0.0`, then it throws; with no host it behaves as before (existing tests pass unchanged).

**Hardening**
- AC-15: Given any response, then it has `content-security-policy` containing `frame-ancestors 'none'`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
- AC-16: Given `rateLimit.max = 3`, when 4 requests are made, then the 4th is 429; `/healthz` is never limited. Given `loginMax = 2`, the 3rd `POST /api/session` is 429.
- AC-17: Given `bodyLimitBytes = 1024`, when a 2 KiB JSON body is posted, then 413.
- AC-18: Given the Host allowlist, a request with `Host: evil.test` is still 403, a non-JSON POST is still 415, and with `allowedHosts: ["e2e.example.com"]` a request with that Host is accepted.
- AC-19: `GET /healthz` → 200 `{status:"ok"}`; `GET /readyz` → 200 `{status:"ready"}`; after draining starts `/readyz` → 503 `{status:"draining"}` and `POST /api/jobs` → 503; when the storage health check fails `/readyz` → 503 `{status:"unavailable"}` with no path in the body.
- AC-20: Given a running job, when `shutdown()` is called, then it waits for the job (up to the timeout) and then closes the server.

**Config**
- AC-21: Given a config file with `maxPage: 3`, when validated, then the error says `maxPage: unknown key (did you mean "maxPages"?)`.
- AC-22: Given `maxPages: "ten"`, then the error says `maxPages` expected number, got string, and does not include `ten`.
- AC-23: `config validate` exits 0 with `Configuration OK` on a valid file and 1 with the error list on an invalid one; `config show` prints JSON without token data.
- AC-24: Given a job request with `options.server`, then it is rejected (400).

**Storage**
- AC-25: `FilesystemBackend` passes the storage contract suite (round trip text/binary, overwrite, missing → null/false, list by prefix sorted & recursive, delete idempotent, stat size, stream, invalid keys rejected, atomic write leaves no temp files, healthCheck).
- AC-26: Given `createStorageBackend({kind:"nope"})`, then it throws listing known kinds; after `registerStorageBackend("mem", f)` it returns the custom backend.

**Container**
- AC-27: The Dockerfile has ≥2 `FROM` stages based on `mcr.microsoft.com/playwright` with the same version as the `playwright` dependency, a non-root `USER`, a `HEALTHCHECK`, and no `COPY` of `data`, credentials, tokens or `.env`.
- AC-28: `.dockerignore` excludes `data/`, credentials, tokens and `.env` but `credentials.example.json` remains included; `docker-compose.yml` uses a named data volume, `env_file`, and `secrets` for credentials + tokens.
