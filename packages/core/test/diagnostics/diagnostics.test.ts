import {
  FakeContextProvider,
  forTheWeb,
  golden,
  parseWithPython,
  TestClock,
  TestPlatform,
  withStableValuesOf,
} from 'rubicon-analytics-testing';
import type { JsonObject } from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiagnosticsState, Event, IdentitySnapshot, PropertyValue } from '../../src';
import {
  DIAGNOSTICS_INTERVAL_MS,
  diagnosticsProperties,
  DiagnosticsReporter,
  eventLine,
  EventPipeline,
  isDiagnosticsDue,
  Log,
  NO_OP_SINK,
  parseQueueKey,
  SDK_DIAGNOSTICS,
  storeKey,
  UuidV7Generator,
} from '../../src';
import { SeededRandom } from 'rubicon-analytics-testing';
import { DEVICE_ID } from '../event/sample-events';
import { consentConfig, KEY_HASH, otherPage, PrivacyPage } from '../privacy/privacy-test-support';

// The port of the Android DiagnosticsTest (Logging 5, Android log 6.6) for Web Logging 5: the event
// and its golden shape, the hourly rhythm across page loads, the checkpoint by subtraction after the
// chunk is written (two pages counting during it), and no event while consent is pending or refused,
// in the memory-only mode, with an unreadable `.device`, switched off or killed. "Opted out keeps
// counting and reports after optIn" is inverted by the contract of 2026-10-14: counts made while
// refused are never stored and are dropped at `optIn()` (Web Logging 5 point 5; plan section 15,
// step 6.5); counts made while pending are merged and reported.

const NOW = TestClock.DEFAULT_START;
const HOUR = DIAGNOSTICS_INTERVAL_MS;

/** Every event line this file makes, for Python to parse in `afterAll` (Web Serialization 3). */
const written: string[] = [];

afterAll(() => {
  parseWithPython(written).forEach((answer, i) => {
    const text = written[i] ?? '';
    expect(answer, text).toEqual({ ok: true, value: JSON.parse(text) as unknown });
  });
});

function counted(lastSentAt?: number): DiagnosticsState {
  return { periodStart: NOW - HOUR, lastSentAt, dropped: new Map([['expired', 2]]), issues: new Map() };
}

function newPage(config: Record<string, unknown> = {}, test = new TestPlatform()): PrivacyPage {
  return new PrivacyPage(test, { config });
}

/** The `SDK Diagnostics` events this page wrote, in order, from the observer's `queued` updates. */
function reports(page: PrivacyPage): Event[] {
  return page.updates.flatMap((update) =>
    update.type === 'queued' && update.event.type === 'track' && update.event.name === SDK_DIAGNOSTICS
      ? [update.event]
      : [],
  );
}

/** The names of every event this page wrote, in order. */
function queuedNames(page: PrivacyPage): string[] {
  return page.updates.flatMap((update) => {
    if (update.type !== 'queued') return [];
    written.push(eventLine(update.event));
    return [update.event.type === 'identify' ? 'identify' : update.event.name];
  });
}

function propertiesOf(event: Event | undefined): Readonly<Record<string, PropertyValue>> | undefined {
  return event?.type === 'track' ? event.properties : undefined;
}

/** The stored `.device` diagnostics group. */
function stored(page: PrivacyPage): Record<string, unknown> | undefined {
  return page.record('device')?.['diagnostics'] as Record<string, unknown> | undefined;
}

function flush(page: PrivacyPage): void {
  page.writer.flush();
  page.run();
}

describe('SDK Diagnostics', () => {
  describe('when it is due (Logging 5)', () => {
    it('never when nothing was counted', () => {
      expect(
        isDiagnosticsDue({ periodStart: undefined, lastSentAt: undefined, dropped: new Map(), issues: new Map() }, NOW),
      ).toBe(false);
    });

    it('at once the first time, then once an hour', () => {
      expect(isDiagnosticsDue(counted(), NOW)).toBe(true);
      expect(isDiagnosticsDue(counted(NOW - HOUR + 1), NOW)).toBe(false);
      expect(isDiagnosticsDue(counted(NOW - HOUR), NOW)).toBe(true);
    });

    it('a last time in the future counts as now', () => {
      expect(isDiagnosticsDue(counted(NOW + 10 * HOUR), NOW)).toBe(false);
    });
  });

  describe('the properties (Android log 6.6)', () => {
    it('match the golden file as a whole event, built by the reporter and the pipeline', () => {
      const state: DiagnosticsState = {
        periodStart: NOW - 4 * HOUR,
        lastSentAt: undefined,
        dropped: new Map([
          ['queue_full', 1200],
          ['expired', 37],
          ['before_send', 3],
        ]),
        issues: new Map([
          ['STORAGE_WRITE_FAILED', 3],
          ['HOST_BLOCKED', 12],
        ]),
      };
      const clock = new TestClock(NOW);
      const log = new Log({ level: 'off', debug: false, sink: NO_OP_SINK });
      const ids = new UuidV7Generator(clock, new SeededRandom(5));
      const pipeline = new EventPipeline({
        config: { beforeSend: [() => null], disabledFields: new Set(), app: {}, pageQueryParams: [], pageTitle: false },
        context: new FakeContextProvider({ osName: 'Android' }),
        sessions: { onEvent: () => ({ session: undefined, before: [] }) },
        ids,
        log,
      });
      const identity: IdentitySnapshot = {
        deviceId: DEVICE_ID,
        userId: null,
        personEpoch: '0'.repeat(16),
        superProperties: {},
      };
      const reporter = new DiagnosticsReporter({
        device: {
          read: () => ({ status: 'missing' }),
          state: { deviceId: DEVICE_ID, retry: undefined as never, diagnostics: state, lastLogged: new Map() },
          checkpointDiagnostics: () => 'written',
        },
        access: { level: 'full' },
        pipeline,
        identity: () => identity,
        ids,
        visible: () => true,
        clock,
        log,
      });

      const report = reporter.prepare(false);
      expect(report?.events).toHaveLength(1);
      const prepared = report?.events[0];
      expect(prepared?.skipsHooks).toBe(true);
      const result = prepared === undefined ? undefined : pipeline.process(prepared);
      if (result?.kind !== 'accepted') throw new Error('SDK Diagnostics was dropped');
      const text = eventLine(result.event);
      written.push(text);

      const file = golden('sdk-diagnostics');
      expect(withStableValuesOf(file, JSON.parse(text) as JsonObject)).toEqual(forTheWeb(file));
      expect(result.event.messageId).toBe(report?.messageId);
    });

    it('carry an empty issues object and a zero total when only one side counted', () => {
      const properties = diagnosticsProperties(
        { periodStart: undefined, lastSentAt: undefined, dropped: new Map(), issues: new Map([['QUEUE_FULL', 1]]) },
        NOW,
      );

      expect(properties).toEqual({
        period_start: '2025-09-29T12:00:00.000Z',
        dropped: { total: 0 },
        issues: { QUEUE_FULL: 1 },
      });
    });

    it('write total first, then the reasons and the codes sorted', () => {
      const properties = diagnosticsProperties(
        {
          periodStart: NOW,
          lastSentAt: undefined,
          dropped: new Map([
            ['storage_error', 1],
            ['backpressure', 2],
          ]),
          issues: new Map([
            ['QUEUE_FULL', 1],
            ['BACKPRESSURE', 1],
          ]),
        },
        NOW,
      );

      expect(Object.keys(properties)).toEqual(['period_start', 'dropped', 'issues']);
      expect(Object.keys(properties['dropped'] as object)).toEqual(['total', 'backpressure', 'storage_error']);
      expect(Object.keys(properties['issues'] as object)).toEqual(['BACKPRESSURE', 'QUEUE_FULL']);
      expect((properties['dropped'] as Record<string, number>)['total']).toBe(3);
    });
  });

  describe('in a page (Web Logging 5)', () => {
    it('a silent device sends nothing', () => {
      const page = newPage();
      page.track('Opened');
      flush(page);

      expect(queuedNames(page)).toEqual(['Session Started', 'Opened']);
      expect(stored(page)?.['last_sent_at']).toBeUndefined();
    });

    it('comes right before the upload of a flush, then the checkpoint subtracts what it reported', () => {
      const page = newPage();
      page.stores.device.countDropped('expired', 2);
      page.log.warn('QUEUE_FULL', () => 'full');
      page.track('Before');
      page.test.clock.advanceBy(1_000);
      flush(page);

      expect(queuedNames(page)).toEqual(['Session Started', 'Before', SDK_DIAGNOSTICS]);
      expect(page.sent().map((batch) => batch.map((event) => event.event))).toEqual([
        ['Session Started', 'Before', SDK_DIAGNOSTICS],
      ]);
      expect(propertiesOf(reports(page)[0])).toEqual({
        period_start: '2025-09-29T12:00:00.000Z',
        dropped: { total: 2, expired: 2 },
        issues: { QUEUE_FULL: 1 },
      });
      expect(reports(page)[0]?.source).toBe('auto');
      expect(stored(page)).toEqual({
        period_start: NOW + 1_000,
        last_sent_at: NOW + 1_000,
        dropped: {},
        issues: {},
      });
    });

    it('at most once an hour, also across page loads', () => {
      const first = newPage();
      first.stores.device.countDropped('expired');
      flush(first);
      first.stores.device.countDropped('expired');
      flush(first);
      expect(reports(first)).toHaveLength(1);

      const reload = otherPage(first);
      flush(reload);
      expect(reports(reload)).toHaveLength(0);

      reload.test.clock.advanceBy(HOUR);
      flush(reload);
      expect(reports(reload)).toHaveLength(1);
      expect(propertiesOf(reports(reload)[0])?.['dropped']).toEqual({ total: 1, expired: 1 });
    });

    it('a last report in the future, after the clock was set back, holds it back for an hour', () => {
      const test = new TestPlatform();
      test.storage.setItem(
        storeKey(KEY_HASH, 'device'),
        `{"v":1,"diagnostics":{"last_sent_at":${String(NOW + 5 * HOUR)},"dropped":{"expired":4}}}`,
      );
      const page = newPage({}, test);
      flush(page);

      expect(reports(page)).toHaveLength(0);
      expect(stored(page)?.['dropped']).toEqual({ expired: 4 });
    });

    it('counters stay when the event could not be written, and the next flush reports them', () => {
      const page = newPage();
      page.track('Opened');
      page.run();
      page.stores.device.countDropped('expired', 2);
      page.test.storage.failWritesWhere = (key) => parseQueueKey(key)?.kind === 'chunk';
      flush(page);

      expect(reports(page)).toHaveLength(0);
      // The chunk store counts the failed write of the event itself, as Android's event store does.
      expect(page.dropped()).toEqual([
        { type: 'dropped', messageIds: [expect.any(String) as unknown], reason: 'storage_error' },
      ]);
      expect(stored(page)?.['last_sent_at']).toBeUndefined();
      expect(stored(page)?.['dropped']).toEqual({ expired: 2, storage_error: 1 });

      page.test.storage.failWritesWhere = undefined;
      flush(page);
      expect(propertiesOf(reports(page)[0])?.['dropped']).toEqual({ total: 3, expired: 2, storage_error: 1 });
      expect(stored(page)?.['dropped']).toEqual({});
    });

    it('a failed checkpoint write reports the same counts again at the next flush', () => {
      const page = newPage();
      page.stores.device.countDropped('expired', 2);
      page.stores.persist();
      page.test.storage.failWritesWhere = (key) => key === storeKey(KEY_HASH, 'device');
      flush(page);
      expect(reports(page)).toHaveLength(1);
      expect(stored(page)?.['last_sent_at']).toBeUndefined();

      page.test.storage.failWritesWhere = undefined;
      flush(page);

      const [first, second] = reports(page);
      expect(propertiesOf(first)?.['dropped']).toEqual({ total: 2, expired: 2 });
      expect(propertiesOf(second)?.['dropped']).toEqual({ total: 2, expired: 2 });
      expect(stored(page)?.['last_sent_at']).toBe(NOW);
      expect(stored(page)?.['dropped']).toEqual({});
    });

    it('two pages counting during a checkpoint keep their increments (Web Logging 5 point 4)', () => {
      const page = newPage();
      const other = otherPage(page);
      page.stores.device.countDropped('expired', 2);
      page.stores.persist();
      // The other page counts at the moment the first one writes the event's chunk, between its
      // snapshot and its checkpoint, and so does the first page itself.
      let counting = true;
      other.test.storage.subscribe((key) => {
        if (!counting || key === null || parseQueueKey(key)?.kind !== 'chunk') return;
        counting = false;
        other.stores.device.countDropped('expired', 3);
        other.stores.device.issueCounter.increment('QUEUE_FULL');
        other.stores.persist();
        page.stores.device.countDropped('backpressure');
      });
      flush(page);

      expect(propertiesOf(reports(page)[0])?.['dropped']).toEqual({ total: 2, expired: 2 });
      expect(stored(page)).toMatchObject({ dropped: { expired: 3, backpressure: 1 }, issues: { QUEUE_FULL: 1 } });
    });

    it('never passes through the hooks, which see every other event', () => {
      const seen: string[] = [];
      const page = newPage({
        beforeSend: [
          (event: Event) => {
            seen.push(event.type === 'identify' ? 'identify' : event.name);
            return null;
          },
        ],
      });
      page.stores.device.countDropped('expired');
      page.track('Dropped by the hook');
      flush(page);

      expect(seen).toEqual(['Session Started', 'Dropped by the hook']);
      expect(queuedNames(page)).toEqual([SDK_DIAGNOSTICS]);
      // The hooks' drops of this flush are counted before it is made, and reported with it.
      expect(propertiesOf(reports(page)[0])?.['dropped']).toEqual({ total: 3, before_send: 2, expired: 1 });
      expect(stored(page)?.['dropped']).toEqual({});
    });

    it('a flush on hiding carries it, and it starts no session on the page that goes away', () => {
      const page = newPage();
      page.stores.device.countDropped('expired');
      page.test.lifecycle.hide();
      page.run();

      expect(queuedNames(page)).toEqual([SDK_DIAGNOSTICS]);
      expect(reports(page)[0]?.context.session).toBeUndefined();
      expect(stored(page)?.['last_sent_at']).toBe(NOW);
    });

    it('a visible page without a session starts one for it, as any automatic event (Android log 6.6)', () => {
      const page = newPage();
      page.stores.device.countDropped('expired');
      flush(page);

      expect(queuedNames(page)).toEqual(['Session Started', SDK_DIAGNOSTICS]);
      expect(reports(page)[0]?.context.session).toBeDefined();
    });

    it('never while consent is pending; the counts are merged at optIn() and reported then', () => {
      const page = newPage(consentConfig('pending'));
      page.stores.device.countDropped('expired', 2);
      page.track('Waiting');
      flush(page);
      expect(reports(page)).toHaveLength(0);
      expect(page.record('device')).toBeUndefined();

      page.privacy.optIn();
      flush(page);

      expect(propertiesOf(reports(page)[0])?.['dropped']).toEqual({ total: 2, expired: 2 });
    });

    it('never while refused; the counts are never stored and are gone after optIn()', () => {
      const page = newPage();
      page.privacy.optOut();
      page.stores.device.countDropped('expired', 2);
      flush(page);
      expect(reports(page)).toHaveLength(0);
      expect(stored(page)?.['dropped'] ?? {}).toEqual({});

      page.privacy.optIn();
      page.track('Back');
      flush(page);

      expect(reports(page)).toHaveLength(0);
      expect(stored(page)?.['dropped'] ?? {}).toEqual({});
    });

    it('never in the memory-only mode, which writes nothing', () => {
      const page = new PrivacyPage(new TestPlatform(), { start: false });
      page.stores.accessLevel = 'none';
      page.start();
      page.stores.device.countDropped('expired');
      page.track('Opened');
      flush(page);

      expect(queuedNames(page)).toEqual(['Session Started', 'Opened']);
      expect(page.storageKeys()).toEqual([]);
    });

    it('never while .device is unreadable, whose checkpoint could never be written', () => {
      const test = new TestPlatform();
      test.storage.setItem(storeKey(KEY_HASH, 'device'), '{"v":2,"diagnostics":{"dropped":{"expired":4}}}');
      const page = newPage({}, test);
      page.stores.device.countDropped('expired');
      flush(page);

      expect(reports(page)).toHaveLength(0);
      expect(test.storage.getItem(storeKey(KEY_HASH, 'device'))).toBe(
        '{"v":2,"diagnostics":{"dropped":{"expired":4}}}',
      );
    });

    it('never when switched off in code', () => {
      const page = newPage({ logging: { sendDiagnostics: false } });
      page.stores.device.countDropped('expired');
      flush(page);

      expect(reports(page)).toHaveLength(0);
      expect(stored(page)?.['dropped']).toEqual({ expired: 1 });
    });

    it('never with a remote diagnostics rate of zero (sampled by device_id, Configuration 1)', () => {
      const test = new TestPlatform();
      test.storage.setItem(
        storeKey(KEY_HASH, 'remote'),
        `{"v":1,"values":{"diagnostics_sample_rate":0},"fetched_at":${String(NOW)}}`,
      );
      const page = newPage({}, test);
      page.stores.device.countDropped('expired');
      flush(page);

      expect(reports(page)).toHaveLength(0);
    });

    it('never with the kill switch on', () => {
      const page = newPage();
      page.run();
      page.flags.stopCollecting();
      page.stores.device.countDropped('expired');
      flush(page);

      expect(reports(page)).toHaveLength(0);
      expect(stored(page)?.['dropped']).toEqual({ expired: 1 });
    });
  });
});
