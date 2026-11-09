import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo } from '../../src/core/llm/models';
import type { HealRecord, Journey, ProgressEvent } from '../../src/core/types';
import { api, streamJob, type HealJobPayload, type RunDetail, type Settings, type SiteDetail, type SiteSummary, type TestCaseRow, type TestDetail } from './api';

type Tab = 'journeys' | 'tests' | 'code' | 'runs' | 'heals' | 'screenshots';
const ACTIONS = ['discover', 'generate', 'run', 'heal', 'all'] as const;

export function App() {
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [site, setSite] = useState<string | null>(null);
  const [detail, setDetail] = useState<SiteDetail | null>(null);
  const [tab, setTab] = useState<Tab>('journeys');
  const [log, setLog] = useState<ProgressEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rediscover, setRediscover] = useState(false);
  const [regenerate, setRegenerate] = useState(false);
  const stop = useRef<() => void>(() => {});

  const refreshSites = useCallback(() => api.sites().then(setSites).catch((e) => setError(String(e.message))), []);
  const refreshDetail = useCallback((id: string) => api.site(id).then(setDetail).catch((e) => setError(String(e.message))), []);

  useEffect(() => { api.config().then(setSettings).catch((e) => setError(String(e.message))); refreshSites(); }, [refreshSites]);
  useEffect(() => { if (site) refreshDetail(site); else setDetail(null); }, [site, refreshDetail]);

  const [testsVersion, setTestsVersion] = useState(0);
  const start = async (action: (typeof ACTIONS)[number], extra: HealJobPayload = {}) => {
    if (!settings) return;
    setError(''); setLog([]); setBusy(true);
    try {
      const { jobId } = await api.startJob({ action, url, options: settings, rediscover, regenerate, ...extra });
      stop.current = streamJob(jobId, (e) => setLog((l) => [...l, e]), () => {
        setBusy(false);
        refreshSites().then(() => { try { const id = new URL(url).host.replace(':', '_'); setSite((s) => s ?? id); } catch { /* ignore */ } });
        if (site) { refreshDetail(site); setTestsVersion((v) => v + 1); }
      });
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const pick = (s: SiteSummary) => { setSite(s.id); setUrl(s.url || s.origin); };

  return (
    <div className="layout">
      <aside>
        <h1>agentic<span>E2E</span></h1>
        <h3>Sites</h3>
        {sites.length === 0 && <p className="muted">No sites yet. Enter a URL and run Discover.</p>}
        <ul className="sites">
          {sites.map((s) => (
            <li key={s.id} className={s.id === site ? 'active' : ''} onClick={() => pick(s)}>
              <b>{s.id}</b>
              <small>{s.journeys} journeys · {s.tests} tests{s.lastRun ? ` · ${s.lastRun.passed}/${s.lastRun.total} passed` : ''}</small>
            </li>
          ))}
        </ul>
      </aside>
      <main>
        <section className="card">
          <div className="row">
            <input className="grow" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Target URL" />
          </div>
          <div className="row">
            {ACTIONS.map((a) => <button key={a} disabled={busy || !url || !settings} onClick={() => start(a)}>{a === 'all' ? 'Run all' : a[0].toUpperCase() + a.slice(1)}</button>)}
            <label><input type="checkbox" checked={rediscover} onChange={(e) => setRediscover(e.target.checked)} /> rediscover</label>
            <label><input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} /> regenerate code</label>
          </div>
          {settings && <SettingsForm s={settings} set={setSettings} />}
          {error && <p className="error">{error}</p>}
        </section>

        {(log.length > 0 || busy) && (
          <section className="card">
            <h3>Progress {busy && <span className="spinner" />}</h3>
            <pre className="log">{log.map((e) => `${e.type === 'stage' ? '▶' : e.type === 'error' ? '✗' : e.type === 'warn' ? '!' : e.type === 'done' ? '✔' : ' '} ${e.message}`).join('\n')}</pre>
          </section>
        )}

        {detail && site && (
          <section className="card">
            <div className="tabs">
              {(['journeys', 'tests', 'code', 'runs', 'heals', 'screenshots'] as Tab[]).map((t) => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
            </div>
            {tab === 'journeys' && <Journeys site={site} journeys={detail.journeys} onSaved={() => refreshDetail(site)} />}
            {tab === 'tests' && <Tests site={site} busy={busy || !settings} version={testsVersion} onHeal={(p) => start('heal', p)} />}
            {tab === 'code' && <Code site={site} tests={detail.tests} />}
            {tab === 'runs' && <Runs site={site} detail={detail} />}
            {tab === 'heals' && <Heals heals={detail.heals} />}
            {tab === 'screenshots' && <Gallery site={site} detail={detail} />}
          </section>
        )}
      </main>
    </div>
  );
}

const CUSTOM = '__custom__';

/** Dropdown of known models for the provider, with a "Custom…" escape hatch for any other id. */
function ModelPicker({ provider, model, onChange }: { provider: Settings['provider']; model: string; onChange: (m: string) => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    let live = true;
    api.models(provider).then((r) => { if (live) setModels(r.models); }).catch(() => { if (live) setModels([]); });
    return () => { live = false; };
  }, [provider]);
  // Keep the id valid for the provider: bare ids <-> `anthropic.`-prefixed Bedrock ids (the server accepts both, this just keeps the dropdown in sync).
  useEffect(() => {
    if (models.length && !custom && !models.some((m) => m.id === model)) {
      const swapped = provider === 'bedrock' ? `anthropic.${model}` : model.replace(/^anthropic\./, '');
      if (models.some((m) => m.id === swapped)) onChange(swapped); else setCustom(true);
    }
  }, [models, model, custom, provider, onChange]);
  const known = models.some((m) => m.id === model);
  return (
    <label>Model
      <select value={custom || !known ? CUSTOM : model} onChange={(e) => { if (e.target.value === CUSTOM) setCustom(true); else { setCustom(false); onChange(e.target.value); } }}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {(custom || !known) && <input value={model} onChange={(e) => onChange(e.target.value)} placeholder={provider === 'bedrock' ? 'global.anthropic.claude-… or us.anthropic.claude-…' : 'claude-…'} />}
    </label>
  );
}

/** Bedrock credentials: pick a named AWS profile found on the server's machine, or the default credential chain. */
function AwsProfilePicker({ value, onChange }: { value: string | null | undefined; onChange: (p: string | null) => void }) {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.awsProfiles().then((r) => { if (live) setProfiles(r.profiles); }).catch((e) => { if (live) setError(String(e.message)); });
    return () => { live = false; };
  }, []);
  // A configured profile that is not (or no longer) in the AWS files is still shown so it is not silently dropped.
  const options = value && !profiles.includes(value) ? [value, ...profiles] : profiles;
  return (
    <label>AWS profile
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Default credential chain</option>
        {options.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      {error && <small className="muted">Could not load profiles: {error}</small>}
      {!error && !profiles.length && <small className="muted">No profiles found in ~/.aws — run <code>aws configure --profile name</code>.</small>}
    </label>
  );
}

function SettingsForm({ s, set }: { s: Settings; set: (s: Settings) => void }) {
  const up = <K extends keyof Settings>(k: K, v: Settings[K]) => set({ ...s, [k]: v });
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <details>
      <summary>Settings</summary>
      <div className="grid">
        <label>Screenshots
          <select value={s.screenshots} onChange={(e) => up('screenshots', e.target.value as Settings['screenshots'])}>
            {['off', 'on-failure', 'every-step', 'end-of-journey'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={s.fullPage} onChange={(e) => up('fullPage', e.target.checked)} /> Full-page screenshots</label>
        <label>Max journeys <input type="number" min={1} value={s.maxJourneys} onChange={(e) => up('maxJourneys', Number(e.target.value))} /></label>
        <label>Max pages <input type="number" min={1} value={s.maxPages} onChange={(e) => up('maxPages', Number(e.target.value))} /></label>
        <label>Max depth <input type="number" min={0} value={s.maxDepth} onChange={(e) => up('maxDepth', Number(e.target.value))} /></label>
        <label>Heal attempts <input type="number" min={0} value={s.healAttempts} onChange={(e) => up('healAttempts', Number(e.target.value))} /></label>
        <label>Provider
          <select value={s.provider} onChange={(e) => up('provider', e.target.value as Settings['provider'])}>
            <option value="anthropic">Anthropic API</option>
            <option value="bedrock">Amazon Bedrock</option>
          </select>
        </label>
        <ModelPicker provider={s.provider} model={s.model} onChange={(m) => up('model', m)} />
        {s.provider === 'bedrock' && <AwsProfilePicker value={s.awsProfile} onChange={(p) => up('awsProfile', p)} />}
        <label>Include <input defaultValue={s.include.join(', ')} onBlur={(e) => up('include', list(e.target.value))} placeholder="search, checkout" /></label>
        <label>Exclude <input defaultValue={s.exclude.join(', ')} onBlur={(e) => up('exclude', list(e.target.value))} placeholder="login" /></label>
        <label className="check"><input type="checkbox" checked={s.requireApproval} onChange={(e) => up('requireApproval', e.target.checked)} /> Only generate approved journeys</label>
        <label className="check"><input type="checkbox" checked={s.headless} onChange={(e) => up('headless', e.target.checked)} /> Headless</label>
      </div>
    </details>
  );
}

function Journeys({ site, journeys, onSaved }: { site: string; journeys: Journey[]; onSaved: () => void }) {
  const [rows, setRows] = useState(journeys);
  const [msg, setMsg] = useState('');
  useEffect(() => setRows(journeys), [journeys]);
  const upd = (i: number, patch: Partial<Journey>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = async (next = rows) => {
    try { await api.saveJourneys(site, next); setMsg('Saved'); onSaved(); } catch (e) { setMsg((e as Error).message); }
  };
  if (!rows.length) return <p className="muted">No journeys yet — run Discover.</p>;
  return (
    <div>
      {rows.map((j, i) => (
        <div className={`journey s-${j.status}`} key={j.id}>
          <div className="row">
            <input className="grow" value={j.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label={`name ${j.id}`} />
            <select value={j.priority} onChange={(e) => upd(i, { priority: e.target.value as Journey['priority'] })}>{['high', 'medium', 'low'].map((p) => <option key={p}>{p}</option>)}</select>
            <select value={j.status} onChange={(e) => upd(i, { status: e.target.value as Journey['status'] })}>{['proposed', 'selected', 'approved', 'rejected'].map((p) => <option key={p}>{p}</option>)}</select>
          </div>
          <input value={j.goal} onChange={(e) => upd(i, { goal: e.target.value })} aria-label={`goal ${j.id}`} />
          <textarea rows={Math.max(3, j.steps.length + 1)} value={j.steps.join('\n')} onChange={(e) => upd(i, { steps: e.target.value.split('\n').filter((l) => l.trim()) })} aria-label={`steps ${j.id}`} />
          {j.rationale && <small className="muted">LLM rank {j.rank}: {j.rationale}</small>}
        </div>
      ))}
      <div className="row">
        <button onClick={() => save()}>Save edits</button>
        <button onClick={() => save(rows.map((j) => (j.status === 'rejected' ? j : { ...j, status: 'approved' as const })))}>Approve all</button>
        <span className="muted">{msg}</span>
      </div>
    </div>
  );
}

/** Stored tests with their latest outcome; heal the ticked ones or every latest-failed one. */
function Tests({ site, busy, version, onHeal }: { site: string; busy: boolean; version: number; onHeal: (p: HealJobPayload) => void }) {
  const [rows, setRows] = useState<TestCaseRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.testCases(site).then((r) => { if (live) { setRows(r.tests); setPicked(new Set()); setErr(''); } }).catch((e) => { if (live) setErr(String(e.message)); });
    return () => { live = false; };
  }, [site, version]);
  if (err) return <p className="error">{err}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  if (!rows.length) return <p className="muted">No generated tests yet — run Generate.</p>;
  const failed = rows.filter((t) => t.lastRun.outcome === 'failed');
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div>
      {rows.map((t) => (
        <label key={t.journeyId} className={`result test-${t.lastRun.outcome}`}>
          <input type="checkbox" checked={picked.has(t.journeyId)} onChange={() => toggle(t.journeyId)} aria-label={`select ${t.journeyId}`} />{' '}
          <b>{t.journeyId}</b> <small>{t.name}</small> <span className="badge">{t.lastRun.outcome.replace('_', ' ')}</span>
          {t.lastRun.error && <small className="muted"> {t.lastRun.error}</small>}
        </label>
      ))}
      <div className="row">
        <button disabled={busy || !picked.size} onClick={() => onHeal({ journeyIds: rows.filter((t) => picked.has(t.journeyId)).map((t) => t.journeyId) })}>Heal selected ({picked.size})</button>
        <button disabled={busy || !failed.length} onClick={() => onHeal({ failedOnly: true })}>Heal all failed ({failed.length})</button>
      </div>
    </div>
  );
}

function Code({ site, tests }: { site: string; tests: SiteDetail['tests'] }) {
  const [sel, setSel] = useState(tests[0]?.id ?? '');
  const [t, setT] = useState<TestDetail | null>(null);
  const [ver, setVer] = useState('current');
  useEffect(() => { if (sel) api.test(site, sel).then((d) => { setT(d); setVer('current'); }); }, [site, sel]);
  if (!tests.length) return <p className="muted">No generated tests yet — run Generate.</p>;
  const code = ver === 'current' ? t?.code : t?.versions.find((v) => v.name === ver)?.code;
  return (
    <div>
      <div className="row">
        <select value={sel} onChange={(e) => setSel(e.target.value)}>{tests.map((x) => <option key={x.id}>{x.id}</option>)}</select>
        <select value={ver} onChange={(e) => setVer(e.target.value)}><option>current</option>{t?.versions.map((v) => <option key={v.name}>{v.name}</option>)}</select>
      </div>
      <pre className="code">{code}</pre>
    </div>
  );
}

function Runs({ site, detail }: { site: string; detail: SiteDetail }) {
  const [sel, setSel] = useState(detail.runs[0]?.id ?? '');
  const [run, setRun] = useState<RunDetail | null>(null);
  useEffect(() => { if (sel) api.run(site, sel).then(setRun); }, [site, sel]);
  if (!detail.runs.length) return <p className="muted">No runs yet.</p>;
  return (
    <div>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>{detail.runs.map((r) => <option key={r.id} value={r.id}>{r.startedAt} ({r.kind}) {r.results.filter((x) => x.status === 'passed').length}/{r.results.length}</option>)}</select>
      {run?.results.map((r) => (
        <div key={r.journeyId} className={`result ${r.status}`}>
          <b>{r.status === 'passed' ? '✔' : '✗'} {r.journeyId}</b> <small>{r.status} · {r.durationMs}ms</small>
          {r.error && <pre className="err">{r.error.slice(0, 1200)}</pre>}
          {r.tracePath && <a href={api.fileUrl(site, r.tracePath)}>trace.zip</a>}
          <div className="thumbs">{r.screenshots.map((s) => <a key={s} href={api.fileUrl(site, s)} target="_blank" rel="noreferrer"><img src={api.fileUrl(site, s)} alt={s} loading="lazy" /></a>)}</div>
        </div>
      ))}
    </div>
  );
}

function Heals({ heals }: { heals: HealRecord[] }) {
  if (!heals.length) return <p className="muted">No heals yet.</p>;
  return (
    <div>
      {heals.map((h) => (
        <div key={h.id} className={`result heal-${h.outcome}`}>
          <b>{h.journeyId}</b> <small>{h.at} · <span className="badge">{h.outcome}</span> {h.verdict && `(${h.verdict})`}</small>
          {h.outcome === 'failed' && h.lastError
            ? <><p><b>Last error:</b> <code>{h.lastError.split('\n').find((l) => l.trim()) ?? h.lastError}</code></p><p className="muted">Last diagnosis: {h.reason}</p></>
            : <p>{h.reason}</p>}
          <ul>{h.attempts.map((a) => <li key={a.n}>attempt {a.n}: {a.accepted ? (a.passed ? 'passed' : 'ran, still failing') : `rejected — ${a.rejection}`}</li>)}</ul>
          {h.candidateDiff && <details><summary>Candidate patch (not applied — saved as a version)</summary><pre className="diff">{h.candidateDiff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l + '\n'}</span>)}</pre></details>}
          {h.diff && <pre className="diff">{h.diff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l + '\n'}</span>)}</pre>}
        </div>
      ))}
    </div>
  );
}

function Gallery({ site, detail }: { site: string; detail: SiteDetail }) {
  const [groups, setGroups] = useState<{ run: string; shots: string[] }[]>([]);
  useEffect(() => {
    Promise.all(detail.runs.map((r) => api.run(site, r.id))).then((runs) => setGroups(runs.map((r) => ({ run: r.id, shots: r.results.flatMap((x) => x.screenshots) })).filter((g) => g.shots.length)));
  }, [site, detail]);
  const pages = detail.pages.filter((p) => p.screenshot);
  if (!groups.length && !pages.length) return <p className="muted">No screenshots. Choose a screenshot mode in Settings and run again.</p>;
  return (
    <div>
      {pages.length > 0 && <><h4>Discovery</h4><div className="thumbs">{pages.map((p) => <a key={p.path} href={api.fileUrl(site, p.screenshot!)} target="_blank" rel="noreferrer"><img src={api.fileUrl(site, p.screenshot!)} alt={p.path} loading="lazy" /><small>{p.path}</small></a>)}</div></>}
      {groups.map((g) => <div key={g.run}><h4>{g.run}</h4><div className="thumbs">{g.shots.map((s) => <a key={s} href={api.fileUrl(site, s)} target="_blank" rel="noreferrer"><img src={api.fileUrl(site, s)} alt={s} loading="lazy" /><small>{s.split('/').slice(-2).join('/')}</small></a>)}</div></div>)}
    </div>
  );
}
