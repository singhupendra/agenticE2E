import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Config } from '../core/config.js';
import type { LLMProvider } from '../core/llm/types.js';
import { TokenRegistry } from '../core/security/tokens.js';
import { buildApp } from './app.js';
import { getLifecycle, installSignalHandlers } from './lifecycle.js';
import type { AuthOptions } from './security.js';

export { buildApp };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * SPEC-014: resolve the auth mode for a real server. API tokens come from AGENTIC_E2E_API_TOKENS (hashes) and/or
 * `server.tokensFile` / AGENTIC_E2E_API_TOKENS_FILE. Without tokens the server refuses to start unless `insecureLocal`
 * is set, which is only allowed on a loopback bind address.
 */
export function resolveAuth(opts: { config: Config; host: string; insecureLocal?: boolean; tokens?: TokenRegistry; env?: Record<string, string | undefined> }): AuthOptions {
  if (opts.insecureLocal) {
    if (!LOOPBACK.has(opts.host.toLowerCase())) throw new Error(`--insecure-local only works on a loopback address (127.0.0.1, localhost, ::1), not ${opts.host}. Create API tokens with \`agentic-e2e token create\` to serve on other interfaces.`);
    return { mode: 'insecure-local' };
  }
  const env = opts.env ?? process.env;
  const tokens = opts.tokens ?? TokenRegistry.fromSources({
    env: env.AGENTIC_E2E_API_TOKENS,
    file: opts.config.server.tokensFile,
    onWarn: (m) => console.warn(`[agentic-e2e] ${m}`),
  });
  if (tokens.size === 0) {
    throw new Error('No API tokens configured. Create one with `agentic-e2e token create --name <you> --role admin --file .agentic-e2e/tokens.json` and set server.tokensFile / AGENTIC_E2E_API_TOKENS_FILE (or AGENTIC_E2E_API_TOKENS), or run `agentic-e2e serve --insecure-local` for an unauthenticated server on localhost only.');
  }
  return { mode: 'tokens', tokens };
}

export async function startServer(opts: {
  config: Config; port?: number; host?: string; llm?: LLMProvider;
  /** SPEC-014: explicit opt-in to an unauthenticated server; loopback only. */
  insecureLocal?: boolean;
  tokens?: TokenRegistry;
  /** test seam for the token env vars (default: process.env) */
  env?: Record<string, string | undefined>;
  /** install SIGTERM/SIGINT graceful-shutdown handlers (the `serve` command does) */
  handleSignals?: boolean;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';
  const auth = resolveAuth({ config: opts.config, host, insecureLocal: opts.insecureLocal, tokens: opts.tokens, env: opts.env });
  if (auth.mode === 'insecure-local') console.warn('[agentic-e2e] WARNING: --insecure-local: API authentication is DISABLED; every local request acts as admin.');
  const app = await buildApp({ config: opts.config, llm: opts.llm, host, auth });
  const lifecycle = getLifecycle(app);
  lifecycle.onClose(() => app.close());
  const address = await app.listen({ port: opts.port ?? 4173, host });
  const uninstall = opts.handleSignals ? installSignalHandlers(lifecycle, { timeoutMs: opts.config.server.shutdownTimeoutMs }) : () => {};
  return {
    url: address.replace('127.0.0.1', 'localhost'),
    close: async () => { uninstall(); await lifecycle.shutdown(0); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { loadConfig } = await import('../core/config.js');
  const { url } = await startServer({ config: await loadConfig(), port: Number(process.env.PORT ?? 4173), insecureLocal: process.env.AGENTIC_E2E_INSECURE_LOCAL === '1', handleSignals: true });
  console.log(`agentic-e2e UI: ${url}`);
}
