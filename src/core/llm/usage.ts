import { LLMBudgetError, type LLMTokenUsage } from './types.js';

/** SPEC-013 FR-14: per-run limits (one CLI command / web job). */
export interface LLMBudget {
  maxCostPerRun?: number;
  maxTokensPerRun?: number;
}

export interface LLMCallRecord extends LLMTokenUsage {
  n: number;
  name: string;
  provider: string;
  model: string;
  latencyMs: number;
  /** undefined = unknown pricing for this model */
  costUsd?: number;
  retries: number;
  /** served from the response cache (no network call) */
  cached: boolean;
  ok: boolean;
  error?: string;
  at: string;
  /** FR-31: journey (and browser/device project) the call was spent on; absent for run-level calls (planning, login) */
  journeyId?: string;
  project?: string;
}

export interface UsageTotals {
  calls: number;
  failed: number;
  cached: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedCalls: number;
  latencyMs: number;
}

export const tokensOf = (u: LLMTokenUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtUsd = (n: number) => `$${n.toFixed(4)}`;

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    failed: 0,
    cached: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    latencyMs: 0,
  };
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const out = emptyTotals();
  for (const k of Object.keys(out) as (keyof UsageTotals)[]) out[k] = a[k] + b[k];
  return out;
}

/** "LLM: 5 calls (1 cached, 0 failed), 12,345 in / 2,345 out tokens (cache r/w 0/0), est. $0.0612" */
export function formatUsageSummary(t: UsageTotals): string {
  return `LLM: ${t.calls} call${t.calls === 1 ? '' : 's'} (${t.cached} cached, ${t.failed} failed), ${fmtInt(t.inputTokens)} in / ${fmtInt(t.outputTokens)} out tokens (cache r/w ${fmtInt(t.cacheReadTokens)}/${fmtInt(t.cacheWriteTokens)}), est. ${fmtUsd(t.costUsd)}${t.unpricedCalls ? ` (+${t.unpricedCalls} unpriced)` : ''}`;
}

/** Accumulates the LLM calls of one run and enforces its budget. */
export class UsageTracker {
  readonly calls: LLMCallRecord[] = [];
  readonly budget: LLMBudget;
  private warnedUnpriced = false;
  private readonly onWarn: (message: string) => void;
  constructor(opts: { budget?: LLMBudget; onWarn?: (message: string) => void } = {}) {
    this.budget = opts.budget ?? {};
    this.onWarn = opts.onWarn ?? (() => {});
  }

  record(call: Omit<LLMCallRecord, 'n' | 'at'>): LLMCallRecord {
    const rec: LLMCallRecord = { ...call, n: this.calls.length + 1, at: new Date().toISOString() };
    this.calls.push(rec);
    if (rec.costUsd === undefined && !rec.cached && this.budget.maxCostPerRun !== undefined && !this.warnedUnpriced) {
      this.warnedUnpriced = true;
      this.onWarn(
        `No pricing for model "${rec.model}": llmBudget.maxCostPerRun cannot be enforced for its calls (maxTokensPerRun still applies)`,
      );
    }
    return rec;
  }

  totals(): UsageTotals {
    return summarizeCalls(this.calls);
  }

  /** FR-15: before a call, refuse when a limit is already reached; after a call, throw when one is exceeded. */
  check(phase: 'before' | 'after'): void {
    checkBudget(this.budget, this.totals(), phase);
  }
}

/** Totals of a list of call records (a run, a journey, ...). */
export function summarizeCalls(calls: readonly LLMCallRecord[]): UsageTotals {
  const t = emptyTotals();
  for (const c of calls) {
    t.calls++;
    if (!c.ok) t.failed++;
    if (c.cached) t.cached++;
    t.retries += c.retries;
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    t.cacheReadTokens += c.cacheReadTokens;
    t.cacheWriteTokens += c.cacheWriteTokens;
    t.latencyMs += c.latencyMs;
    if (c.costUsd === undefined) {
      if (!c.cached) t.unpricedCalls++;
    } else t.costUsd += c.costUsd;
  }
  t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return t;
}

function checkBudget(budget: LLMBudget, t: UsageTotals, phase: 'before' | 'after'): void {
  const { maxCostPerRun, maxTokensPerRun } = budget;
  if (maxCostPerRun === undefined && maxTokensPerRun === undefined) return;
  const over = (spent: number, max: number) => (phase === 'before' ? spent >= max : spent > max);
  const tail = `after ${t.calls} call${t.calls === 1 ? '' : 's'}; LLM work stopped.`;
  if (maxCostPerRun !== undefined && over(t.costUsd, maxCostPerRun)) {
    throw new LLMBudgetError(
      `LLM budget exceeded: estimated cost ${fmtUsd(t.costUsd)} ${phase === 'before' ? 'reached' : 'exceeds'} llmBudget.maxCostPerRun ${fmtUsd(maxCostPerRun)} ${tail} Raise llmBudget.maxCostPerRun (--max-cost) or narrow the run (--max-journeys, --include).`,
    );
  }
  if (maxTokensPerRun !== undefined && over(t.totalTokens, maxTokensPerRun)) {
    throw new LLMBudgetError(
      `LLM budget exceeded: ${fmtInt(t.totalTokens)} tokens ${phase === 'before' ? 'reached' : 'exceed'} llmBudget.maxTokensPerRun ${fmtInt(maxTokensPerRun)} ${tail} Raise llmBudget.maxTokensPerRun (--max-tokens-per-run) or narrow the run (--max-journeys, --include).`,
    );
  }
}
