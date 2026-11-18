# SPEC-010: Quality gates & CI

- **Status:** Implemented (v0.10)
- **Depends on:** SPEC-001 (repo layout, Vitest suite), SPEC-009 (secret-handling guarantees, `.gitignore` rules)
- **Stack:** `.github/` (new: workflows, Dependabot, CODEOWNERS, PR template), `eslint.config.js`, `.prettierrc.json`,
  `.prettierignore`, `.gitleaks.toml` (new), `scripts/check-tracked-secrets.ts` (new), `vitest.config.ts`,
  `package.json`, `pnpm-lock.yaml`, `tsconfig.json` (include `scripts`), `CONTRIBUTING.md` (new), README (one link)

## 1. Problem — gaps found in the current repo (origin/main `d640cd7`)

| # | Gap |
|---|-----|
| G-1 | No CI at all: there is no `.github/` directory. Typecheck and the 298 Vitest tests only run when someone remembers to. |
| G-2 | `pnpm install --frozen-lockfile` **fails** today: the lockfile records `@aws-sdk/credential-providers` with specifier `3.1164.0` while `package.json` says `^3.1164.0`. Any CI using a frozen install would fail on the first step. |
| G-3 | No lint or formatter: no ESLint/Prettier config, no `pnpm lint` / `pnpm format` scripts. |
| G-4 | No coverage provider and no thresholds; coverage can silently drop. Measured baseline on `src/**`: lines 95.4 %, statements 92.1 %, branches 84.2 %, functions 90.0 %. |
| G-5 | Secret protection is local only: `.gitignore` (bypassed by `git add -f`) and SPEC-009's runtime refusal to *load* a tracked credentials file. Nothing fails a PR that commits `credentials.json`, a `storageState.json`, `.agentic-e2e/` or `.auth/`, and nothing scans for leaked API keys. |
| G-6 | The web UI build (`pnpm web:build`) is never exercised except by typecheck. |
| G-7 | Integration tests need Chromium; CI must install it (`playwright install --with-deps chromium`). |
| G-8 | No `packageManager` field, so CI cannot pin the pnpm version deterministically. |
| G-9 | No Dependabot, CODEOWNERS, PR template or CONTRIBUTING guide; the spec-ID commit rule lives only in a personal CLAUDE.md. |

## 2. Non-goals

- Changing product behaviour. Lint/format fixes are mechanical only; every existing test must still pass unchanged.
- Type-aware (type-checked) ESLint rules — `tsc` already runs; type-aware linting would double CI time.
- Coverage of `web/` (there is no browser test infrastructure for the UI; it is covered by typecheck + build).
- Enabling the nightly workflow. It ships disabled.

## 3. Functional requirements

### 3.1 CI workflow (`.github/workflows/ci.yml`)

| ID | Requirement |
|----|-------------|
| FR-1 | Triggers on `pull_request` and on `push` to `main`. Concurrency group per ref, cancelling superseded PR runs. Top-level `permissions: contents: read`. |
| FR-2 | Job `checks` (ubuntu-latest): checkout → `pnpm/action-setup` (version from `packageManager`) → `actions/setup-node` with `node-version-file`/Node 20 and `cache: pnpm` → `pnpm install --frozen-lockfile` → `pnpm check:secrets` → `pnpm typecheck` → `pnpm lint` → `pnpm format:check` → Playwright Chromium install (`pnpm exec playwright install --with-deps chromium`, browsers cached by Playwright version) → `pnpm test:coverage` → `pnpm web:build`. |
| FR-3 | Coverage report (`coverage/`) is uploaded as an artifact (`if: always()`); it contains source paths and counts only. |
| FR-4 | Job `secret-scan` runs `gitleaks/gitleaks-action@v2` with full history (`fetch-depth: 0`) and `GITHUB_TOKEN`. `.gitleaks.toml` extends the default rules and allowlists only `credentials.example.json` (fake values). |
| FR-5 | No step prints environment variables, secrets or credentials; CI needs **no** secrets (tests use the mock LLM). |

### 3.2 Tracked-secret check (`scripts/check-tracked-secrets.ts`, `pnpm check:secrets`)

| ID | Requirement |
|----|-------------|
| FR-6 | `isForbiddenTrackedPath(p)` is true for: any basename matching `credentials*.json` **except** `credentials.example.json`; any basename matching `*.credentials.json`; any basename matching `storageState*.json`; any path with a `.agentic-e2e` or `.auth` directory segment. Backslashes are normalised. |
| FR-7 | `findForbiddenTrackedFiles(cwd)` lists `git ls-files -z` output in `cwd` filtered by FR-6. |
| FR-8 | The CLI exits `1` and prints each offending **path** (never file contents) with remediation (`git rm --cached <path>`, rotate the secrets); exits `0` with a one-line OK otherwise. Outside a git repo it exits `2` with an error. |

### 3.3 Lint, format, coverage

| ID | Requirement |
|----|-------------|
| FR-9 | `eslint.config.js` (flat config): `@eslint/js` recommended + `typescript-eslint` recommended for `src`, `test`, `scripts`, `web/src`, config files; `eslint-plugin-react-hooks` for `web/src`; `eslint-config-prettier` last. Ignores `dist`, `web/dist`, `data`, `coverage`, `node_modules`. `pnpm lint` = `eslint .` with zero errors; `pnpm lint:fix` exists. |
| FR-10 | `.prettierrc.json` matches the existing style (single quotes, semicolons, trailing commas, `printWidth` 120). `pnpm format` writes, `pnpm format:check` checks. `.prettierignore` excludes `pnpm-lock.yaml`, build output, `data/`, `coverage/`, and Markdown (`**/*.md` — hand-formatted tables, edited by many branches). |
| FR-11 | Vitest coverage uses `@vitest/coverage-v8`, `include: ['src/**/*.ts']`, reporters `text-summary`, `html`, `json-summary`, `lcov`. Thresholds are the measured baseline minus ~2 points and never below 70 % lines: **lines 93, statements 90, branches 82, functions 88**. `pnpm test:coverage` = `vitest run --coverage`. `pnpm test:run` keeps running without coverage. |
| FR-12 | `package.json` has `"packageManager": "pnpm@10.33.0"`; the lockfile importer specifiers equal the `package.json` specifiers (fixes G-2). |

### 3.4 Repository hygiene

| ID | Requirement |
|----|-------------|
| FR-13 | `.github/dependabot.yml`: ecosystems `npm` (directory `/`) and `github-actions`, weekly; npm minor/patch updates grouped. |
| FR-14 | `.github/CODEOWNERS`: `* @singhupendra` (docs refer to the owner only as `` `@singhupendra` ``). |
| FR-15 | `.github/pull_request_template.md`: summary, `Spec: SPEC-0NN` field, and a checklist (spec written/updated first, tests first, commits `type(SPEC-0NN): …`, `pnpm typecheck`/`lint`/`format:check`/`test:run` pass, no credentials/storageState/API keys added, README/CONTRIBUTING updated). |
| FR-16 | `CONTRIBUTING.md`: setup, the spec-driven workflow, commit convention, local commands mirroring CI, secret-handling rules (link SPEC-009), coverage policy, nightly workflow setup. README gets one link to it. |

### 3.5 Nightly workflow (`.github/workflows/nightly.yml`, disabled by default)

| ID | Requirement |
|----|-------------|
| FR-17 | Triggers: `schedule` (daily) and `workflow_dispatch`; never `pull_request`/`push`. The job runs only if repository variable `AGENTIC_E2E_NIGHTLY == 'true'` (or on manual dispatch with that variable set) — unset ⇒ skipped. |
| FR-18 | Sites come from repository variable `AGENTIC_E2E_NIGHTLY_SITES` (one URL per line). LLM credentials come from repository secrets (`ANTHROPIC_API_KEY`, or Bedrock `AWS_BEARER_TOKEN_BEDROCK` + variables for provider/region/model). Optional credentials JSON from secret `AGENTIC_E2E_CREDENTIALS_JSON` is written to `$RUNNER_TEMP` with mode `600` (outside the workspace) and passed via `AGENTIC_E2E_CREDENTIALS`; `--auth` is only added when it is present. |
| FR-19 | Each site runs `pnpm cli all <url>`; results upload `data/` **excluding** `data/**/auth/**` (storageState) and `.agentic-e2e/`. Secrets are never echoed. `permissions: contents: read`. |

## 4. Secret handling (SPEC-009 guarantees preserved)

- CI requires no secrets and the test suite keeps using the mock LLM; nothing new logs env vars or credentials.
- `check:secrets` and gitleaks add *server-side* enforcement on top of `.gitignore` and the runtime refusal (FR-5 of SPEC-009).
- The check prints paths only, never contents.
- Nightly: credentials are materialised outside the workspace with `600`, session files are excluded from artifacts.

## 5. Acceptance criteria (Given / When / Then)

- **AC-1** Given `credentials.json`, `a/credentials.prod.json`, `x.credentials.json`, `storageState.json`, `e2e/storageState-admin.json`, `.agentic-e2e/credentials.json`, `.auth/u.json`, `a\\.auth\\u.json`, When `isForbiddenTrackedPath` is called, Then each is `true`; Given `credentials.example.json`, `docs/credentials.example.json`, `src/core/credentials.ts`, `test/credentials.test.ts`, `auth.json`, `src/core/auth.ts`, `my.auth.ts`, Then each is `false`.
- **AC-2** Given a temporary git repo with a force-added `credentials.json` and `.auth/s.json` plus a tracked `credentials.example.json`, When `findForbiddenTrackedFiles` runs, Then it returns exactly the two forbidden paths; When the CLI runs there, Then it exits `1`, prints both paths and `git rm --cached`, and does not print the file contents.
- **AC-3** Given a clean temp repo, When the CLI runs, Then it exits `0`; Given a non-repo directory, Then it exits `2`.
- **AC-4** Given this repository, When `findForbiddenTrackedFiles` runs, Then the result is empty.
- **AC-5** Given `ci.yml`, Then it triggers on `pull_request` and `push: branches: [main]`, has `permissions.contents: read`, and the `checks` job runs, in order, a frozen install with pnpm cache, `check:secrets`, `typecheck`, `lint`, `format:check`, a Playwright Chromium install, `test:coverage` and `web:build`; a `secret-scan` job uses `gitleaks/gitleaks-action` with `fetch-depth: 0`.
- **AC-6** Given `nightly.yml`, Then it has `schedule` + `workflow_dispatch` and no `pull_request`/`push`, its job is gated on `vars.AGENTIC_E2E_NIGHTLY == 'true'`, credentials are written under `RUNNER_TEMP` with `chmod 600`, and the artifact path excludes `auth` directories.
- **AC-7** Given `dependabot.yml`, Then it has `npm` and `github-actions` updates. Given `CODEOWNERS`, Then it has `* @singhupendra`. Given the PR template, Then it contains a `SPEC-` field and checklist items for spec-first, tests-first and no secrets. Given `CONTRIBUTING.md`, Then it documents `pnpm lint`, `pnpm format`, `pnpm test:coverage`, `pnpm check:secrets` and the nightly variables.
- **AC-8** Given `package.json`, Then scripts `lint`, `lint:fix`, `format`, `format:check`, `test:coverage`, `check:secrets` exist and `packageManager` starts with `pnpm@`; Given `pnpm-lock.yaml`, Then every importer specifier equals the `package.json` specifier.
- **AC-9** Given `vitest.config.ts`, Then coverage provider is `v8`, includes `src/**/*.ts`, and thresholds are ≥ 70 lines and equal to FR-11.
- **AC-10** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test:run` and `pnpm test:coverage` all pass locally; the reformat commit is mechanical (no test changes in behaviour).

## 6. Rollout note

The Prettier adoption reformats most files. It is a single `style(SPEC-010)` commit, regenerated with `pnpm format` after
every rebase. Branches opened before this lands should run `pnpm format` after rebasing; a conflict in a reformatted file
is resolved by taking the branch's version and running `pnpm format`.
