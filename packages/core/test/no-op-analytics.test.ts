import { describe, expect, expectTypeOf, it } from 'vitest';
import { createNoOpAnalytics } from '../src';
import type { Analytics } from '../src';

// The Analytics interface and the no-op (Web Public API 3, Public API 2, 5, 8, Android log 3.3), the
// port of the Android `NoOpAnalyticsTest`. The "many threads" test has no counterpart on one thread.

const METHODS = [
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
] as const;

const READERS = ['isOptedOut', 'deviceId'] as const;

type Method = (typeof METHODS)[number];

/** The no-op as a JavaScript caller sees it: any argument, any number of them. */
type Loose = Record<Method, (...args: unknown[]) => unknown>;

/** An object whose every trap records and throws, so any read of an argument fails the test. */
function trap(touched: string[]): object {
  const fail = (name: string) => () => {
    touched.push(name);
    throw new Error(`the no-op touched its argument (${name})`);
  };
  return new Proxy(
    {},
    {
      get: fail('get'),
      has: fail('has'),
      ownKeys: fail('ownKeys'),
      getOwnPropertyDescriptor: fail('getOwnPropertyDescriptor'),
      getPrototypeOf: fail('getPrototypeOf'),
      set: fail('set'),
      defineProperty: fail('defineProperty'),
      deleteProperty: fail('deleteProperty'),
    },
  );
}

function anyInput(touched: string[]): unknown[] {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const throwing = {
    get value(): never {
      touched.push('getter');
      throw new Error('the no-op ran a getter');
    },
  };
  return [
    undefined,
    null,
    '',
    ' '.repeat(300),
    '\uD800',
    NaN,
    Infinity,
    BigInt(10),
    Symbol('s'),
    () => 1,
    new Date(NaN),
    new Map([[1, 2]]),
    cyclic,
    throwing,
    trap(touched),
    Promise.resolve(1),
  ];
}

describe('the Analytics interface', () => {
  it('has exactly the decided members (Public API 8, Web Public API 3)', () => {
    expectTypeOf<keyof Analytics>().toEqualTypeOf<Method | (typeof READERS)[number]>();
    expect(Object.keys(createNoOpAnalytics()).sort()).toEqual([...METHODS, ...READERS].sort());
  });

  it('takes the decided arguments: plain objects at the door, unknown for register (Web Public API 4)', () => {
    expectTypeOf<Parameters<Analytics['track']>>().toEqualTypeOf<[string, Record<string, unknown>?]>();
    expectTypeOf<Parameters<Analytics['screen']>>().toEqualTypeOf<[string, Record<string, unknown>?]>();
    expectTypeOf<Parameters<Analytics['identify']>>().toEqualTypeOf<[string, Record<string, unknown>?]>();
    expectTypeOf<Parameters<Analytics['register']>>().toEqualTypeOf<[string, unknown]>();
    expectTypeOf<Parameters<Analytics['unregister']>>().toEqualTypeOf<[string]>();
    expectTypeOf<Parameters<Analytics['reset']>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<Analytics['flush']>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<Analytics['optOut']>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<Analytics['optIn']>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<Analytics['clearLocalData']>>().toEqualTypeOf<[]>();
  });

  it('every method returns void, never a Promise or the instance (Public API 5)', () => {
    expectTypeOf<ReturnType<Analytics[Method]>>().toBeVoid();
  });

  it('the two reads are readonly properties, not methods (Web Public API 3)', () => {
    expectTypeOf<Analytics['isOptedOut']>().toEqualTypeOf<boolean>();
    expectTypeOf<Analytics['deviceId']>().toEqualTypeOf<string>();
    const analytics = createNoOpAnalytics();
    const assign = () => {
      // @ts-expect-error isOptedOut is readonly
      analytics.isOptedOut = false;
      // @ts-expect-error deviceId is readonly
      analytics.deviceId = 'id';
    };
    expect(assign).toBeTypeOf('function');
  });
});

describe('createNoOpAnalytics', () => {
  describe('accepts every call', () => {
    it('every method returns without doing anything', () => {
      const analytics = createNoOpAnalytics();
      analytics.track('Event', { i: 0 });
      analytics.screen('screen');
      analytics.identify('user', { plan: 'pro' });
      analytics.register('key', 0);
      analytics.unregister('key');
      analytics.flush();
      analytics.optOut();
      analytics.optIn();
      analytics.clearLocalData();
      analytics.reset();

      expect(analytics.isOptedOut).toBe(true);
      expect(analytics.deviceId).toBe('');
    });

    it('every method accepts any input and returns undefined', () => {
      const touched: string[] = [];
      const loose = createNoOpAnalytics() as unknown as Loose;
      const inputs = anyInput(touched);
      for (const method of METHODS) {
        expect(loose[method]()).toBeUndefined();
        for (const input of inputs) {
          expect(loose[method](input)).toBeUndefined();
          expect(loose[method](input, input, input)).toBeUndefined();
        }
        expect(loose[method](...inputs)).toBeUndefined();
      }
    });

    it('reads none of its arguments: no getter, Proxy trap or toJSON runs', () => {
      const touched: string[] = [];
      const loose = createNoOpAnalytics() as unknown as Loose;
      const withToJson = {
        toJSON: () => {
          touched.push('toJSON');
          return {};
        },
      };
      for (const method of METHODS) loose[method](...anyInput(touched), withToJson);
      expect(touched).toEqual([]);
    });
  });

  describe('nothing is sent', () => {
    it('it reports opted out, also after optIn', () => {
      const analytics = createNoOpAnalytics();
      analytics.optIn();
      expect(analytics.isOptedOut).toBe(true);
    });

    it('it has no device id, also after clearLocalData', () => {
      const analytics = createNoOpAnalytics();
      analytics.clearLocalData();
      expect(analytics.deviceId).toBe('');
    });
  });

  describe('the object', () => {
    it('two calls return different objects with their own methods', () => {
      const first = createNoOpAnalytics();
      const second = createNoOpAnalytics();
      expect(first).not.toBe(second);
      const replaced = () => undefined;
      Object.assign(first, { track: replaced });
      expect((first as unknown as Loose).track).toBe(replaced);
      expect((second as unknown as Loose).track).not.toBe(replaced);
    });

    it('is a plain object literal whose members are all own enumerable properties', () => {
      const analytics = createNoOpAnalytics();
      expect(Object.getPrototypeOf(analytics)).toBe(Object.prototype);
      for (const member of [...METHODS, ...READERS]) {
        expect(Object.getOwnPropertyDescriptor(analytics, member)?.enumerable).toBe(true);
      }
      const loose = analytics as unknown as Loose;
      for (const method of METHODS) expect(loose[method]).toBeTypeOf('function');
    });
  });

  describe('spread-based fakes (Web Public API 3)', () => {
    it('a fake that replaces one method type-checks as Analytics and keeps the others', () => {
      const tracked: string[] = [];
      const fake: Analytics = {
        ...createNoOpAnalytics(),
        track: (name) => {
          tracked.push(name);
        },
      };
      fake.track('Purchase Completed', { amount: 49.9 });
      fake.flush();
      expect(tracked).toEqual(['Purchase Completed']);
      expect(Object.keys(fake).sort()).toEqual([...METHODS, ...READERS].sort());
      expect(fake.isOptedOut).toBe(true);
    });

    it('a fake gains a verb the no-op gains, because spread copies own properties', () => {
      // A later version of the no-op with one more verb: the fake's code is unchanged.
      const later = { ...createNoOpAnalytics(), group: () => undefined };
      const fake = { ...later, track: () => undefined };
      expect(fake.group).toBeTypeOf('function');
      expectTypeOf(fake).toExtend<Analytics>();
    });

    it('a class instance would lose its methods in a spread, which is why the no-op is a literal', () => {
      class Prototyped {
        track(): void {}
      }
      // Object.assign copies what spread copies, own enumerable properties; the methods of a class
      // live on its prototype.
      expect(Object.assign({}, new Prototyped())).not.toHaveProperty('track');
    });
  });
});
