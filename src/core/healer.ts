import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { LLMProvider } from './llm/types.js';
import { healSchema } from './llm/schemas.js';
import { stripFences } from './codegen.js';
import type { Store } from './storage.js';
import type { HealAttempt, HealRecord, ProgressFn, RunRecord, TestResult } from './types.js';
import { validateSpec, weakensAssertions } from './validate.js';

export const HEAL_SYSTEM = `You are a Playwright test maintenance engineer. A generated end-to-end test failed. You get the test code, the error, and the page as it was at the moment of failure (URL, ARIA snapshot, HTML excerpt, and possibly a screenshot).

First classify the failure (verdict):
- "test_breakage": the app still offers the functionality the journey needs, but the test is wrong or stale (renamed label/button/text, changed role, different URL, wrong locator, missing wait/step, wrong test data). Provide a patched test.
- "app_bug": the app is genuinely broken or no longer delivers the behaviour the journey's assertions describe (error page, 500, missing feature, wrong result, confirmation never appears although all inputs were valid). Do NOT patch; explain what is broken.
- "flaky_or_environment": timing, network or environment issue; the test logic looks right. Do NOT patch.

Rules for patches (verdict test_breakage only):
- Return the COMPLETE corrected spec in "code". Keep the import from './_support', the step() structure, and the test name.
- NEVER delete, weaken, comment out or skip assertions; never add test.skip/fixme; never replace assertions with tautologies. You may update the expected values of assertions only when the page clearly shows the new correct value for the same behaviour. Adding assertions is fine.
- Prefer getByRole/getByLabel/getByTestId locators grounded in the ARIA snapshot you are given.`;

export type RunnerFn = (journeyIds: string[]) => Promise<RunRecord>;

export interface HealOptions {
  site: string;
  baseUrl: string;
  journeyId: string;
  failure: TestResult;
  attempts: number;
  runner: RunnerFn;
  onProgress?: ProgressFn;
}

function readImage(store: Store, site: string, rel?: string) {
  if (!rel) return [];
  try {
    const abs = store.resolveFile(site, rel);
    if (!fs.existsSync(abs)) return [];
    return [{ mediaType: 'image/png' as const, data: fs.readFileSync(abs).toString('base64') }];
  } catch {
    return [];
  }
}

function buildPrompt(code: string, f: TestResult, feedback: string[]): string {
  const snap = f.failure;
  return [
    `Journey: ${f.journeyId}`,
    `Current test code:\n\`\`\`ts\n${code}\`\`\``,
    `Failure (${f.status}):\n${(f.error ?? 'unknown error').slice(0, 4000)}`,
    snap ? `Page at failure: ${snap.url} — "${snap.title}"\n\nARIA snapshot:\n${snap.ariaSnapshot.slice(0, 8000)}\n\nHTML excerpt:\n${snap.html.slice(0, 10000)}` : 'No page snapshot was captured.',
    feedback.length ? `Feedback from earlier attempts — do not repeat these mistakes:\n${feedback.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Try to repair one failing test. Never leaves a worse test than the original active. */
export async function healTest(store: Store, llm: LLMProvider, opts: HealOptions): Promise<HealRecord> {
  const { site, journeyId } = opts;
  const original = store.loadTest(site, journeyId);
  if (original === null) throw new Error(`No stored test for journey "${journeyId}"`);
  if (!store.loadTestVersion(site, journeyId, 'original')) store.saveTestVersion(site, journeyId, 'original', original);

  let current = original;
  let last = opts.failure;
  const attempts: HealAttempt[] = [];
  const feedback: string[] = [];
  let outcome: HealRecord['outcome'] = 'failed';
  let verdict: HealRecord['verdict'];
  let reason = 'No attempt produced a passing test';
  let diff: string | undefined;

  for (let n = 1; n <= opts.attempts; n++) {
    opts.onProgress?.({ type: 'info', stage: 'heal', message: `Healing "${journeyId}" — attempt ${n}/${opts.attempts}` });
    const out = await llm.structured({
      name: 'heal_test', description: 'Diagnose a failing Playwright test and optionally return a patched spec.', system: HEAL_SYSTEM,
      prompt: buildPrompt(current, last, feedback), schema: healSchema, images: readImage(store, site, last.failure?.screenshot),
    });
    verdict = out.verdict;
    reason = out.reason;

    if (out.verdict === 'app_bug') {
      attempts.push({ n, verdict, reason, accepted: false, rejection: 'verdict app_bug: not patched' });
      outcome = 'app_bug';
      break;
    }
    if (out.verdict === 'flaky_or_environment') {
      const rerun = (await opts.runner([journeyId])).results[0];
      attempts.push({ n, verdict, reason, accepted: true, passed: rerun.status === 'passed', error: rerun.error });
      if (rerun.status === 'passed') { outcome = 'flaky_or_environment'; break; }
      last = rerun;
      feedback.push(`Attempt ${n}: you called it flaky/environment but a plain re-run still failed: ${(rerun.error ?? '').slice(0, 500)}`);
      continue;
    }

    const reject = (rejection: string) => { attempts.push({ n, verdict, reason, accepted: false, rejection }); feedback.push(`Attempt ${n} rejected: ${rejection}`); };
    if (!out.code) { reject('verdict was test_breakage but no code was returned'); continue; }
    const patched = stripFences(out.code);
    if (patched === current) { reject('patch is identical to the current code'); continue; }
    const weak = weakensAssertions(original, patched);
    if (weak) { reject(weak); continue; }
    const v = await validateSpec(patched);
    if (!v.ok) { reject(`patch failed validation: ${v.errors.join('; ')}`); continue; }

    store.saveTest(site, journeyId, patched);
    const rerun = (await opts.runner([journeyId])).results[0];
    const passed = rerun.status === 'passed';
    attempts.push({ n, verdict, reason, accepted: true, passed, error: passed ? undefined : rerun.error });
    if (passed) {
      store.saveTestVersion(site, journeyId, `healed-${store.listTestVersions(site, journeyId).length}`, patched);
      diff = createTwoFilesPatch(`${journeyId}.spec.ts (original)`, `${journeyId}.spec.ts (healed)`, original, patched, '', '', { context: 3 });
      outcome = 'healed';
      break;
    }
    current = patched;
    last = rerun;
    feedback.push(`Attempt ${n}: your patch ran but still failed with: ${(rerun.error ?? '').slice(0, 600)}`);
  }

  if (outcome !== 'healed') store.saveTest(site, journeyId, original); // restore: never keep a worse/unverified test
  const record: HealRecord = {
    id: `${journeyId}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    journeyId, at: new Date().toISOString(), outcome, verdict, reason,
    originalError: (opts.failure.error ?? '').slice(0, 4000), attempts, diff,
  };
  store.appendHeal(site, record);
  opts.onProgress?.({ type: outcome === 'healed' ? 'info' : 'warn', stage: 'heal', message: `"${journeyId}": ${outcome} — ${reason}` });
  return record;
}
