// Importing the built package touches no browser global (Web Public API 7). Each global is replaced
// by a getter that records the access; the plain-Node environment has no window, document or
// localStorage, and Node's own navigator is guarded as well.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GUARDED = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history'] as const;

let touched: string[] = [];
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
