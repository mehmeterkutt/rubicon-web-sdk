import { expect, test } from '@playwright/test';

test('opens a blank page', async ({ page }) => {
  await page.goto('about:blank');
  expect(await page.evaluate(() => document.readyState)).toBe('complete');
});
