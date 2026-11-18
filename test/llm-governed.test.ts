import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AnthropicProvider } from '../src/core/llm/anthropic.js';
import { GovernedLLM } from '../src/core/llm/governed.js';
import { MockLLM } from '../src/core/llm/mock.js';
import { RedactingLLM } from '../src/core/llm/redacting.js';
import { ResponseCache } from '../src/core/llm/response-cache.js';
import { UsageTracker, formatUsageSummary } from '../src/core/llm/usage.js';
import { LLMBudgetError, LLMOutputError, type LLMCallOptions, type LLMProvider, type LLMResult, type LLMTokenUsage, type StructuredRequest } from '../src/core/llm/types.js';
import { createLogger } from '../src/core/obs/logger.js';
import { Redactor } from '../src/core/redact.js';

const schema = z.object({ code: z.string() });
const req = (prompt = 'p'): StructuredRequest<{ code: string }> => ({ name: 'write_playwright_spec', description: 'd', system: 's', prompt, schema });
const usage = (i: number, o: number, r = 0, w = 0): LLMTokenUsage => ({ inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w });

/** A provider that reports usage, optionally failing first. */
class FakeProvider implements LLMProvider {
  calls: StructuredRequest<unknown>[] = [];
  signals: (AbortSignal | undefined)[] = [];
  constructor(private u: LLMTokenUsage, private failures: unknown[] = [], private out: unknown = { code: 'x' }) {}
  async structured<T>(r: StructuredRequest<T>): Promise<T> { return (await this.structuredDetailed(r)).data; }
  async structuredDetailed<T>(r: StructuredRequest<T>, o?: LLMCallOptions): Promise<LLMResult<T>> {
    this.calls.push(r as StructuredRequest<unknown>);
    this.signals.push(o?.signal);
    const f = this.failures.shift();
    if (f) throw f;
    return { data: r.schema.parse(this.out), usage: this.u, model: 'claude-sonnet-5-5' };
  }
}

const capture = () => { const lines: string[] = []; return { lines, log: createLogger({ level: 'debug', format: 'json', stream: { write: (s) => { lines.push(s); } } }), json: () => lines.map((l) => JSON.parse(l)) }; };
const noSleep = { maxRetries: 3, timeoutMs: 1000, sleep: async () => {}, random: () => 0.5 };

describe('SPEC-013 GovernedLLM: usage accounting', () => {
  it('AC-5: records tokens, latency, cost and logs llm.call', async () => {
    const tracker = new UsageTracker();
    const c = capture();
    const llm = new GovernedLLM(new FakeProvider(usage(1000, 500, 2000, 100)), { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep, log: c.log });
    expect(await llm.structured(req())).toEqual({ code: 'x' });
    const [call] = tracker.calls;
    expect(call).toMatchObject({ n: 1, name: 'write_playwright_spec', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100, retries: 0, cached: false, ok: true });
    expect(call.costUsd).toBeCloseTo(0.00745, 8);
    expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    const t = tracker.totals();
    expect(t).toMatchObject({ calls: 1, failed: 0, cached: 0, inputTokens: 1000, outputTokens: 500, totalTokens: 3600, unpricedCalls: 0 });
    expect(c.json().find((l) => l.msg === 'llm.call')).toMatchObject({ level: 'info', call: 1, inputTokens: 1000, outputTokens: 500 });
    expect(formatUsageSummary(t)).toMatch(/^LLM: 1 call \(0 cached, 0 failed\), 1,000 in \/ 500 out tokens \(cache r\/w 2,000\/100\), est\. \$0\.007[45]$/);
  });

  it('providers without usage (MockLLM) are recorded with zero tokens', async () => {
    const tracker = new UsageTracker();
    const llm = new GovernedLLM(new MockLLM(() => ({ code: 'y' })), { provider: 'anthropic', model: 'claude-haiku-5-5', usage: tracker, retry: noSleep });
    await llm.structured(req());
    expect(tracker.calls[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0, ok: true });
  });

  it('AC-10/11: retries are counted and logged; a final failure is recorded ok:false', async () => {
    const tracker = new UsageTracker();
    const c = capture();
    const err = (s: number) => Object.assign(new Error(`HTTP ${s}`), { status: s });
    const p = new FakeProvider(usage(10, 10), [err(429), err(500)]);
    await new GovernedLLM(p, { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep, log: c.log }).structured(req());
    expect(tracker.calls[0]).toMatchObject({ retries: 2, ok: true });
    expect(c.json().filter((l) => l.msg === 'llm.retry').map((l) => [l.level, l.status])).toEqual([['warn', 429], ['warn', 500]]);
    expect(p.signals[0]).toBeInstanceOf(AbortSignal);

    const bad = new GovernedLLM(new FakeProvider(usage(1, 1), [err(503), err(503)]), { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: { ...noSleep, maxRetries: 1 }, log: c.log });
    await expect(bad.structured(req())).rejects.toThrow('HTTP 503');
    expect(tracker.calls[1]).toMatchObject({ ok: false, retries: 1, error: 'HTTP 503' });
    expect(tracker.totals().failed).toBe(1);
    expect(c.json().find((l) => l.msg === 'llm.failed')?.level).toBe('error');
  });
});

describe('SPEC-013 budgets', () => {
  it('AC-7: maxCostPerRun stops after the call that exceeds it and refuses the next one', async () => {
    // the provider reports claude-sonnet-5-5: 1000 in + 600 out = 0.002 + 0.006 = $0.008 per call
    const p = new FakeProvider(usage(1000, 600));
    const tracker = new UsageTracker({ budget: { maxCostPerRun: 0.01 } });
    const llm = new GovernedLLM(p, { provider: 'anthropic', model: 'claude-haiku-4-5', usage: tracker, retry: noSleep });
    await llm.structured(req());
    const e = await llm.structured(req()).catch((x) => x);
    expect(e).toBeInstanceOf(LLMBudgetError);
    expect(e.message).toMatch(/maxCostPerRun/);
    expect(e.message).toMatch(/\$0\.016/);
    expect(e.message).toMatch(/--max-cost/);
    const third = await llm.structured(req()).catch((x) => x);
    expect(third).toBeInstanceOf(LLMBudgetError);
    expect(p.calls).toHaveLength(2);
  });

  it('AC-8: maxTokensPerRun counts every token kind', async () => {
    const tracker = new UsageTracker({ budget: { maxTokensPerRun: 1000 } });
    const llm = new GovernedLLM(new FakeProvider(usage(600, 200, 300, 100)), { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep });
    const e = await llm.structured(req()).catch((x) => x);
    expect(e).toBeInstanceOf(LLMBudgetError);
    expect(e.message).toMatch(/maxTokensPerRun 1,000/);
    expect(e.message).toMatch(/1,200 tokens/);
  });

  it('FR-17: an unpriced model warns once that the cost budget cannot be enforced', async () => {
    const warns: string[] = [];
    const tracker = new UsageTracker({ budget: { maxCostPerRun: 0.0001 }, onWarn: (m) => warns.push(m) });
    const llm = new GovernedLLM(new MockLLM(() => ({ code: 'x' })), { provider: 'bedrock', model: 'arn:aws:bedrock:custom', usage: tracker, retry: noSleep });
    await llm.structured(req()); await llm.structured(req());
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/cannot be enforced/);
    expect(tracker.totals().unpricedCalls).toBe(2);
  });
});

describe('SPEC-013 usage of paid-for but invalid responses (review r4611577658)', () => {
  /** Returns usage, then throws LLMOutputError with it attached — like AnthropicProvider on schema-invalid output. */
  class InvalidOutputProvider implements LLMProvider {
    calls = 0;
    async structured<T>(): Promise<T> { throw new Error('unused'); }
    async structuredDetailed<T>(): Promise<LLMResult<T>> {
      this.calls++;
      throw Object.assign(new LLMOutputError('Invalid write_playwright_spec output (schema)'), { usage: usage(1000, 600), model: 'claude-sonnet-5-5' });
    }
  }

  it('counts the tokens and cost of an LLMOutputError response', async () => {
    const tracker = new UsageTracker();
    const llm = new GovernedLLM(new InvalidOutputProvider(), { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep });
    await expect(llm.structured(req())).rejects.toBeInstanceOf(LLMOutputError);
    expect(tracker.calls[0]).toMatchObject({ ok: false, inputTokens: 1000, outputTokens: 600, model: 'claude-sonnet-5-5' });
    expect(tracker.calls[0].costUsd).toBeCloseTo(0.008, 10);
    expect(tracker.totals()).toMatchObject({ failed: 1, totalTokens: 1600 });
  });

  it('invalid-output responses trip the budget', async () => {
    const p = new InvalidOutputProvider();
    const tracker = new UsageTracker({ budget: { maxCostPerRun: 0.01 } });
    const llm = new GovernedLLM(p, { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep });
    await expect(llm.structured(req())).rejects.toBeInstanceOf(LLMOutputError); // $0.008
    const e = await llm.structured(req()).catch((x) => x); // $0.016 > $0.01
    expect(e).toBeInstanceOf(LLMBudgetError);
    expect(e.message).toMatch(/maxCostPerRun/);
    await expect(llm.structured(req())).rejects.toBeInstanceOf(LLMBudgetError);
    expect(p.calls).toBe(2);
  });
});

describe('SPEC-013 response cache', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llmcache-'));
  const files = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith('.json')) : []);

  it('AC-14: read-write serves identical requests from disk', async () => {
    const dir = tmp();
    const p = new FakeProvider(usage(100, 100));
    const tracker = new UsageTracker();
    const llm = new GovernedLLM(p, { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: tracker, retry: noSleep, cache: new ResponseCache({ dir, mode: 'read-write' }) });
    await llm.structured(req('same'));
    expect(await llm.structured(req('same'))).toEqual({ code: 'x' });
    expect(p.calls).toHaveLength(1);
    expect(tracker.calls[1]).toMatchObject({ cached: true, inputTokens: 0, costUsd: 0 });
    expect(files(dir)).toHaveLength(1);
    await llm.structured(req('different'));
    expect(p.calls).toHaveLength(2);
    // a fresh process (new tracker + cache instance) also hits
    const p2 = new FakeProvider(usage(1, 1));
    await new GovernedLLM(p2, { provider: 'anthropic', model: 'claude-sonnet-5-5', usage: new UsageTracker(), retry: noSleep, cache: new ResponseCache({ dir, mode: 'read-only' }) }).structured(req('same'));
    expect(p2.calls).toHaveLength(0);
  });

  it('key depends on model, schema and images; invalid entries are misses', () => {
    const c = new ResponseCache({ dir: tmp(), mode: 'read-write' });
    const k = c.key(req(), { provider: 'anthropic', model: 'a' });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(c.key(req(), { provider: 'anthropic', model: 'b' })).not.toBe(k);
    expect(c.key({ ...req(), schema: z.object({ other: z.string() }) } as never, { provider: 'anthropic', model: 'a' })).not.toBe(k);
    expect(c.key({ ...req(), images: [{ mediaType: 'image/png', data: 'AAA' }] }, { provider: 'anthropic', model: 'a' })).not.toBe(k);
    c.set(k, { name: 'n', model: 'a', output: { nope: 1 } });
    expect(c.get(k, schema)).toBeUndefined();
  });

  it('read-only never writes; off disables', async () => {
    const dir = tmp();
    await new GovernedLLM(new FakeProvider(usage(1, 1)), { provider: 'anthropic', model: 'm', usage: new UsageTracker(), retry: noSleep, cache: new ResponseCache({ dir, mode: 'read-only' }) }).structured(req());
    expect(files(dir)).toHaveLength(0);
    await new GovernedLLM(new FakeProvider(usage(1, 1)), { provider: 'anthropic', model: 'm', usage: new UsageTracker(), retry: noSleep, cache: new ResponseCache({ dir, mode: 'off' }) }).structured(req());
    expect(files(dir)).toHaveLength(0);
  });

  it('AC-14: with RedactingLLM outside, cache files never hold a credential', async () => {
    const dir = tmp();
    const redactor = new Redactor([{ value: 'pa55word!', placeholder: '{{password}}' }]);
    const p = new FakeProvider(usage(1, 1), [], { code: 'echo pa55word!' });
    const governed = new GovernedLLM(p, { provider: 'anthropic', model: 'm', usage: new UsageTracker(), retry: noSleep, cache: new ResponseCache({ dir, mode: 'read-write', redactor }) });
    await new RedactingLLM(governed, redactor, { dropImages: true }).structured(req('log in with pa55word!'));
    const content = files(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(content).not.toContain('pa55word!');
    expect(p.calls[0].prompt).toBe('log in with {{password}}');
  });
});

describe('SPEC-013 AnthropicProvider usage, prompt caching and retry options', () => {
  const fake = (u: Record<string, number> = { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 }) => {
    const calls: { body: any; opts: any }[] = [];
    return { calls, client: { messages: { create: async (body: any, opts: any) => { calls.push({ body, opts }); return { content: [{ type: 'tool_use', name: 't', input: { code: 'x' } }], stop_reason: 'tool_use', usage: u }; } } } as any };
  };
  const r = { name: 't', description: 'd', system: 'sys', prompt: 'p', schema };

  it('AC-13 / FR-8: returns usage and passes signal + maxRetries 0', async () => {
    const f = fake();
    const ac = new AbortController();
    const res = await new AnthropicProvider({ model: 'claude-haiku-4-5', client: f.client, timeoutMs: 1234 }).structuredDetailed(r, { signal: ac.signal });
    expect(res.data).toEqual({ code: 'x' });
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
    expect(res.model).toBe('claude-haiku-4-5');
    expect(f.calls[0].opts).toMatchObject({ signal: ac.signal, maxRetries: 0, timeout: 1234 });
  });

  it('AC-13 / FR-20: promptCaching puts an explicit breakpoint on the system block', async () => {
    const on = fake();
    await new AnthropicProvider({ model: 'claude-haiku-4-5', client: on.client, promptCaching: true }).structured(r);
    expect(on.calls[0].body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(on.calls[0].body.cache_control).toBeUndefined();
    const off = fake();
    await new AnthropicProvider({ model: 'claude-haiku-4-5', client: off.client, promptCaching: false }).structured(r);
    expect(off.calls[0].body.system).toBe('sys');
    const forced = fake();
    await new AnthropicProvider({ model: 'claude-opus-5-5', client: forced.client, promptCaching: true }).structured(r);
    expect(forced.calls[0].body.system[0].text).toMatch(/calling the `t` tool/);
  });

  it('attaches usage and model to LLMOutputError (schema-invalid or missing tool call)', async () => {
    const make = (content: unknown[]) => ({ messages: { create: async () => ({ content, stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 8 } }) } }) as any;
    const bad = await new AnthropicProvider({ model: 'claude-haiku-4-5', client: make([{ type: 'tool_use', name: 't', input: { nope: 1 } }]) }).structuredDetailed(r).catch((x) => x);
    expect(bad).toBeInstanceOf(LLMOutputError);
    expect(bad).toMatchObject({ usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'claude-haiku-4-5' });
    const none = await new AnthropicProvider({ model: 'claude-haiku-4-5', client: make([{ type: 'text', text: 'hi' }]) }).structuredDetailed(r).catch((x) => x);
    expect(none).toMatchObject({ usage: { inputTokens: 7, outputTokens: 8 } });
  });

  it('missing usage fields default to 0', async () => {
    const f = fake({ input_tokens: 5, output_tokens: 6 });
    const res = await new AnthropicProvider({ model: 'm', client: f.client }).structuredDetailed(r);
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
