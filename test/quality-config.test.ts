import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { packageRoot } from '../src/core/paths.js';
import vitestConfig from '../vitest.config.js';

const root = packageRoot();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const yamlOf = (rel: string): any => parse(read(rel));
type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; if?: string };

describe('CI workflow (SPEC-010 AC-5)', () => {
  const wf = yamlOf('.github/workflows/ci.yml');

  it('runs on pull requests and pushes to main with read-only permissions', () => {
    expect(wf.on).toHaveProperty('pull_request');
    expect(wf.on.push.branches).toEqual(['main']);
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('runs the quality gates in order', () => {
    const steps: Step[] = wf.jobs.checks.steps;
    const idx = (pred: (s: Step) => boolean, label: string) => {
      const i = steps.findIndex(pred);
      expect(i, `missing step: ${label}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const runs = (cmd: string) => (s: Step) => (s.run ?? '').includes(cmd);
    const order = [
      idx((s) => (s.uses ?? '').startsWith('pnpm/action-setup'), 'pnpm setup'),
      idx((s) => (s.uses ?? '').startsWith('actions/setup-node') && s.with?.cache === 'pnpm', 'node + pnpm cache'),
      idx(runs('pnpm install --frozen-lockfile'), 'frozen install'),
      idx(runs('pnpm check:secrets'), 'tracked secrets'),
      idx(runs('pnpm typecheck'), 'typecheck'),
      idx(runs('pnpm lint'), 'lint'),
      idx(runs('pnpm format:check'), 'format check'),
      idx(runs('playwright install --with-deps chromium'), 'playwright browsers'),
      idx(runs('pnpm test:coverage'), 'tests with coverage'),
      idx(runs('pnpm web:build'), 'web build'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('scans for secrets with gitleaks over full history', () => {
    const steps: Step[] = wf.jobs['secret-scan'].steps;
    const checkout = steps.find((s) => (s.uses ?? '').startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(steps.some((s) => (s.uses ?? '').startsWith('gitleaks/gitleaks-action@'))).toBe(true);
  });

  it('needs no repository secrets', () => {
    expect(read('.github/workflows/ci.yml')).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]/);
  });
});

describe('nightly workflow (SPEC-010 AC-6)', () => {
  const text = read('.github/workflows/nightly.yml');
  const wf = yamlOf('.github/workflows/nightly.yml');

  it('only runs on schedule / manual dispatch', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('is disabled unless the AGENTIC_E2E_NIGHTLY variable is true', () => {
    const jobs = Object.values(wf.jobs) as { if?: string }[];
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.if).toContain("vars.AGENTIC_E2E_NIGHTLY == 'true'");
  });

  const steps: Step[] = Object.values(wf.jobs).flatMap((j) => (j as { steps: Step[] }).steps);

  it('replays stored tests with `agentic-e2e run` from a committed data dir, after the tracked-secrets check', () => {
    const runIdx = steps.findIndex((s) => /pnpm cli run "\$\{args\[@\]\}" --data-dir "\$DATA_DIR"/.test(s.run ?? ''));
    const checkIdx = steps.findIndex((s) => (s.run ?? '').includes('pnpm check:secrets'));
    expect(runIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(runIdx);
    expect(text).not.toMatch(/pnpm cli (all|discover|generate|heal)\b/);
    expect(text).toContain('vars.AGENTIC_E2E_NIGHTLY_DATA_DIR');
  });

  it('writes credentials outside the workspace with mode 600 and never uploads sessions', () => {
    expect(text).toContain('RUNNER_TEMP');
    expect(text).toContain('chmod 600');
    expect(wf.permissions).toEqual({ contents: 'read' });
    const upload = steps.find((s) => (s.uses ?? '').startsWith('actions/upload-artifact'));
    const paths = String(upload?.with?.path)
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    // explicit allow-list (runs + screenshots) plus an exclusion for stored sessions
    expect(paths.filter((p) => !p.startsWith('!')).every((p) => /\/sites\/\*\/(runs|screenshots)\/$/.test(p))).toBe(
      true,
    );
    expect(paths).toContain('!${{ env.DATA_DIR }}/**/auth/**');
    expect(text).not.toMatch(/echo[^\n]*secrets\./);
  });
});

describe('repository hygiene files (SPEC-010 AC-7)', () => {
  it('configures Dependabot for npm and GitHub Actions', () => {
    const d = yamlOf('.github/dependabot.yml');
    expect(d.updates.map((u: { 'package-ecosystem': string }) => u['package-ecosystem']).sort()).toEqual([
      'github-actions',
      'npm',
    ]);
  });

  it('has CODEOWNERS', () => {
    expect(read('.github/CODEOWNERS')).toMatch(/^\*\s+@singhupendra\s*$/m);
  });

  it('has a PR template with a spec-ID checklist', () => {
    const t = read('.github/pull_request_template.md');
    expect(t).toMatch(/SPEC-0NN/);
    expect(t).toMatch(/- \[ \][^\n]*spec/i);
    expect(t).toMatch(/- \[ \][^\n]*tests? (first|before)/i);
    expect(t).toMatch(/- \[ \][^\n]*(credential|secret)/i);
  });

  it('documents the workflow in CONTRIBUTING.md', () => {
    const c = read('CONTRIBUTING.md');
    for (const s of [
      'pnpm lint',
      'pnpm format',
      'pnpm test:coverage',
      'pnpm check:secrets',
      'AGENTIC_E2E_NIGHTLY',
      'AGENTIC_E2E_NIGHTLY_SITES',
      'AGENTIC_E2E_NIGHTLY_DATA_DIR',
      'pnpm cli run',
    ]) {
      expect(c).toContain(s);
    }
  });
});

describe('package scripts and lockfile (SPEC-010 AC-8)', () => {
  const pkg = JSON.parse(read('package.json'));

  it('exposes the quality scripts and pins pnpm', () => {
    for (const s of ['lint', 'lint:fix', 'format', 'format:check', 'test:coverage', 'check:secrets']) {
      expect(pkg.scripts, s).toHaveProperty(s);
    }
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('keeps lockfile specifiers in sync with package.json (frozen install works)', () => {
    const lock = yamlOf('pnpm-lock.yaml');
    const importer = lock.importers['.'];
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const declared: Record<string, string> = pkg[field] ?? {};
      const locked: Record<string, { specifier: string }> = importer[field] ?? {};
      expect(Object.keys(locked).sort(), field).toEqual(Object.keys(declared).sort());
      for (const [name, spec] of Object.entries(declared)) expect(locked[name].specifier, name).toBe(spec);
    }
  });
});

describe('coverage thresholds (SPEC-010 AC-9)', () => {
  it('uses v8 coverage on src with thresholds at baseline minus a margin', () => {
    const cov = (vitestConfig as any).test.coverage;
    expect(cov.provider).toBe('v8');
    expect(cov.include).toEqual(['src/**/*.ts']);
    expect(cov.thresholds.lines).toBeGreaterThanOrEqual(70);
    expect(cov.thresholds).toEqual({ lines: 91, statements: 90, branches: 82, functions: 88 });
  });
});
