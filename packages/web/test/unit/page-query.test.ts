import { URL as NodeUrl } from 'node:url';
import { SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { decodeFormComponent, queryValues } from '../../src/platform/page-query';

// `context.page.query` from `location.search` (Web Context 2): only the named parameters, decoded as
// `URLSearchParams` decodes them, which the parser replaces below the floor (Edge 17).

describe('queryValues', () => {
  it('keeps only the named parameters', () => {
    expect(queryValues('?page=2&sort=price&token=abc', ['page', 'sort'])).toEqual({ page: '2', sort: 'price' });
  });

  it('gives nothing when no named parameter is present, or no name is configured', () => {
    expect(queryValues('?token=abc', ['page'])).toBeUndefined();
    expect(queryValues('', ['page'])).toBeUndefined();
    expect(queryValues('?page=2', [])).toBeUndefined();
  });

  it('a name given twice keeps its first value, as URLSearchParams.get does', () => {
    expect(queryValues('?tag=a&tag=b', ['tag'])).toEqual({ tag: 'a' });
    expect(new URLSearchParams('?tag=a&tag=b').get('tag')).toBe('a');
  });

  it('a name without = has the empty value, and an empty value stays', () => {
    expect(queryValues('?flag&page=', ['flag', 'page'])).toEqual({ flag: '', page: '' });
  });

  it('decodes names and values: + is a space, escapes are UTF-8', () => {
    expect(queryValues('?q=caf%C3%A9+au+lait&s%C3%B6z=%E2%9C%93', ['q', 'söz'])).toEqual({
      q: 'café au lait',
      söz: '✓',
    });
  });

  it('reads the search with or without its question mark, and skips empty pairs', () => {
    expect(queryValues('page=2', ['page'])).toEqual({ page: '2' });
    expect(queryValues('?&&page=2&', ['page'])).toEqual({ page: '2' });
  });

  it('a parameter named __proto__ stays a field', () => {
    const values = queryValues('?__proto__=x', ['__proto__']);
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.keys(values ?? {})).toEqual(['__proto__']);
    expect(values?.['__proto__']).toBe('x');
  });
});

describe('decodeFormComponent, against URLSearchParams', () => {
  // The path of `location.search`: the URL parser percent-encodes the text, then `searchParams`
  // decodes it. Node's own parser (Ada); jsdom's (whatwg-url), and Node's `URLSearchParams` given
  // raw text outside ASCII, decode such text differently from the engines.
  const reference = (text: string) => new NodeUrl(`https://example.com/?a=${text}`).searchParams.get('a') ?? '';

  it('keeps a malformed escape as it is and replaces an invalid sequence with U+FFFD', () => {
    for (const text of [
      '%',
      '%4',
      '%zz',
      '100%',
      '%C3',
      '%C3%28',
      '%E2%82',
      '%ED%A0%80',
      '%F4%90%80%80',
      '%FF',
      '%C0%AF',
    ]) {
      expect(decodeFormComponent(text), text).toBe(reference(text));
    }
  });

  it('decodes text outside ASCII as the URL parser encodes it, a lone surrogate as U+FFFD', () => {
    for (const text of ['ğüşıöç', '文字', '\u{1F600}', '\ud800x', 'x\udc00']) {
      expect(decodeFormComponent(text), text).toBe(reference(text));
    }
  });

  // No raw space: `location.search` never holds one, and the URL parser trims a trailing one.
  it('agrees on 5000 random strings of escapes, bytes and characters', () => {
    const random = new SeededRandom(75);
    const pieces = ['%', '+', '=', 'a', 'Z', '0', 'é', '\u{1F600}', '\ud800', '\udc00'];
    for (let n = 0; n < 5000; n += 1) {
      let text = '';
      const length = random.nextUint32() % 12;
      for (let i = 0; i < length; i += 1) {
        const pick = random.nextUint32() % (pieces.length + 2);
        if (pick < pieces.length) text += pieces[pick] ?? '';
        else text += `%${(random.nextUint32() % 256).toString(16).padStart(2, '0')}`;
      }
      expect(decodeFormComponent(text), JSON.stringify(text)).toBe(reference(text));
    }
  });
});
