import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const scriptBuild = fileURLToPath(new URL('../../dist/rubicon.min.js', import.meta.url));
const esmEntry = new URL('../../dist/index.mjs', import.meta.url).href;

// The script build installs window.Rubicon with the runtime exports of the package and nothing else
// on window (Web Public API 2, 7). window.Rubicon appears with the first runtime export, step 3.3
// (plan section 15, step 1.1); step 7.8 builds the script entry and tests the snippet.

test('the script build defines no global other than window.Rubicon', async ({ page }) => {
  await page.goto('about:blank');
  const before = await page.evaluate(() => Object.getOwnPropertyNames(window));
  await page.addScriptTag({ path: scriptBuild });
  const after = await page.evaluate(() => Object.getOwnPropertyNames(window));
  expect(after.filter((name) => !before.includes(name) && name !== 'Rubicon')).toEqual([]);
});

test('window.Rubicon holds exactly the runtime exports of the package', async ({ page }) => {
  const exported = (await import(esmEntry)) as Record<string, unknown>;
  const expected = Object.keys(exported)
    .sort()
    .map((name) => [name, typeof exported[name]]);
  expect(expected).toContainEqual(['createNoOpAnalytics', 'function']);

  await page.goto('about:blank');
  await page.addScriptTag({ path: scriptBuild });
  const installed = await page.evaluate(() => {
    const rubicon: unknown = Reflect.get(window, 'Rubicon');
    if (typeof rubicon !== 'object' || rubicon === null) return null;
    return Object.keys(rubicon)
      .sort()
      .map((name) => [name, typeof Reflect.get(rubicon, name)]);
  });
  expect(installed).toEqual(expected);
});

test('the no-op from window.Rubicon accepts every verb', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ path: scriptBuild });
  const result = await page.evaluate(() => {
    type Verb = (...args: unknown[]) => unknown;
    const rubicon = Reflect.get(window, 'Rubicon') as { createNoOpAnalytics: () => Record<string, unknown> };
    const analytics = rubicon.createNoOpAnalytics();
    const verbs = [
      'track',
      'screen',
      'identify',
      'reset',
      'register',
      'unregister',
      'flush',
      'optOut',
      'optIn',
      'clearLocalData',
    ];
    const allUndefined = verbs.every((verb) => (analytics[verb] as Verb)('x', { a: 1 }) === undefined);
    return { allUndefined, isOptedOut: analytics.isOptedOut, deviceId: analytics.deviceId };
  });
  expect(result).toEqual({ allUndefined: true, isOptedOut: true, deviceId: '' });
});

test('createAnalytics from window.Rubicon makes one instance per page, held in the page marker', async ({ page }) => {
  await page.goto('about:blank');
  await page.addScriptTag({ path: scriptBuild });
  const result = await page.evaluate(() => {
    type Instance = { readonly deviceId: string; readonly isOptedOut: boolean };
    const rubicon = Reflect.get(window, 'Rubicon') as { createAnalytics: (config: unknown) => Instance };
    const lines: string[] = [];
    const logging = { level: 'warn', logger: (_level: string, message: string) => lines.push(message) };
    const first = rubicon.createAnalytics({ apiKey: 'rk_test', host: 'https://api.example.com', logging });
    const second = rubicon.createAnalytics({ apiKey: 'rk_other', logging });
    const marker: unknown = Reflect.get(window, Symbol.for('rubicon.analytics'));
    return {
      same: first === second,
      deviceIdIsUuidV7: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first.deviceId),
      isOptedOut: first.isOptedOut,
      lines: lines.map((line) => line.split(':')[0]),
      markerHoldsFirst: typeof marker === 'object' && marker !== null && Reflect.get(marker, 'analytics') === first,
    };
  });
  expect(result).toEqual({
    same: true,
    deviceIdIsUuidV7: true,
    isOptedOut: false,
    lines: ['SECOND_INSTANCE'],
    markerHoldsFirst: true,
  });
});
