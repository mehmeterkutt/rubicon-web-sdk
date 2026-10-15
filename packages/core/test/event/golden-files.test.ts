import {
  forTheWeb,
  golden,
  GOLDEN_FILES,
  goldenFileNames,
  goldenText,
  MemoryStorage,
  parseWithPython,
  RecordingSink,
  SeededRandom,
  TestClock,
  TestPlatform,
  withStableValuesOf,
} from 'rubicon-analytics-testing';
import type { GoldenName, JsonObject } from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { Analytics } from '../../src';
import {
  captureOf,
  ChunkStore,
  createCore,
  keyHash,
  Log,
  NO_OP_SINK,
  parseQueueKey,
  shutdown,
  storeKey,
} from '../../src';

// The wire contract complete (step 8.4; Web Event Model 4, Web Context 5, Serialization 5): the port
// of the Android GoldenFilesTest. The automatic events are what the real core (the factory, the
// pipeline, the session and the writer) stores in `localStorage` for a scripted page, with a fixed
// clock and a context provider giving the files' values the web has, compared structurally with the
// files after the ids, the session id and `library` are checked and taken from them and the fields
// the web never produces are removed from them. The envelope is what the chunk store builds. Every
// golden file has its producing test, listed below, and every line written here and every file is
// parsed by Python (Web Serialization 3).

const API_KEY = 'rk_golden';
const KEY_HASH = keyHash(API_KEY);
/** 2025-09-29T12:00:00.000Z, the time of the files. */
const T0 = TestClock.DEFAULT_START;
const MINUTE = 60_000;

/**
 * Where each Android file is produced on the web. The five events of Web Lifecycle 3, 4 and 5 are
 * never produced: their tests below show that the scenarios which make them on Android make none on
 * the web, and Python reads the files.
 */
const PRODUCED_BY: Readonly<Record<GoldenName, string>> = {
  track: 'event-model.test.ts, the wire form of a track event',
  screen: 'event-model.test.ts, the wire form of a screen event',
  identify: 'event-model.test.ts, the wire form of an identify event',
  'sdk-diagnostics': 'diagnostics.test.ts, built by the reporter and the pipeline',
  envelope: 'this file, the chunk store',
  'session-started': 'this file, the real core',
  'session-ended': 'this file, the real core',
  'network-request': 'this file, the real core (the properties: web tracked-fetch.test.ts)',
  'application-installed': 'never on the web (Web Lifecycle 4)',
  'application-updated': 'never on the web (Web Lifecycle 4)',
  'application-opened': 'never on the web (Web Lifecycle 3)',
  'application-backgrounded': 'never on the web (Web Lifecycle 3)',
  'deep-link-opened': 'never on the web (Web Lifecycle 5)',
};

/** The Android-only automatic events (Web Lifecycle 3, 4, 5). */
const NEVER_ON_THE_WEB = [
  'Application Installed',
  'Application Updated',
  'Application Opened',
  'Application Backgrounded',
  'Deep Link Opened',
];

/** Every line this file reads from storage or builds, for Python in `afterAll`. */
const written: string[] = [];

afterAll(() => {
  parseWithPython(written).forEach((answer, i) => {
    const text = written[i] ?? '';
    expect(answer, text).toEqual({ ok: true, value: JSON.parse(text) as unknown });
  });
});

interface Page {
  readonly test: TestPlatform;
  readonly analytics: Analytics;
  /** Runs every slice and timer due now. */
  readonly run: () => void;
}

/**
 * A page of the real core at `T0`, offline so the chunks stay in storage, its remote configuration
 * fetched just now, with the files' context values: `app.*` from the configuration (Web Context 5),
 * the device, OS and screen as the provider's static values, `locale` and `timezone` at every call.
 */
function open(test = new TestPlatform({ online: false }), appVersion = '1.4.0'): Page {
  test.context.staticContext = {
    osName: 'Android',
    deviceType: 'phone',
    screenWidth: 1080,
    screenHeight: 2400,
    screenDensity: 2.625,
  };
  test.context.callTimeContext = { locale: 'tr-TR', timezone: 'Europe/Istanbul' };
  test.storage.area.entries.set(
    storeKey(KEY_HASH, 'remote'),
    JSON.stringify({ v: 1, values: {}, fetched_at: test.clock.now() }),
  );
  const analytics = createCore(
    {
      apiKey: API_KEY,
      // The diagnostics file has its own test; no `SDK Diagnostics` in these scenarios.
      logging: { sendDiagnostics: false },
      context: { app: { name: 'Rubicon', version: appVersion, namespace: 'com.rubicon.demo' } },
    },
    test.platform,
    { sink: new RecordingSink() },
  );
  return {
    test,
    analytics,
    run: () => {
      test.scheduler.runUntilIdle();
    },
  };
}

/** Every event line of this key's chunks in `localStorage`, parsed; each line is kept for Python. */
function stored(test: TestPlatform): JsonObject[] {
  const events: JsonObject[] = [];
  for (const [key, value] of test.storage.area.entries) {
    const parsed = parseQueueKey(key);
    if (parsed?.kind !== 'chunk' || parsed.name.keyHash !== KEY_HASH) continue;
    for (const text of value.split('\n')) {
      if (text === '') continue;
      written.push(text);
      events.push(JSON.parse(text) as JsonObject);
    }
  }
  return events;
}

function nameOf(event: JsonObject): unknown {
  return event.event ?? event.name ?? event.type;
}

/** The one stored event called `name`. */
function storedEvent(test: TestPlatform, name: string): JsonObject {
  const found = stored(test).filter((event) => nameOf(event) === name);
  expect(found, name).toHaveLength(1);
  return found[0] ?? {};
}

function expectGolden(name: GoldenName, actual: JsonObject): void {
  const file = golden(name);
  expect(withStableValuesOf(file, actual), name).toEqual(forTheWeb(file));
}

describe('the golden files (Web Event Model 4)', () => {
  it('the directory holds exactly the Android set, and each file has its producing test or decision', () => {
    expect(goldenFileNames()).toEqual([...GOLDEN_FILES].sort());
    expect(Object.keys(PRODUCED_BY).sort()).toEqual([...GOLDEN_FILES].sort());
  });

  it('every file is one JSON object to Python, an independent parser', () => {
    const texts = GOLDEN_FILES.map((name) => goldenText(name));
    parseWithPython(texts.map((text) => JSON.stringify(JSON.parse(text)))).forEach((answer, i) => {
      expect(answer).toEqual({ ok: true, value: JSON.parse(texts[i] ?? '') as unknown });
      expect(answer.ok && typeof answer.value === 'object' && !Array.isArray(answer.value)).toBe(true);
    });
  });
});

describe('session events through the real core (Web Session 1, 5)', () => {
  it('a first visit, a hidden page and a return after the inactivity timeout', () => {
    const page = open();
    page.analytics.track('Checkout Started');
    page.run();
    // Hiding is activity of a live session (plan section 15, step 6.2, reading c): its last activity.
    page.test.scheduler.advanceBy(65_000);
    page.test.lifecycle.hide();
    page.run();

    expectGolden('session-started', storedEvent(page.test, 'Session Started'));

    // Becoming visible after more than the 30 minutes of Web Session 1 finds the end.
    page.test.scheduler.advanceBy(31 * MINUTE);
    page.test.lifecycle.show();
    page.run();

    expectGolden('session-ended', storedEvent(page.test, 'Session Ended'));
    shutdown(page.analytics);
  });

  it('none of the Android lifecycle events: no opened, backgrounded or installed (Web Lifecycle 3, 4)', () => {
    const page = open();
    page.analytics.track('Checkout Started');
    page.run();
    page.test.scheduler.advanceBy(65_000);
    page.test.lifecycle.hide();
    page.run();
    page.test.scheduler.advanceBy(31 * MINUTE);
    page.test.lifecycle.show();
    page.analytics.track('Checkout Started');
    page.run();

    expect(stored(page.test).map(nameOf)).toEqual([
      'Session Started',
      'Checkout Started',
      'Session Ended',
      'Session Started',
      'Checkout Started',
    ]);
    shutdown(page.analytics);
  });

  it('no Application Updated when a later page load is configured with another app.version (Web Lifecycle 4)', () => {
    const first = open(new TestPlatform({ online: false }), '1.3.2');
    first.analytics.track('Checkout Started');
    first.run();
    shutdown(first.analytics);

    const second = open(first.test.otherPage(), '1.4.0');
    second.analytics.track('Checkout Started');
    second.run();

    const names = stored(second.test).map(nameOf);
    expect(names).toEqual(['Session Started', 'Checkout Started', 'Checkout Started']);
    expect(names.filter((name) => NEVER_ON_THE_WEB.includes(String(name)))).toEqual([]);
    shutdown(second.analytics);
  });
});

describe('Network Request through the real core (Web Lifecycle 6)', () => {
  it('the automatic capture with the properties of the file gives the file', () => {
    const page = open();
    const capture = captureOf(page.analytics);
    // `createTrackedFetch` makes the properties (web tracked-fetch.test.ts checks them against the
    // same file); here the rest of the event, as the Android core test does.
    capture?.track('network_requests', 'Network Request', golden('network-request').properties as JsonObject);
    page.run();

    expect(stored(page.test).map(nameOf)).toEqual(['Session Started', 'Network Request']);
    expectGolden('network-request', storedEvent(page.test, 'Network Request'));
    shutdown(page.analytics);
  });
});

describe('the envelope (Serialization 5, Web Queue 2, 5)', () => {
  it('streams the stored lines unchanged after sent_at', () => {
    const file = golden('envelope');
    const batch = file.batch as JsonObject[];
    const store = new ChunkStore({
      keyHash: KEY_HASH,
      storage: new MemoryStorage(),
      access: { level: 'full' },
      log: new Log({ level: 'off', debug: false, sink: NO_OP_SINK }),
      clock: new TestClock(T0 + MINUTE),
      random: new SeededRandom(1),
      drops: { count: () => undefined },
    });
    const lines = batch.map((event) => ({ text: JSON.stringify(event), timestamp: event.timestamp as number }));
    expect(store.write(lines).stored).toBe(2);

    const chunks = store.walk() ?? [];
    const result = store.buildBatch(chunks, { sentAt: file.sent_at as number });
    if (result.status !== 'built') throw new Error('the batch was not built');
    written.push(result.body, ...lines.map((line) => line.text));

    expect(result.lines.map((line) => line.text)).toEqual(lines.map((line) => line.text));
    expect(JSON.parse(result.body)).toEqual(file);
  });
});
