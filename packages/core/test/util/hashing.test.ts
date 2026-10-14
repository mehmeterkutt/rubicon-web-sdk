import { createHash } from 'node:crypto';
import { SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { keyHash, sha256Hex } from '../../src';

// The sha-256 half of the Android HttpDatesAndHashingTest with its vectors, the examples of NIST
// (FIPS 180-4 and its example document, SHA256.pdf, and the long message of FIPS 180-2 appendix
// B.3), and Node's own SHA-256 as the reference for UTF-8 input and every padding length.

const nodeSha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('matches the NIST examples of two blocks and of a million characters', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('hashes the UTF-8 bytes', () => {
    const text = 'rk_live_ğüşıöç';

    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });

  it.each([
    ['two-byte characters', 'é ß ğ'],
    ['three-byte characters', '文字 € ‰'],
    ['surrogate pairs', '😀 𝄞 🇹🇷'],
    ['the largest code point', '\u{10ffff}'],
  ])('hashes the UTF-8 bytes of %s', (_, text) => {
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });

  it('a lone surrogate is hashed as U+FFFD, as TextEncoder writes it', () => {
    expect(sha256Hex('a\ud800b')).toBe(sha256Hex('a\ufffdb'));
    expect(sha256Hex('a\udc00')).toBe(sha256Hex('a\ufffd'));
    expect(sha256Hex('\ud800')).toBe(nodeSha256('\ud800'));
    expect(Buffer.from(new TextEncoder().encode('a\ud800b')).equals(Buffer.from('a\ufffdb', 'utf8'))).toBe(true);
  });

  it('agrees with Node on every length around the padding boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const text = 'x'.repeat(length);
      if (sha256Hex(text) !== nodeSha256(text))
        expect(sha256Hex(text), `length ${String(length)}`).toBe(nodeSha256(text));
    }
  });

  it('agrees with Node on 2000 random strings of any code unit', () => {
    const random = new SeededRandom(7);
    for (let i = 0; i < 2_000; i += 1) {
      const length = random.nextUint32() % 150;
      let text = '';
      for (let j = 0; j < length; j += 1) text += String.fromCharCode(random.nextUint32() % 0x10000);
      if (sha256Hex(text) !== nodeSha256(text)) expect(sha256Hex(text), JSON.stringify(text)).toBe(nodeSha256(text));
    }
  });
});

describe('keyHash', () => {
  it('is the first 16 hex characters of the SHA-256 of the key', () => {
    expect(keyHash('abc')).toBe('ba7816bf8f01cfea');
    expect(keyHash('rk_live_ğüşıöç')).toBe(nodeSha256('rk_live_ğüşıöç').slice(0, 16));
  });
});
