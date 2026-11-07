import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Config } from '../core/config.js';
import type { LLMProvider } from '../core/llm/types.js';
import { buildApp } from './app.js';

export { buildApp };

export async function startServer(opts: { config: Config; port?: number; host?: string; llm?: LLMProvider }): Promise<{ url: string; close: () => Promise<void> }> {
  const app = await buildApp({ config: opts.config, llm: opts.llm });
  const host = opts.host ?? '127.0.0.1';
  const address = await app.listen({ port: opts.port ?? 4173, host });
  return { url: address.replace('127.0.0.1', 'localhost'), close: () => app.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { loadConfig } = await import('../core/config.js');
  const { url } = await startServer({ config: await loadConfig(), port: Number(process.env.PORT ?? 4173) });
  console.log(`agentic-e2e UI: ${url}`);
}
