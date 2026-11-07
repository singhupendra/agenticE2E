# SPEC-004: Amazon Bedrock API key (bearer token) auth and env-based model id

- **Status:** Implemented (v0.4)
- **Depends on:** SPEC-002 (Bedrock provider), SPEC-003 (AWS profile selection)
- **Stack:** `@anthropic-ai/bedrock-sdk` (`apiKey` option), zod

## 1. Summary

With `provider: "bedrock"` the app connects using an **Amazon Bedrock API key** supplied through three
environment variables, with no AWS profile or access key/secret needed:

```bash
export AGENTIC_E2E_PROVIDER=bedrock
export AWS_BEARER_TOKEN_BEDROCK=...            # the Bedrock API key
export AWS_REGION=us-east-1
export AGENTICQA_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5   # any Bedrock model / inference-profile id
```

## 2. Non-goals

- Auto-switching the provider to Bedrock just because the variables are present (`AWS_BEARER_TOKEN_BEDROCK` is a standard AWS variable and may be set for other tools); `provider` stays explicit.
- Accepting the key through config files, CLI flags or the web UI, or ever storing/echoing it (SPEC-002 FR-6: no secrets in config or API).
- Creating or rotating Bedrock API keys.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **API key auth.** With `provider: "bedrock"`, no `awsProfile` selected, and a non-empty `AWS_BEARER_TOKEN_BEDROCK` in the environment the Bedrock client is created with that value as its `apiKey` (Bearer auth). It is read from the same `env` used for the other AWS variables. Surrounding whitespace is trimmed. |
| FR-2 | **Precedence.** A selected `awsProfile` (SPEC-003 FR-2) still wins: the key is not passed to the client then. With neither a key nor a profile the client is created as before (AWS default credential chain). The key is ignored for `provider: "anthropic"`. |
| FR-3 | **Region.** Unchanged (SPEC-002 FR-2 / SPEC-003 FR-4): `awsRegion` > selected profile's region > `AWS_REGION` > `AWS_DEFAULT_REGION`; the key is not tied to a region by this app. |
| FR-4 | **Model id from env.** New env var `AGENTICQA_BEDROCK_MODEL_ID` sets `model` when the resolved provider is `bedrock`. Precedence for `model`: defaults < file < `AGENTIC_E2E_MODEL` < `AGENTICQA_BEDROCK_MODEL_ID` < CLI `--model`. It is ignored for `anthropic` and when empty. The usual id mapping (SPEC-002 FR-3) applies, so `us.anthropic.…`, `anthropic.…` and ARNs pass through and bare ids get the `anthropic.` prefix. |
| FR-5 | **Secret hygiene.** The key never appears in config objects, API responses, logs or error messages, and does not reach the generated-test subprocess (existing env allowlist). |
| FR-6 | **Docs/CLI.** README and `models --provider bedrock` output describe the three variables. |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given bedrock, no profile, `env.AWS_BEARER_TOKEN_BEDROCK="  tok  "`, When the client is created, Then `createClient` receives `apiKey: "tok"` plus the region.
- **AC-2** Given a token and `awsProfile: "dev"`, Then `createClient` receives no `apiKey`.
- **AC-3** Given no token (unset or empty), Then `createClient` receives no `apiKey` key at all.
- **AC-4** Given provider `anthropic` and a token, Then the Anthropic provider is created and the token is not used.
- **AC-5** Given `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION=eu-west-1`, no profile/region option, Then the client is created for `eu-west-1` with the key.
- **AC-6** Given env `AGENTIC_E2E_PROVIDER=bedrock` and `AGENTICQA_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5-5`, When resolved, Then `model` is that id.
- **AC-7** Given the same model env, file model `a`, `AGENTIC_E2E_MODEL=b`, Then the Bedrock env var wins over both; CLI `model: "c"` wins over it.
- **AC-8** Given `AGENTICQA_BEDROCK_MODEL_ID` with provider `anthropic` (default), Then `model` is unchanged. Empty value is ignored. Provider set to bedrock only by the CLI/file still triggers it.
- **AC-9** Given the factory with the token in `deps.env`, When an error is thrown for a missing region, Then the message does not contain the token. The resolved config has no token field.
- **AC-10** Given `buildRunnerEnv` with `AWS_BEARER_TOKEN_BEDROCK` in the parent env, Then it is dropped.

## 5. Design notes

- The SDK already falls back to `process.env.AWS_BEARER_TOKEN_BEDROCK`; passing it explicitly from the injected `env` keeps behaviour identical in production while making it testable and keeping the precedence rule (profile beats key) in one place, `src/core/llm/bedrock.ts`.
- `AGENTICQA_BEDROCK_MODEL_ID` is applied in `resolveConfig` after the provider is known, since it only makes sense for Bedrock.
