import type { LLMProvider } from './llm/types.js';
import { codeSchema } from './llm/schemas.js';
import { pageToPrompt } from './planner.js';
import type { Store } from './storage.js';
import type { Journey, PageModel, ProgressFn } from './types.js';
import { validateSpec } from './validate.js';

export const CODEGEN_SYSTEM = `You write Playwright Test (TypeScript) specs for user journeys.
Rules:
- First line: import { test, expect } from './_support';  (never import from '@playwright/test' directly)
- Exactly one test(...) per journey, signature async ({ page, step }) => { ... }. Wrap each journey step in: await step('<step description>', async () => { ... });
- Navigate with relative URLs (await page.goto('/path')); baseURL is configured.
- Prefer resilient locators in this order: getByRole (with name), getByLabel, getByTestId, getByPlaceholder, getByText. Never use brittle CSS/XPath or nth() unless unavoidable.
- Use web-first assertions (await expect(locator).toBeVisible()/toHaveText()/toHaveURL()...). Every journey must assert its real expected outcome, not just that clicks succeeded. No fixed sleeps (waitForTimeout).
- Only use elements/labels that exist in the provided page models. Use deterministic test data (e.g. "Test User", "test@example.com").
- Return only the TypeScript source in the code field, no markdown fences.`;

export function stripFences(code: string): string {
  const m = /^\s*```(?:ts|typescript)?\s*\n([\s\S]*?)\n?```\s*$/.exec(code);
  return (m ? m[1] : code).replace(/\s+$/, '') + '\n';
}

export interface SpecInput { journey: Journey; pages: PageModel[]; baseUrl: string }

function journeyPrompt({ journey, pages, baseUrl }: SpecInput): string {
  return `Site: ${baseUrl}\n\nJourney\nid: ${journey.id}\nname: ${journey.name}\ngoal: ${journey.goal}\nsteps:\n${journey.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nPage models:\n\n${pages.map((p) => pageToPrompt(p, { elements: 30, aria: 1000 })).join('\n\n')}\n\nWrite the Playwright spec for this journey.`;
}

export async function generateSpec(llm: LLMProvider, input: SpecInput, opts: { retries: number }): Promise<{ code: string; attempts: number }> {
  let prompt = journeyPrompt(input);
  let lastErrors: string[] = [];
  const maxAttempts = opts.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = await llm.structured({ name: 'write_playwright_spec', description: 'Return the Playwright spec source.', system: CODEGEN_SYSTEM, prompt, schema: codeSchema });
    const code = stripFences(out.code);
    const v = await validateSpec(code);
    if (v.ok) return { code, attempts: attempt };
    lastErrors = v.errors;
    prompt = `${journeyPrompt(input)}\n\nYour previous attempt was INVALID:\n\n${code}\n\nDiagnostics:\n${v.errors.map((e) => `- ${e}`).join('\n')}\n\nFix every diagnostic and return the complete corrected spec.`;
  }
  throw new Error(`Generated spec for "${input.journey.id}" failed validation after ${maxAttempts} attempts: ${lastErrors.join('; ')}`);
}

export interface GenerateOptions {
  site: string; baseUrl: string; pages: PageModel[]; retries: number; requireApproval: boolean; regenerate?: boolean; onProgress?: ProgressFn;
}
export interface GenerateResult { generated: string[]; skipped: string[]; failed: { id: string; error: string }[] }

export async function generateTests(store: Store, llm: LLMProvider, journeys: Journey[], opts: GenerateOptions): Promise<GenerateResult> {
  const res: GenerateResult = { generated: [], skipped: [], failed: [] };
  const eligible = journeys.filter((j) => (opts.requireApproval ? j.status === 'approved' : j.status === 'approved' || j.status === 'selected'));
  for (const journey of eligible) {
    if (!opts.regenerate && store.hasTest(opts.site, journey.id)) {
      res.skipped.push(journey.id);
      opts.onProgress?.({ type: 'info', stage: 'generate', message: `Reusing stored test for "${journey.name}"` });
      continue;
    }
    opts.onProgress?.({ type: 'info', stage: 'generate', message: `Generating test for "${journey.name}"` });
    try {
      const { code, attempts } = await generateSpec(llm, { journey, pages: opts.pages, baseUrl: opts.baseUrl }, { retries: opts.retries });
      store.saveTest(opts.site, journey.id, code);
      store.saveTestVersion(opts.site, journey.id, 'original', code);
      res.generated.push(journey.id);
      opts.onProgress?.({ type: 'info', stage: 'generate', message: `Saved ${journey.id}.spec.ts (${attempts} attempt${attempts > 1 ? 's' : ''})` });
    } catch (e) {
      const error = (e as Error).message;
      res.failed.push({ id: journey.id, error });
      opts.onProgress?.({ type: 'warn', stage: 'generate', message: error });
    }
  }
  return res;
}
