# SPEC-005: Use the bedrock-runtime client for Amazon Bedrock (replace Mantle)

- **Status:** Implemented (v0.5)
- **Supersedes:** the Mantle parts of SPEC-002 (FR-2, non-goals, AC-10, design notes) and SPEC-003 (design notes)
- **Depends on:** SPEC-002, SPEC-003, SPEC-004
- **Stack:** `@anthropic-ai/bedrock-sdk` (`AnthropicBedrock`), `@aws-sdk/credential-providers`

## 1. Problem

The Bedrock provider uses `AnthropicBedrockMantle` (`bedrock-mantle.<region>.api.aws`). For the `test` account it returns
`404 The model '…' does not exist` for every Claude model in `ap-south-1`, `us-east-1` and `us-west-2`. The classic
`bedrock-runtime` endpoint works, but only with an inference-profile id (`global.anthropic.claude-sonnet-5-5`); the bare
`anthropic.claude-sonnet-5-5` fails with "on-demand throughput isn't supported". The classic client also has no profile
option and falls back to the shell's `AWS_PROFILE`.

## 2. Non-goals

- Keeping Mantle as an option or fallback.
- Changing the Anthropic provider, structured-output behaviour, or the config schema.
- Auto-discovering inference profiles, or changing how API keys are accepted (SPEC-004).

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Client.** With `provider: "bedrock"` the client is `AnthropicBedrock` (`bedrock-runtime`). `AnthropicBedrockMantle` is no longer imported or used anywhere. |
| FR-2 | **Profile credentials.** With a selected `awsProfile`, the client gets a `providerChainResolver` that resolves credentials with `fromNodeProviderChain({ profile })`. The selected profile wins over the shell's `AWS_PROFILE` and over `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (SPEC-003 FR-2 unchanged). Static keys, SSO, assume-role and `credential_process` profiles all work. |
| FR-3 | **No profile.** Without a profile, the client is created as in SPEC-004: `apiKey` if `AWS_BEARER_TOKEN_BEDROCK` is set, otherwise the SDK's default credential chain. Region precedence is unchanged. |
| FR-4 | **Default model.** The Bedrock default model is `global.anthropic.claude-sonnet-5-5`. The Anthropic default stays `claude-sonnet-5-5`. |
| FR-5 | **Id mapping.** `resolveModelId('bedrock', id)` keeps ids that already have a vendor, inference-profile or ARN prefix. A bare catalog id (`claude-sonnet-5-5`) maps to `global.anthropic.<id>`, not `anthropic.<id>`, because the catalog models are inference-profile-only. An explicit `anthropic.<id>` is passed through unchanged. |
| FR-6 | **Catalog and tool choice.** `models --provider bedrock` and the UI dropdown list `global.anthropic.…` ids. `supportsForcedToolChoice` keeps working for `global.`-prefixed ids. |
| FR-7 | **Secret hygiene.** Unchanged from SPEC-004 FR-5. |
| FR-8 | **Docs.** README and the CLI Bedrock hint describe the bedrock-runtime client, the `global.` default and the profile behaviour. SPEC-002/003 get a "superseded by SPEC-005" note; their text is not deleted. |

## 4. Acceptance criteria (Given / When / Then)

- **AC-1** Given bedrock and no profile or key, When the client is created, Then `AnthropicBedrock` is used and `createClient` receives only `awsRegion`.
- **AC-2** Given `awsProfile: "test"`, Then `createClient` receives `awsRegion` and a `providerChainResolver` function, and no `awsProfile` and no `apiKey`.
- **AC-3** Given `awsProfile: "test"` and `AWS_PROFILE=bedrock` in env, When the resolver runs (with a fake `fromNodeProviderChain`), Then it is called with `{ profile: "test" }`.
- **AC-4** Given a profile and `AWS_BEARER_TOKEN_BEDROCK`, Then no `apiKey` is passed (SPEC-004 AC-2).
- **AC-5** Given an unknown profile name, Then the existing "profile not found, available: …" error is thrown.
- **AC-6** Given provider `bedrock` and no model set, When the provider is created, Then its effective model is `global.anthropic.claude-sonnet-5-5` (config `model` stays the bare `claude-sonnet-5-5`, mapped by FR-5); with provider `anthropic` it stays `claude-sonnet-5-5`.
- **AC-7** Given `resolveModelId('bedrock', 'claude-sonnet-5-5')`, Then the result is `global.anthropic.claude-sonnet-5-5`; `anthropic.claude-sonnet-5-5`, `us.anthropic.…`, `apac.anthropic.…` and `arn:…` pass through unchanged.
- **AC-8** Given `listModels('bedrock')`, Then every id starts with `global.anthropic.`.
- **AC-9** Given `global.anthropic.claude-sonnet-5-5`, Then `supportsForcedToolChoice` returns false.
- **AC-10** Given a fake client, When `structured()` is called, Then the request uses the Bedrock model id and the tool input is returned validated.
- **AC-11** `grep -r "Mantle" src` returns nothing.
- **AC-12** (Manual) With `AGENTIC_E2E_PROVIDER=bedrock AGENTIC_E2E_AWS_PROFILE=test`, `pnpm run cli discover https://vhaan.in/` gets past "Asking the LLM to propose journeys".

## 5. Design notes

- `@aws-sdk/credential-providers` becomes a direct dependency, because pnpm does not expose the SDK's transitive copy.
- A resolver is passed instead of `awsProfile` because the classic client has no profile option and otherwise reads `AWS_PROFILE`.
- Mantle's endpoint is not usable for this account today. If that changes, a separate spec can reintroduce it as opt-in.
- Verified 2026-11-07, profile `test`, `ap-south-1`: `global.anthropic.claude-sonnet-5-5` works; `apac.`, `in.` and `us.` are rejected; the bare `anthropic.` id returns a 400.
