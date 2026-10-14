import { runInNewContext } from 'node:vm';
import { parseWithPython, SeededRandom } from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { PropertyProblem, PropertyProblemKind, PropertyValue } from '../../src';
import {
  checkName,
  ISO_MAX_MILLIS,
  ISO_MIN_MILLIS,
  isOversizeLine,
  MAX_EVENT_BYTES,
  mergeSuperProperties,
  normalizeProperties,
  replaceLoneSurrogates,
  utf8ByteLength,
  writeJson,
} from '../../src';

// The port of the Android PropertyNormalizerTest (Serialization 2, 3; Android log 2.5) with the
// JavaScript conversion table of Web Serialization 2, one `describe` per row, in its order. Values
// from another realm come from `node:vm` contexts here; the iframe, DOM node and `window` cases run
// in jsdom (`packages/web/test/unit/property-normalizer-realm.test.ts`). Every line written here is
// parsed again by Python with strict UTF-8 (afterAll, Web Serialization 3).

const written: string[] = [];

function write(values: Record<string, PropertyValue>): string {
  const line = writeJson(values);
  written.push(line);
  return line;
}

afterAll(() => {
  const answers = parseWithPython(written);
  answers.forEach((answer, i) => {
    const line = written[i] ?? '';
    expect(answer, line).toEqual({ ok: true, value: JSON.parse(line) as unknown });
  });
});

function expectKept(value: unknown, expected: PropertyValue): void {
  const result = normalizeProperties({ p: value });
  expect(Object.keys(result.values)).toEqual(['p']);
  expect(result.values.p).toEqual(expected);
  expect(result.problems).toEqual([]);
  write(result.values);
}

function expectDropped(value: unknown, kind: PropertyProblemKind, type?: string): void {
  const result = normalizeProperties({ p: value, other: 'kept' });
  expect(result.values).toEqual({ other: 'kept' });
  expect(result.problems).toEqual([type === undefined ? { kind, path: 'p' } : { kind, path: 'p', type }]);
}

function bigint(text: string): bigint {
  return BigInt(text);
}

// A value from another realm (a `vm` context has its own `Object`, `Array`, `Date` and so on).
function foreign(code: string): unknown {
  return runInNewContext(code);
}

class Order {
  constructor(readonly secret: string) {}
}

describe('the conversion table of Web Serialization 2, row by row', () => {
  describe('1. a string', () => {
    it('is kept as it is', () => {
      expectKept('a', 'a');
      expectKept('', '');
      expectKept('😀 ğ 日', '😀 ğ 日');
    });

    it('has its lone surrogates replaced with U+FFFD', () => {
      expectKept('a\uD800b', 'a\uFFFDb');
    });
  });

  describe('2. a boolean and null', () => {
    it('are kept as they are', () => {
      expectKept(true, true);
      expectKept(false, false);
      expectKept(null, null);
      expect(write(normalizeProperties({ coupon: null }).values)).toBe('{"coupon":null}');
    });
  });

  describe('3. undefined as an object value', () => {
    it('is an absent key, without a problem, at any level and in a Map', () => {
      const result = normalizeProperties({
        coupon: undefined,
        nested: { a: undefined, b: 1 },
        map: new Map([['a', undefined]]),
      });

      expect(result.values).toEqual({ nested: { b: 1 }, map: {} });
      expect(Object.keys(result.values)).toEqual(['nested', 'map']);
      expect(result.problems).toEqual([]);
      expect(write(result.values)).toBe('{"nested":{"b":1},"map":{}}');
    });
  });

  describe('4. undefined or a hole in a list', () => {
    it('is null, so positions are kept', () => {
      // eslint-disable-next-line no-sparse-arrays -- the hole is the case
      expectKept([1, , 3], [1, null, 3]);
      expectKept([1, undefined, 3], [1, null, 3]);
      expectKept(new Set([undefined]), [null]);
      expect(write(normalizeProperties({ p: new Array(2) }).values)).toBe('{"p":[null,null]}');
    });
  });

  describe('5. a finite number', () => {
    it('is kept as it is, also beyond the safe integer range', () => {
      for (const value of [0, 7, -7, 1.5, 49.9, 2 ** 53, 2 ** 53 + 2, 1e21, 1e-7, 5e-324, 1.7976931348623157e308]) {
        expectKept(value, value);
      }
      expect(write(normalizeProperties({ big: 1e21, price: 50.0, small: 1e-7 }).values)).toBe(
        '{"big":1e+21,"price":50,"small":1e-7}',
      );
    });
  });

  describe('6. NaN and Infinity', () => {
    it('are unsupported, never the silent null of JSON.stringify', () => {
      expectDropped(NaN, 'not-finite', 'number');
      expectDropped(Infinity, 'not-finite', 'number');
      expectDropped(-Infinity, 'not-finite', 'number');
    });
  });

  describe('7. a BigInt', () => {
    it('is a number within the safe integer range', () => {
      expectKept(bigint('123'), 123);
      expectKept(bigint('-123'), -123);
      expectKept(bigint('0'), 0);
      expectKept(bigint(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
      expectKept(bigint(String(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
    });

    it('is unsupported beyond it, rather than losing precision silently', () => {
      expectDropped(bigint('9007199254740992'), 'out-of-range', 'bigint');
      expectDropped(bigint('-9007199254740992'), 'out-of-range', 'bigint');
      expectDropped(bigint('18446744073709551616'), 'out-of-range', 'bigint');
    });
  });

  describe('8. a boxed primitive', () => {
    it('is its primitive value, with the rules of that value', () => {
      expectKept(new Number(5), 5);
      expectKept(new String('a'), 'a');
      expectKept(new Boolean(false), false);
      expectKept(new String('a\uDC00'), 'a\uFFFD');
      expectKept(Object(bigint('7')), 7);
      expectDropped(new Number(NaN), 'not-finite', 'number');
      expectDropped(Object(bigint('18446744073709551616')), 'out-of-range', 'bigint');
    });

    it('is told by its internal slot: a plain object that only claims the tag stays a plain object', () => {
      let calls = 0;
      const impostor = {
        [Symbol.toStringTag]: 'Number',
        value: 1,
        valueOf: () => (calls += 1),
      };

      const result = normalizeProperties({ p: impostor });

      expect(result.values).toEqual({ p: { value: 1 } });
      expect(result.problems).toEqual([{ kind: 'unsupported-type', path: 'p.valueOf', type: 'function' }]);
      expect(calls).toBe(0);
    });

    it('a boxed Symbol is unsupported', () => {
      expectDropped(Object(Symbol('s')), 'unsupported-type', 'Symbol');
    });
  });

  describe('9. a valid Date in the years 0000 to 9999', () => {
    it('is its toISOString() text, the Android IsoDates format', () => {
      expectKept(new Date(0), '1970-01-01T00:00:00.000Z');
      expectKept(new Date(Date.UTC(2026, 9, 14, 8)), '2026-10-14T08:00:00.000Z');
      expectKept(new Date(1_791_878_400_000), '2026-10-13T08:00:00.000Z');
      expectKept(new Date(ISO_MIN_MILLIS), '0000-01-01T00:00:00.000Z');
      expectKept(new Date(ISO_MAX_MILLIS), '9999-12-31T23:59:59.999Z');
    });

    it('never runs a method replaced on the date', () => {
      const date = new Date(0);
      date.toISOString = () => 'secret';

      expectKept(date, '1970-01-01T00:00:00.000Z');
    });
  });

  describe('10. an invalid Date, or one outside those years', () => {
    it('is unsupported', () => {
      expectDropped(new Date(NaN), 'out-of-range', 'Date');
      expectDropped(new Date(ISO_MAX_MILLIS + 1), 'out-of-range', 'Date');
      expectDropped(new Date(ISO_MIN_MILLIS - 1), 'out-of-range', 'Date');
      // The Android vector: 10000-01-01T00:00:00.000Z.
      expectDropped(new Date(253_402_300_800_000), 'out-of-range', 'Date');
    });
  });

  describe('11. Temporal values and date-library objects', () => {
    // Node 24 has no Temporal: a Temporal value presents itself through its prototype's tag.
    class Instant {
      get [Symbol.toStringTag](): string {
        return 'Temporal.Instant';
      }
      toJSON(): string {
        throw new Error('a foreign toJSON ran');
      }
    }
    // The marker each library sets on its instances (moment `_isAMomentObject`, Day.js
    // `$isDayjsObject` and, before it, `$d`, Luxon `isLuxonDateTime`).
    class Moment {
      readonly _isAMomentObject = true;
      toJSON(): string {
        throw new Error('a foreign toJSON ran');
      }
    }
    class Dayjs {
      readonly $isDayjsObject = true;
      readonly $d = new Date(0);
    }
    class OldDayjs {
      readonly $L = 'en';
      readonly $d = new Date(0);
    }
    class DateTime {
      readonly isLuxonDateTime = true;
    }

    it('are unsupported, named, with the hint', () => {
      expectDropped(new Instant(), 'date-library', 'Temporal.Instant');
      expectDropped(new Moment(), 'date-library', 'moment');
      expectDropped(new Dayjs(), 'date-library', 'Dayjs');
      expectDropped(new OldDayjs(), 'date-library', 'Dayjs');
      expectDropped(new DateTime(), 'date-library', 'DateTime');
    });

    it('a plain object with a library marker is a plain object', () => {
      expectKept({ _isAMomentObject: true }, { _isAMomentObject: true });
    });
  });

  describe('12. an Array', () => {
    it('is a list', () => {
      expectKept([1, 'a', null, true], [1, 'a', null, true]);
      expectKept([], []);
      expectKept([[1], { a: [2] }], [[1], { a: [2] }]);
    });

    it('keeps only its positions, not other keys', () => {
      const array: unknown[] & { extra?: number } = [1];
      array.extra = 2;

      expectKept(array, [1]);
    });
  });

  describe('13. a Set', () => {
    it('is a list in iteration order', () => {
      expectKept(new Set(['b', 'a', 'b']), ['b', 'a']);
      expectKept(new Set([1, new Set([2])]), [1, [2]]);
    });
  });

  describe('14. a Map', () => {
    it('is an object of its string keys', () => {
      expectKept(
        new Map<string, unknown>([
          ['k', 1],
          ['n', null],
        ]),
        { k: 1, n: null },
      );
    });

    it("an entry with another key is unsupported, Android's Map rule", () => {
      const result = normalizeProperties({
        m: new Map<unknown, unknown>([
          [1, 'a'],
          [null, 'b'],
          [{}, 'c'],
          [Symbol('s'), 'd'],
          ['', 'e'],
          ['ok', 2],
        ]),
      });

      expect(result.values).toEqual({ m: { ok: 2 } });
      expect(result.problems).toEqual(
        ['number', 'null', 'Object', 'symbol', 'blank'].map((type) => ({ kind: 'invalid-key', path: 'm', type })),
      );
    });
  });

  describe('15. a typed array', () => {
    it('is a list of numbers', () => {
      expectKept(new Uint8Array([1, 2]), [1, 2]);
      expectKept(new Int32Array([-1, 2]), [-1, 2]);
      expectKept(new Uint8ClampedArray([300]), [255]);
      expectKept(new Float64Array([1.5, -0.25]), [1.5, -0.25]);
      expectKept(new Float32Array([0.5]), [0.5]);
    });

    it('a non-finite element is dropped as any list element', () => {
      const result = normalizeProperties({ p: new Float64Array([1.5, NaN, Infinity]) });

      expect(result.values).toEqual({ p: [1.5] });
      expect(result.problems.map((problem) => problem.path)).toEqual(['p[1]', 'p[2]']);
    });

    it('BigInt64Array and BigUint64Array elements follow the BigInt rule', () => {
      const result = normalizeProperties({
        signed: new BigInt64Array([bigint('1'), bigint('-9223372036854775808')]),
        unsigned: new BigUint64Array([bigint('2')]),
      });

      expect(result.values).toEqual({ signed: [1], unsigned: [2] });
      expect(result.problems).toEqual([{ kind: 'out-of-range', path: 'signed[1]', type: 'bigint' }]);
    });
  });

  describe('16. ArrayBuffer, DataView, Blob and File', () => {
    it('are unsupported', () => {
      const buffer = new ArrayBuffer(4);
      expectDropped(buffer, 'unsupported-type', 'ArrayBuffer');
      expectDropped(new SharedArrayBuffer(4), 'unsupported-type', 'SharedArrayBuffer');
      expectDropped(new DataView(buffer), 'unsupported-type', 'DataView');
      expectDropped(new Blob(['secret']), 'unsupported-type', 'Blob');
      expectDropped(new File(['secret'], 'secret.txt'), 'unsupported-type', 'File');
    });
  });

  describe('17. a plain object', () => {
    it('is an object of its own enumerable string keys', () => {
      const parent = { inherited: 1 };
      const value = Object.create(parent) as Record<string | symbol, unknown>;
      expect(normalizeProperties({ p: value }).problems).toEqual([
        { kind: 'unsupported-type', path: 'p', type: 'Object' },
      ]);

      const plain: Record<string | symbol, unknown> = { a: 1, [Symbol('s')]: 2 };
      Object.defineProperty(plain, 'hidden', { value: 3, enumerable: false });

      expectKept(plain, { a: 1 });
    });

    it('with a null prototype is a plain object', () => {
      const value = Object.create(null) as Record<string, unknown>;
      value.a = 1;

      expectKept(value, { a: 1 });
    });

    it('a __proto__ key stays a key of the copy', () => {
      const value = JSON.parse('{"__proto__":{"a":1},"b":2}') as unknown;

      const result = normalizeProperties({ p: value });

      expect(Object.keys(result.values.p ?? {})).toEqual(['__proto__', 'b']);
      expect(Object.getPrototypeOf(result.values.p)).toBe(Object.prototype);
      expect(write(result.values)).toBe('{"p":{"__proto__":{"a":1},"b":2}}');
    });

    it('a toJSON of its own is a function value, dropped; it is never run', () => {
      let calls = 0;
      const value = { a: 1, toJSON: () => (calls += 1) };

      const result = normalizeProperties({ p: value });

      expect(result.values).toEqual({ p: { a: 1 } });
      expect(result.problems).toEqual([{ kind: 'unsupported-type', path: 'p.toJSON', type: 'function' }]);
      expect(calls).toBe(0);
    });
  });

  describe('18. a getter or a Proxy trap that throws', () => {
    it('drops only its key; the error is caught and its text never kept', () => {
      const value = {
        before: 1,
        get secret(): unknown {
          throw new Error('secret text');
        },
        after: 2,
      };

      const result = normalizeProperties({ p: value, q: 3 });

      expect(result.values).toEqual({ p: { before: 1, after: 2 }, q: 3 });
      expect(result.problems).toEqual([{ kind: 'unreadable', path: 'p.secret' }]);
    });

    it('a top-level getter that throws drops only its key', () => {
      const value = {
        get p(): unknown {
          throw new Error('secret text');
        },
        q: 1,
      };

      expect(normalizeProperties(value)).toEqual({
        values: { q: 1 },
        problems: [{ kind: 'unreadable', path: 'p' }],
        oversize: false,
      });
    });

    it('a list element whose getter throws drops only that element', () => {
      const array = [1, 2, 3];
      Object.defineProperty(array, 1, {
        get: () => {
          throw new Error('secret text');
        },
      });

      const result = normalizeProperties({ p: array });

      expect(result.values).toEqual({ p: [1, 3] });
      expect(result.problems).toEqual([{ kind: 'unreadable', path: 'p[1]' }]);
    });

    it('a Proxy whose get trap throws drops its keys', () => {
      const proxy = new Proxy(
        { a: 1, b: 2 },
        {
          get: (target, key) => {
            if (key === 'a') throw new Error('secret text');
            return Reflect.get(target, key) as unknown;
          },
        },
      );

      const result = normalizeProperties({ p: proxy });

      expect(result.values).toEqual({ p: { b: 2 } });
      expect(result.problems).toEqual([{ kind: 'unreadable', path: 'p.a' }]);
    });

    it('a Proxy whose traps throw on every access drops the whole value', () => {
      const hostile = new Proxy(
        {},
        {
          get: () => {
            throw new Error('secret text');
          },
          ownKeys: () => {
            throw new Error('secret text');
          },
          getPrototypeOf: () => {
            throw new Error('secret text');
          },
        },
      );
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();

      const result = normalizeProperties({ hostile, revoked: revocable.proxy, kept: 1 });

      expect(result.values).toEqual({ kept: 1 });
      expect(result.problems).toEqual([
        { kind: 'unreadable', path: 'hostile' },
        { kind: 'unreadable', path: 'revoked' },
      ]);
    });

    it('a Proxy that throws as the properties themselves gives no properties', () => {
      const hostile = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('secret text');
          },
        },
      );

      expect(normalizeProperties(hostile)).toEqual({
        values: {},
        problems: [{ kind: 'unreadable', path: '' }],
        oversize: false,
      });
    });

    it('a Proxy that reads fine is copied as its target', () => {
      expectKept(new Proxy({ a: [1] }, {}), { a: [1] });
      expectKept(new Proxy([1, 2], {}), [1, 2]);
    });
  });

  describe('19. a URL', () => {
    it('is its href', () => {
      expectKept(new URL('https://a.com/b'), 'https://a.com/b');
      expectKept(new URL('HTTPS://A.com/b/../c?q=1#f'), 'https://a.com/c?q=1#f');
    });
  });

  describe('20. any other object with a toJSON', () => {
    it('is unsupported, and its toJSON is never run', () => {
      let calls = 0;
      class Decimal {
        toJSON(): string {
          calls += 1;
          return '19.99';
        }
      }

      expectDropped(new Decimal(), 'unsupported-type', 'Decimal');
      expect(calls).toBe(0);
    });
  });

  describe('21. class instances, Error, RegExp, Promise, functions and Symbol', () => {
    it('are unsupported, named by their type and never by their value', () => {
      expectDropped(new Order('secret'), 'unsupported-type', 'Order');
      expectDropped(new Error('secret'), 'unsupported-type', 'Error');
      expectDropped(new TypeError('secret'), 'unsupported-type', 'Error');
      expectDropped(/secret/, 'unsupported-type', 'RegExp');
      expectDropped(Promise.resolve('secret'), 'unsupported-type', 'Promise');
      expectDropped(() => 'secret', 'unsupported-type', 'function');
      expectDropped(
        function secret() {
          return 1;
        },
        'unsupported-type',
        'function',
      );
      expectDropped(Symbol('secret'), 'unsupported-type', 'symbol');
      expectDropped(new WeakMap(), 'unsupported-type', 'WeakMap');
    });

    it('a tag or a class name that is not an identifier is not written', () => {
      class Tagged {
        get [Symbol.toStringTag](): string {
          return 'secret value';
        }
      }
      expectDropped(new Tagged(), 'unsupported-type', 'Tagged');
      const Named = {
        'secret value': class {
          readonly field = 1;
        },
      }['secret value'];

      expectDropped(new Named(), 'unsupported-type', 'Object');
    });
  });

  describe('22. blank keys, lengths, depth and cycles', () => {
    it('follow the Android rules (the describes below)', () => {
      expect(normalizeProperties({ '': 1 }).problems).toEqual([{ kind: 'invalid-key', path: '', type: 'blank' }]);
    });
  });
});

describe('values from another realm (Web Serialization 2: Object.prototype.toString, never instanceof)', () => {
  it('are converted by the same rows', () => {
    const values = foreign(`({
      date: new Date(0),
      invalidDate: new Date(NaN),
      map: new Map([['k', [1]]]),
      set: new Set(['a']),
      array: [1, , 3],
      typed: new Uint8Array([7]),
      object: { a: { b: 1 } },
      nullPrototype: Object.create(null),
      number: new Number(5),
      string: new String('s'),
      boolean: new Boolean(true),
      big: Object(BigInt(7)),
      error: new Error('secret'),
      instance: new (class Order {})(),
      regexp: /secret/,
    })`) as Record<string, unknown>;
    expect(values.object).not.toBeInstanceOf(Object);
    expect(values.date).not.toBeInstanceOf(Date);

    const result = normalizeProperties(values);

    expect(result.values).toEqual({
      date: '1970-01-01T00:00:00.000Z',
      map: { k: [1] },
      set: ['a'],
      array: [1, null, 3],
      typed: [7],
      object: { a: { b: 1 } },
      nullPrototype: {},
      number: 5,
      string: 's',
      boolean: true,
      big: 7,
    });
    expect(result.problems).toEqual([
      { kind: 'out-of-range', path: 'invalidDate', type: 'Date' },
      { kind: 'unsupported-type', path: 'error', type: 'Error' },
      { kind: 'unsupported-type', path: 'instance', type: 'Order' },
      { kind: 'unsupported-type', path: 'regexp', type: 'RegExp' },
    ]);
    // The copy is made of this realm's objects.
    expect(result.values.object).toBeInstanceOf(Object);
  });

  it('the properties themselves may come from another realm', () => {
    expect(normalizeProperties(foreign('({ a: 1 })')).values).toEqual({ a: 1 });
    expect(normalizeProperties(foreign("new Map([['a', 1]])")).values).toEqual({ a: 1 });
  });
});

describe('the properties argument', () => {
  it('undefined gives no properties and no problem', () => {
    expect(normalizeProperties(undefined)).toEqual({ values: {}, problems: [], oversize: false });
  });

  it('a Map with string keys is accepted as an object', () => {
    expect(normalizeProperties(new Map([['a', 1]]))).toEqual({ values: { a: 1 }, problems: [], oversize: false });
  });

  it('anything else gives no properties and one problem naming its type; the event is kept', () => {
    const cases: [unknown, string][] = [
      [null, 'null'],
      ['secret', 'string'],
      [5, 'number'],
      [[1, 2], 'Array'],
      [new Date(0), 'Date'],
      [new Set([1]), 'Set'],
      [new Order('secret'), 'Order'],
    ];
    for (const [input, type] of cases) {
      expect(normalizeProperties(input)).toEqual({
        values: {},
        problems: [{ kind: 'unsupported-type', path: '', type }],
        oversize: false,
      });
    }
  });
});

// The JavaScriptCore cases of Web Public API 4 (measured on 2026-10-12), with what the SDK sends
// instead of what JSON.stringify would.
describe('the JavaScriptCore cases of Web Public API 4', () => {
  it('undefined, a function, NaN, Infinity, a BigInt, a Date, 1.0 and nested arrays with holes', () => {
    const result = normalizeProperties({
      absent: undefined,
      callback: () => 1,
      nan: NaN,
      infinity: Infinity,
      count: bigint('42'),
      huge: bigint('18446744073709551616'),
      at: new Date(Date.UTC(2026, 9, 12, 8)),
      price: 1.0,
      // eslint-disable-next-line no-sparse-arrays -- the holes are the case
      grid: [[1, , 3], [, 2], []],
    });

    expect(write(result.values)).toBe(
      '{"count":42,"at":"2026-10-12T08:00:00.000Z","price":1,"grid":[[1,null,3],[null,2],[]]}',
    );
    expect(result.problems).toEqual([
      { kind: 'unsupported-type', path: 'callback', type: 'function' },
      { kind: 'not-finite', path: 'nan', type: 'number' },
      { kind: 'not-finite', path: 'infinity', type: 'number' },
      { kind: 'out-of-range', path: 'huge', type: 'bigint' },
    ]);
  });
});

describe('nested values', () => {
  it('a bad element drops only that element', () => {
    const result = normalizeProperties({ list: [1, new Order('x'), 3, NaN] });

    expect(result.values).toEqual({ list: [1, 3] });
    expect(result.problems.map((problem) => problem.path)).toEqual(['list[1]', 'list[3]']);
  });

  it('paths name nested keys and positions', () => {
    const result = normalizeProperties({ cart: { items: [{ sku: 'A1' }, { sku: new Order('x') }] } });

    expect(result.problems.map((problem) => problem.path)).toEqual(['cart.items[1].sku']);
    expect(result.values).toEqual({ cart: { items: [{ sku: 'A1' }, {}] } });
  });

  it('a nested entry with a key that is not a string is dropped', () => {
    const result = normalizeProperties({
      m: new Map<unknown, unknown>([
        [1, 'a'],
        ['b', 2],
      ]),
    });

    expect(result.values).toEqual({ m: { b: 2 } });
    expect(result.problems).toEqual([{ kind: 'invalid-key', path: 'm', type: 'number' }]);
  });
});

describe('property keys', () => {
  it('a blank key is dropped', () => {
    const result = normalizeProperties({ '': 1, '  ': 2, '\t\n': 3, '\u00a0': 4, ok: 5 });

    expect(result.values).toEqual({ ok: 5 });
    expect(result.problems.map((problem) => problem.kind)).toEqual([
      'invalid-key',
      'invalid-key',
      'invalid-key',
      'invalid-key',
    ]);
  });

  it('a key of 255 code units is kept, 256 is dropped', () => {
    const key254 = 'k'.repeat(254);
    const key255 = 'k'.repeat(255);
    const key256 = 'k'.repeat(256);

    const result = normalizeProperties({ [key254]: 1, [key255]: 2, [key256]: 3 });

    expect(Object.keys(result.values)).toEqual([key254, key255]);
    expect(result.problems).toEqual([{ kind: 'invalid-key', path: '', type: '256 characters' }]);
  });

  it("a key is counted in UTF-16 code units, as Kotlin's length", () => {
    const emoji127 = '😀'.repeat(127) + 'a';
    const emoji128 = '😀'.repeat(128);

    expect(Object.keys(normalizeProperties({ [emoji127]: 1, [emoji128]: 2 }).values)).toEqual([emoji127]);
  });

  it('keys are never trimmed', () => {
    expect(Object.keys(normalizeProperties({ ' padded ': 1 }).values)).toEqual([' padded ']);
  });

  it('a lone surrogate in a key becomes U+FFFD, so none reaches the writer (Web Serialization 1)', () => {
    const result = normalizeProperties({ 'a\uD800': 1, nested: { '\uDC00b': 2 } });

    expect(result.values).toEqual({ 'a\uFFFD': 1, nested: { '\uFFFDb': 2 } });
    expect(result.problems).toEqual([]);
    write(result.values);
  });

  it('a key that is not a string is dropped (a Map at the top level)', () => {
    const result = normalizeProperties(
      new Map<unknown, unknown>([
        [1, 'a'],
        [null, 'b'],
        ['ok', 'c'],
      ]),
    );

    expect(result.values).toEqual({ ok: 'c' });
    expect(result.problems.map((problem) => problem.type)).toEqual(['number', 'null']);
  });
});

describe('string values', () => {
  it('1023 and 1024 code units are kept, 1025 are cut to 1024 without a marker', () => {
    expectKept('a'.repeat(1023), 'a'.repeat(1023));
    expectKept('a'.repeat(1024), 'a'.repeat(1024));

    const result = normalizeProperties({ p: 'a'.repeat(1025) });

    expect(result.values.p).toBe('a'.repeat(1024));
    expect(result.problems).toEqual([{ kind: 'truncated', path: 'p', type: 'string' }]);
  });

  it('truncation never splits a surrogate pair', () => {
    const text = 'a'.repeat(1023) + '😀' + 'b';

    expect(normalizeProperties({ p: text }).values.p).toBe('a'.repeat(1023));
    expect(normalizeProperties({ p: 'a'.repeat(1022) + '😀' + 'b' }).values.p).toBe('a'.repeat(1022) + '😀');
  });

  it('unpaired surrogates become U+FFFD, pairs are kept', () => {
    expectKept('a\uD800b', 'a\uFFFDb');
    expectKept('\uDC00x', '\uFFFDx');
    expectKept('x\uD83D', 'x\uFFFD');
    expectKept('😀 ok', '😀 ok');
    expectKept('\uDC00\uD800', '\uFFFD\uFFFD');
    expectKept('\uD800😀', '\uFFFD😀');
  });

  it('a URL and a boxed string are cut like any string', () => {
    const long = `https://a.com/${'p'.repeat(2000)}`;

    expect(normalizeProperties({ p: new URL(long) }).values.p).toBe(long.slice(0, 1024));
    expect(normalizeProperties({ p: new String('s'.repeat(1025)) }).values.p).toBe('s'.repeat(1024));
  });

  it('replaceLoneSurrogates keeps the length and returns the same string when nothing changes', () => {
    const clean = 'abc😀';

    expect(replaceLoneSurrogates(clean)).toBe(clean);
    expect(replaceLoneSurrogates('\uD800\uD800\uDC00').length).toBe(3);
  });
});

describe('nesting depth', () => {
  it('three levels of nesting are allowed, the fourth is dropped', () => {
    const three = { cart: { items: [{ sku: 'A1', qty: 2 }] } };
    // Four containers: a, b and c are levels 1 to 3, d would be level 4.
    const four = { a: { b: { c: { d: { e: 1 } } }, keep: 1 } };

    expect(normalizeProperties(three).values).toEqual(three);
    const result = normalizeProperties(four);
    expect(result.values).toEqual({ a: { b: { c: {} }, keep: 1 } });
    expect(result.problems).toEqual([{ kind: 'too-deep', path: 'a.b.c.d', type: 'Object' }]);
  });

  it('every container counts a level: Map, Set and typed arrays included', () => {
    const result = normalizeProperties({
      a: [new Map([['b', new Set([new Uint8Array([1]), 2])]])],
    });

    expect(result.values).toEqual({ a: [{ b: [2] }] });
    expect(result.problems).toEqual([{ kind: 'too-deep', path: 'a[0].b[0]', type: 'Uint8Array' }]);
  });

  it('values that are not containers are fine at any level', () => {
    expectKept([[[1, 'a', null, new Date(0)]]], [[[1, 'a', null, '1970-01-01T00:00:00.000Z']]]);
  });

  it('an object that contains itself stops at the depth limit', () => {
    const loop: Record<string, unknown> = { n: 1 };
    loop.self = loop;

    const result = normalizeProperties({ loop });

    expect(result.problems).toEqual([{ kind: 'too-deep', path: 'loop.self.self.self', type: 'Object' }]);
    expect(depthOf(result.values.loop)).toBe(3);
    write(result.values);
  });

  it('a list and a Map that contain themselves stop at the depth limit', () => {
    const list: unknown[] = [];
    list.push(list);
    const map = new Map<string, unknown>();
    map.set('self', map);

    const result = normalizeProperties({ list, map });

    expect(result.problems.map((problem) => problem.kind)).toEqual(['too-deep', 'too-deep']);
  });
});

function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (typeof value === 'object' && value !== null) return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  return 0;
}

describe('property count', () => {
  function properties(count: number, prefix = 'p'): Record<string, PropertyValue> {
    const result: Record<string, PropertyValue> = {};
    for (let i = 1; i <= count; i += 1) result[`${prefix}${String(i)}`] = i;
    return result;
  }

  it('255 and 256 properties are kept, the 257th is dropped', () => {
    expect(Object.keys(normalizeProperties(properties(255)).values)).toHaveLength(255);
    expect(normalizeProperties(properties(256)).problems).toEqual([]);

    const result = normalizeProperties(properties(257));

    expect(Object.keys(result.values)).toHaveLength(256);
    expect(result.values).not.toHaveProperty('p257');
    expect(result.problems).toEqual([{ kind: 'too-many', path: '', count: 1 }]);
  });

  it('dropped values take no room', () => {
    const input: Record<string, unknown> = { bad: NaN, ...properties(256) };

    const result = normalizeProperties(input);

    expect(Object.keys(result.values)).toHaveLength(256);
    expect(result.problems.map((problem) => problem.kind)).toEqual(['not-finite']);
  });

  it("super properties merge in and the event's own key wins", () => {
    const merged = mergeSuperProperties({ plan: 'event', a: 1 }, { plan: 'super', b: 2 });

    expect(merged.values).toEqual({ plan: 'event', a: 1, b: 2 });
    expect(merged.problems).toEqual([]);
  });

  it('above 256, super properties are dropped first', () => {
    const merged = mergeSuperProperties(properties(250), properties(10, 's'));

    expect(Object.keys(merged.values)).toHaveLength(256);
    expect(Object.keys(merged.values)).toEqual(expect.arrayContaining(Object.keys(properties(250))));
    expect(merged.values).toHaveProperty('s6');
    expect(merged.values).not.toHaveProperty('s7');
    expect(merged.problems).toEqual([{ kind: 'too-many', path: '', count: 4 }]);
  });

  it('256 own properties leave no room for super properties', () => {
    const merged = mergeSuperProperties(properties(256), { p1: 'super', s: 1 });

    expect(merged.values).toEqual(properties(256));
    expect(merged.problems).toEqual([{ kind: 'too-many', path: '', count: 1 }]);
  });

  it('a super property named __proto__ stays a key', () => {
    const superProperties = JSON.parse('{"__proto__":1}') as Record<string, PropertyValue>;

    expect(Object.keys(mergeSuperProperties({ a: 1 }, superProperties).values)).toEqual(['__proto__', 'a']);
  });
});

describe('event names', () => {
  it('a name of 1 to 255 code units is valid and never trimmed', () => {
    expect(checkName('a')).toEqual({ valid: true, name: 'a' });
    expect(checkName(' Purchase Completed ')).toEqual({ valid: true, name: ' Purchase Completed ' });
    expect(checkName('n'.repeat(255))).toEqual({ valid: true, name: 'n'.repeat(255) });
  });

  it('a blank name, one of 256 code units or one that is not a string is invalid', () => {
    for (const name of ['', '   ', '\u00a0', 'n'.repeat(256), undefined, null, 5, {}]) {
      expect(checkName(name)).toEqual({ valid: false, problem: { kind: 'invalid-name', path: '' } });
    }
  });

  it('a lone surrogate in a name becomes U+FFFD', () => {
    expect(checkName('a\uD800')).toEqual({ valid: true, name: 'a\uFFFD' });
  });
});

describe('the event size (32 KB of UTF-8, Serialization 3)', () => {
  it('exactly 32 KB is kept, one byte more is over', () => {
    expect(MAX_EVENT_BYTES).toBe(32_768);
    expect(isOversizeLine('a'.repeat(32_768))).toBe(false);
    expect(isOversizeLine('a'.repeat(32_769))).toBe(true);
  });

  it('is measured in UTF-8 bytes, not code units', () => {
    // 10 922 three-byte characters are 32 766 bytes.
    expect(isOversizeLine('日'.repeat(10_922) + 'ab')).toBe(false);
    expect(isOversizeLine('日'.repeat(10_922) + 'abc')).toBe(true);
    // A surrogate pair is four bytes: 8192 of them are exactly 32 KB.
    expect(isOversizeLine('😀'.repeat(8192))).toBe(false);
    expect(isOversizeLine('😀'.repeat(8192) + 'a')).toBe(true);
  });
});

// The user's decision of 2026-10-15 (section 15, step 2.5), a web difference from Android: the walk
// stops once the JSON of what it copied is certainly over 32 KB, so `track('x', { a: new Array(1e9) })`
// returns at once, and the writer's `oversize` decision is the one the whole walk would give. The
// whole walk is `normalizeProperties(input, Infinity)`. Elements are counted through `Proxy` traps
// and getters, never by the clock.
describe('the walk stops past the event size (section 15, step 2.5, 2026-10-15)', () => {
  // An array whose element reads are counted: `Array.isArray` sees through a `Proxy`.
  function counted<T>(array: T[]): { array: T[]; reads: () => number } {
    let reads = 0;
    const proxy = new Proxy(array, {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { array: proxy, reads: () => reads };
  }

  // A plain object whose `v` getter counts its reads.
  function element(i: number, visits: { count: number }): Record<string, unknown> {
    return {
      get v(): number {
        visits.count += 1;
        return i;
      },
    };
  }

  // The line an event with these properties would at least be.
  function lineOf(values: Record<string, PropertyValue>): string {
    return writeJson({ type: 'track', event: 'x', properties: values });
  }

  // `{"l":[...]}` whose JSON is exactly `bytes` long, of ASCII strings without escapes.
  function sized(bytes: number): Record<string, unknown> {
    const list = Array.from({ length: 32 }, () => 'x'.repeat(1000));
    list.push('');
    const rest = bytes - writeJson({ l: list }).length;
    list[32] = 'x'.repeat(rest);
    const input = { l: list };
    expect(writeJson(input).length).toBe(bytes);
    return input;
  }

  it('a sparse array of a billion elements is read only up to the limit', () => {
    const { array, reads } = counted(new Array<unknown>(1e9));

    const result = normalizeProperties({ a: array, after: 1 });

    expect(result.oversize).toBe(true);
    const copied = result.values.a as PropertyValue[];
    expect(reads()).toBe(copied.length);
    expect(reads()).toBeLessThan(7000);
    expect(result.values).not.toHaveProperty('after');
    expect(result.problems).toEqual([]);
    // The copy is itself over the limit, so the writer's scan alone drops it, and so does a second pass.
    const length = utf8ByteLength(writeJson(result.values));
    expect(length).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(length).toBeLessThan(MAX_EVENT_BYTES + 16);
    expect(normalizeProperties(result.values).oversize).toBe(true);
  });

  it('a plain new Array(1e9) returns', () => {
    const result = normalizeProperties({ a: new Array(1e9) });

    expect(result.oversize).toBe(true);
    expect(isOversizeLine(lineOf(result.values))).toBe(true);
  });

  it('a huge sparse array nested in an object and a list stops every level above it', () => {
    const { array, reads } = counted(new Array<unknown>(1e9));

    const result = normalizeProperties({ a: { b: [1, array, 2], c: 3 }, d: 4 });

    expect(result.oversize).toBe(true);
    expect(reads()).toBeLessThan(7000);
    const b = (result.values.a as Record<string, PropertyValue>).b as PropertyValue[];
    expect(b).toHaveLength(2);
    expect(b[0]).toBe(1);
    expect(result.values.a).not.toHaveProperty('c');
    expect(result.values).not.toHaveProperty('d');
  });

  it('a huge Set and a huge Map are walked only up to the limit', () => {
    const size = 200_000;
    const setVisits = { count: 0 };
    const set = new Set(Array.from({ length: size }, (_, i) => element(i, setVisits)));
    const mapVisits = { count: 0 };
    const map = new Map(Array.from({ length: size }, (_, i) => [`k${String(i)}`, element(i, mapVisits)]));

    const fromSet = normalizeProperties({ s: set });
    const fromMap = normalizeProperties({ m: map });

    expect(fromSet.oversize).toBe(true);
    expect(setVisits.count).toBe((fromSet.values.s as PropertyValue[]).length);
    expect(setVisits.count).toBeLessThan(5000);
    expect(fromMap.oversize).toBe(true);
    expect(mapVisits.count).toBe(Object.keys(fromMap.values.m as object).length);
    expect(mapVisits.count).toBeLessThan(5000);
  });

  it('a huge typed array is walked only up to the limit', () => {
    const result = normalizeProperties({ t: new Uint8Array(1e7) });

    expect(result.oversize).toBe(true);
    expect((result.values.t as PropertyValue[]).length).toBeLessThan(17_000);
  });

  it('properties of exactly 32 KB are walked whole and not flagged; one byte more is flagged', () => {
    const exact = sized(MAX_EVENT_BYTES);
    expect(normalizeProperties(exact)).toEqual({ values: exact, problems: [], oversize: false });

    const over = sized(MAX_EVENT_BYTES + 1);
    expect(normalizeProperties(over)).toEqual({ values: over, problems: [], oversize: true });
    expect(normalizeProperties({ ...over, after: 1 }).values).toEqual(over);
  });

  it('the size is counted in UTF-8 bytes', () => {
    // 10 921 three-byte characters in strings of at most 1024 code units.
    const strings = Array.from({ length: 11 }, () => '日'.repeat(1000));
    strings[10] = '日'.repeat(921);
    const input = { l: strings };
    const bytes = utf8ByteLength(writeJson(input));

    expect(normalizeProperties(input).oversize).toBe(bytes > MAX_EVENT_BYTES);
    expect(normalizeProperties(input, bytes - 1).oversize).toBe(true);
    expect(normalizeProperties(input, bytes).oversize).toBe(false);
  });

  it('a value that a later key replaces is not counted, so the decision stays the one of the whole walk', () => {
    const big = Array.from({ length: 40 }, () => 'x'.repeat(1000));
    const replaced = { '\uD800': big, '�': 1 };
    const map = new Map<string, unknown>([
      ['\uDC00', big],
      ['�', 2],
    ]);

    expect(normalizeProperties(replaced)).toEqual({ values: { '�': 1 }, problems: [], oversize: false });
    expect(normalizeProperties({ m: map })).toEqual({ values: { m: { '�': 2 } }, problems: [], oversize: false });
    expect(normalizeProperties({ '\uD800': 1, '�': big }).oversize).toBe(true);
  });

  it('problems are reported up to the stop', () => {
    const result = normalizeProperties({ a: NaN, big: new Array(1e9), c: NaN });

    expect(result.oversize).toBe(true);
    expect(result.problems).toEqual([{ kind: 'not-finite', path: 'a', type: 'number' }]);
  });

  it('seeded random inputs around the limit: the same decision as the whole walk, the same result below it', () => {
    const random = new SeededRandom(3215);
    let over = 0;
    let under = 0;
    for (let i = 0; i < 300; i += 1) {
      const input = sizedRandomObject(random);
      const early = normalizeProperties(input);
      const whole = normalizeProperties(input, Infinity);

      const wholeOver = isOversizeLine(lineOf(whole.values));
      expect(isOversizeLine(lineOf(early.values))).toBe(wholeOver);
      if (early.oversize) {
        expect(wholeOver).toBe(true);
        expect(utf8ByteLength(writeJson(whole.values))).toBeGreaterThan(MAX_EVENT_BYTES);
        over += 1;
      } else {
        expect(early).toEqual(whole);
        under += 1;
      }
    }
    expect(over).toBeGreaterThan(50);
    expect(under).toBeGreaterThan(50);
  });
});

// A top-level object whose JSON is roughly 8 KB to 64 KB: lists of strings with multi-byte
// characters, escapes and lone surrogates, numbers, nested objects, sets, maps, sparse arrays, dropped
// values, and keys that become equal once their lone surrogates are replaced.
function sizedRandomObject(random: SeededRandom): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  const target = 8000 + below(random, 56_000);
  let size = 0;
  while (size < target) {
    const key = below(random, 8) === 0 ? ['\uD800', '�', '\uDC00x', '�x'][below(random, 4)] : `k${String(size)}`;
    const [value, bytes] = sizedRandomValue(random, Math.min(target - size + 100, 20_000), 1);
    Object.defineProperty(object, key as string, { value, enumerable: true, writable: true, configurable: true });
    size += bytes;
  }
  return object;
}

function sizedRandomValue(random: SeededRandom, budget: number, depth: number): [unknown, number] {
  const pieces = ['a', 'é', '日', '😀', '"', '\\', '\n', '\u0001', '\uD800'];
  const text = (): string => {
    let value = '';
    for (let n = 1 + below(random, 300); n > 0; n -= 1) value += pieces[below(random, pieces.length)] ?? '';
    return value;
  };
  const kind = depth >= 3 ? below(random, 3) : below(random, 8);
  switch (kind) {
    case 0:
      return [text(), 400];
    case 1:
      return [random.nextUint32() / 7, 18];
    case 2:
      return [[NaN, undefined, () => 1, null][below(random, 4)], 4];
    case 3: {
      const list: unknown[] = [];
      let used = 0;
      while (used < budget) {
        const [element, bytes] = sizedRandomValue(random, budget / 4, depth + 1);
        list.push(element);
        used += bytes + 1;
      }
      return [list, used];
    }
    case 4: {
      const object: Record<string, unknown> = {};
      let used = 0;
      for (let n = 0; used < budget; n += 1) {
        const [element, bytes] = sizedRandomValue(random, budget / 4, depth + 1);
        object[below(random, 6) === 0 ? '\uDBFF' : `n${String(n)}`] = element;
        used += bytes + 6;
      }
      return [object, used];
    }
    case 5: {
      const [list, bytes] = sizedRandomValue(random, budget, 3);
      return [Array.isArray(list) ? new Set(list) : new Set([list]), bytes];
    }
    case 6: {
      const map = new Map<string, unknown>();
      let used = 0;
      for (let n = 0; used < budget; n += 1) {
        const [element, bytes] = sizedRandomValue(random, budget / 4, depth + 1);
        map.set(below(random, 6) === 0 ? '\uDFFF' : `m${String(n)}`, element);
        used += bytes + 6;
      }
      return [map, used];
    }
    default: {
      const sparse = new Array<unknown>(Math.max(1, Math.floor(budget / 5)));
      sparse[below(random, sparse.length)] = text();
      return [sparse, budget];
    }
  }
}

describe('deep copies', () => {
  it("changing the caller's objects afterwards changes nothing", () => {
    const tags = ['a'];
    const nested: Record<string, unknown> = { tags };
    const map = new Map([['k', 1]]);
    const input: Record<string, unknown> = { nested, map, n: 1 };

    const result = normalizeProperties(input);
    input.n = 2;
    nested.extra = true;
    tags.push('b');
    map.set('k', 2);

    expect(result.values).toEqual({ nested: { tags: ['a'] }, map: { k: 1 }, n: 1 });
    expect((result.values.nested as Record<string, unknown>).tags).not.toBe(tags);
  });

  it('a list or object that is reused is copied at each place', () => {
    const shared = { a: 1 };

    const result = normalizeProperties({ x: shared, y: [shared] });

    expect(result.values).toEqual({ x: { a: 1 }, y: [{ a: 1 }] });
    expect(result.values.x).not.toBe((result.values.y as PropertyValue[])[0]);
  });
});

describe('the second pass, after the hooks (Event Model 3)', () => {
  it('normalized values pass again unchanged and without a problem', () => {
    const first = normalizeProperties({
      cart: { items: [{ sku: 'A1', qty: 2 }] },
      at: new Date(0),
      tags: new Set(['a']),
      long: 'x'.repeat(2000),
      text: 'a\uD800',
    });

    const second = normalizeProperties(first.values);

    expect(second).toEqual({ values: first.values, problems: [], oversize: false });
    expect(second.values).not.toBe(first.values);
  });

  it('what a hook put back is cleaned like a call', () => {
    const first = normalizeProperties({ a: 1 });
    const fromHook: Record<string, unknown> = { ...first.values, map: new Map([['k', NaN]]), fn: () => 1 };

    const second = normalizeProperties(fromHook);

    expect(second.values).toEqual({ a: 1, map: {} });
    expect(second.problems).toEqual([
      { kind: 'not-finite', path: 'map.k', type: 'number' },
      { kind: 'unsupported-type', path: 'fn', type: 'function' },
    ]);
  });
});

// Robustness (plan section 5): seeded random values of every kind the table names, hostile ones
// included, never make the normalizer throw; the result is a tree of PropertyValues with no lone
// surrogate, at most 3 levels deep, that Python parses (afterAll); no foreign method ran.
describe('seeded random values', () => {
  it('never make it throw and always give a valid tree', () => {
    const random = new SeededRandom(2025);
    const ran = { count: 0 };
    for (let i = 0; i < 3000; i += 1) {
      const input = randomObject(random, 0, ran);
      const result = normalizeProperties(below(random, 10) === 0 ? randomValue(random, 0, ran) : input);
      expectValidTree(result.values, 0);
      expect(Object.keys(result.values).length).toBeLessThanOrEqual(256);
      expectProblemsWithoutValues(result.problems);
      expect(normalizeProperties(result.values).problems).toEqual([]);
      write(result.values);
    }
    expect(ran.count).toBe(0);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function expectValidTree(value: unknown, depth: number): void {
  if (Array.isArray(value)) {
    expect(depth).toBeLessThan(4);
    for (const element of value) expectValidTree(element, depth + 1);
  } else if (typeof value === 'object' && value !== null) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(depth).toBeLessThan(4);
    for (const [key, element] of Object.entries(value)) {
      expect(LONE_SURROGATE.test(key)).toBe(false);
      expectValidTree(element, depth + 1);
    }
  } else if (typeof value === 'string') {
    expect(LONE_SURROGATE.test(value)).toBe(false);
    expect(value.length).toBeLessThanOrEqual(1024);
  } else if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
  } else {
    expect(value === null || typeof value === 'boolean').toBe(true);
  }
}

function expectProblemsWithoutValues(problems: readonly PropertyProblem[]): void {
  for (const problem of problems) expect(JSON.stringify(problem)).not.toContain(SECRET);
}

const SECRET = 'SECRET-VALUE';

function below(random: SeededRandom, n: number): number {
  return random.nextUint32() % n;
}

function randomString(random: SeededRandom, maxLength: number): string {
  let text = '';
  for (let i = below(random, maxLength); i > 0; i -= 1) text += String.fromCharCode(below(random, 0x10000));
  return text;
}

function randomKey(random: SeededRandom): unknown {
  switch (below(random, 10)) {
    case 0:
      return '';
    case 1:
      return 'k'.repeat(256);
    case 2:
      return '__proto__';
    default:
      return randomString(random, 6) + 'k';
  }
}

function randomObject(random: SeededRandom, depth: number, ran: { count: number }): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (let i = below(random, 8); i > 0; i -= 1) {
    const key = randomKey(random) as string;
    Object.defineProperty(object, key, {
      value: randomValue(random, depth, ran),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (depth > 0 && below(random, 20) === 0) object.self = object;
  return object;
}

function randomValue(random: SeededRandom, depth: number, ran: { count: number }): unknown {
  const sneaky = (): string => {
    ran.count += 1;
    return SECRET;
  };
  switch (below(random, 32)) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return below(random, 2) === 0;
    case 3:
      return random.nextUint32() - 0x8000_0000;
    case 4:
      return (random.nextUint32() / 7) * 10 ** (below(random, 60) - 30);
    case 5:
      return [NaN, Infinity, -Infinity, -0][below(random, 4)];
    case 6:
      return BigInt(random.nextUint32()) * BigInt(random.nextUint32()) * BigInt(below(random, 3) === 0 ? 1 : 1000);
    case 7:
      return new Date((random.nextUint32() - 0x8000_0000) * 1e5 * below(random, 5));
    case 8:
      return [new Number(random.nextUint32()), new String(SECRET), new Boolean(true)][below(random, 3)];
    case 9:
      return { [Symbol.toStringTag]: 'Temporal.PlainDate', toJSON: sneaky, toString: sneaky };
    case 10:
      return randomString(random, below(random, 4) === 0 ? 2000 : 12);
    case 11:
      return SECRET;
    case 12:
      return new Set([1, randomString(random, 4), undefined]);
    case 13:
      return new Map<unknown, unknown>([
        [randomKey(random), randomValue(random, depth + 1, ran)],
        [random.nextUint32(), SECRET],
      ]);
    case 14:
      return [new Uint8Array([1, 2]), new Float64Array([NaN, 1.5]), new BigInt64Array([BigInt(-1)])][below(random, 3)];
    case 15:
      return new Order(SECRET);
    case 16:
      return new Error(SECRET);
    case 17:
      return sneaky;
    case 18:
      return Symbol(SECRET);
    case 19:
      return {
        get secret(): unknown {
          throw new Error(SECRET);
        },
      };
    case 20:
      return new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error(SECRET);
          },
        },
      );
    case 21:
      return { toJSON: sneaky, valueOf: sneaky, [Symbol.toPrimitive]: sneaky, value: 1 };
    case 22:
      return new URL(`https://a.com/${randomString(random, 4)}`);
    case 23:
      return new ArrayBuffer(2);
    case 24:
      return foreign('({ a: [1, new Date(0)], b: new Map([["c", 1]]) })');
    case 25: {
      // eslint-disable-next-line no-sparse-arrays -- holes are a case
      const array: unknown[] = [, 1];
      array.length = below(random, 4);
      return array;
    }
    case 26:
    case 27:
      return Array.from({ length: below(random, 4) }, () => randomValue(random, depth + 1, ran));
    default:
      return depth < 6 ? randomObject(random, depth + 1, ran) : 'leaf';
  }
}
