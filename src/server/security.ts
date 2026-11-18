import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../core/config.js';
import { OPERATOR_ACTIONS, OPERATOR_JOB_OPTIONS, roleAtLeast, type Role } from '../core/security/roles.js';
import type { Principal, TokenRegistry } from '../core/security/tokens.js';
import type { StorageBackend } from '../core/storage/backend.js';
import type { Lifecycle } from './lifecycle.js';

/**
 * SPEC-014: authentication, authorisation and hardening for the Fastify server.
 *  - `tokens`: Bearer tokens (hashed at rest) or a session cookie obtained with one.
 *  - `insecure-local`: explicit opt-in, loopback only; every request acts as admin.
 *  - `none`: legacy in-process default of `buildApp()` (no auth); never used by `startServer`.
 * Never logs or echoes a token, a hash or the session cookie.
 */
export type AuthOptions = { mode: 'tokens'; tokens: TokenRegistry } | { mode: 'insecure-local' } | { mode: 'none' };

export const SESSION_COOKIE = 'ae2e_session';
const LOCAL_ADMIN: Principal = { name: 'local', role: 'admin' };
const PUBLIC_API = new Set(['/api/health', '/api/session']);
const MAX_SESSIONS = 10_000;

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal | null }
}

const pathOf = (url: string) => url.split('?')[0];
const isPublic = (url: string) => {
  const p = pathOf(url);
  return p === '/healthz' || p === '/readyz' || PUBLIC_API.has(p) || !(p === '/api' || p.startsWith('/api/'));
};

function bearerOf(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m?.[1];
}
function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

class SessionStore {
  private sessions = new Map<string, { principal: Principal; expires: number }>();
  constructor(private ttlMs: number) {}
  create(principal: Principal): string {
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { principal, expires: Date.now() + this.ttlMs });
    return id;
  }
  get(id: string | undefined): Principal | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expires < Date.now()) { this.sessions.delete(id); return null; }
    return s.principal;
  }
  delete(id: string | undefined) { if (id) this.sessions.delete(id); }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Role needed for a request (after body parsing). */
export function requiredRole(method: string, routeUrl: string | undefined, body: unknown, base: Config): { role: Role; reason?: string } {
  if (method === 'GET' || method === 'HEAD') return { role: 'viewer' };
  if (method === 'POST' && routeUrl === '/api/jobs') {
    const b = (body ?? {}) as { action?: unknown; options?: unknown };
    if (!OPERATOR_ACTIONS.has(String(b.action))) return { role: 'admin' };
    const opts = b.options && typeof b.options === 'object' && !Array.isArray(b.options) ? (b.options as Record<string, unknown>) : {};
    const changed = Object.keys(opts).filter((k) => !OPERATOR_JOB_OPTIONS.has(k) && !same(opts[k], (base as Record<string, unknown>)[k]));
    return changed.length ? { role: 'admin', reason: `changing settings (${changed.join(', ')})` } : { role: 'operator' };
  }
  return { role: 'admin' };
}

export async function registerSecurity(app: FastifyInstance, opts: { config: Config; auth: AuthOptions; lifecycle: Lifecycle; storage: StorageBackend }) {
  const { server } = opts.config;
  const sessions = new SessionStore(server.sessionTtlMs);
  const authRequired = opts.auth.mode === 'tokens';
  const tokens = opts.auth.mode === 'tokens' ? opts.auth.tokens : undefined;

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"],
        connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: false, // only over https, below
    crossOriginEmbedderPolicy: false,
  });
  app.addHook('onSend', async (req, reply) => {
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
  });

  await app.register(rateLimit, {
    global: true,
    max: server.rateLimit.max,
    timeWindow: server.rateLimit.timeWindowMs,
    keyGenerator: (req) => req.ip,
    allowList: (req) => ['/healthz', '/readyz'].includes(pathOf(req.url)),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: 'Too many requests', message: `Rate limit exceeded; retry in ${ctx.after}` }),
  });

  const principalOf = (req: FastifyRequest): Principal | null => {
    if (!authRequired) return LOCAL_ADMIN;
    return tokens!.verify(bearerOf(req)) ?? sessions.get(cookieOf(req, SESSION_COOKIE));
  };
  const deny401 = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Bearer realm="agentic-e2e"').send({ error: 'Authentication required' });

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    req.principal = principalOf(req);
    if (opts.lifecycle.draining && req.method === 'POST' && pathOf(req.url) === '/api/jobs') return reply.code(503).send({ error: 'Server is shutting down' });
    if (!isPublic(req.url) && !req.principal) return deny401(reply);
  });
  app.addHook('preHandler', async (req, reply) => {
    if (isPublic(req.url)) return;
    const need = requiredRole(req.method, req.routeOptions.url, req.body, opts.config);
    if (!roleAtLeast(req.principal!.role, need.role)) return reply.code(403).send({ error: `Requires role ${need.role}${need.reason ? ` for ${need.reason}` : ''}` });
  });

  // Liveness: no I/O. Readiness: not draining and storage writable. Bodies never carry paths or error details.
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    if (opts.lifecycle.draining) return reply.code(503).send({ status: 'draining' });
    try { await opts.storage.healthCheck(); } catch { return reply.code(503).send({ status: 'unavailable' }); }
    return { status: 'ready' };
  });

  const status = (p: Principal | null) => ({ authRequired, authenticated: !!p, ...(p ? { name: p.name, role: p.role } : {}) });
  const cookie = (req: FastifyRequest, value: string, maxAgeS: number) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${req.protocol === 'https' ? '; Secure' : ''}`;

  app.get('/api/session', async (req) => status(req.principal ?? null));
  app.post('/api/session', { config: { rateLimit: { max: server.rateLimit.loginMax, timeWindow: server.rateLimit.timeWindowMs } } }, async (req, reply) => {
    if (!authRequired) return status(LOCAL_ADMIN);
    const bodyToken = (req.body as { token?: unknown } | null)?.token;
    const p = tokens!.verify(bearerOf(req) ?? (typeof bodyToken === 'string' ? bodyToken : undefined));
    if (!p) return deny401(reply);
    const id = sessions.create(p);
    reply.header('set-cookie', cookie(req, id, Math.floor(server.sessionTtlMs / 1000)));
    return status(p);
  });
  app.delete('/api/session', async (req, reply) => {
    sessions.delete(cookieOf(req, SESSION_COOKIE));
    reply.header('set-cookie', cookie(req, '', 0));
    return status(authRequired ? null : LOCAL_ADMIN);
  });
}
