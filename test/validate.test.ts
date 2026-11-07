import { describe, it, expect } from 'vitest';
import { validateSpec, countAssertions, weakensAssertions } from '../src/core/validate.js';
import { GOOD_SPEC, TYPE_ERROR_SPEC } from './helpers/specs.js';

describe('validateSpec', () => {
  it('accepts a valid spec', async () => {
    const r = await validateSpec(GOOD_SPEC);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects type errors with readable diagnostics', async () => {
    const r = await validateSpec(TYPE_ERROR_SPEC);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/gotoo/);
    expect(r.errors[0]).toMatch(/line \d+/i);
  });

  it('rejects syntax errors', async () => {
    const r = await validateSpec('import { test } from "./_support"; test("x", async ({page}) => { await page.goto(;');
    expect(r.ok).toBe(false);
  });

  it('AC-20: rejects code without expect()', async () => {
    const r = await validateSpec(`import { test } from './_support';\ntest('x', async ({ page }) => { await page.goto('/'); });`);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/expect/);
  });

  it('rejects skipped/only tests, missing test(), and direct playwright import', async () => {
    expect((await validateSpec(GOOD_SPEC.replace("test('home", "test.skip('home"))).errors.join(' ')).toMatch(/skip/);
    expect((await validateSpec(GOOD_SPEC.replace("test('home", "test.only('home"))).errors.join(' ')).toMatch(/only/);
    expect((await validateSpec(`import { expect } from './_support';\nexpect(1).toBe(1);`)).errors.join(' ')).toMatch(/test\(/);
    expect((await validateSpec(GOOD_SPEC.replace("'./_support'", "'@playwright/test'"))).errors.join(' ')).toMatch(/_support/);
  });
});

describe('validateSpec security restrictions', () => {
  const withLine = (line: string) => GOOD_SPEC.replace("test('home", line + "\ntest('home");
  const bad: [string, string, RegExp][] = [
    ['fs import', "import fs from 'fs';", /import/],
    ['node:fs import', "import { readFileSync } from 'node:fs';", /import/],
    ['child_process import', "import { exec } from 'node:child_process';", /import/],
    ['relative import', "import x from '../../secrets';", /import/],
    ['side-effect import', "import 'node:os';", /import/],
    ['re-export', "export * from 'node:fs';", /import|export/],
    ['require', "const f = require('fs');", /require/],
    ['process.env', "const k = process.env.ANTHROPIC_API_KEY;", /process/],
    ['eval', "eval('1');", /eval/],
    ['Function ctor', "new Function('return 1')();", /Function/],
    ['dynamic import', "const m = await import('node:fs');", /dynamic import/],
    ['globalThis', "const p = globalThis.process;", /globalThis/],
  ];
  for (const [name, line, re] of bad) {
    it('rejects ' + name, async () => {
      const r = await validateSpec(withLine(line));
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(re);
    });
  }
  it('allows @playwright/test imports and property names like page.process', async () => {
    const r = await validateSpec(GOOD_SPEC.replace("import { test, expect } from './_support';", "import { test, expect } from './_support';\nimport type { Page } from '@playwright/test';\nconst o = { process: 1, eval: 2 };"));
    expect(r.errors).toEqual([]);
  });
});

describe('assertion guards', () => {
  it('counts expect calls', () => { expect(countAssertions(GOOD_SPEC)).toBe(2); expect(countAssertions('// expect(x)\nconst a = 1;')).toBe(0); });
  it('detects weakening', () => {
    expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC)).toBeNull();
    expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC.replace(/\s*await expect\(page\)\.toHaveTitle.*\n/, '\n'))).toMatch(/fewer/i);
    expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC + '\nexpect(true).toBe(true);')).toMatch(/tautolog/i);
    expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC.replace("test('home", "test.fixme('home"))).toMatch(/skip|fixme/i);
    expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC + "\nexpect(page.getByText('x')).toBeVisible({ timeout: 0 });")).toBeNull();
  });
  it('allows adding assertions', () => { expect(weakensAssertions(GOOD_SPEC, GOOD_SPEC.replace('});\n});', "});\n  await expect(page).toHaveURL(/x/);\n});"))).toBeNull(); });
});
