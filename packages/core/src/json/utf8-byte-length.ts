/**
 * The number of bytes `text` takes in UTF-8, counted over its UTF-16 code units without encoding it
 * (Web Serialization 1, Snowplow's method): the 32 KB limit of an event line (Serialization 3).
 *
 * One byte below U+0080, two below U+0800, four for a surrogate pair, three for every other code
 * unit. A lone surrogate counts three bytes, the U+FFFD that `TextEncoder` writes for it, so the
 * count equals `TextEncoder` on any string; the normalizer leaves no lone surrogate anyway.
 * `TextEncoder` would allocate the bytes of every line, so it stays the tests' oracle.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The longest start of `text` whose UTF-8 encoding takes at most `maxBytes`, counted as
 * {@link utf8ByteLength} counts, never splitting a surrogate pair: how the HTTP layer keeps at most
 * 4 KB of an error body (HTTP 4, Web HTTP 3).
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    const pair = isHighSurrogate(unit) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1));
    const size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) return text.slice(0, i);
    bytes += size;
    if (pair) i += 1;
  }
  return text;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
