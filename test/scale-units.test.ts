import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/core/config.js';
import { resolveTargets, buildProjects, artifactPolicy, projectDir } from '../src/core/scale/targets.js';
import { parseShard, applyShard } from '../src/core/scale/shard.js';
import {
  resolveEnvironment,
  environmentSecrets,
  publicEnvironments,
  EnvironmentError,
} from '../src/core/scale/environments.js';
import {
  withDefaultTags,
  isDestructiveJourney,
  filterJourneyIds,
  editTags,
  normalizeTags,
  parseTagEdits,
  applyTagEdits,
} from '../src/core/scale/tags.js';
import { aggregateByJourney, failuresToHeal } from '../src/core/scale/results.js';
import { publicError } from '../src/core/credentials.js';
import type { Journey, TestResult } from '../src/core/types.js';

const cfg = (file: Record<string, unknown> = {}, cli: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
  resolveConfig({ file: file as never, cli: cli as never, env, cwd: '/tmp' });
const j = (id: string, extra: Partial<Journey> = {}): Journey => ({
  id,
  name: `Journey ${id}`,
  goal: 'g',
  priority: 'medium',
  tags: [],
  steps: ['open the page'],
  status: 'selected',
  ...extra,
});
const r = (
  journeyId: string,
  status: TestResult['status'],
  project = 'chromium',
  extra: Partial<TestResult> = {},
): TestResult => ({
  journeyId,
  file: `tests/${journeyId}.spec.ts`,
  status,
  durationMs: 1,
  screenshots: [],
  project,
  browser: 'chromium',
  ...extra,
});

describe('SPEC-012 config', () => {
  it('defaults keep the previous behaviour', () => {
    const c = cfg();
    expect(c.workers).toBe(2);
    expect(c.retries).toBe(0);
    expect(c.trace).toBe('retain-on-failure');
    expect(c.video).toBe('off');
    expect(c.environments).toEqual({});
    expect(c.env).toBeUndefined();
    expect(c.shard).toBeUndefined();
  });
  it('AC-4: workers / retries validation', () => {
    expect(cfg({}, { workers: 4, retries: 2 })).toMatchObject({ workers: 4, retries: 2 });
    expect(cfg({ workers: '50%' }).workers).toBe('50%');
    expect(() => cfg({}, { workers: 0 })).toThrow(/workers/);
    expect(() => cfg({}, { retries: -1 })).toThrow(/retries/);
    expect(() => cfg({ workers: 'lots' })).toThrow(/workers/);
  });
  it('AC-5: shard must look like i/n', () => {
    expect(cfg({}, { shard: '1/4' }).shard).toBe('1/4');
    expect(() => cfg({}, { shard: 'x' })).toThrow(/shard/);
  });
  it('AC-2: unknown browser is rejected; trace/video enums', () => {
    expect(() => cfg({ browsers: ['edge'] })).toThrow(/browsers/);
    expect(() => cfg({ trace: 'sometimes' })).toThrow(/trace/);
    expect(cfg({ trace: 'on-failure', video: 'retain-on-failure' })).toMatchObject({
      trace: 'on-failure',
      video: 'retain-on-failure',
    });
  });
  it('FR-8: environments + env from AGENTIC_E2E_ENV; CLI wins', () => {
    const environments = {
      staging: { baseUrl: 'https://staging.example.com' },
      prod: { baseUrl: 'https://example.com' },
    };
    expect(cfg({ environments }, {}, { AGENTIC_E2E_ENV: 'staging' }).env).toBe('staging');
    expect(cfg({ environments }, { env: 'prod' }, { AGENTIC_E2E_ENV: 'staging' }).env).toBe('prod');
    expect(() => cfg({ environments: { bad: { baseUrl: 'ftp://x' } } })).toThrow(/environments/);
  });
});

describe('SPEC-012 targets (FR-1..4)', () => {
  it('AC-1: default is chromium; browsers ∪ devices otherwise', () => {
    expect(resolveTargets({})).toEqual([{ name: 'chromium', browser: 'chromium' }]);
    expect(resolveTargets({ browsers: ['firefox', 'firefox'], devices: ['iPhone 15'] })).toEqual([
      { name: 'firefox', browser: 'firefox' },
      { name: 'iPhone 15', browser: 'webkit', device: 'iPhone 15' },
    ]);
    expect(resolveTargets({ devices: ['Pixel 7'] })).toEqual([
      { name: 'Pixel 7', browser: 'chromium', device: 'Pixel 7' },
    ]);
  });
  it('AC-2: unknown device fails with a suggestion', () => {
    expect(() => resolveTargets({ devices: ['iPhone 99'] })).toThrow(/Unknown device "iPhone 99".*iPhone/);
  });
  it('AC-1: one project per target with the right use', () => {
    const { projects, projectsFor } = buildProjects({
      targets: resolveTargets({ browsers: ['chromium', 'webkit'], devices: ['Pixel 7'] }),
      ids: ['a', 'b'],
    });
    expect(projects.map((p) => p.name)).toEqual(['chromium', 'webkit', 'Pixel 7']);
    expect(projects[1].use).toMatchObject({ browserName: 'webkit', viewport: { width: 1280, height: 800 } });
    expect(projects[2].use).toMatchObject({ isMobile: true, defaultBrowserType: 'chromium' });
    expect(projectsFor('a')).toEqual(['chromium', 'webkit', 'Pixel 7']);
  });
  it('AC-3: auth splits each target into public and [auth] projects', () => {
    const { projects, projectsFor, meta } = buildProjects({
      targets: resolveTargets({ browsers: ['chromium', 'firefox'] }),
      ids: ['pub', 'acct'],
      auth: { storageState: '/s.json', journeyIds: ['acct'] },
    });
    expect(projects.map((p) => p.name)).toEqual(['chromium', 'chromium [auth]', 'firefox', 'firefox [auth]']);
    expect(
      projects.filter((p) => (p.use as { storageState?: string }).storageState === '/s.json').map((p) => p.name),
    ).toEqual(['chromium [auth]', 'firefox [auth]']);
    expect(projectsFor('acct')).toEqual(['chromium [auth]', 'firefox [auth]']);
    expect(projectsFor('pub')).toEqual(['chromium', 'firefox']);
    expect(meta['firefox [auth]']).toMatchObject({ target: { browser: 'firefox' }, auth: true });
  });
  it('AC-14 / FR-19: trace/video mapping, forced off in auth mode', () => {
    expect(artifactPolicy('trace', 'on-failure', false)).toBe('retain-on-first-failure');
    expect(artifactPolicy('video', 'on-failure', false)).toBe('retain-on-failure');
    expect(artifactPolicy('trace', 'retain-on-failure', false)).toBe('retain-on-failure');
    expect(artifactPolicy('video', 'on', false)).toBe('on');
    expect(artifactPolicy('trace', 'on', true)).toBe('off');
    expect(artifactPolicy('video', 'on', true)).toBe('off');
  });
  it('project dirs are filesystem-safe slugs', () => {
    expect(projectDir('iPhone 15 [auth]')).toBe('iphone-15-auth');
  });
});

describe('SPEC-012 shard (FR-6, AC-5)', () => {
  it('parses and validates', () => {
    expect(parseShard('2/4')).toEqual({ current: 2, total: 4 });
    for (const bad of ['0/2', '3/2', 'x', '1/0', '1']) expect(() => parseShard(bad)).toThrow(/shard/i);
  });
  it('splits the sorted ids into contiguous chunks that cover the list', () => {
    const ids = ['e', 'a', 'c', 'b', 'd'];
    expect(applyShard(ids, { current: 2, total: 2 })).toEqual(['d', 'e']);
    expect(applyShard(ids, { current: 1, total: 2 })).toEqual(['a', 'b', 'c']);
    for (const total of [1, 2, 3, 4, 7]) {
      const all = Array.from({ length: total }, (_, i) => applyShard(ids, { current: i + 1, total })).flat();
      expect(all.sort()).toEqual([...ids].sort());
    }
    expect(applyShard(['a'], { current: 2, total: 3 })).toEqual([]);
  });
});

describe('SPEC-012 environments (FR-8..11)', () => {
  const environments = {
    staging: {
      baseUrl: 'https://staging.example.com/app',
      headers: { 'x-env-token': 'Bearer ${STG_TOKEN}', 'x-plain': 'yes' },
    },
    prod: { baseUrl: 'https://example.com' },
    Production: { baseUrl: 'https://example.com', readOnly: false },
    dev: { baseUrl: 'http://localhost:3000' },
  };
  it('resolves baseUrl, interpolated headers and readOnly defaults', () => {
    const e = resolveEnvironment({ environments, env: 'staging' }, { STG_TOKEN: 's3cr3t-token' })!;
    expect(e).toMatchObject({
      name: 'staging',
      baseUrl: 'https://staging.example.com/app',
      origin: 'https://staging.example.com',
      readOnly: false,
    });
    expect(e.headers).toEqual({ 'x-env-token': 'Bearer s3cr3t-token', 'x-plain': 'yes' });
    expect(resolveEnvironment({ environments, env: 'prod' }, {})!.readOnly).toBe(true);
    expect(resolveEnvironment({ environments, env: 'Production' }, {})!.readOnly).toBe(false);
    expect(resolveEnvironment({ environments, env: 'dev' }, {})!.readOnly).toBe(false);
    expect(resolveEnvironment({ environments }, {})).toBeNull();
  });
  it('unknown env lists names', () => {
    expect(() => resolveEnvironment({ environments, env: 'qa' }, {})).toThrow(/Unknown environment "qa".*staging/);
  });
  it('AC-8: unset variable names the variable for the CLI but not for web clients', () => {
    let err: unknown;
    try {
      resolveEnvironment({ environments, env: 'staging' }, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as Error).message).toContain('STG_TOKEN');
    expect(publicError(err)).not.toContain('STG_TOKEN');
  });
  it('header values become redactor secrets; public view has names only', () => {
    const e = resolveEnvironment({ environments, env: 'staging' }, { STG_TOKEN: 's3cr3t-token' })!;
    expect(environmentSecrets(e).map((s) => s.value)).toContain('Bearer s3cr3t-token');
    expect(environmentSecrets(e).map((s) => s.value)).toContain('s3cr3t-token');
    const pub = publicEnvironments(environments);
    expect(pub.staging).toEqual({
      baseUrl: 'https://staging.example.com/app',
      readOnly: false,
      headers: ['x-env-token', 'x-plain'],
    });
    expect(JSON.stringify(pub)).not.toContain('Bearer');
  });
});

describe('SPEC-012 tags, destructive, filters (FR-12, 14..16)', () => {
  it('AC-10: default suite tags by priority; LLM tags normalised', () => {
    expect(withDefaultTags('high', [])).toEqual(['smoke', 'critical', 'regression']);
    expect(withDefaultTags('medium', undefined)).toEqual(['regression']);
    expect(withDefaultTags('low', ['Smoke', 'smoke'])).toEqual(['smoke']);
    expect(withDefaultTags('low', ['Destructive'])).toEqual(['destructive', 'regression']);
    expect(normalizeTags([' A ', 'a', 'Bad Tag'])).toEqual(['a', 'bad-tag']);
  });
  it('AC-9: destructive = tag, else heuristic; read-only tag overrides', () => {
    expect(isDestructiveJourney(j('buy', { tags: ['destructive'] }))).toBe(true);
    expect(
      isDestructiveJourney(
        j('delete-account', { name: 'Delete account', steps: ['open settings', 'click Delete account'] }),
      ),
    ).toBe(true);
    expect(isDestructiveJourney(j('checkout', { name: 'Checkout', goal: 'Place an order and pay' }))).toBe(true);
    expect(isDestructiveJourney(j('browse', { name: 'Browse products', goal: 'See the catalogue' }))).toBe(false);
    expect(isDestructiveJourney(j('rm', { name: 'Remove item from cart', tags: ['read-only'] }))).toBe(false);
  });
  it('AC-12: grep (substring or /regex/) and tag (any) filters', () => {
    const js = [
      j('a', { tags: ['smoke'] }),
      j('checkout', { name: 'Checkout flow', tags: ['regression'] }),
      j('c', { tags: ['regression', 'critical'] }),
    ];
    const ids = ['a', 'checkout', 'c', 'orphan'];
    expect(filterJourneyIds(ids, js, { tag: ['smoke'] })).toEqual(['a']);
    expect(filterJourneyIds(ids, js, { tag: ['critical', 'smoke'] })).toEqual(['a', 'c']);
    expect(filterJourneyIds(ids, js, { grep: 'CHECKOUT' })).toEqual(['checkout']);
    expect(filterJourneyIds(ids, js, { grep: '/^(a|orphan)$/' })).toEqual(['a', 'orphan']);
    expect(filterJourneyIds(ids, js, { grep: 'regression', tag: ['critical'] })).toEqual(['c']);
    expect(filterJourneyIds(ids, js, {})).toEqual(ids);
  });
  it('AC-11: editTags add/remove/set with validation', () => {
    const js = [j('a', { tags: ['regression'] }), j('b', { tags: ['smoke'] })];
    const out = editTags(js, ['a'], { add: ['Critical'], remove: ['regression'] });
    expect(out.map((x) => x.tags)).toEqual([['critical'], ['smoke']]);
    expect(editTags(js, [], { set: ['smoke'] }).map((x) => x.tags)).toEqual([['smoke'], ['smoke']]);
    expect(() => editTags(js, ['zz'], { add: ['x'] })).toThrow(/Unknown journey id.*zz.*a, b/);
    expect(() => editTags(js, ['a'], { add: ['!!'] })).toThrow(/Invalid tag/);
  });
});

describe('SPEC-012 journeys tag edits (FR-15)', () => {
  it('parses id=tag,tag pairs', () => {
    expect(parseTagEdits(['a=x, y', '*=z'])).toEqual([
      { id: 'a', tags: ['x', 'y'] },
      { id: '*', tags: ['z'] },
    ]);
    for (const bad of ['nonsense', '=x', 'a=']) expect(() => parseTagEdits([bad])).toThrow(/id=tag/);
  });
  it('applies set, then add, then remove; validates before changing anything', () => {
    const js = [j('a', { tags: ['regression'] }), j('b', { tags: ['smoke'] })];
    expect(
      applyTagEdits(js, { set: ['*=smoke'], add: ['a=critical'], remove: ['b=smoke'] }).map((x) => x.tags),
    ).toEqual([['smoke', 'critical'], []]);
    expect(() => applyTagEdits(js, { add: ['a=ok', 'zz=x'] })).toThrow(/Unknown journey id.*zz/);
    expect(js[0].tags).toEqual(['regression']);
  });
});

describe('SPEC-012 results (FR-22)', () => {
  it('AC-16: one entry per journey, failed if any project failed', () => {
    const results = [
      r('x', 'passed', 'chromium'),
      r('x', 'failed', 'firefox', { error: 'boom' }),
      r('y', 'passed', 'chromium'),
      r('y', 'passed', 'firefox'),
    ];
    const agg = aggregateByJourney(results);
    expect(agg.map((a) => [a.journeyId, a.status, a.project])).toEqual([
      ['x', 'failed', 'firefox'],
      ['y', 'passed', 'chromium'],
    ]);
    expect(failuresToHeal(results).map((f) => [f.journeyId, f.project])).toEqual([['x', 'firefox']]);
    expect(failuresToHeal([r('x', 'timedOut', 'a'), r('x', 'failed', 'b')])).toHaveLength(1);
  });
});
