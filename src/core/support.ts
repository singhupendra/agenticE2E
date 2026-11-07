/**
 * Source of the `_support.ts` file written next to every site's generated tests.
 * Generated specs `import { test, expect } from './_support'`. It adds:
 *  - a `step(name, fn)` fixture (wraps test.step and takes per-step screenshots)
 *  - an auto fixture that takes end-of-journey / on-failure screenshots and dumps a
 *    DOM + ARIA snapshot on failure so the healer can see the page as it was.
 * Behaviour is driven by env vars set by the runner.
 */
export const SUPPORT_SOURCE = `import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export { expect };

const MODE = process.env.AGENTIC_E2E_SCREENSHOTS ?? 'on-failure';
const FULL_PAGE = process.env.AGENTIC_E2E_FULL_PAGE === 'true';
const SHOT_DIR = process.env.AGENTIC_E2E_SHOT_DIR ?? '';
const FAILURE_DIR = process.env.AGENTIC_E2E_FAILURE_DIR ?? '';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

async function shot(page: Page, journey: string, name: string): Promise<string | undefined> {
  if (!SHOT_DIR) return undefined;
  try {
    const dir = path.join(SHOT_DIR, journey);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.png');
    await page.screenshot({ path: file, fullPage: FULL_PAGE });
    return file;
  } catch {
    return undefined;
  }
}

export const test = base.extend<{
  step: <T>(name: string, body: () => Promise<T>) => Promise<T>;
  _agentic: void;
}>({
  step: async ({ page }, use, testInfo) => {
    const journey = path.basename(testInfo.file).replace(/\\.spec\\.[tj]s$/, '');
    let n = 0;
    await use(async (name, body) => {
      const result = await base.step(name, body);
      if (MODE === 'every-step') await shot(page, journey, String(++n).padStart(2, '0') + '-' + slug(name));
      return result;
    });
  },
  _agentic: [
    async ({ page }, use, testInfo) => {
      await use();
      const journey = path.basename(testInfo.file).replace(/\\.spec\\.[tj]s$/, '');
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        const screenshot = MODE !== 'off' ? await shot(page, journey, 'failure') : undefined;
        if (FAILURE_DIR) {
          try {
            fs.mkdirSync(FAILURE_DIR, { recursive: true });
            let ariaSnapshot = '';
            let html = '';
            try { ariaSnapshot = await page.locator('body').ariaSnapshot({ timeout: 3000 }); } catch {}
            try { html = (await page.content()).slice(0, 60000); } catch {}
            fs.writeFileSync(
              path.join(FAILURE_DIR, journey + '.json'),
              JSON.stringify({ url: page.url(), title: await page.title().catch(() => ''), ariaSnapshot, html, screenshot }),
            );
          } catch {}
        }
      } else if (MODE === 'end-of-journey') {
        await shot(page, journey, 'end');
      }
    },
    { auto: true },
  ],
});
`;
