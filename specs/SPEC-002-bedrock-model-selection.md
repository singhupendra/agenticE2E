# SPEC-002: Amazon Bedrock provider and model selection

- **Status:** Implemented (v0.2)
- **Depends on:** SPEC-001 (FR-8 config precedence, FR-9 LLM layer)
- **Stack:** `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle`), zod, Fastify, React

## 1. Summary

agenticE2E can talk to Claude through Amazon Bedrock as well as the Anthropic API, and the
user can pick the provider and the model from the config file, env, CLI and web UI. A small
built-in catalog of known Claude models (per provider) backs `agentic-e2e models`, `GET /api/models`
and the UI model dropdown; any other model id may still be typed in.

## 2. Non-goals

- Live discovery of Bedrock models (`ListFoundationModels`) or checking the account has model access.
- Non-Anthropic models on Bedrock (the pipeline relies on Anthropic tool-use + image input).
- Managing AWS credentials/SSO: the standard AWS credential chain is used as-is.
- The legacy `bedrock-runtime` InvokeModel client (the Messages-API "Mantle" endpoint is used).

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Provider setting.** New config key `provider`: `"anthropic"` (default) \| `"bedrock"`, and `awsRegion` (optional string). Same precedence as other keys: defaults < file < env (`AGENTIC_E2E_PROVIDER`, `AGENTIC_E2E_AWS_REGION`) < CLI (`--provider`, `--aws-region`) / web UI. |
| FR-2 | **Bedrock provider.** With `provider: "bedrock"` all LLM calls go through the Bedrock Mantle client with the same structured-output behaviour (tool-use + zod re-validation) as the Anthropic provider. Region: `awsRegion`, else `AWS_REGION`, else `AWS_DEFAULT_REGION`; none → clear error. Credentials come from the AWS default chain (env, profile/SSO, instance role) or a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`); no secrets in config. |
| FR-3 | **Model ids.** `model` stays a free string. For Bedrock, a bare first-party id (`claude-sonnet-5-5`) is mapped to its Bedrock id (`anthropic.claude-sonnet-5-5`); ids that already start with `anthropic.`, a region/inference-profile prefix (`us.`, `eu.`, `apac.`, `global.`…) or `arn:` are passed through unchanged. For Anthropic, an `anthropic.`-prefixed id is stripped to the bare id. |
| FR-4 | **Model catalog.** A catalog lists known Claude models with `id`, `label`, per provider. `agentic-e2e models [--provider p]` prints it; `GET /api/models?provider=p` returns it as JSON (`provider` defaults to the server's configured one; unknown provider → 400); the web UI shows a Provider select and a Model select fed by it, plus a "Custom…" option to type any id. |
| FR-5 | **Forced tool choice compatibility.** Newer models (Sonnet 5.5, Opus 5.5, Fable 5.1, Mythos 5.1) reject `tool_choice: {type:"tool"}` with a 400. For those the provider sends `tool_choice: {type:"auto"}` and adds a system-prompt instruction to call the named tool; other models keep the forced call. Output is still schema-validated, a missing tool call raises `LLMOutputError`. |
| FR-6 | **Web/API safety.** `provider` and `model` may be overridden per job; `awsRegion` may not (it is an operator setting, and is interpolated into the endpoint host). `awsRegion` must match `^[a-z]{2}(-[a-z0-9]+)+-\d+$`. `GET /api/config` returns `provider` but not `awsRegion`, so the settings object the UI loads can be posted back as job options. AWS credentials are never exposed via the API and never reach the generated-test subprocess (existing env allowlist). |

## 4. Acceptance criteria (Given / When / Then)

### Config (FR-1)
- **AC-1** Given no config, When resolved, Then `provider` is `"anthropic"` and `awsRegion` is undefined.
- **AC-2** Given file `provider: "anthropic"`, env `AGENTIC_E2E_PROVIDER=bedrock`, CLI `--provider anthropic`, When resolved, Then env beats file and CLI beats env.
- **AC-3** Given `provider: "openai"`, When resolved, Then it fails with a validation error naming `provider`.
- **AC-4** Given `awsRegion: "us-east-1; evil"` or `"../x"`, When resolved, Then it fails naming `awsRegion`; `"us-east-1"`, `"ap-southeast-1"` are accepted.

### Model ids and catalog (FR-3, FR-4)
- **AC-5** Given provider `bedrock`, When `resolveModelId('claude-sonnet-5-5')`, Then `anthropic.claude-sonnet-5-5`; `anthropic.x`, `us.anthropic.x`, `global.anthropic.x`, `arn:aws:bedrock:…` are unchanged.
- **AC-6** Given provider `anthropic`, When `resolveModelId('anthropic.claude-opus-5-5')`, Then `claude-opus-5-5`; a bare id is unchanged.
- **AC-7** Given the catalog, When listed for `bedrock`, Then every id is Bedrock-form; for `anthropic` every id is bare; both include the default model `claude-sonnet-5-5`.
- **AC-8** Given the API, When `GET /api/models?provider=bedrock`, Then 200 with the catalog; `?provider=nope` → 400; no param → the server's configured provider.
- **AC-9** Given the CLI, When `models --provider bedrock`, Then it prints the Bedrock catalog and exits 0; `--provider nope` exits non-zero.

### Provider behaviour (FR-2, FR-5)
- **AC-10** Given provider `bedrock` with a fake Mantle client, When `structured()` is called, Then the request uses the Bedrock model id and the tool input is returned validated.
- **AC-11** Given provider `bedrock` and no region anywhere, When the provider is created, Then it throws an error mentioning `AWS_REGION`.
- **AC-12** Given `awsRegion` unset and `AWS_REGION=eu-west-1`, When the Bedrock client is created, Then it is created for `eu-west-1`; explicit `awsRegion` wins over the env.
- **AC-13** Given model `claude-sonnet-5-5`, When `structured()` runs, Then `tool_choice` is `auto` and the system prompt names the tool; given `claude-haiku-4-5`, Then `tool_choice` is `{type:"tool", name}`.
- **AC-14** Given the factory with `provider: "anthropic"`/`"bedrock"`, When a provider is created, Then it is the Anthropic / Bedrock client respectively (no network).

### Web/API (FR-6)
- **AC-15** Given a job request with `options.awsRegion`, When parsed, Then it is rejected; with `options.provider: "bedrock"` and a model it is accepted.
- **AC-16** Given `GET /api/config`, Then it includes `provider`, omits `awsRegion`, and the whole object is accepted as job options.

## 5. Design notes

- `src/core/llm/models.ts`: catalog, `resolveModelId`, `supportsForcedToolChoice`.
- `src/core/llm/bedrock.ts`: builds the Mantle client; reuses `AnthropicProvider` (same Messages surface) via its injectable `client`.
- `createLLMProvider(config)` in `src/core/llm/index.ts` replaces the hard-coded `new AnthropicProvider` in `createContext`.
- Bedrock model access is enabled per account/region in AWS; failures surface as the SDK's API error. Not verified against live AWS in automated tests (all tests use fakes).

## 6. Known limitations
- Catalog is static and may lag new releases; use the custom model field for anything else.
- Bedrock pricing and rate limits differ from the Anthropic API.
