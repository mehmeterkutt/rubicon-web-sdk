// The inputs of the conversion table of Web Serialization 2, row by row, and of its limits, built
// from the constructors of one realm: a page's window, an iframe's window, or Node's global object.
// `buildCases` is self-contained (no import, no outer name), because the serialization spec sends
// its source text into each engine and runs the same function in Node, so the four results come
// from the same inputs. The expectations of every row are the core's unit tests
// (packages/core/test/validation/property-normalizer.test.ts); this table proves the engines agree.

/** The constructors a case is built from. */
export interface Realm {
  readonly Object: ObjectConstructor;
  readonly Array: ArrayConstructor;
  readonly Date: DateConstructor;
  readonly Map: MapConstructor;
  readonly Set: SetConstructor;
  readonly Uint8Array: Uint8ArrayConstructor;
  readonly Float64Array: Float64ArrayConstructor;
  readonly BigInt64Array: BigInt64ArrayConstructor;
  readonly Number: NumberConstructor;
  readonly String: StringConstructor;
  readonly Boolean: BooleanConstructor;
  readonly Symbol: SymbolConstructor;
  readonly BigInt: (value: string) => bigint;
  readonly URL: typeof URL;
  readonly Error: ErrorConstructor;
  readonly RegExp: RegExpConstructor;
  readonly Promise: PromiseConstructor;
  readonly Proxy: ProxyConstructor;
  readonly ArrayBuffer: ArrayBufferConstructor;
  readonly DataView: DataViewConstructor;
  readonly Blob: typeof Blob;
  readonly JSON: JSON;
}

/** One row: the properties given to `track`. */
export interface SerializationCase {
  readonly name: string;
  readonly input: unknown;
}

export function buildCases(realm: Realm): SerializationCase[] {
  const cases: SerializationCase[] = [];
  const add = (name: string, input: unknown): void => {
    cases.push({ name, input });
  };
  const object = (entries: [string, unknown][]): Record<string, unknown> => {
    const value = new realm.Object() as Record<string, unknown>;
    for (const [key, item] of entries) value[key] = item;
    return value;
  };
  const list = (...items: unknown[]): unknown[] => realm.Array.from(items);
  const repeat = (text: string, count: number): string => new realm.Array(count + 1).join(text);
  class Order {
    secret = 'value';
  }
  class WithToJson {
    toJSON(): string {
      return 'ran';
    }
  }
  class Moment {
    _isAMomentObject = true;
  }

  // Rows 1 and 2: strings, booleans and null.
  add(
    '1 strings',
    object([
      ['plain', 'a'],
      ['empty', ''],
      ['unicode', '😀 ğ 日'],
      ['lone', 'a\uD800b\uDC00c'],
    ]),
  );
  add(
    '2 boolean and null',
    object([
      ['yes', true],
      ['no', false],
      ['nothing', null],
    ]),
  );
  // Rows 3 and 4: undefined is an absent key, null in a list; holes too.
  const sparse = new realm.Array(3);
  sparse[0] = 1;
  sparse[2] = 3;
  add(
    '3 undefined values',
    object([
      ['gone', undefined],
      [
        'nested',
        object([
          ['gone', undefined],
          ['kept', 1],
        ]),
      ],
    ]),
  );
  add(
    '4 undefined and holes in lists',
    object([
      ['list', list(1, undefined, 3)],
      ['sparse', sparse],
    ]),
  );
  // Rows 5 and 6: finite numbers as they are, NaN and the infinities unsupported.
  add(
    '5 finite numbers',
    object([
      ['half', 1.5],
      ['big', 1e21],
      ['unsafe', 2 ** 53 + 2],
      ['tiny', 1e-7],
      ['cents', 49.9],
      ['whole', 50.0],
      ['negativeZero', -0],
    ]),
  );
  add(
    '6 NaN and infinities',
    object([
      ['nan', NaN],
      ['up', Infinity],
      ['down', -Infinity],
      ['kept', 1],
    ]),
  );
  // Row 7: BigInt within the safe range, beyond it unsupported.
  add(
    '7 BigInt',
    object([
      ['safe', realm.BigInt('123')],
      ['unsafe', realm.BigInt('9007199254740993')],
    ]),
  );
  // Row 8: boxed primitives.
  add(
    '8 boxed primitives',
    object([
      ['number', new realm.Number(5)],
      ['string', new realm.String('a')],
      ['boolean', new realm.Boolean(false)],
      ['symbol', realm.Object(realm.Symbol('s'))],
      ['bigint', realm.Object(realm.BigInt('7'))],
    ]),
  );
  // Rows 9 and 10: dates.
  add(
    '9 valid dates',
    object([
      ['now', new realm.Date(Date.UTC(2026, 9, 14, 8))],
      ['epoch', new realm.Date(0)],
      ['first', new realm.Date(-62167219200000)],
      ['last', new realm.Date(253402300799999)],
    ]),
  );
  add(
    '10 invalid dates',
    object([
      ['invalid', new realm.Date(NaN)],
      ['before', new realm.Date(-62167219200001)],
      ['after', new realm.Date(253402300800000)],
    ]),
  );
  // Row 11: date-library objects, with the hint.
  add(
    '11 date libraries',
    object([
      ['moment', new Moment()],
      ['plain', object([['_isAMomentObject', true]])],
    ]),
  );
  // Rows 12 to 15: lists, sets, maps and typed arrays.
  const withExtra = list(1, 2) as unknown[] & { extra?: string };
  withExtra.extra = 'ignored';
  add(
    '12 arrays',
    object([
      ['list', list(1, 'two', null)],
      ['extra', withExtra],
    ]),
  );
  add('13 sets', object([['set', new realm.Set(['a', 'b', 'a'])]]));
  add(
    '14 maps',
    object([
      [
        'map',
        new realm.Map<unknown, unknown>([
          ['k', 1],
          ['nested', new realm.Map([['x', true]])],
        ]),
      ],
      [
        'mixed',
        new realm.Map<unknown, unknown>([
          ['ok', 1],
          [2, 'number key'],
        ]),
      ],
    ]),
  );
  add(
    '15 typed arrays',
    object([
      ['bytes', new realm.Uint8Array([1, 2, 255])],
      ['doubles', new realm.Float64Array([1.5, NaN, 3])],
      ['bigints', new realm.BigInt64Array([realm.BigInt('1'), realm.BigInt('-9223372036854775808')])],
    ]),
  );
  // Row 16: binary containers.
  add(
    '16 binary',
    object([
      ['buffer', new realm.ArrayBuffer(4)],
      ['view', new realm.DataView(new realm.ArrayBuffer(4))],
      ['blob', new realm.Blob(['x'])],
      ['kept', 1],
    ]),
  );
  // Row 17: plain objects, a null prototype, a `__proto__` key, an own toJSON.
  const nullPrototype = realm.Object.create(null) as Record<string, unknown>;
  nullPrototype.a = 1;
  add(
    '17 plain objects',
    object([
      [
        'plain',
        object([
          ['a', 1],
          ['b', object([['c', 'd']])],
        ]),
      ],
      ['nullPrototype', nullPrototype],
      ['proto', realm.JSON.parse('{"__proto__":1,"x":2}')],
      [
        'ownToJson',
        object([
          ['toJSON', () => 'ran'],
          ['kept', 1],
        ]),
      ],
    ]),
  );
  // Row 18: a getter or a Proxy trap that throws.
  const getter = new realm.Object() as Record<string, unknown>;
  realm.Object.defineProperty(getter, 'bad', {
    enumerable: true,
    get: () => {
      throw new realm.Error('secret');
    },
  });
  getter.good = 1;
  const trap = new realm.Proxy(object([['a', 1]]), {
    get: () => {
      throw new realm.Error('secret');
    },
  });
  add(
    '18 throwing reads',
    object([
      ['getter', getter],
      ['proxy', trap],
      ['kept', 1],
    ]),
  );
  // Rows 19 to 21: URL, foreign toJSON, class instances and the rest.
  add('19 URL', object([['url', new realm.URL('https://a.com/b?q=1#f')]]));
  add(
    '20 foreign toJSON',
    object([
      ['custom', new WithToJson()],
      ['kept', 1],
    ]),
  );
  add(
    '21 unsupported objects',
    object([
      ['order', new Order()],
      ['error', new realm.Error('secret')],
      ['regexp', new realm.RegExp('a')],
      ['promise', realm.Promise.resolve(1)],
      ['function', () => 1],
      ['symbol', realm.Symbol('s')],
      ['kept', 1],
    ]),
  );
  // Row 22 and the limits of Serialization 3: keys, lengths, depth, cycles, count.
  add(
    '22 keys',
    object([
      [repeat('k', 255), 1],
      [repeat('k', 256), 2],
      ['', 3],
      ['   ', 4],
      ['lone\uD800', 5],
    ]),
  );
  add(
    '22 string lengths',
    object([
      ['at', repeat('a', 1024)],
      ['over', repeat('a', 1025)],
      ['pair', `${repeat('a', 1023)}😀`],
    ]),
  );
  add(
    '22 depth',
    object([
      ['three', object([['b', object([['c', 1]])]])],
      ['four', list(list(list(list(1))))],
    ]),
  );
  const cycle = object([['name', 'loop']]);
  cycle.self = cycle;
  add('22 cycle', object([['cycle', cycle]]));
  const many: [string, unknown][] = [];
  for (let i = 0; i < 260; i += 1) many.push([`p${String(i)}`, i]);
  add('22 property count', object(many));
  // The event size: properties over 32 KB stop the walk and set `oversize`.
  add(
    '32 KB of properties',
    object([
      ['a', repeat('x', 1000)],
      ['b', realm.Array.from({ length: 40 }, () => repeat('y', 1000))],
    ]),
  );
  // The properties argument itself.
  add('arguments: a Map', new realm.Map([['a', 1]]));
  add('arguments: a list', list(1, 2));
  add('arguments: a string', 'text');
  return cases;
}
