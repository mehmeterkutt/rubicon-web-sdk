// `context.page.query` (Web Context 2): only the parameters named in `context.page.queryParams`, read
// from `location.search` as `URLSearchParams` reads it (the `application/x-www-form-urlencoded`
// parser of the URL Standard: `+` is a space, percent-escapes are UTF-8 bytes, a malformed escape is
// kept as it is and an invalid byte sequence becomes U+FFFD). `URLSearchParams` itself is Edge 17,
// above the floor of Web Public API 6, so the parser is our own; the unit test compares it with
// `URLSearchParams` on random input. A name given twice keeps its first value, as
// `URLSearchParams.get` does; a name without `=` has the empty value.

/**
 * The values of the parameters named in `names` found in `search` (`location.search`, with or
 * without its `?`), or `undefined` when none is there. The result's keys are defined, not assigned,
 * so a parameter named `__proto__` stays a field.
 */
export function queryValues(search: string, names: readonly string[]): Record<string, string> | undefined {
  if (names.length === 0) return undefined;
  let found: Record<string, string> | undefined;
  const text = search.charAt(0) === '?' ? search.substring(1) : search;
  for (const sequence of text.split('&')) {
    if (sequence === '') continue;
    const equals = sequence.indexOf('=');
    const name = decodeFormComponent(equals < 0 ? sequence : sequence.substring(0, equals));
    if (names.indexOf(name) < 0) continue;
    found = found ?? {};
    if (Object.prototype.hasOwnProperty.call(found, name)) continue;
    const value = equals < 0 ? '' : decodeFormComponent(sequence.substring(equals + 1));
    Object.defineProperty(found, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return found;
}

/** One name or value of a form-urlencoded string: `+` as a space, then percent-decoded as UTF-8. */
export function decodeFormComponent(text: string): string {
  const plain = text.replace(/\+/g, ' ');
  if (!/[%\u0080-\uffff]/.test(plain)) return plain;
  return utf8Decode(percentDecode(plain));
}

// The URL Standard's percent-decode: `%` and two hex digits is a byte, anything else its UTF-8 bytes.
function percentDecode(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit === 0x25 && /^[0-9A-Fa-f]{2}$/.test(text.substring(i + 1, i + 3))) {
      bytes.push(parseInt(text.substring(i + 1, i + 3), 16));
      i += 2;
    } else if (unit < 0x80) {
      bytes.push(unit);
    } else {
      // `location.search` is ASCII; a string from elsewhere is encoded as the URL parser would.
      const point = text.codePointAt(i) ?? unit;
      if (point > 0xffff) i += 1;
      appendUtf8(bytes, point >= 0xd800 && point <= 0xdfff ? 0xfffd : point);
    }
  }
  return bytes;
}

function appendUtf8(bytes: number[], point: number): void {
  if (point < 0x800) {
    bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
  } else if (point < 0x10000) {
    bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  } else {
    bytes.push(
      0xf0 | (point >> 18),
      0x80 | ((point >> 12) & 0x3f),
      0x80 | ((point >> 6) & 0x3f),
      0x80 | (point & 0x3f),
    );
  }
}

// The Encoding Standard's UTF-8 decoder with replacement: each maximal invalid subpart is one U+FFFD.
function utf8Decode(bytes: readonly number[]): string {
  let out = '';
  let point = 0;
  let needed = 0;
  let seen = 0;
  let lower = 0x80;
  let upper = 0xbf;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (needed === 0) {
      if (byte <= 0x7f) {
        out += String.fromCharCode(byte);
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        point = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        point = byte & 0xf;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        point = byte & 0x7;
      } else {
        out += '�';
      }
      continue;
    }
    if (byte < lower || byte > upper) {
      // The sequence ends here; this byte starts over.
      out += '�';
      point = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      i -= 1;
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    point = (point << 6) | (byte & 0x3f);
    seen += 1;
    if (seen !== needed) continue;
    out += String.fromCodePoint(point);
    point = needed = seen = 0;
  }
  return needed === 0 ? out : out + '�';
}
