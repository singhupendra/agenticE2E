import { AsyncLocalStorage } from 'node:async_hooks';

/** SPEC-013 FR-31: what an LLM call is spent on (codegen / heal of one journey). Unset = run-level (planning, login). */
export interface LLMScope {
  journeyId?: string;
  project?: string;
}

const storage = new AsyncLocalStorage<LLMScope>();

/** Runs `fn` with `scope` attached to every LLM call it makes (async-context local, so concurrent work does not mix). */
export function withLLMScope<T>(scope: LLMScope, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...scope }, fn);
}

export function currentLLMScope(): LLMScope | undefined {
  return storage.getStore();
}
