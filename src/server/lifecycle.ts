import type { FastifyInstance } from 'fastify';

/**
 * SPEC-014 FR-16: draining + bounded graceful shutdown. While draining, /readyz is 503 and new jobs are refused; shutdown
 * waits for running jobs (up to a timeout), then runs the close callbacks (e.g. `app.close()`).
 */
export class Lifecycle {
  draining = false;
  private closers: (() => Promise<void>)[] = [];
  private shutdownPromise?: Promise<{ timedOut: boolean }>;
  constructor(private readonly opts: { activeJobs: () => number; pollMs?: number }) {}

  activeJobs() {
    return this.opts.activeJobs();
  }
  startDraining() {
    this.draining = true;
  }
  onClose(fn: () => Promise<void>) {
    this.closers.push(fn);
  }

  shutdown(timeoutMs: number): Promise<{ timedOut: boolean }> {
    this.shutdownPromise ??= (async () => {
      this.startDraining();
      const deadline = Date.now() + timeoutMs;
      while (this.opts.activeJobs() > 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 250));
      const timedOut = this.opts.activeJobs() > 0;
      for (const c of this.closers) await c().catch(() => {});
      return { timedOut };
    })();
    return this.shutdownPromise;
  }
}

const lifecycles = new WeakMap<FastifyInstance, Lifecycle>();
export function setLifecycle(app: FastifyInstance, lc: Lifecycle) {
  lifecycles.set(app, lc);
}
export function getLifecycle(app: FastifyInstance): Lifecycle {
  const lc = lifecycles.get(app);
  if (!lc) throw new Error('app has no lifecycle (not built by buildApp)');
  return lc;
}

/**
 * Install SIGTERM/SIGINT handlers: first signal drains and shuts down gracefully, a second one exits immediately.
 * Returns an uninstaller.
 */
export function installSignalHandlers(
  lc: Lifecycle,
  opts: { timeoutMs: number; log?: (m: string) => void; exit?: (code: number) => void },
): () => void {
  const log = opts.log ?? ((m) => console.error(m));
  const exit = opts.exit ?? ((c) => process.exit(c));
  let signalled = false;
  const handler = (sig: NodeJS.Signals) => {
    if (signalled) {
      log(`[agentic-e2e] ${sig} again: exiting now`);
      exit(1);
      return;
    }
    signalled = true;
    const n = lc.activeJobs();
    log(
      `[agentic-e2e] ${sig}: draining${n ? `, waiting up to ${Math.round(opts.timeoutMs / 1000)}s for ${n} running job(s)` : ''}`,
    );
    void lc.shutdown(opts.timeoutMs).then(({ timedOut }) => {
      if (timedOut) log('[agentic-e2e] shutdown timeout reached; stopping with jobs still running');
      exit(0);
    });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
