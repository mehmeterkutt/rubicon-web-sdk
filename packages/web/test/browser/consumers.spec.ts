import { readFileSync } from 'node:fs';
import type { RecordedRequest, TestServer } from 'rubicon-analytics-testing/server';
import { TEST_HOST_A, expect, test } from './fixtures';

// The consumer apps of step 8.2 (Web Public API 7): the packed tarball installed with npm and the app
// built by Vite and by webpack in production mode (packages/web/test/consumers, built by
// `pnpm -r build`). Each app creates the instance from its bundle and its event reaches the server;
// the apps that import only `createNoOpAnalytics` run with the no-op.

const API_KEY = 'rk_consumers';
const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

interface WireEvent {
  readonly event?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly context: { readonly library?: { readonly name?: string; readonly version?: string } };
}

function events(server: TestServer): WireEvent[] {
  return server.requests
    .filter((request: RecordedRequest) => request.method === 'POST' && request.path === '/v1/batch')
    .flatMap((request) => (JSON.parse(request.body) as { batch: WireEvent[] }).batch);
}

test.beforeEach(({ server }) => {
  server.respond('/v1/config', { status: 404 });
});

for (const bundler of ['vite', 'webpack'] as const) {
  test(`the ${bundler} app sends its event with the packed library`, async ({ page, server }) => {
    await page.addInitScript((config) => Reflect.set(window, '__rubiconTest', config), {
      apiKey: API_KEY,
      host: server.origin(),
    });
    await page.goto(server.url(`/consumers/${bundler}/`, TEST_HOST_A));

    await expect
      .poll(async () => {
        await page.evaluate(() => {
          (Reflect.get(window, '__analytics') as { flush: () => void } | undefined)?.flush();
        });
        return events(server).filter((event) => event.event === 'Consumer Loaded');
      })
      .toEqual([
        expect.objectContaining({
          properties: { bundler },
          context: expect.objectContaining({ library: { name: 'rubicon-web', version: VERSION } }),
        }),
      ]);
  });

  test(`the ${bundler} app importing only the no-op runs it`, async ({ page, server }) => {
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(server.url(`/consumers/${bundler}-no-op/`, TEST_HOST_A));
    await page.waitForFunction(() => Reflect.get(window, '__analytics') !== undefined);

    expect(
      await page.evaluate(() => {
        const analytics = Reflect.get(window, '__analytics') as { isOptedOut: boolean; deviceId: string };
        return [analytics.isOptedOut, analytics.deviceId];
      }),
    ).toEqual([true, '']);
    expect(errors).toEqual([]);
  });
}
