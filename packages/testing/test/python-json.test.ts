import { describe, expect, it } from 'vitest';
import { parseWithPython } from '../src';

describe('parseWithPython', () => {
  it('parses each line and answers in order', () => {
    const answers = parseWithPython(['{"a":1}', '[1,"x",null]', '{"t":"ğ日😀","n":1e+21,"f":49.9}']);

    expect(answers).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: [1, 'x', null] },
      { ok: true, value: { t: 'ğ日😀', n: 1e21, f: 49.9 } },
    ]);
  });

  it('keeps U+2028 and U+2029 inside a line, as JSON Lines split on \\n only', () => {
    expect(parseWithPython(['{"s":"a b c"}'])).toEqual([{ ok: true, value: { s: 'a b c' } }]);
  });

  it('refuses a raw lone surrogate as invalid UTF-8 rather than reading U+FFFD', () => {
    const [high, low] = parseWithPython(['{"s":"a\ud800b"}', '{"s":"\udc00"}']);

    expect(high).toMatchObject({ ok: false, error: expect.stringContaining('UnicodeDecodeError') as unknown });
    expect(low).toMatchObject({ ok: false, error: expect.stringContaining('UnicodeDecodeError') as unknown });
  });

  it('refuses NaN and Infinity, which Python would otherwise accept', () => {
    const answers = parseWithPython(['{"x":NaN}', '{"x":-Infinity}']);

    expect(answers.every((a) => !a.ok)).toBe(true);
  });

  it('refuses trailing content, a raw control character and a truncated object', () => {
    const answers = parseWithPython(['{"a":1}}x', '{"a":"\u0001"}', '{"type":"track"']);

    expect(answers.map((a) => a.ok)).toEqual([false, false, false]);
  });

  it('fails the count when a line holds a raw line break', () => {
    expect(() => parseWithPython(['{"a":\n1}'])).toThrow(/answered 2 lines for 1/);
  });

  it('throws when Python cannot be run, so a test that needs it fails rather than skips', () => {
    expect(() => parseWithPython(['{}'], 'python3-that-does-not-exist')).toThrow(/Python 3 is required/);
  });

  it('throws when Python does not answer in time, so a stalled run fails rather than hangs', () => {
    expect(() => parseWithPython(['{}'], 'python3', 1)).toThrow(/did not answer within 1 ms/);
  });

  it('answers nothing for no lines', () => {
    expect(parseWithPython([])).toEqual([]);
  });
});
