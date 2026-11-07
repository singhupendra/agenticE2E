export const GOOD_SPEC = `import { test, expect } from './_support';

test('home page loads', async ({ page, step }) => {
  await step('open home', async () => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Fixture Shop/);
  });
  await step('see heading', async () => {
    await expect(page.getByRole('heading', { name: 'Welcome to Fixture Shop' })).toBeVisible();
  });
});
`;
export const TYPE_ERROR_SPEC = GOOD_SPEC.replace("page.goto('/')", "page.gotoo('/')");
export const FAILING_SPEC = `import { test, expect } from './_support';

test('contact form', async ({ page, step }) => {
  await step('open contact', async () => {
    await page.goto('/contact');
  });
  await step('fill and submit', async () => {
    await page.getByLabel('Your full name').fill('Ada');
    await page.getByRole('button', { name: 'Send message' }).click();
  });
  await expect(page.getByRole('status')).toContainText('Thanks');
});
`;
export const HEALED_SPEC = FAILING_SPEC.replace("getByLabel('Your full name')", "getByLabel('Name')").replace("click();", "click();").replace("fill('Ada')", "fill('Ada');\n    await page.getByLabel('Email').fill('ada@example.com')");
