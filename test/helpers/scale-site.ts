import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScaleSite {
  url: string;
  requests: { path: string; headers: http.IncomingHttpHeaders }[];
  close: () => Promise<void>;
}

/** SPEC-012: a tiny site that records every request's headers (to check env headers / base URLs). */
export async function startScaleSite(title = 'Scale Site'): Promise<ScaleSite> {
  const requests: ScaleSite['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '/', headers: req.headers });
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const OK_SPEC = `import { test, expect } from './_support';
test('ok', async ({ page, step }) => {
  await step('open', async () => { await page.goto('/'); await expect(page.locator('h1')).toBeVisible(); });
});
`;
export const FAIL_SPEC = `import { test, expect } from './_support';
test('fail', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Not there' })).toBeVisible({ timeout: 500 });
});
`;
export const FLAKY_SPEC = `import { test, expect } from './_support';
test('flaky', async ({ page }, testInfo) => {
  await page.goto('/');
  expect(testInfo.retry).toBeGreaterThan(0);
});
`;
export const SLOW_SPEC = `import { test } from './_support';
test('slow', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(3000);
});
`;
