import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));

// window.Rubicon itself appears with the first export (step 3.3); step 7.8 tests its contents.
test('the script build defines no global other than window.Rubicon', async ({ page }) => {
  await page.goto('about:blank');
  const before = await page.evaluate(() => Object.getOwnPropertyNames(window));
  await page.addScriptTag({ path: scriptBuild });
  const after = await page.evaluate(() => Object.getOwnPropertyNames(window));
  expect(after.filter((name) => !before.includes(name) && name !== 'Rubicon')).toEqual([]);
});
