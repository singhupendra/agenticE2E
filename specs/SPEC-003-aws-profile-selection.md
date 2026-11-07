# SPEC-003: AWS profile selection for Amazon Bedrock

- **Status:** Implemented (v0.3)
- **Depends on:** SPEC-001 (FR-8 config precedence), SPEC-002 (Bedrock provider, FR-2/FR-6)
- **Stack:** `@anthropic-ai/bedrock-sdk` (`awsProfile` option), zod, Fastify, React

## 1. Summary

With `provider: "bedrock"` the user can choose which **named AWS profile** (from `~/.aws/credentials`
and `~/.aws/config`, including profiles that hold an access key + secret) supplies credentials. The
profile is chosen when the app starts (config file, env, CLI flag) and can also be picked from a
dropdown in the web UI, which is fed by the profiles found on the machine. When a profile is chosen
it is used even if `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or `AWS_BEARER_TOKEN_BEDROCK` are set in
the environment; when none is chosen behaviour is unchanged (AWS default credential chain).

## 2. Non-goals

- Reading, storing, displaying or editing the access key / secret themselves. Only profile *names* (and a profile's `region`) are read from the AWS files.
- Running `aws sso login` or refreshing expired credentials.
- Editing AWS profiles from the UI.
- Falling back to `AWS_PROFILE`: it keeps its standard meaning in the AWS credential chain (env credentials win over it); use `awsProfile` for an explicit choice.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| FR-1 | **Setting.** New config key `awsProfile` (optional string). Same precedence as other keys: defaults < file < env `AGENTIC_E2E_AWS_PROFILE` < CLI `--aws-profile` / web UI. Must match `^[A-Za-z0-9_][A-Za-z0-9_.@:+=,/-]{0,127}$`. |
| FR-2 | **Profile used for credentials.** With `provider: "bedrock"` and `awsProfile` set, the Bedrock client is created with that profile so credentials come from it (precedence over env keys and `AWS_BEARER_TOKEN_BEDROCK`). `awsProfile` unset → client is created exactly as before. `awsProfile` is ignored for `provider: "anthropic"`. |
| FR-3 | **Profile discovery.** `listAwsProfiles(env)` returns the sorted, de-duplicated profile names found in the shared config file (`AWS_CONFIG_FILE`, default `~/.aws/config`: `[default]` and `[profile x]`) and credentials file (`AWS_SHARED_CREDENTIALS_FILE`, default `~/.aws/credentials`: `[x]`). Missing/unreadable files → no profiles, never an error. `[sso-session …]`, `[services …]` and other non-profile sections are ignored. No secret values are ever returned. |
| FR-4 | **Region from profile.** Region resolution becomes: `awsRegion` > the selected profile's `region` (only when `awsProfile` is set) > `AWS_REGION` > `AWS_DEFAULT_REGION`; none → the existing error (which now also mentions the profile's region). A profile region that is not region-shaped is ignored. |
| FR-5 | **Unknown profile.** If `awsProfile` is set but not among the discovered profiles, creating the Bedrock provider fails with a clear error naming the profile and listing the available ones (instead of an opaque credential failure on the first LLM call). |
| FR-6 | **CLI.** `--aws-profile <name>` on every command that takes `--provider`. New `agentic-e2e aws-profiles` lists discovered profiles (marking the configured one) and exits 0 even when there are none (prints a hint). `models --provider bedrock` mentions `--aws-profile`. |
| FR-7 | **API.** `GET /api/aws-profiles` → `{ profiles: string[], selected?: string }` (`selected` = server's configured profile). `GET /api/config` includes `awsProfile` (when set). Job `options.awsProfile` is accepted if valid per FR-1 **and** present in the discovered profiles, else the request is rejected (400); the check only applies when the job uses Bedrock. `options.awsProfile: null` means "no profile" and overrides a server-configured one (used by the UI's "Default credential chain" choice). `awsRegion` remains operator-only (SPEC-002 FR-6). AWS secrets are never exposed. |
| FR-8 | **Web UI.** With provider Bedrock, Settings shows an "AWS profile" select: "Default credential chain", then each discovered profile; the server's configured profile is preselected. The choice is sent as `options.awsProfile` when starting jobs. Hidden for the Anthropic provider. |

## 4. Acceptance criteria (Given / When / Then)

### Config (FR-1)
- **AC-1** Given no config, When resolved, Then `awsProfile` is undefined.
- **AC-2** Given file `awsProfile: "a"`, env `AGENTIC_E2E_AWS_PROFILE=b`, CLI `awsProfile: "c"`, When resolved, Then env beats file and CLI beats env.
- **AC-3** Given `awsProfile: "x; rm -rf"`, `"-bad"` or `""`, When resolved, Then it fails naming `awsProfile`; `"default"`, `"my-profile"`, `"corp.sso_admin"` are accepted.

### Discovery (FR-3)
- **AC-4** Given a config file with `[default]`, `[profile dev]`, `[sso-session s]`, `[services x]` and a credentials file with `[dev]`, `[ci]`, When listing, Then `['ci','default','dev']`.
- **AC-5** Given missing files, When listing, Then `[]`. Given `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`, Then those paths are used.
- **AC-6** Given a profile with `aws_secret_access_key`, When listing, Then the secret appears nowhere in the result.

### Provider (FR-2, FR-4, FR-5)
- **AC-7** Given `awsProfile: "dev"` (present in the files), When the Bedrock client is created, Then `createClient` receives `{ awsRegion, awsProfile: "dev" }`; with no profile, `awsProfile` is undefined.
- **AC-8** Given profile `dev` with `region = eu-west-1` and no `awsRegion`/env region, Then the client region is `eu-west-1`; explicit `awsRegion` wins; with `AWS_REGION=us-west-2` and profile selected, the profile region wins; with no profile selected `AWS_REGION` is used.
- **AC-9** Given `awsProfile: "ghost"` not in the files, Then provider creation throws mentioning `ghost` and the available profile names.
- **AC-10** Given provider `anthropic` with `awsProfile` set, Then creating the provider does not look at AWS files and succeeds.

### CLI / API (FR-6, FR-7)
- **AC-11** Given `aws-profiles` with a fixture `AWS_CONFIG_FILE`, Then it prints the profiles and exits 0; with none, exits 0 with a hint.
- **AC-12** Given `GET /api/aws-profiles`, Then 200 `{ profiles, selected }`.
- **AC-13** Given a job request with a known `options.awsProfile`, Then accepted (202); with an unknown one → 400 naming the profile; with `options.awsRegion` → still rejected.
- **AC-15** Given a server configured with `awsProfile: "dev"`, When a job is started with `options.awsProfile: null`, Then the job's effective config has no `awsProfile`; with `options.awsProfile: "ci"` it is `ci`; with no `awsProfile` option it stays `dev`. An unknown profile with `provider: "anthropic"` is not rejected.
- **AC-14** Given `GET /api/config` with a configured profile, Then it includes `awsProfile` and the object is still accepted as job options.

## 5. Design notes

- `src/core/aws-profiles.ts`: minimal INI reader (`listAwsProfiles`, `awsProfileRegion`). Only section headers and the `region` key are interpreted.
- `src/core/llm/bedrock.ts`: resolves profile/region, validates the profile (FR-5), passes `awsProfile` to `AnthropicBedrockMantle`, which loads credentials for that profile through the AWS SDK chain (SSO, assume-role, `credential_process` and static keys all work as they do for the AWS CLI).
- The profile is validated against locally discovered profiles before it reaches the SDK, so a web client cannot name arbitrary strings.
- `parseJobRequest` now keeps only the option keys the client actually sent (zod had been filling in schema defaults, which would have reset the server's own `provider`/`awsProfile` for jobs that omitted them), and `mergeJobConfig` applies them over the server config.
- The web UI is served on loopback only (SPEC-001); profile names are not secrets.

## 6. Known limitations
- Profiles defined outside the standard files (e.g. a custom resolver) are not discoverable and are rejected by FR-5; use the default chain there.
- Credentials are resolved on the first LLM call, so an expired SSO session surfaces then (run `aws sso login --profile <name>`).
