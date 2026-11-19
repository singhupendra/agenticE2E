# Contributing to agenticE2E

Thanks for helping. This repo is **spec-driven** and every PR goes through the same quality gates as CI
([SPEC-010](specs/SPEC-010-quality-gates-ci.md)). The code owner is `@singhupendra` (see `.github/CODEOWNERS`).

## Setup

```bash
pnpm install                              # Node 22.12+ (package.json engines); pnpm version is pinned by "packageManager" in package.json
pnpm exec playwright install chromium     # integration tests (add firefox webkit for SPEC-012 cross-browser runs)
```

## Workflow: spec → tests → code

1. **Spec first.** Add `specs/SPEC-0NN-<topic>.md` (problem, non-goals, functional requirements, Given/When/Then
   acceptance criteria, status). Specs are never deleted; update their status instead.
2. **Tests first.** Turn the acceptance criteria into failing Vitest tests under `test/` (red), then implement (green),
   then refactor.
3. **Commits** use conventional commits with the spec id: `feat(SPEC-0NN): …`, `fix(SPEC-0NN): …`,
   `test(SPEC-0NN): …`, `docs(SPEC-0NN): …`, `style(SPEC-0NN): …`.
4. **PR**: fill in the template (spec id + checklist). CI must be green; CODEOWNERS review is requested automatically.

Keep changes modular: new functionality goes into its own module (e.g. `src/core/<area>/`), and shared files
(`src/cli/index.ts`, `src/core/config.ts`, README) are touched minimally.

## Local commands (same as CI)

| Command | What it does |
|---------|--------------|
| `pnpm check:secrets` | Fails if `credentials*.json` (except `credentials.example.json`), `*.credentials.json`, `storageState*.json`, `tokens*.json`, `.env` / `.env.*` (except `.env.example`), or anything under `.agentic-e2e/` / `.auth/` is tracked by git. Prints paths only. |
| `pnpm typecheck` | `tsc` for the backend/CLI/tests and for the web UI |
| `pnpm lint` / `pnpm lint:fix` | ESLint (`@eslint/js` + `typescript-eslint` recommended, React hooks rules for `web/src`) |
| `pnpm format` / `pnpm format:check` | Prettier (single quotes, width 120; Markdown is not formatted) |
| `pnpm test:run` | Vitest, no coverage (no network or API key needed; needs Chromium) |
| `pnpm test:coverage` | Vitest with V8 coverage on `src/**` and thresholds; HTML report in `coverage/` |
| `pnpm web:build` | Production build of the web UI |

CI (`.github/workflows/ci.yml`) runs all of the above on every pull request and on pushes to `main`, plus a
[gitleaks](https://github.com/gitleaks/gitleaks) secret scan over the full history. CI needs no repository secrets.

### Rebasing onto the Prettier adoption

SPEC-010 reformatted the code base with Prettier in one `style(SPEC-010)` commit. If your branch predates it and a
rebase conflicts in a file that was only reformatted, keep your version of the file, run `pnpm format`, and continue.

## Coverage policy

Thresholds live in `vitest.config.ts` and are set to the measured level minus a small margin (never below 70 % lines):
lines 93, statements 91, branches 85, functions 90. Raise them when coverage goes up; lowering them needs a reason
in the PR description. `web/` is covered by typecheck + build (there is no browser test harness for the UI).

## Secrets — the rules (SPEC-009)

- Real credentials live only in `.agentic-e2e/credentials.json` (gitignored) or environment variables; use
  `credentials.example.json` (fake values) as the template. Never commit `storageState*.json` or `.auth/`.
- Never log, return, stream, store or send to an LLM a credential, API key or token. Redact with `Redactor`.
- If something secret was committed: `git rm --cached <file>`, **rotate the secret**, and treat history as leaked.
- `pnpm check:secrets` and gitleaks enforce this in CI; `.gitleaks.toml` allowlists only `credentials.example.json`.

## Nightly runs (optional, disabled by default)

`.github/workflows/nightly.yml` replays the **stored** tests with `agentic-e2e run <url>` (`pnpm cli run <url>`) against
real sites every night (03:00 IST) and on manual dispatch. It does not discover, generate or heal, so it costs no LLM
tokens. It is **skipped** unless you opt in.

**1. Commit the tests.** Stored tests normally live in the gitignored `data/`, so generate them into a separate data
directory and commit that directory:

```bash
pnpm cli all https://shop.example.com --data-dir e2e-data    # or discover + generate
git add e2e-data/sites/*/{site.json,journeys.json,tests}     # never auth/ (sessions); runs/ and screenshots/ are optional noise
pnpm check:secrets                                           # fails if e2e-data/sites/*/auth/* got staged and committed
```

**2. Configure** in *Settings → Secrets and variables → Actions*:

| Kind | Name | Value |
|------|------|-------|
| Variable | `AGENTIC_E2E_NIGHTLY` | `true` (anything else, or unset, keeps the workflow disabled) |
| Variable | `AGENTIC_E2E_NIGHTLY_SITES` | One site per line: `<url> [extra run flags]`, e.g. `https://shop.example.com` or `https://app.example.com --auth --user alice --journey checkout`. `#` starts a comment. |
| Variable | `AGENTIC_E2E_NIGHTLY_DATA_DIR` | Optional: the committed data directory (default `e2e-data`) |
| Secret | `AGENTIC_E2E_CREDENTIALS_JSON` | For `--auth` sites: the full credentials file (same format as `credentials.example.json`). Prefer dedicated low-privilege test accounts. |
| Secret | `ANTHROPIC_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK` | Only if an `--auth` site has no `login` hints (the LLM then locates the login form). Bedrock also uses variables `AGENTIC_E2E_PROVIDER=bedrock`, `AWS_REGION`, optionally `AGENTICQA_BEDROCK_MODEL_ID` / `AGENTIC_E2E_MODEL`. |

The workflow runs `pnpm check:secrets` first. The credentials secret is written to `$RUNNER_TEMP` with mode `600`
(outside the checkout), each value in it is masked in the logs, and it is deleted at the end. Only `runs/` and
`screenshots/` of each site are uploaded as an artifact, never stored sessions (`auth/`). A failing test fails the
workflow.
