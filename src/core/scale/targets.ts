import { devices } from 'playwright';
import { BROWSERS, type ArtifactPolicy, type BrowserName } from './options.js';

/** SPEC-012 FR-1..4: a browser or a Playwright device preset; one Playwright project per target. */
export interface Target {
  name: string;
  browser: BrowserName;
  device?: string;
}

export interface PwProject {
  name: string;
  testMatch?: string[];
  use: Record<string, unknown>;
}
export interface ProjectMeta {
  target: Target;
  auth: boolean;
}

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

function suggest(name: string): string {
  const needle = name.toLowerCase().split(/\s+/)[0] ?? '';
  const close = Object.keys(devices)
    .filter((d) => d.toLowerCase().includes(needle) && !d.endsWith(' landscape'))
    .slice(0, 6);
  return close.length
    ? ` Did you mean: ${close.join(', ')}?`
    : ' See https://playwright.dev/docs/emulation#devices for preset names.';
}

export function resolveTargets(cfg: { browsers?: readonly string[]; devices?: readonly string[] }): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const b of cfg.browsers ?? []) {
    if (!(BROWSERS as readonly string[]).includes(b))
      throw new Error(`Unknown browser "${b}". Valid browsers: ${BROWSERS.join(', ')}`);
    if (!seen.has(b)) {
      seen.add(b);
      out.push({ name: b, browser: b as BrowserName });
    }
  }
  for (const d of cfg.devices ?? []) {
    const preset = (devices as Record<string, { defaultBrowserType?: BrowserName } | undefined>)[d];
    if (!preset) throw new Error(`Unknown device "${d}".${suggest(d)}`);
    if (!seen.has(d)) {
      seen.add(d);
      out.push({ name: d, browser: preset.defaultBrowserType ?? 'chromium', device: d });
    }
  }
  return out.length ? out : [{ name: 'chromium', browser: 'chromium' }];
}

function targetUse(t: Target): Record<string, unknown> {
  if (t.device) return { ...(devices as Record<string, object>)[t.device] };
  return { browserName: t.browser, viewport: DESKTOP_VIEWPORT };
}

const AUTH_SUFFIX = ' [auth]';
const specGlob = (id: string) => `**/${id}.spec.ts`;

/**
 * One project per target; in auth mode each target is split into a public project and a `<target> [auth]` project
 * that carries the storageState (SPEC-009).
 */
export function buildProjects(opts: {
  targets: Target[];
  ids: string[];
  auth?: { storageState: string; journeyIds: string[] };
}) {
  const authIds = new Set(opts.auth?.journeyIds ?? []);
  const split = !!opts.auth && authIds.size > 0;
  const publicIds = opts.ids.filter((id) => !authIds.has(id));
  const privateIds = opts.ids.filter((id) => authIds.has(id));
  const projects: PwProject[] = [];
  const meta: Record<string, ProjectMeta> = {};
  for (const t of opts.targets) {
    if (!split) {
      projects.push({ name: t.name, use: targetUse(t) });
      meta[t.name] = { target: t, auth: false };
      continue;
    }
    if (publicIds.length) {
      projects.push({ name: t.name, testMatch: publicIds.map(specGlob), use: targetUse(t) });
      meta[t.name] = { target: t, auth: false };
    }
    const name = t.name + AUTH_SUFFIX;
    projects.push({
      name,
      testMatch: privateIds.map(specGlob),
      use: { ...targetUse(t), storageState: opts.auth!.storageState },
    });
    meta[name] = { target: t, auth: true };
  }
  const projectsFor = (id: string) =>
    projects.filter((p) => !split || meta[p.name].auth === authIds.has(id)).map((p) => p.name);
  return { projects, meta, projectsFor };
}

/** FR-18/19: map our policy to Playwright's; always off when logged-in tests run (traces/videos capture typed values). */
export function artifactPolicy(kind: 'trace' | 'video', policy: ArtifactPolicy, auth: boolean): string {
  if (auth || policy === 'off') return 'off';
  if (policy === 'on-failure') return kind === 'trace' ? 'retain-on-first-failure' : 'retain-on-failure';
  return policy;
}

/** Filesystem-safe directory for a project's screenshots / failure dumps (must match `_support.ts`). */
export function projectDir(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}
