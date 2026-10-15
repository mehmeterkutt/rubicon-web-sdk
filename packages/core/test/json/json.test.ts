import { readdirSync, readFileSync } from 'node:fs';
import { parseWithPython, SeededRandom } from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonObject, PropertyValue } from '../../src';
import {
  checkLine,
  jsonObjectFromEntries,
  mergeJsonObject,
  readJsonObject,
  replaceTopLevelString,
  utf8ByteLength,
  writeJson,
} from '../../src';

// The port of the Android JsonTest (Serialization 1, 5; Android log 2.4) for Web Serialization 1
// and 3: the writer is plain JSON.stringify, so the engine behaviours it relies on are pinned here,
// and every line this file writes is parsed again by Python with strict UTF-8 (afterAll).

const written: string[] = [];

function write(value: JsonObject): string {
  const line = writeJson(value);
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

// Structural comparison: key order, spacing and escaping are ignored.
function expectSameJson(actual: string, expected: string): void {
  expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
}

describe('writeJson', () => {
  it('writes null as JSON null', () => {
    expect(write({ coupon: null })).toBe('{"coupon":null}');
  });

  it('writes null inside nested objects and arrays', () => {
    expectSameJson(write({ a: { b: null }, c: [1, null] }), '{"a":{"b":null},"c":[1,null]}');
  });

  it('leaves out a key whose value is undefined, as an unset optional field', () => {
    expect(write({ a: 1, b: undefined, c: { d: undefined } })).toBe('{"a":1,"c":{}}');
  });

  it('writes every JSON type, compact', () => {
    const line = write({
      s: 'text',
      t: true,
      f: false,
      i: 7,
      l: 9_007_199_254_740_991,
      d: 1.5,
      n: null,
      list: ['a', 1, 2.5, false, null, [1], { k: 'v' }],
      map: { nested: { deep: [1, 2] } },
    });

    expectSameJson(
      line,
      '{"s":"text","t":true,"f":false,"i":7,"l":9007199254740991,"d":1.5,"n":null,' +
        '"list":["a",1,2.5,false,null,[1],{"k":"v"}],"map":{"nested":{"deep":[1,2]}}}',
    );
    expect(line).not.toMatch(/\s/);
  });

  it('writes an empty object, array and string', () => {
    expect(write({ m: {}, l: [], s: '' })).toBe('{"m":{},"l":[],"s":""}');
  });

  it('takes the PropertyValue tree of Web Public API 4 as it is', () => {
    const properties: Record<string, PropertyValue> = { cart: { items: [{ sku: 'A1', qty: 2 }] }, coupon: null };

    expect(write({ type: 'track', properties })).toBe(
      '{"type":"track","properties":{"cart":{"items":[{"sku":"A1","qty":2}]},"coupon":null}}',
    );
  });
});

// Each behaviour of the engine's JSON that the layer relies on or that the normalizer works around
// (Web Serialization 1); a different engine fails here. The three engines run them in step 8.1.
describe('the engine behaviours the layer relies on', () => {
  it('a whole-number double is written as an integer', () => {
    expect(write({ price: 50.0 })).toBe('{"price":50}');
  });

  it('a number is written as its shortest round-trip text', () => {
    expect(write({ price: 49.9, sum: 0.1 + 0.2 })).toBe('{"price":49.9,"sum":0.30000000000000004}');
  });

  it('a very large or small double uses exponent form, spelled 1e+21', () => {
    expect(write({ x: 1e21, y: 1e-7, z: 1.5e-7 })).toBe('{"x":1e+21,"y":1e-7,"z":1.5e-7}');
  });

  it('a number beyond the safe integer range is written as the double it is', () => {
    expect(write({ a: 2 ** 53 + 2, b: 1e20 })).toBe('{"a":9007199254740994,"b":100000000000000000000}');
  });

  it('minus zero is written as 0', () => {
    expect(write({ x: -0 })).toBe('{"x":0}');
  });

  it('NaN and Infinity are written as null without a word, which is why the normalizer drops them', () => {
    expect(write({ a: NaN, b: Infinity, c: [-Infinity] })).toBe('{"a":null,"b":null,"c":[null]}');
  });

  it('a slash is not escaped', () => {
    expect(write({ url: 'https://a.com/b' })).toBe('{"url":"https://a.com/b"}');
  });

  it('control characters are escaped, so a line never holds a raw line break; U+2028 and U+2029 are not', () => {
    const line = write({ s: 'a\nb\rc\td\u0000e\u001f  ' });

    expect(line).toBe('{"s":"a\\nb\\rc\\td\\u0000e\\u001f  "}');
    expect(line).not.toMatch(/[\n\r]/);
  });

  it('a lone surrogate is escaped by this engine; floor engines write it raw, so the normalizer replaces it', () => {
    expect(write({ s: 'a\ud800', t: '\udc00b' })).toBe('{"s":"a\\ud800","t":"\\udc00b"}');
  });

  it('integer-like keys come first, so nothing may depend on key order', () => {
    expect(write({ b: 1, 2: 2, a: 3, 1: 4 })).toBe('{"1":4,"2":2,"b":1,"a":3}');
  });

  it('the engine would lose a Map or Set, run toJSON and throw on a BigInt: values the normalizer never lets through', () => {
    expect(JSON.stringify({ m: new Map([['a', 1]]), s: new Set([1]) })).toBe('{"m":{},"s":{}}');
    expect(JSON.stringify({ d: { toJSON: () => 'ran' } })).toBe('{"d":"ran"}');
    expect(() => JSON.stringify({ b: BigInt(1) })).toThrow(TypeError);
  });
});

describe('readJsonObject', () => {
  it.each([
    '',
    '   ',
    '[1,2]',
    '"text"',
    '12',
    'null',
    '{"type":"track"',
    '{"a":1}}x',
    '{"a":1}{"b":2}',
    '{a:1',
    "{'a':1}",
    '{"a":NaN}',
    'not json',
  ])('anything but one JSON object is undefined: %j', (text) => {
    expect(readJsonObject(text)).toBeUndefined();
  });

  it('accepts whitespace around the object', () => {
    expect(readJsonObject(' {"a":1} \n')?.integer('a')).toBe(1);
  });

  it('reads a __proto__ key as an own field, never as the prototype', () => {
    const fields = readJsonObject('{"__proto__":{"polluted":true},"a":1}');

    expect(fields?.has('__proto__')).toBe(true);
    expect(fields?.keys).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(fields?.toObject())).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('round trip', () => {
  it('every JSON type comes back', () => {
    const record = {
      s: 'text',
      b: true,
      i: 7,
      l: 9_007_199_254_740_991,
      d: 1.5,
      n: null,
      list: ['a', 1, null, [true]],
      map: { k: { deep: 'v' } },
    };

    expect(readJsonObject(write(record))?.toObject()).toEqual(record);
  });

  it('non-ASCII, escaped and control characters survive, and the byte count is the encoded length', () => {
    const text = 'ğüşİıöç 日本 😀 "quoted" back\\slash /slash \n\t\r\b\f \u0001    ';
    const line = write({ [text]: text });

    expect(readJsonObject(line)?.string(text)).toBe(text);
    expect(utf8ByteLength(line)).toBe(new TextEncoder().encode(line).length);
  });

  it('a 32 KB line survives', () => {
    const value = 'x'.repeat(32 * 1024);
    const line = write({ big: value });

    expect(utf8ByteLength(line)).toBeGreaterThan(32 * 1024);
    expect(readJsonObject(line)?.string('big')).toBe(value);
  });

  it('a 32 KB line of four-byte characters counts four bytes each', () => {
    const value = '😀'.repeat(8 * 1024);
    const line = write({ big: value });

    expect(utf8ByteLength(line)).toBe(32 * 1024 + '{"big":""}'.length);
    expect(readJsonObject(line)?.string('big')).toBe(value);
  });

  it('seeded random trees are standard JSON and valid UTF-8 to Python, and read back the same', () => {
    const random = new SeededRandom(24);
    const trees = Array.from({ length: 2000 }, () => randomObject(random, 0));
    const lines = trees.map((tree) => writeJson(tree));
    const answers = parseWithPython(lines);

    trees.forEach((tree, i) => {
      const line = lines[i] ?? '';
      expect(answers[i], line).toEqual({ ok: true, value: tree });
      expect(readJsonObject(line)?.toObject(), line).toEqual(tree);
      expect(utf8ByteLength(line), line).toBe(new TextEncoder().encode(line).length);
    });
  });
});

describe('JsonFields', () => {
  const device = readJsonObject(
    '{"v":1,"device_id":"0191","consent":"granted","last_build":140,"retry":{"step":3},' +
      '"missing_is_fine":null,"future_key":[1,2],"step":"3","ratio":0.5,"huge":1.0E30,"flag":true}',
  );
  if (device === undefined) throw new Error('the record must parse');

  it('reads fields of the right type', () => {
    expect(device.integer('v')).toBe(1);
    expect(device.string('device_id')).toBe('0191');
    expect(device.integer('last_build')).toBe(140);
    expect(device.fields('retry')?.integer('step')).toBe(3);
    expect(device.object('retry')).toEqual({ step: 3 });
    expect(device.array('future_key')).toEqual([1, 2]);
    expect(device.number('ratio')).toBe(0.5);
    expect(device.number('v')).toBe(1);
    expect(device.boolean('flag')).toBe(true);
    expect(device.value('future_key')).toEqual([1, 2]);
  });

  it('a missing key is undefined, never a default', () => {
    expect(device.has('user_id')).toBe(false);
    expect(device.string('user_id')).toBeUndefined();
    expect(device.integer('timestamp')).toBeUndefined();
    expect(device.number('timestamp')).toBeUndefined();
    expect(device.boolean('opted_out')).toBeUndefined();
    expect(device.fields('session')).toBeUndefined();
    expect(device.object('session')).toBeUndefined();
    expect(device.array('session')).toBeUndefined();
    expect(device.value('session')).toBeUndefined();
  });

  it('a wrongly typed value is undefined, never coerced', () => {
    expect(device.integer('step')).toBeUndefined();
    expect(device.integer('device_id')).toBeUndefined();
    expect(device.string('last_build')).toBeUndefined();
    expect(device.integer('ratio')).toBeUndefined();
    expect(device.integer('huge')).toBeUndefined();
    expect(device.boolean('consent')).toBeUndefined();
    expect(device.number('consent')).toBeUndefined();
    expect(device.fields('future_key')).toBeUndefined();
    expect(device.object('future_key')).toBeUndefined();
    expect(device.array('retry')).toBeUndefined();
  });

  it('an integer must be safe and a number finite', () => {
    const fields = readJsonObject('{"big":5000000000,"unsafe":9007199254740993,"inf":1e400}');

    expect(fields?.integer('big')).toBe(5_000_000_000);
    expect(fields?.integer('unsafe')).toBeUndefined();
    expect(fields?.number('unsafe')).toBe(2 ** 53);
    expect(fields?.number('inf')).toBeUndefined();
  });

  it('JSON null is present but has no value', () => {
    expect(device.has('missing_is_fine')).toBe(true);
    expect(device.isNull('missing_is_fine')).toBe(true);
    expect(device.isNull('v')).toBe(false);
    expect(device.isNull('absent')).toBe(false);
    expect(device.string('missing_is_fine')).toBeUndefined();
  });

  it('extra keys are kept and can be listed', () => {
    expect(device.keys).toEqual(expect.arrayContaining(['future_key', 'v', 'retry']) as unknown);
    expect(device.toObject().future_key).toEqual([1, 2]);
  });

  it('a key inherited from Object.prototype is not a field', () => {
    expect(device.has('toString')).toBe(false);
    expect(device.value('constructor')).toBeUndefined();
  });
});

describe('jsonObjectFromEntries', () => {
  it('builds an object in entry order, the later of two equal keys winning, __proto__ a field', () => {
    const object = jsonObjectFromEntries([
      ['b', 1],
      ['__proto__', 'x'],
      ['a', [true]],
      ['b', 2],
    ]);

    expect(writeJson(object)).toBe('{"b":2,"__proto__":"x","a":[true]}');
    expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
  });
});

describe('mergeJsonObject', () => {
  it('a store with missing, extra and wrongly typed fields keeps every field it does not change', () => {
    const stored = readJsonObject('{"v":1,"step":"3","future_key":{"a":[1]},"counters":{"oversize":2}}');
    if (stored === undefined) throw new Error('the record must parse');

    // This page's changes: a missing field set, a wrongly typed one replaced, a nested one rewritten.
    const merged = mergeJsonObject(stored.toObject(), {
      device_id: '0191',
      step: 3,
      counters: { oversize: (stored.fields('counters')?.integer('oversize') ?? 0) + 1 },
    });
    const line = write(merged);

    expect(JSON.parse(line)).toEqual({
      v: 1,
      step: 3,
      future_key: { a: [1] },
      counters: { oversize: 3 },
      device_id: '0191',
    });
  });

  it('a change to undefined removes the key', () => {
    expect(mergeJsonObject({ a: 1, b: 2 }, { b: undefined, c: undefined })).toEqual({ a: 1 });
  });

  it('leaves both inputs unchanged', () => {
    const base = { a: 1 };
    const changes = { b: 2 };

    mergeJsonObject(base, changes);

    expect(base).toEqual({ a: 1 });
    expect(changes).toEqual({ b: 2 });
  });

  it('keeps a stored __proto__ key as a field through read, merge and write', () => {
    const stored = readJsonObject('{"__proto__":{"x":1},"v":1}');
    if (stored === undefined) throw new Error('the record must parse');

    const merged = mergeJsonObject(stored.toObject(), { v: 2 });

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.keys(merged)).toEqual(['__proto__', 'v']);
    expect(write(merged)).toBe('{"__proto__":{"x":1},"v":2}');
  });
});

describe('replaceTopLevelString (step 6.5)', () => {
  // As `writeJson` writes a line: integer-like keys first, `1e+21`, U+2028 raw, `__proto__` a key.
  const line =
    '{"2":"x","type":"track","__proto__":"a key","device_id":"old","properties":{"device_id":"old","n":1e+21,"s":"é\u2028"}}';

  it('changes only the top-level field and writes every other byte as it was', () => {
    const replaced = replaceTopLevelString(line, 'device_id', 'old', 'new');

    expect(replaced).toBe(line.replace('"device_id":"old","properties"', '"device_id":"new","properties"'));
  });

  it('gives undefined when the field holds another value, is missing, or the line is not an object', () => {
    expect(replaceTopLevelString(line, 'device_id', 'other', 'new')).toBeUndefined();
    expect(replaceTopLevelString(line, 'user_id', 'old', 'new')).toBeUndefined();
    expect(replaceTopLevelString('not json', 'device_id', 'old', 'new')).toBeUndefined();
    expect(replaceTopLevelString('["old"]', 'device_id', 'old', 'new')).toBeUndefined();
  });
});

describe('checkLine', () => {
  const golden = new URL('../fixtures/golden/', import.meta.url);
  const events = readdirSync(golden).filter((name) => name.endsWith('.json') && name !== 'envelope.json');

  it.each(events)('reads the message_id, timestamp and device_id of the golden %s', (name) => {
    const event = JSON.parse(readFileSync(new URL(name, golden), 'utf8')) as Record<string, string | number>;

    expect(checkLine(write(event))).toEqual({
      kind: 'event',
      messageId: event.message_id,
      timestamp: event.timestamp,
      deviceId: event.device_id,
    });
  });

  it('trailing content after the object makes a line corrupt (Android log 2.4)', () => {
    const line = '{"type":"track","message_id":"m1","timestamp":1}';

    expect(checkLine(line).kind).toBe('event');
    expect(checkLine(`${line}}x`)).toEqual({ kind: 'corrupt', messageId: undefined });
    expect(checkLine(`${line}${line}`)).toEqual({ kind: 'corrupt', messageId: undefined });
  });

  it.each([
    ['type missing', '{"message_id":"m1","timestamp":1}', 'm1'],
    ['type not a string', '{"type":1,"message_id":"m1","timestamp":1}', 'm1'],
    ['message_id missing', '{"type":"track","timestamp":1}', undefined],
    ['message_id not a string', '{"type":"track","message_id":7,"timestamp":1}', undefined],
    ['timestamp missing', '{"type":"track","message_id":"m1"}', 'm1'],
    ['timestamp a string', '{"type":"track","message_id":"m1","timestamp":"1"}', 'm1'],
    ['timestamp not whole', '{"type":"track","message_id":"m1","timestamp":1.5}', 'm1'],
    ['timestamp null', '{"type":"track","message_id":"m1","timestamp":null}', 'm1'],
  ])('a line with %s is corrupt, with its message_id when readable', (_, line, messageId) => {
    expect(checkLine(line)).toEqual({ kind: 'corrupt', messageId });
  });

  it.each(['', ' ', '[]', '"track"', 'null', '{"type":"track","message_id":"m1","timestamp":1'])(
    'a line that is not one JSON object is corrupt: %j',
    (line) => {
      expect(checkLine(line)).toEqual({ kind: 'corrupt', messageId: undefined });
    },
  );

  it('a missing or wrongly typed device_id is not corruption; the device check is the caller’s', () => {
    expect(checkLine('{"type":"track","message_id":"m1","timestamp":1}')).toEqual({
      kind: 'event',
      messageId: 'm1',
      timestamp: 1,
      deviceId: undefined,
    });
    expect(checkLine('{"type":"track","message_id":"m1","timestamp":1,"device_id":5}')).toMatchObject({
      kind: 'event',
      deviceId: undefined,
    });
  });
});

// Random trees with hostile characters: quotes, backslashes, controls, separators, the bounds of
// each UTF-8 length and surrogate pairs; numbers of every magnitude. No lone surrogate, as after the
// normalizer, and no -0, which is written as 0 (pinned above).
const PIECES = [
  'a', 'Z', '0', ' ', '"', '\\', '/', '\n', '\t', '\u0000', '\u001f', '\u007f', '\u0080', '߿',
  'ࠀ', ' ', ' ', '﻿', '￿', 'ğ', '日', '😀', '𝄞', '\u{10ffff}', '{', '}', '[', ']', ':', ',',
]; // prettier-ignore
const NUMBERS = [0, 1, 1e21, 1e-7, 49.9, 50, 5e-324, 1.7976931348623157e308, 2 ** 53, 0.1 + 0.2, -1.5];

function below(random: SeededRandom, n: number): number {
  return random.nextUint32() % n;
}

function randomString(random: SeededRandom): string {
  let text = '';
  for (let i = below(random, 12); i > 0; i -= 1) text += PIECES[below(random, PIECES.length)] ?? '';
  return text;
}

function randomNumber(random: SeededRandom): number {
  switch (below(random, 4)) {
    case 0:
      return random.nextUint32() | 0;
    case 1:
      return (random.nextUint32() % 0x20_0000) * 0x1_0000_0000 + random.nextUint32();
    case 2: {
      const sign = below(random, 2) === 0 ? 1 : -1;
      return (sign * random.nextUint32()) / 0x1_0000_0000 / 10 ** (below(random, 40) - 25) || 0;
    }
    default:
      return NUMBERS[below(random, NUMBERS.length)] ?? 0;
  }
}

function randomValue(random: SeededRandom, depth: number): PropertyValue {
  switch (below(random, depth < 3 ? 8 : 6)) {
    case 0:
      return null;
    case 1:
      return below(random, 2) === 0;
    case 2:
    case 3:
      return randomNumber(random);
    case 4:
    case 5:
      return randomString(random);
    case 6:
      return Array.from({ length: below(random, 4) }, () => randomValue(random, depth + 1));
    default:
      return randomObject(random, depth + 1);
  }
}

function randomObject(random: SeededRandom, depth: number): { [key: string]: PropertyValue } {
  const object: { [key: string]: PropertyValue } = {};
  for (let i = below(random, 6); i > 0; i -= 1) object[randomString(random)] = randomValue(random, depth);
  return object;
}
