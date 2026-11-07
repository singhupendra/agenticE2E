import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { listAwsProfiles } from '../core/aws-profiles.js';
import type { Config } from '../core/config.js';
import { parseJourneys } from '../core/journeys.js';
import { listModels, PROVIDERS, type ProviderId } from '../core/llm/models.js';
import type { LLMProvider } from '../core/llm/types.js';
import { packageRoot } from '../core/paths.js';
import { Store } from '../core/storage.js';
import { JobManager, parseJobRequest } from './jobs.js';

const FILE_PREFIXES = ['screenshots/', 'runs/'];
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.zip': 'application/zip', '.json': 'application/json', '.log': 'text/plain' };

/** `awsEnv` is a test seam: the environment used to locate the AWS config/credentials files (default: process.env). */
export async function buildApp(opts: { config: Config; llm?: LLMProvider; webDir?: string; host?: string; awsEnv?: Record<string, string | undefined> }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const store = new Store(opts.config.dataDir);
  const jobs = new JobManager(opts.config, opts.llm);

  // This server runs generated tests and spends LLM credits. Defences:
  //  1. Host allowlist on every request (stops DNS rebinding: a rebound page has Host == Origin == attacker.com).
  //  2. Mutating requests must be application/json (cannot be sent cross-site without a CORS preflight, which we never grant).
  //  3. If an Origin is sent on a mutating request it must match Host.
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (opts.host && !['0.0.0.0', '::'].includes(opts.host)) allowedHosts.add(opts.host.toLowerCase().replace(/^([^[].*:.*)$/, '[$1]'));
  const hostnameOf = (hostHeader: string | undefined) => {
    try { return new URL(`http://${hostHeader ?? ''}`).hostname.toLowerCase(); } catch { return ''; }
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(hostnameOf(req.headers.host))) return reply.code(403).send({ error: 'Host not allowed' });
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'Content-Type must be application/json' });
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* invalid origin */ }
      if (host !== req.headers.host) return reply.code(403).send({ error: 'Cross-origin request rejected' });
    }
  });

  const siteOr404 = (site: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    try {
      store.siteDir(site);
    } catch (e) {
      reply.code(400).send({ error: (e as Error).message });
      return null;
    }
    const meta = store.loadSite(site);
    if (!meta) { reply.code(404).send({ error: `Unknown site ${site}` }); return null; }
    return meta;
  };

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => {
    const { dataDir: _d, maxTokens: _m, awsRegion: _r, ...pub } = opts.config;
    return pub;
  });
  app.get<{ Querystring: { provider?: string } }>('/api/models', async (req, reply) => {
    const provider = req.query.provider ?? opts.config.provider;
    if (!(PROVIDERS as readonly string[]).includes(provider)) return reply.code(400).send({ error: `provider must be one of ${PROVIDERS.join(', ')}` });
    return { provider, models: listModels(provider as ProviderId) };
  });
  // Profile *names* only; never keys, secrets or tokens.
  app.get('/api/aws-profiles', async () => ({ profiles: listAwsProfiles(opts.awsEnv ?? process.env), ...(opts.config.awsProfile ? { selected: opts.config.awsProfile } : {}) }));
  app.get('/api/sites', async () => store.listSites().map((s) => {
    const runs = store.listRuns(s.id);
    const last = runs.at(-1);
    return { ...s, journeys: store.loadJourneys(s.id)?.length ?? 0, tests: store.listTests(s.id).length, runs: runs.length, lastRun: last ? { id: last.id, passed: last.results.filter((r) => r.status === 'passed').length, total: last.results.length } : null };
  }));

  app.get<{ Params: { site: string } }>('/api/sites/:site', async (req, reply) => {
    const meta = siteOr404(req.params.site, reply);
    if (!meta) return;
    const id = meta.id;
    return {
      meta,
      journeys: store.loadJourneys(id) ?? [],
      pages: (store.loadPages(id) ?? []).map((p) => ({ path: p.path, title: p.title, depth: p.depth, screenshot: p.screenshot })),
      tests: store.listTests(id).map((t) => ({ id: t, versions: store.listTestVersions(id, t) })),
      runs: store.listRuns(id).map((r) => ({ id: r.id, kind: r.kind, startedAt: r.startedAt, screenshots: r.screenshots, results: r.results.map((x) => ({ journeyId: x.journeyId, status: x.status })) })).reverse(),
      heals: store.loadHeals(id).slice().reverse(),
    };
  });

  app.put<{ Params: { site: string }; Body: unknown }>('/api/sites/:site/journeys', async (req, reply) => {
    const meta = siteOr404(req.params.site, reply);
    if (!meta) return;
    try {
      const journeys = parseJourneys(req.body);
      store.saveJourneys(meta.id, journeys);
      return journeys;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { site: string; id: string } }>('/api/sites/:site/tests/:id', async (req, reply) => {
    const meta = siteOr404(req.params.site, reply);
    if (!meta) return;
    try {
      const code = store.loadTest(meta.id, req.params.id);
      if (code === null) return reply.code(404).send({ error: 'No such test' });
      const versions = store.listTestVersions(meta.id, req.params.id).map((name) => ({ name, code: store.loadTestVersion(meta.id, req.params.id, name) }));
      return { id: req.params.id, code, versions };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { site: string; runId: string } }>('/api/sites/:site/runs/:runId', async (req, reply) => {
    const meta = siteOr404(req.params.site, reply);
    if (!meta) return;
    try {
      const r = store.loadRun(meta.id, req.params.runId);
      return r ?? reply.code(404).send({ error: 'No such run' });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { site: string; '*': string } }>('/api/sites/:site/files/*', async (req, reply) => {
    const meta = siteOr404(req.params.site, reply);
    if (!meta) return;
    const rel = req.params['*'];
    try {
      if (!FILE_PREFIXES.some((p) => rel.startsWith(p)) || rel.split(/[\\/]/).includes('..')) return reply.code(403).send({ error: 'Forbidden' });
      const abs = store.resolveFile(meta.id, rel);
      const mime = MIME[path.extname(abs).toLowerCase()];
      if (!mime) return reply.code(403).send({ error: 'File type not served' });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'Not found' });
      return reply.header('content-type', mime).header('x-content-type-options', 'nosniff').send(fs.createReadStream(abs));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/jobs', async (req, reply) => {
    let jr;
    try { jr = parseJobRequest(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    const profile = jr.options?.awsProfile;
    // Only meaningful (and only checked) when the job will actually use Bedrock.
    if (profile && (jr.options?.provider ?? opts.config.provider) === 'bedrock' && !listAwsProfiles(opts.awsEnv ?? process.env).includes(profile)) return reply.code(400).send({ error: `Unknown AWS profile "${profile}"` });
    try {
      const job = jobs.start(jr);
      return reply.code(202).send({ jobId: job.id });
    } catch (e) {
      return reply.code((e as { statusCode?: number }).statusCode ?? 500).send({ error: (e as Error).message });
    }
  });
  app.get('/api/jobs', async () => jobs.list());
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const j = jobs.get(req.params.id);
    return j ? { ...j, events: j.events.slice(-200) } : reply.code(404).send({ error: 'No such job' });
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/events', (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'No such job' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const terminal = (t: string) => t === 'done' || t === 'error';
    let unsub = () => {};
    const end = () => { unsub(); res.end(); };
    let finished = false;
    unsub = jobs.subscribe(job.id, (e) => { send(e); if (terminal(e.type)) { finished = true; end(); } });
    for (const e of job.events) { send(e); if (terminal(e.type)) finished = true; }
    if (finished) end();
    req.raw.on('close', () => unsub());
  });

  const webDir = opts.webDir ?? path.join(packageRoot(), 'web', 'dist');
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
  }
  return app;
}
