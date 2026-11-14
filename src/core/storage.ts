import fs from 'node:fs';
import path from 'node:path';
import type { HealRecord, Journey, PageModel, RunRecord, SiteMeta } from './types.js';
import { SUPPORT_SOURCE } from './support.js';
import { Redactor } from './redact.js';

const SITE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeSite(input: string): SiteMeta & { host: string } {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) URLs are supported, got ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  const port = u.port && u.port !== defaultPort ? u.port : '';
  const id = (host + (port ? `_${port}` : '')).replace(/[^a-z0-9._-]/g, '_');
  return { id, host, origin: u.origin, url: u.origin + (u.pathname === '/' ? '' : u.pathname) + u.search };
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export class Store {
  /** SPEC-009: everything persisted goes through `redactor`, so a credential value can never land in data/. */
  constructor(public readonly dataDir: string, private readonly redactor: Redactor = Redactor.empty()) {}

  redact(s: string): string { return this.redactor.redact(s); }
  private writeJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.redactor.redact(JSON.stringify(data, null, 2)) + '\n');
  }

  /** Playwright storageState of a logged-in user (contains session cookies: gitignored, 0600, never served). */
  authDir(site: string) { return path.join(this.siteDir(site), 'auth'); }
  authStatePath(site: string, user: string) { return path.join(this.authDir(site), `${this.checkId(user, SAFE_RE)}.json`); }

  siteDir(site: string): string {
    if (!SITE_RE.test(site) || site.includes('..')) throw new Error(`Invalid site id: ${JSON.stringify(site)}`);
    return path.join(this.dataDir, 'sites', site);
  }
  private checkId(id: string, re = ID_RE) {
    if (!re.test(id) || id.includes('..')) throw new Error(`Invalid id: ${JSON.stringify(id)}`);
    return id;
  }
  testsDir(site: string) { return path.join(this.siteDir(site), 'tests'); }
  testFile(site: string, id: string) { return path.join(this.testsDir(site), `${this.checkId(id)}.spec.ts`); }

  /** True when a site directory exists in the data dir (never creates it). */
  hasSite(site: string): boolean { return fs.existsSync(this.siteDir(site)); }

  ensureSite(site: string) {
    const tests = this.testsDir(site);
    fs.mkdirSync(tests, { recursive: true });
    const sup = path.join(tests, '_support.ts');
    if (!fs.existsSync(sup) || fs.readFileSync(sup, 'utf8') !== SUPPORT_SOURCE) fs.writeFileSync(sup, SUPPORT_SOURCE);
  }

  saveSite(meta: SiteMeta) {
    this.ensureSite(meta.id);
    const prev = this.loadSite(meta.id);
    this.writeJson(path.join(this.siteDir(meta.id), 'site.json'), { ...prev, ...meta, updatedAt: new Date().toISOString() });
  }
  loadSite(site: string): SiteMeta | null { return readJson<SiteMeta>(path.join(this.siteDir(site), 'site.json')); }
  listSites(): SiteMeta[] {
    const root = path.join(this.dataDir, 'sites');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((d) => SITE_RE.test(d)).map((d) => this.loadSite(d)).filter((x): x is SiteMeta => !!x);
  }

  saveJourneys(site: string, journeys: Journey[]) { this.writeJson(path.join(this.siteDir(site), 'journeys.json'), journeys); }
  loadJourneys(site: string): Journey[] | null { return readJson<Journey[]>(path.join(this.siteDir(site), 'journeys.json')); }
  savePages(site: string, pages: PageModel[]) { this.writeJson(path.join(this.siteDir(site), 'pages.json'), pages); }
  loadPages(site: string): PageModel[] | null { return readJson<PageModel[]>(path.join(this.siteDir(site), 'pages.json')); }

  saveTest(site: string, id: string, code: string) {
    this.ensureSite(site);
    fs.writeFileSync(this.testFile(site, id), this.redactor.redact(code));
  }
  loadTest(site: string, id: string): string | null {
    const f = this.testFile(site, id);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
  hasTest(site: string, id: string) { return fs.existsSync(this.testFile(site, id)); }
  listTests(site: string): string[] {
    const d = this.testsDir(site);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.spec.ts')).map((f) => f.replace(/\.spec\.ts$/, '')).sort();
  }
  private versionFile(site: string, id: string, name: string) {
    return path.join(this.testsDir(site), '.versions', this.checkId(id), `${this.checkId(name, SAFE_RE)}.spec.ts`);
  }
  saveTestVersion(site: string, id: string, name: string, code: string) {
    const f = this.versionFile(site, id, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, this.redactor.redact(code));
  }
  loadTestVersion(site: string, id: string, name: string): string | null {
    const f = this.versionFile(site, id, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
  listTestVersions(site: string, id: string): string[] {
    const d = path.dirname(this.versionFile(site, id, 'x'));
    return fs.existsSync(d) ? fs.readdirSync(d).map((f) => f.replace(/\.spec\.ts$/, '')).sort() : [];
  }

  appendHeal(site: string, rec: HealRecord) {
    const f = path.join(this.siteDir(site), 'heals.json');
    this.writeJson(f, [...(readJson<HealRecord[]>(f) ?? []), rec]);
  }
  loadHeals(site: string): HealRecord[] { return readJson<HealRecord[]>(path.join(this.siteDir(site), 'heals.json')) ?? []; }

  createRun(site: string): { id: string; dir: string; screenshotsDir: string } {
    const base = new Date().toISOString().replace(/[:.]/g, '-');
    let id = base;
    for (let i = 2; fs.existsSync(path.join(this.siteDir(site), 'runs', id)); i++) id = `${base}-${i}`;
    const dir = path.join(this.siteDir(site), 'runs', id);
    fs.mkdirSync(dir, { recursive: true });
    return { id, dir, screenshotsDir: path.join(this.siteDir(site), 'screenshots', id) };
  }
  runDir(site: string, runId: string) { return path.join(this.siteDir(site), 'runs', this.checkId(runId, SAFE_RE)); }
  saveRun(site: string, run: RunRecord) { this.writeJson(path.join(this.runDir(site, run.id), 'result.json'), run); }
  loadRun(site: string, runId: string): RunRecord | null { return readJson<RunRecord>(path.join(this.runDir(site, runId), 'result.json')); }
  listRuns(site: string): RunRecord[] {
    const d = path.join(this.siteDir(site), 'runs');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).sort().map((r) => this.loadRun(site, r)).filter((x): x is RunRecord => !!x);
  }

  /** Resolve a relative path inside a site dir; throws on traversal. */
  resolveFile(site: string, rel: string): string {
    const root = this.siteDir(site);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes site directory');
    return abs;
  }
}
