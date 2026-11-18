# SPEC-013: Observability & LLM governance

- **Status:** Implemented (v0.13)
- **Depends on:** SPEC-001 (pipeline, storage, server jobs), SPEC-002/005 (providers, Bedrock), SPEC-009 (`Redactor`, secret hygiene)
- **Stack:** new `src/core/obs/{logger,secrets,audit,tracing,usage-store,config,index}.ts`, new `src/core/llm/{governed,retry,usage,response-cache}.ts`;
  small edits to `llm/{types,anthropic,index,models}.ts`, `config.ts`, `pipeline.ts`, `codegen.ts`, `healer.ts`, `auth.ts`, `server/{app,jobs}.ts`,
  `cli/index.ts` (+ new `cli/obs-commands.ts`), `web/src`, README

## 1. Problem — gaps in the current code (d640cd7)

| # | Gap |
|---|-----|
| G-1 | No logging layer at all: a handful of `console.log/error` calls, no levels, no machine-readable format, no way to turn on debug output. |
| G-2 | Nothing ties the output of one CLI command / web job together: no correlation id, run ids are not logged. |
| G-3 | `console.error` in `server/app.ts` prints raw error messages; nothing guarantees that API keys (`ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, AWS secret keys) or credential values never reach a log line. |
| G-4 | `LLMProvider.structured()` returns only the parsed output: token usage, latency, cache hits and model are thrown away; cost is unknown. |
| G-5 | No spend limits: a large site or a heal loop can spend without bound. |
| G-6 | Retries are whatever the Anthropic SDK does by default (2 retries, no visibility); no request timeout is configured beyond the SDK's 10 min default. |
| G-7 | No prompt caching: every call sends `system` as a plain string. |
| G-8 | Re-running `generate`/`discover` (e.g. in CI) pays for identical prompts again; there is no response cache. |
| G-9 | No record of who discovered, generated, applied a heal patch or approved/rejected journeys, and when. |
| G-10 | No tracing; nothing can be exported to an OpenTelemetry backend. |

## 2. Non-goals

- Exact billing. Costs are **estimates** from Anthropic first-party list prices (Bedrock is billed by AWS at its own rates).
- A full OpenTelemetry SDK dependency. A small built-in OTLP/HTTP-JSON exporter is enough (traces only, no metrics/logs signals).
- Persisting raw prompts or model responses in logs. The response cache stores parsed outputs only, and only when opted in.
- Tamper-*proof* audit storage. The audit log is append-only and hash-chained so tampering is *detectable*.

## 3. Functional requirements

### 3.1 Structured logging

| ID | Requirement |
|----|-------------|
| FR-1 | A pino-based logger (`createLogger`) with levels `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Config `logLevel` (default `warn`), `logFormat` `pretty`\|`json` (default `pretty`); env `AGENTIC_E2E_LOG_LEVEL` / `AGENTIC_E2E_LOG_FORMAT`; CLI `--log-level` / `--log-format`. Logs go to **stderr** so stdout (human output, `--json`) is unaffected. |
| FR-2 | `json` writes one JSON object per line with `level` (label), `time` (ISO), `msg` and bindings. `pretty` writes `HH:MM:SS.mmm LEVEL msg key=value …` (no extra dependency). |
| FR-3 | Every CLI command / web job gets a **correlation id** (`correlationId`, a UUID; the job id for web jobs) bound to every log line of that job, plus `action` and `site`. Test runs log their `runId`; LLM calls log `call` index. |
| FR-4 | Progress events are mirrored to the log at `debug` (they are already shown to the user); operational events use real levels: LLM call `info`, retry `warn`, budget stop / failed call `error`, exporter failures `warn`. |

### 3.2 Secret redaction (SPEC-009 guarantees extended to logs/traces)

| ID | Requirement |
|----|-------------|
| FR-5 | Every log line passes, **after serialisation**, through a `Redactor` (from `src/core/redact.ts`) that knows (a) every credential value of the loaded credentials file and (b) the values of secret env vars: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ACCESS_KEY_ID`, `E2E_PASSWORD`, `E2E_USERNAME`, and any `OTEL_EXPORTER_OTLP_HEADERS` value. Env secrets are replaced with `[REDACTED]`. |
| FR-6 | Additionally, well-known secret shapes are scrubbed even if not known: Anthropic keys `sk-ant-…`, AWS access key ids `AKIA…/ASIA…`, Bedrock API keys `ABSK…`, `Bearer <token>`, and values of keys named `password`, `apiKey`, `authorization`, `token`, `secret`, `x-api-key` (pino `redact` paths). |
| FR-7 | The same redaction applies to trace span attributes/events before export, to audit entries, to usage reports and to the response cache. |

### 3.3 LLM usage accounting

| ID | Requirement |
|----|-------------|
| FR-8 | Providers may implement `structuredDetailed(req, { signal })` returning `{ data, usage?, model? }`. `AnthropicProvider` (first-party and Bedrock) returns `usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` from the response. Providers without it (e.g. `MockLLM`) are recorded with zero tokens. |
| FR-9 | `src/core/llm/models.ts` holds a **pricing table** (USD per million tokens: input, output, 5-minute cache write, cache read) for the catalog models (+ Fable 5.2, Opus 5, Sonnet 5). `modelPricing(id)` resolves bare, `anthropic.`-prefixed, inference-profile-prefixed (`global.anthropic.…`), date-suffixed and `-v1:0`-suffixed ids. `estimateCostUsd(model, usage)` returns `undefined` for an unknown model. |
| FR-10 | Each call is recorded: `{ n, name, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, latencyMs, costUsd?, retries, cached, ok, error?, at }`. Totals: calls, failed, cached, retries, tokens by kind, `costUsd`, `unpricedCalls`. |
| FR-11 | At the end of every CLI command / web job that touched a site, a **usage report** `{ id: correlationId, action, site, actor, startedAt, finishedAt, status, provider, model, budget, totals, calls }` is written to `<dataDir>/sites/<site>/usage/<id>.json` (only when at least one LLM call was made). |
| FR-12 | The CLI prints a one-line summary after each command that made LLM calls: `LLM: 5 calls (1 cached, 0 failed), 12,345 in / 2,345 out tokens (cache r/w 0/0), est. $0.0612`. New command `usage <url> [--json] [--limit n]` lists stored reports (JSON = the report objects). |
| FR-13 | Server: `GET /api/sites/:site/usage` returns the reports (newest first); each web job exposes `usage` totals and emits an `info` event (`stage: "llm"`) with the summary before its terminal event. The web UI has a **Usage** tab (per-report table + site total) and shows the summary in the progress log. |

### 3.4 Budgets

| ID | Requirement |
|----|-------------|
| FR-14 | Config `llmBudget: { maxCostPerRun?: number (USD > 0), maxTokensPerRun?: int > 0 }` (CLI `--max-cost <usd>`, `--max-tokens-per-run <n>`). "Run" = one CLI command / web job (one usage tracker). Tokens = input + output + cache read + cache write. |
| FR-15 | Before each call, if a limit is already reached (`>=`), the call is not made; after each call, if a limit is exceeded (`>`), an `LLMBudgetError` is thrown. The message names the limit, the amount spent, the call count, and how to raise it (`llmBudget.maxCostPerRun` / `--max-cost`). Cached responses cost nothing and are allowed. |
| FR-16 | `LLMBudgetError` is never swallowed: codegen (per-journey catch), the healer (per-attempt catch; it still restores the original test) and login (error wrapping) re-throw it, so the command/job ends with that error (CLI exit 1, job `status: error`). The usage report is still written (`status: "error"`). |
| FR-17 | A cost budget with an unpriced model logs a `warn` once ("cost budget cannot be enforced for model X"); the token budget still applies. Web clients cannot change `llmBudget` (the server's budget protects its credits). |

### 3.5 Retries and timeouts

| ID | Requirement |
|----|-------------|
| FR-18 | Calls are retried with exponential backoff and **full jitter** (`delay = random() * min(maxDelay, base * 2^attempt)`, base 500 ms, max 20 s) on HTTP 408, 409, 429, 5xx (incl. 529), connection errors and request timeouts. Not retried: other 4xx, `LLMOutputError` (schema), `LLMBudgetError`. A `retry-after` header (seconds) raises the delay to at least that value (capped at 60 s). |
| FR-19 | Config `llmMaxRetries` (default 3) and `llmTimeoutMs` (per attempt, default 300 000). The timeout aborts the request (`AbortSignal` passed to the SDK) and raises `LLMTimeoutError`. The SDK's own retries are disabled per request (`maxRetries: 0`) so retries are not compounded. Each retry is logged at `warn` with status, attempt and delay, and counted in the call record. |

### 3.6 Prompt caching

| ID | Requirement |
|----|-------------|
| FR-20 | Config `promptCaching` (default `true`): `AnthropicProvider` sends `system` as one text block with `cache_control: { type: "ephemeral" }` (an explicit breakpoint, which the legacy Bedrock runtime also accepts; top-level automatic caching is not used because legacy Bedrock rejects it on older models). With `promptCaching: false` `system` stays a plain string. Cache read/write tokens are taken from `usage.cache_read_input_tokens` / `cache_creation_input_tokens` and priced separately. |

### 3.7 Deterministic response cache (opt-in)

| ID | Requirement |
|----|-------------|
| FR-21 | Config `llmCache`: `off` (default) \| `read-write` \| `read-only` (CLI `--llm-cache`, env `AGENTIC_E2E_LLM_CACHE`). Key = SHA-256 of a canonical JSON of `{ v, provider, model, name, description, system, prompt, JSON-schema of the output, SHA-256 of each image }` — computed on the already-redacted request. |
| FR-22 | Entries live in `<dataDir>/llm-cache/<key[0..2]>/<key>.json` as `{ key, name, model, createdAt, output }`, written through the context `Redactor`. A hit is re-validated against the schema (an invalid entry is a miss), is recorded as `cached: true` with zero tokens/cost, and makes no network call. `read-only` never writes (CI). |

### 3.8 Audit log

| ID | Requirement |
|----|-------------|
| FR-23 | Append-only JSON Lines file `<dataDir>/audit.jsonl` (opened with `a`, never rewritten). Entry: `{ at, actor, action, site?, correlationId?, details, prev, hash }`, `hash = sha256(prev + canonical entry)`, `prev` = previous entry's hash (or 64 zeros), so edits/deletions are detectable by `verifyAuditLog`. |
| FR-24 | Actions recorded: `discover` (pages, journeys, user name), `generate` (generated/failed/reused ids), `heal.patch_applied` (journeyId, heal id, lines added/removed), `journeys.status_changed` (`[{ id, from, to }]`) from CLI `journeys --approve/--reject/--approve-all/--edit` and `PUT /api/sites/:site/journeys`. |
| FR-25 | Actor: `cli:<os user>` for the CLI, `web:<client ip>` for the server. Entries are redacted. CLI `audit [--site <id>] [--limit n] [--json] [--verify]`. |

### 3.9 OpenTelemetry tracing (optional)

| ID | Requirement |
|----|-------------|
| FR-26 | Off by default. Enabled only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED` is not `true`. Spans are POSTed as OTLP/HTTP JSON to `<endpoint>/v1/traces` (or the traces endpoint as-is), with headers from `OTEL_EXPORTER_OTLP_HEADERS` and `service.name` from `OTEL_SERVICE_NAME` (default `agentic-e2e`). |
| FR-27 | Spans: a root span per command/job (`agentic-e2e.<action>`, trace id = correlation id without dashes), a child span per pipeline stage (from `stage` progress events), and a child span per LLM call with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.usage.input_tokens`/`output_tokens`, `agentic_e2e.cost_usd`, `agentic_e2e.cached`, `agentic_e2e.retries`; errors set status `ERROR`. Spans are flushed at the end of the command/job. Export failures are logged at `warn` and never fail the command. |

## 4. Acceptance criteria

| ID | Given / When / Then |
|----|---------------------|
| AC-1 | **Given** `logFormat: json`, `logLevel: info` **when** a context logs `llm.call` **then** stderr gets one JSON line with `level: "info"`, `msg`, `correlationId`, `action`. |
| AC-2 | **Given** `logLevel: warn` **when** `info` and `warn` lines are logged **then** only the `warn` line is written; `silent` writes nothing. |
| AC-3 | **Given** `logFormat: pretty` **when** a line is logged **then** it reads `HH:MM:SS.mmm WARN msg key=value`. |
| AC-4 | **Given** a credentials file with password `s3cr3t-pw`, `ANTHROPIC_API_KEY=sk-ant-api03-REALKEY…` in the env **when** a log line contains the password, the key value, an unrelated `sk-ant-…` string, `Bearer abc.def.ghi`, or an object field `password` **then** none of those values appear in the output (placeholders / `[REDACTED]` instead). |
| AC-5 | **Given** a provider returning usage `{input 1000, output 500, cache read 2000, cache write 100}` on `claude-sonnet-5-5` **when** one call is made **then** the record has those tokens and `costUsd = (1000·2 + 500·10 + 2000·0.10 + 100·2.5) / 1e6`. |
| AC-6 | **Given** model ids `claude-opus-5-5`, `global.anthropic.claude-opus-5-5`, `anthropic.claude-haiku-4-5-20251001-v1:0` **when** pricing is looked up **then** the right rows are found; `my-custom-model` → `undefined` and cost `undefined`. |
| AC-7 | **Given** `llmBudget.maxCostPerRun: 0.01` and calls costing $0.008 each **when** the second call completes **then** `LLMBudgetError` (message names `maxCostPerRun` and the spent amount) is thrown, and a third call is refused without reaching the provider. |
| AC-8 | **Given** `maxTokensPerRun: 1000` **when** usage reaches 1200 tokens **then** `LLMBudgetError` mentions `maxTokensPerRun`. |
| AC-9 | **Given** a budget error inside `generateTests` / `healTest` **then** it propagates (not recorded as a per-journey failure / heal outcome) and the healer restored the original test. |
| AC-10 | **Given** a provider failing with status 429 then 500 then succeeding **when** called with `llmMaxRetries: 3` **then** it succeeds, `retries: 2`, sleeps were jittered exponential (`random·500`, `random·1000`), and two `warn` lines were logged. |
| AC-11 | **Given** status 400 or an `LLMOutputError` **then** no retry. **Given** 503 forever and `llmMaxRetries: 2` **then** 3 attempts and the last error is thrown and recorded `ok: false`. |
| AC-12 | **Given** a `retry-after: 3` header **then** the delay is ≥ 3000 ms. **Given** a provider that hangs and `llmTimeoutMs: 50` **then** the attempt is aborted (signal aborted) with `LLMTimeoutError` and retried. |
| AC-13 | **Given** `promptCaching: true` **then** the request's `system` is `[{ type: "text", text, cache_control: { type: "ephemeral" } }]` and `maxRetries: 0` + `signal` are passed as request options; **given** `false` **then** `system` is the plain string. |
| AC-14 | **Given** `llmCache: read-write` **when** the same request is made twice **then** the provider is called once, the second record is `cached: true`, cost 0, and an entry file exists under `llm-cache/`. A different prompt is a miss. **Given** `read-only` with an empty cache **then** no file is written. **Given** auth mode **then** the cache file contains no credential value. |
| AC-15 | **Given** audit entries appended **then** `verifyAuditLog` is `ok`; **when** a line is edited or removed **then** it reports the first broken line. Credential values in details are redacted. |
| AC-16 | **Given** stored journeys **when** the CLI approves one / `PUT /api/sites/:site/journeys` rejects one **then** `journeys.status_changed` is appended with `{ id, from, to }` and actor `cli:*` / `web:*`. |
| AC-17 | **Given** a full mocked pipeline (`runAll`) **then** the audit log has `discover`, `generate`, and `heal.patch_applied` entries sharing the run's correlation id, and a usage report exists under `sites/<site>/usage/`. |
| AC-18 | **Given** no OTLP endpoint env **then** the tracer is a no-op (no fetch). **Given** `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` **when** a job finishes **then** one POST to `http://collector:4318/v1/traces` carries `resourceSpans` with the root, stage and LLM spans (32-hex trace id, 16-hex span ids, parent links, `gen_ai.*` attributes) and headers from `OTEL_EXPORTER_OTLP_HEADERS`; attribute values are redacted; a failing fetch does not throw. |
| AC-19 | **Given** a web job **then** `GET /api/jobs/:id` has `usage` totals, the SSE stream has an `info` event with `stage: "llm"` before `done`, and `GET /api/sites/:site/usage` lists the report. **Given** a job request with `options.llmBudget` **then** 400. |
| AC-20 | **Given** config file/env/CLI values for the new keys **then** they resolve with precedence CLI > env > file and are validated (`logLevel: "loud"` → error). |
| AC-21 | **Given** the CLI `usage <url> --json` **then** it prints the stored reports as JSON; without `--json` one line per report. |

## 5. Security notes

- The redaction is applied to the *serialised* log line, so a secret nested anywhere (error messages, objects, arrays) is caught.
- The response cache key and entries are computed from the redacted request (the `RedactingLLM` sits outside the governed layer), so a cache file cannot contain a credential that the prompt did not.
- OTLP headers (often an API key for the collector) are registered as secrets and never logged.
