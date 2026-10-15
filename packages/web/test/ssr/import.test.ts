// Importing the built package touches no browser global (Web Public API 7). Each global is replaced
// by a getter that records the access; the plain-Node environment has no window, document or
// localStorage, and Node's own navigator is guarded as well. Since step 3.3 the no-op is created and
// every verb called through both entries; step 7.1 adds createAnalytics returning the no-op here.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GUARDED = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history'] as const;

let touched: string[] = [];

/** The no-op as the built entries give it: their types are not read here. */
interface NoOp {
  track(name: string, properties?: Record<string, unknown>): void;
  screen(name: string, properties?: Record<string, unknown>): void;
  identify(userId: string, traits?: Record<string, unknown>): void;
  reset(): void;
  register(key: string, value: unknown): void;
  unregister(key: string): void;
  flush(): void;
  optOut(): void;
  optIn(): void;
  clearLocalData(): void;
  readonly isOptedOut: boolean;
  readonly deviceId: string;
}

interface Entry {
  createNoOpAnalytics: () => NoOp;
}

/** Creates the no-op and calls every verb; each returns undefined. */
function callEveryVerb(entry: Entry): NoOp {
  const analytics = entry.createNoOpAnalytics();
  const verbs = analytics as unknown as Record<string, (...args: unknown[]) => unknown>;
  const calls: [string, unknown[]][] = [
    ['track', ['Purchase Completed', { amount: 49.9 }]],
    ['screen', ['checkout', { step: 1 }]],
    ['identify', ['user-1', { plan: 'pro' }]],
    ['register', ['tenant', 'acme']],
    ['unregister', ['tenant']],
    ['flush', []],
    ['optOut', []],
    ['optIn', []],
    ['clearLocalData', []],
    ['reset', []],
  ];
  for (const [verb, args] of calls) expect(verbs[verb]?.(...args)).toBeUndefined();
  expect(Object.keys(analytics).sort()).toEqual([...calls.map(([verb]) => verb), 'deviceId', 'isOptedOut'].sort());
  return analytics;
}
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  touched = [];
  for (const name of GUARDED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      },
    });
  }
});

afterEach(() => {
  for (const name of GUARDED) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('the built package in plain Node', () => {
  it('has a guard that records an access to a browser global', async () => {
    const touching: string = 'data:text/javascript,void globalThis.window;';
    await import(touching);
    expect(touched).toEqual(['window']);
  });

  it('imports the ESM entry without touching a browser global', async () => {
    const entry = new URL('../../dist/index.mjs', import.meta.url).href;
    const module: unknown = await import(entry);
    expect(module).toBeTypeOf('object');
    expect(touched).toEqual([]);
  });

  it('creates the no-op from the ESM entry and calls every verb without touching a browser global', async () => {
    const entry = new URL('../../dist/index.mjs', import.meta.url).href;
    const analytics = callEveryVerb((await import(entry)) as Entry);
    expect(analytics.isOptedOut).toBe(true);
    expect(analytics.deviceId).toBe('');
    expect(touched).toEqual([]);
  });

  it('creates the no-op from the CommonJS entry and calls every verb without touching a browser global', () => {
    const require = createRequire(import.meta.url);
    const analytics = callEveryVerb(require(new URL('../../dist/index.cjs', import.meta.url).pathname) as Entry);
    expect(analytics.isOptedOut).toBe(true);
    expect(analytics.deviceId).toBe('');
    expect(touched).toEqual([]);
  });

  it('requires the CommonJS entry without touching a browser global', () => {
    const require = createRequire(import.meta.url);
    const module: unknown = require(new URL('../../dist/index.cjs', import.meta.url).pathname);
    expect(module).toBeTypeOf('object');
    expect(touched).toEqual([]);
  });

  it('resolves both entries through the exports map', () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve('rubicon-analytics')).toMatch(/dist\/index\.cjs$/);
    expect(import.meta.resolve('rubicon-analytics')).toMatch(/dist\/index\.mjs$/);
  });
});
