import { describe, expect, it } from 'vitest';
import { FakeContextProvider } from '../src';

const all = { disabled: new Set<string>(), queryParams: ['page', 'sort'], title: true };

function provider(): FakeContextProvider {
  return new FakeContextProvider(
    {
      osName: 'macOS',
      browserName: 'Chrome',
      browserVersion: '156',
      deviceType: 'desktop',
      screenWidth: 900,
      screenHeight: 1440,
      screenDensity: 2,
      pageReferrer: 'https://www.example.com/',
    },
    {
      pageUrl: 'https://shop.example.com/orders/:id',
      viewportWidth: 1280,
      viewportHeight: 720,
      pageQuery: { page: '2', sort: 'price', token: 'abc' },
      pageTitle: 'Orders',
      locale: 'tr-TR',
      timezone: 'Europe/Istanbul',
    },
  );
}

describe('FakeContextProvider', () => {
  it('returns what the test set and counts the reads', () => {
    const context = provider();
    expect(context.staticValues(new Set())).toEqual(context.staticContext);
    expect(context.callTimeValues(all)).toEqual({
      ...context.callTimeContext,
      pageQuery: { page: '2', sort: 'price' },
    });
    expect(context.staticReads).toBe(1);
    expect(context.callTimeReads).toBe(1);
  });

  it('leaves out every disabled field, named by its wire path', () => {
    const context = provider();
    const disabled = new Set(['os.name', 'screen.density', 'page.referrer', 'page.url', 'page.query', 'timezone']);
    const staticValues = context.staticValues(disabled);
    expect(Object.keys(staticValues).sort()).toEqual([
      'browserName',
      'browserVersion',
      'deviceType',
      'screenHeight',
      'screenWidth',
    ]);
    const callTime = context.callTimeValues({ ...all, disabled });
    expect(Object.keys(callTime).sort()).toEqual(['locale', 'pageTitle', 'viewportHeight', 'viewportWidth']);
    expect(context.lastDisabled).toBe(disabled);
  });

  it('keeps only the named query parameters and the title only when enabled (Web Context 2)', () => {
    const context = provider();
    const values = context.callTimeValues({ disabled: new Set(), queryParams: ['token-free'], title: false });
    expect(values.pageQuery).toBeUndefined();
    expect(values.pageTitle).toBeUndefined();
  });

  it('gives empty values by default', () => {
    const context = new FakeContextProvider();
    expect(context.staticValues(new Set())).toEqual({});
    expect(context.callTimeValues(all)).toEqual({});
  });
});
