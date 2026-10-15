import { normalizeProperties, writeJson } from 'rubicon-analytics-core';
import { afterEach, describe, expect, it } from 'vitest';

// The rows of Web Serialization 2 that need a DOM (plan step 2.5): values created in an iframe, whose
// constructors are not this page's, and DOM nodes and `window`. The rest of the table runs in plain
// Node in `packages/core/test/validation`, with `node:vm` realms; the three engines run both in step
// 8.1 (Web Serialization 3).

interface FrameGlobals {
  readonly Object: ObjectConstructor;
  readonly Array: ArrayConstructor;
  readonly Date: DateConstructor;
  readonly Map: MapConstructor;
  readonly Set: SetConstructor;
  readonly Uint8Array: Uint8ArrayConstructor;
  readonly Number: NumberConstructor;
  readonly URL: typeof URL;
  readonly Error: ErrorConstructor;
}

const frames: HTMLIFrameElement[] = [];

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
});

function frameGlobals(): FrameGlobals {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  frames.push(frame);
  const globals = frame.contentWindow as unknown as FrameGlobals | null;
  if (globals === null) throw new Error('the iframe has no window');
  return globals;
}

describe('the conversion table across realms (Web Serialization 2)', () => {
  it('the iframe has constructors of its own', () => {
    const frame = frameGlobals();

    expect(new frame.Date(0)).not.toBeInstanceOf(Date);
    expect(new frame.Map()).not.toBeInstanceOf(Map);
    expect(new frame.Object()).not.toBeInstanceOf(Object);
    expect(frame.Array.of(1)).not.toBeInstanceOf(Array);
  });

  it('a Date, a Map, a Set, an Array, a typed array and a plain object from an iframe are converted', () => {
    const frame = frameGlobals();
    const plain = new frame.Object() as Record<string, unknown>;
    plain.a = 1;
    plain.nested = frame.Array.of('x', undefined);

    const result = normalizeProperties({
      date: new frame.Date(Date.UTC(2026, 9, 14, 8)),
      map: new frame.Map<unknown, unknown>([['k', 1]]),
      set: new frame.Set(['a', 'b']),
      array: frame.Array.of(1, 2),
      typed: new frame.Uint8Array([1, 2]),
      plain,
      nullPrototype: frame.Object.create(null) as unknown,
      boxed: new frame.Number(5),
      url: new frame.URL('https://a.com/b'),
    });

    expect(result.problems).toEqual([]);
    expect(result.values).toEqual({
      date: '2026-10-14T08:00:00.000Z',
      map: { k: 1 },
      set: ['a', 'b'],
      array: [1, 2],
      typed: [1, 2],
      plain: { a: 1, nested: ['x', null] },
      nullPrototype: {},
      boxed: 5,
      url: 'https://a.com/b',
    });
  });

  it('an Error and a class instance from an iframe are unsupported', () => {
    const frame = frameGlobals();

    const result = normalizeProperties({ error: new frame.Error('secret'), kept: 1 });

    expect(result.values).toEqual({ kept: 1 });
    expect(result.problems).toEqual([{ kind: 'unsupported-type', path: 'error', type: 'Error' }]);
  });

  it('DOM nodes, a document and a window are unsupported, named by their tag', () => {
    // Vitest's jsdom environment makes Node's global object the page's `window`, so the window is
    // the iframe's.
    const frameWindow = frameGlobals() as unknown as Window;
    const element = document.createElement('div');
    element.textContent = 'secret';

    const result = normalizeProperties({
      element,
      text: document.createTextNode('secret'),
      document,
      window: frameWindow,
      list: [element, 1],
    });

    expect(result.values).toEqual({ list: [1] });
    expect(result.problems).toEqual([
      { kind: 'unsupported-type', path: 'element', type: 'HTMLDivElement' },
      { kind: 'unsupported-type', path: 'text', type: 'Text' },
      { kind: 'unsupported-type', path: 'document', type: 'Document' },
      { kind: 'unsupported-type', path: 'window', type: 'Window' },
      { kind: 'unsupported-type', path: 'list[0]', type: 'HTMLDivElement' },
    ]);
    expect(writeJson(result.values)).toBe('{"list":[1]}');
  });
});
