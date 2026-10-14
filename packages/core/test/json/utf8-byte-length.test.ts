import { SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '../../src';

// The 32 KB limit is measured by a scan over code units (Web Serialization 1); TextEncoder is the
// oracle (Web Serialization 3). The three engines run the same comparison in step 8.1.

const encoded = (text: string): number => new TextEncoder().encode(text).length;

describe('utf8ByteLength', () => {
  it.each([
    ['the empty string', '', 0],
    ['ASCII up to U+007F', 'a\u007f', 2],
    ['two bytes from U+0080 to U+07FF', '\u0080߿', 4],
    ['three bytes from U+0800 to U+FFFF', 'ࠀ日￿', 9],
    ['four bytes for a surrogate pair', '😀\u{10000}\u{10ffff}', 12],
    ['a lone high surrogate, as the U+FFFD that TextEncoder writes', 'a\ud800b', 5],
    ['a lone low surrogate', '\udc00', 3],
    ['a high surrogate at the end', 'a\udbff', 4],
    ['two high surrogates, then a pair', '\ud800😀', 7],
    ['a low surrogate before a high one', '\udc00\ud800', 6],
  ])('counts %s', (_, text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
    expect(utf8ByteLength(text)).toBe(encoded(text));
  });

  it('equals TextEncoder on seeded random strings with surrogate pairs and lone surrogates', () => {
    const random = new SeededRandom(2024);
    for (let n = 0; n < 5000; n += 1) {
      let text = '';
      for (let i = random.nextUint32() % 40; i > 0; i -= 1) text += randomPiece(random);
      if (utf8ByteLength(text) !== encoded(text))
        expect(utf8ByteLength(text), JSON.stringify(text)).toBe(encoded(text));
    }
  });

  it('equals TextEncoder on a string of every code unit', () => {
    let text = '';
    for (let unit = 0; unit <= 0xffff; unit += 1) text += String.fromCharCode(unit);

    expect(utf8ByteLength(text)).toBe(encoded(text));
  });
});

// Any code unit, weighted towards the boundaries and the surrogates.
function randomPiece(random: SeededRandom): string {
  const word = random.nextUint32();
  switch (word % 6) {
    case 0:
      return String.fromCharCode(word % 0x80);
    case 1:
      return String.fromCharCode(0x80 + (word % 0x780));
    case 2:
      return String.fromCharCode(word % 0x10000);
    case 3:
      return String.fromCodePoint(0x10000 + (word % 0x100000));
    case 4:
      return String.fromCharCode(0xd800 + (word % 0x800));
    default:
      return String.fromCharCode([0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff][word % 7] ?? 0);
  }
}
