import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import type { Event } from 'rubicon-analytics-core';
import { RecordingLogger } from 'rubicon-analytics-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../src';
import type { AnalyticsConfig } from '../../src';
import { installScriptBuild } from '../../src/script/script-build';
import { adoptSnippet } from '../../src/script/snippet-adapter';
import { resetForTests } from '../../src/testing';
import { recordConsole, restoreConsole } from './console-support';

// The snippet of step 7.8 in jsdom (Web Public API 2, Web HTTP 6, Web Context 4, Web Lifecycle 2 and
// 5, Web Session 5): the stub's text run as the host's inline script, the adapter that takes it over
// when the script build loads, and the script build's global. The two tags in the engines, under a
// Content Security Policy, are in test/browser/snippet.spec.ts.
//
// Virtual time through Vitest's fake timers, which replace `Date` and `setTimeout` of the page: the
// stub records `Date.now()`, the browser platform's clock and scheduler read the same globals.

// jsdom's `URL` is not Node's, which `fileURLToPath` takes.
const STUB = readFileSync(fileURLToPath(new NodeUrl('../../src/snippet/stub.js', import.meta.url)), 'utf8').replace(
  /\r?\n$/,
  '',
);
const START = Date.UTC(2026, 9, 15, 12, 0, 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The stub's CSP hash, published with every release (Web HTTP 6). The stub's text is public API,
 * frozen like any other: a change of this value is a public API change and is named at the top of
 * the pull request.
 */
const STUB_HASH = 'sha256-mywLhcK4TH7k1aho9iPYn0R3UrCoasuducthS/F4UEQ=';

type Queue = [string, unknown[], Record<string, unknown>][];
type Stub = Record<string, unknown> & { _q: Queue; __SV: number };

/** The stub run as the host's inline script; jsdom runs no script element, so it is a function. */
function runStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the host's inline script, as text.
  const script = new Function(STUB) as () => void;
  script();
}

function stub(): Stub {
  return Reflect.get(window, 'rubicon') as Stub;
}

/** `window.rubicon` as the page calls it. */
function rubicon(): Record<string, (...args: unknown[]) => unknown> {
  return Reflect.get(window, 'rubicon') as Record<string, (...args: unknown[]) => unknown>;
}

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

let events: Event[] = [];
let logger: RecordingLogger;

function config(extra: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    apiKey: 'rk_snippet',
    host: 'https://api.example.com',
    logging: { logger: logger.logger, level: 'debug', sendDiagnostics: false },
    beforeSend: [
      (event) => {
        events.push(event);
        return event;
      },
    ],
    ...extra,
  };
}

function settle(): void {
  vi.advanceTimersByTime(1_000);
}

function nameOf(event: Event | undefined): string | undefined {
  return event === undefined ? undefined : event.type === 'identify' ? 'identify' : event.name;
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  events = [];
  logger = new RecordingLogger();
  history.replaceState(null, '', '/landing?utm_source=mail&utm_medium=&token=secret&utm_campaign=fall%20sale#top');
  // Every instance reaches the network through `fetch`: one that never answers keeps the tests off it.
  vi.stubGlobal('fetch', () => new Promise(() => undefined));
});

afterEach(() => {
  resetForTests();
  restoreConsole();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'rubicon');
  Reflect.deleteProperty(window, 'Rubicon');
  Reflect.deleteProperty(document, 'visibilityState');
  history.replaceState(null, '', '/');
  localStorage.clear();
  for (const pair of document.cookie.split('; ')) {
    const name = pair.split('=')[0] ?? '';
    if (name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
});

describe('the stub (src/snippet/stub.js)', () => {
  it('is the frozen text whose hash is published', () => {
    expect(`sha256-${createHash('sha256').update(STUB, 'utf8').digest('base64')}`).toBe(STUB_HASH);
    expect(STUB).not.toContain('\n');
  });

  it('installs window.rubicon with the sentinel, the queue and one method per verb, and no reads', () => {
    runStub();

    expect(stub().__SV).toBe(1);
    expect(Object.keys(stub()).sort()).toEqual(
      [
        '__SV',
        '_q',
        'init',
        'track',
        'screen',
        'identify',
        'reset',
        'register',
        'unregister',
        'flush',
        'optOut',
        'optIn',
        'clearLocalData',
      ].sort(),
    );
    expect('isOptedOut' in stub()).toBe(false);
    expect('deviceId' in stub()).toBe(false);
  });

  it('queues a page viewed record first, with the five utm_* only and the cleaned URL (Web Context 4)', () => {
    runStub();

    expect(stub()._q).toEqual([
      [
        'pageViewed',
        ['utm_source=mail&utm_medium=&utm_campaign=fall%20sale'],
        { t: START, o: 'http://localhost:3000', p: '/landing', w: innerWidth, h: innerHeight, v: 'visible' },
      ],
    ]);
    expect(JSON.stringify(stub()._q)).not.toContain('token');
    expect(JSON.stringify(stub()._q)).not.toContain('top');
  });

  it('records the time, the URL, the viewport and the visibility of every queued call (Web Session 5)', () => {
    runStub();
    const properties = { plan: 'pro' };
    vi.advanceTimersByTime(250);
    setVisibility('hidden');
    history.pushState(null, '', '/second?q=1');

    expect(rubicon()['track']?.('Signed Up', properties)).toBeUndefined();
    rubicon()['identify']?.('user-1');

    expect(stub()._q.slice(1)).toEqual([
      [
        'track',
        ['Signed Up', properties],
        { t: START + 250, o: 'http://localhost:3000', p: '/second', w: innerWidth, h: innerHeight, v: 'hidden' },
      ],
      ['identify', ['user-1'], expect.objectContaining({ p: '/second', v: 'hidden' }) as unknown],
    ]);
  });

  it('stores nothing and inserts no script', () => {
    const scripts = document.scripts.length;

    runStub();
    rubicon()['track']?.('Anything');

    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(document.scripts.length).toBe(scripts);
  });

  it('does nothing when window.rubicon exists: a snippet pasted twice keeps the first queue', () => {
    runStub();
    rubicon()['track']?.('First');
    const first = stub();

    runStub();

    expect(stub()).toBe(first);
    expect(stub()._q.map((entry) => entry[0])).toEqual(['pageViewed', 'track']);
  });

  it('a page whose location cannot be read still queues, with the time only', () => {
    runStub();
    const location = Object.getOwnPropertyDescriptor(window, 'location');
    vi.stubGlobal('location', undefined);
    try {
      rubicon()['track']?.('Without URL');
    } finally {
      if (location !== undefined) Object.defineProperty(window, 'location', location);
    }

    expect(stub()._q[1]).toEqual(['track', ['Without URL'], { t: START }]);
  });
});

describe('the adapter (src/script/snippet-adapter.ts)', () => {
  it('replays the queue in order through the factory, each call with its recorded time and URL', () => {
    runStub();
    vi.advanceTimersByTime(100);
    rubicon()['track']?.('First', { n: 1 });
    vi.advanceTimersByTime(100);
    history.pushState(null, '', '/orders/12345');
    rubicon()['identify']?.('user-1', { plan: 'pro' });
    rubicon()['screen']?.('checkout');
    rubicon()['init']?.(config());
    vi.advanceTimersByTime(5_000);

    adoptSnippet();
    settle();

    expect(events.map(nameOf)).toEqual(['Session Started', 'Page Viewed', 'First', 'identify', 'checkout']);
    const [, view, first, identify, screen] = events;
    expect(view?.timestamp).toBe(START);
    expect(view?.type === 'track' ? view.properties : undefined).toEqual({
      utm_source: 'mail',
      utm_campaign: 'fall sale',
    });
    // The push before the library arrived moved the load's view, a redirect for all it can tell
    // (plan section 15, step 8.1); its time and campaign stay the stub's record.
    expect(view?.context.page.url).toBe('http://localhost:3000/orders/:id');
    expect(first?.timestamp).toBe(START + 100);
    expect(first?.context.page.url).toBe('http://localhost:3000/landing');
    expect(identify?.timestamp).toBe(START + 200);
    expect(identify?.userId).toBe('user-1');
    expect(identify?.context.page.url).toBe('http://localhost:3000/orders/:id');
    expect(screen?.context.session?.id).toBe(first?.context.session?.id);
    expect(new Set(events.map((event) => event.messageId)).size).toBe(events.length);
  });

  it('turns the stub into the instance: live calls, the two reads, and functions taken from the stub before', () => {
    runStub();
    const early = rubicon()['track'];
    rubicon()['init']?.(config());
    adoptSnippet();
    const stubObject = stub();
    vi.advanceTimersByTime(10_000);

    rubicon()['track']?.('Live');
    early?.('Through the old function');
    settle();

    expect(stub()).toBe(stubObject);
    expect(Reflect.get(stubObject, 'deviceId')).toMatch(UUID);
    expect(Reflect.get(stubObject, 'isOptedOut')).toBe(false);
    expect(events.map(nameOf).slice(-2)).toEqual(['Live', 'Through the old function']);
    expect(events.at(-2)?.timestamp).toBe(START + 10_000);
  });

  it('without an init the stub goes on queueing, and the first init loads', () => {
    runStub();
    adoptSnippet();
    rubicon()['track']?.('Before init');
    expect(stub()._q.map((entry) => entry[0])).toEqual(['pageViewed', 'track']);
    vi.advanceTimersByTime(60_000);

    rubicon()['init']?.(config());
    settle();

    expect(events.map(nameOf)).toEqual(['Session Started', 'Page Viewed', 'Before init']);
    expect(events[1]?.timestamp).toBe(START);
  });

  it('a call recorded while hidden starts no session, and the load waits for the first visible moment', () => {
    setVisibility('hidden');
    runStub();
    rubicon()['track']?.('Hidden');
    rubicon()['init']?.(config());
    // Shown two minutes later: the session the view starts then began more than the 60 s tolerance
    // after the hidden call, which therefore carries none (Web Session 5).
    vi.advanceTimersByTime(120_000);
    setVisibility('visible');

    adoptSnippet();
    settle();

    expect(events.map(nameOf)).toEqual(['Session Started', 'Page Viewed', 'Hidden']);
    expect(events[1]?.timestamp).toBe(START + 120_000);
    expect(events[2]?.timestamp).toBe(START);
    expect(events[2]?.context.session).toBeUndefined();
  });

  it('with page_views off the record makes no view', () => {
    runStub();
    rubicon()['track']?.('Only');
    rubicon()['init']?.(config({ autocapture: { enabled: ['sessions'] } }));

    adoptSnippet();
    settle();

    expect(events.map(nameOf)).toEqual(['Session Started', 'Only']);
  });

  it('a second init, queued or called later, returns the first instance with SECOND_INSTANCE', () => {
    runStub();
    rubicon()['init']?.(config());
    rubicon()['init']?.(config({ apiKey: 'rk_other' }));
    adoptSnippet();
    rubicon()['init']?.(config({ apiKey: 'rk_third' }));

    expect(logger.lines.map((line) => line.message.split(':')[0])).toContain('SECOND_INSTANCE');
    expect(logger.lines.filter((line) => line.level === 'error').map((line) => line.message.split(':')[0])).toEqual([
      'SECOND_INSTANCE',
    ]);
  });

  it('an entry the library does not know, or cannot read, is skipped with a DEBUG line; the rest is replayed', () => {
    runStub();
    stub()._q.push(['group', ['acme'], { t: START }]);
    (stub()._q as unknown[]).push('not an entry');
    rubicon()['track']?.('Kept');
    rubicon()['init']?.(config());

    adoptSnippet();
    settle();

    expect(events.map(nameOf)).toEqual(['Session Started', 'Kept', 'Page Viewed']);
    const debug = logger.lines.filter((line) => line.level === 'debug').map((line) => line.message);
    expect(debug).toContain('The snippet queued a call the library does not know; it was skipped');
    expect(debug).toContain('A queued call of the snippet could not be read; it was skipped');
    expect(logger.lines.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([]);
  });

  it('an unusable configuration gives the no-op, and the page goes on', () => {
    recordConsole();
    runStub();
    rubicon()['track']?.('Lost');
    rubicon()['init']?.({ apiKey: '' });

    expect(() => {
      adoptSnippet();
      rubicon()['track']?.('Still nothing');
    }).not.toThrow();

    expect(Reflect.get(stub(), 'deviceId')).toBe('');
    expect(Reflect.get(stub(), 'isOptedOut')).toBe(true);
  });

  it('a window.rubicon that is not a stub is left alone', () => {
    const own = { track: () => 'mine' };
    Reflect.set(window, 'rubicon', own);

    adoptSnippet();

    expect(Reflect.get(window, 'rubicon')).toBe(own);
    expect(own.track()).toBe('mine');
  });
});

describe('the script build (src/script/script-build.ts)', () => {
  it('installs window.Rubicon with the runtime exports of the package, and adopts the stub', () => {
    runStub();
    rubicon()['init']?.(config());

    installScriptBuild(api);

    const namespace = Reflect.get(window, 'Rubicon') as Record<string, unknown>;
    expect(Object.keys(namespace).sort()).toEqual(['createAnalytics', 'createNoOpAnalytics', 'createTrackedFetch']);
    expect(namespace['createAnalytics']).toBe(api.createAnalytics);
    expect(Reflect.get(stub(), 'deviceId')).toMatch(UUID);
  });

  it('a second load is refused with SECOND_INSTANCE and changes nothing (Web Public API 2)', () => {
    const lines = recordConsole();
    runStub();
    rubicon()['init']?.(config());
    installScriptBuild(api);
    const namespace: unknown = Reflect.get(window, 'Rubicon');
    const instance = stub();
    const deviceId: unknown = Reflect.get(instance, 'deviceId');

    installScriptBuild({ createAnalytics: () => undefined });

    expect(Reflect.get(window, 'Rubicon')).toBe(namespace);
    expect(Reflect.get(window, 'rubicon')).toBe(instance);
    expect(Reflect.get(instance, 'deviceId')).toBe(deviceId);
    // No configuration reaches a second load: the default level, `debug` off, so a plain error line.
    expect(lines).toEqual([
      {
        method: 'error',
        args: [expect.stringMatching(/^\[Rubicon\] SECOND_INSTANCE: The script build was loaded again on this page/)],
      },
    ]);
  });

  it('never overwrites a Rubicon global the page made itself', () => {
    recordConsole();
    const own = { mine: true };
    Reflect.set(window, 'Rubicon', own);

    installScriptBuild(api);

    expect(Reflect.get(window, 'Rubicon')).toBe(own);
  });
});
