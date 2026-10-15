import { TEST_HOST_A, TEST_HOST_B, TEST_SITE, expect, test } from '../fixtures';

// D15: Web Identity 2 and Web Privacy 2 share the identity and consent cookies across a site's
// subdomains with a `Domain` attribute. These tests prove that every engine of the suite serves the
// two hosts of the test site as one site; the result per engine is in plan section 15 (step 1.3).

test('a cookie with Domain=rubicon.test set on a.rubicon.test is read on b.rubicon.test', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const written = await page.evaluate((site) => {
    document.cookie = `rubicon_probe=1; Domain=${site}; Path=/; SameSite=Lax; Max-Age=60`;
    return document.cookie;
  }, TEST_SITE);

  await page.goto(server.url('/pages/blank.html', TEST_HOST_B));
  const read = await page.evaluate(() => document.cookie);

  expect(written).toBe('rubicon_probe=1');
  expect(read).toBe('rubicon_probe=1');
});

test('a host-only cookie set on a.rubicon.test is not read on b.rubicon.test', async ({ page, server }) => {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  const written = await page.evaluate(() => {
    document.cookie = 'rubicon_host_only=1; Path=/; SameSite=Lax; Max-Age=60';
    return document.cookie;
  });

  await page.goto(server.url('/pages/blank.html', TEST_HOST_B));
  const read = await page.evaluate(() => document.cookie);

  expect(written).toBe('rubicon_host_only=1');
  expect(read).toBe('');
});
