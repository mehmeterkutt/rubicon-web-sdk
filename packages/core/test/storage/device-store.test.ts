import { MemoryStorage, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  DAILY_LOG_WINDOW_MS,
  DEVICE_FIELDS,
  DIAGNOSTICS_FIELDS,
  MAX_COUNT,
  RETRY_FIELDS,
  SUSPECT_FIELDS,
} from '../../src';
import type { DeviceState, DiagnosticsState } from '../../src';
import { openPage, plant } from './store-test-support';

const DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';

const FULL: DeviceState = {
  deviceId: DEVICE_ID,
  retry: {
    pausedUntil: 1_759_150_860_000,
    step: 3,
    lastFailure: 'timeout',
    rev: 41,
    probeAt: 1_759_150_860_500,
    suspects: new Map([['a1b2c3d4e5f60718.3', { f: 6, alone: 2, clearedBy: 1 }]]),
  },
  diagnostics: {
    periodStart: 1_759_100_000_000,
    lastSentAt: 1_759_000_000_000,
    dropped: new Map([['queue_full', 12]]),
    issues: new Map([['QUEUE_FULL', 2]]),
  },
  lastLogged: new Map([['QUEUE_FULL', 1_759_100_000_000]]),
};

const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

describe('DeviceStore', () => {
  describe('the record', () => {
    it('has exactly the decided keys', () => {
      const page = openPage();
      page.stores.device.write(() => FULL);

      const stored = page.stored('device')!;

      expect(keysOf(stored)).toEqual(['v', ...DEVICE_FIELDS].sort());
      expect(keysOf(stored)).toEqual(['device_id', 'diagnostics', 'last_logged', 'retry', 'v']);
      expect(keysOf(stored.retry)).toEqual([...RETRY_FIELDS].sort());
      expect(keysOf(stored.retry)).toEqual(['last_failure', 'paused_until', 'probe_at', 'rev', 'step', 'suspects']);
      const suspects = (stored.retry as { suspects: Record<string, unknown> }).suspects;
      expect(keysOf(suspects['a1b2c3d4e5f60718.3'])).toEqual([...SUSPECT_FIELDS].sort());
      expect(keysOf(suspects['a1b2c3d4e5f60718.3'])).toEqual(['alone', 'cleared_by', 'f']);
      expect(keysOf(stored.diagnostics)).toEqual([...DIAGNOSTICS_FIELDS].sort());
      expect(keysOf(stored.diagnostics)).toEqual(['dropped', 'issues', 'last_sent_at', 'period_start']);
      expect(page.raw('device')).toBe(
        '{"v":1,"device_id":"0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f","retry":{"paused_until":1759150860000,' +
          '"step":3,"last_failure":"timeout","rev":41,"probe_at":1759150860500,"suspects":{"a1b2c3d4e5f60718.3":' +
          '{"f":6,"alone":2,"cleared_by":1}}},"diagnostics":{"period_start":1759100000000,"last_sent_at":' +
          '1759000000000,"dropped":{"queue_full":12},"issues":{"QUEUE_FULL":2}},"last_logged":' +
          '{"QUEUE_FULL":1759100000000}}',
      );
    });

    it('leaves absent optional fields out', () => {
      const page = openPage();
      page.stores.device.write((state) => ({ ...state, deviceId: DEVICE_ID }));

      expect(page.stored('device')).toEqual({
        v: 1,
        device_id: DEVICE_ID,
        retry: { step: 0, rev: 0, suspects: {} },
        diagnostics: { dropped: {}, issues: {} },
        last_logged: {},
      });
    });

    it('reads back as written, in another page', () => {
      const page = openPage();
      page.stores.device.write(() => FULL);

      const other = openPage(page.storage.otherPage());

      expect(other.stores.device.state).toEqual(FULL);
      expect(other.stores.device.read()).toEqual({ status: 'present', state: FULL });
    });

    it('keeps the fields it does not know, at the top and inside its groups (Web Disk 5)', () => {
      const page = openPage();
      plant(
        page.storage,
        'device',
        '{"v":1,"device_id":"d","flag":true,"retry":{"step":1,"next":"x","suspects":{"p.1":{"f":5,"why":2}}},' +
          '"diagnostics":{"dropped":{"corrupt":1},"extra":[1]}}',
      );

      page.stores.device.countDropped('corrupt');
      page.stores.device.write((state) => ({ ...state, retry: { ...state.retry, step: 2 } }));

      expect(page.stored('device')).toEqual({
        v: 1,
        device_id: 'd',
        flag: true,
        retry: { step: 2, next: 'x', rev: 0, suspects: { 'p.1': { f: 5, why: 2, alone: 0, cleared_by: 0 } } },
        diagnostics: { dropped: { corrupt: 2 }, extra: [1], issues: {}, period_start: TestClock.DEFAULT_START },
        last_logged: {},
      });
    });
  });

  describe('missing and unreadable', () => {
    it('a missing record has no id and nothing is written until a change', () => {
      const page = openPage();

      expect(page.stores.device.read()).toEqual({ status: 'missing' });
      expect(page.stores.device.state.deviceId).toBeUndefined();
      expect(page.stores.device.persist()).toBe('unchanged');
      expect(page.storage.writeCount).toBe(0);
    });

    it('an unreadable record keeps the changes in memory and is never written', () => {
      const page = openPage();
      plant(page.storage, 'device', '{"v":1,"device_id":"kept","diagnostics":{"dropped":{"corrupt":"3"}}}');
      const before = page.raw('device');

      page.stores.device.write((state) => ({ ...state, deviceId: 'temporary' }));
      page.stores.device.countDropped('expired', 2);

      expect(page.stores.device.persist()).toBe('held');
      expect(page.stores.device.read()).toEqual({ status: 'unreadable' });
      expect(page.stores.device.state.deviceId).toBe('temporary');
      expect(page.stores.device.state.diagnostics.dropped.get('expired')).toBe(2);
      expect(page.raw('device')).toBe(before);
      expect(page.storage.writeCount).toBe(0);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    it('logs STORE_UNREADABLE once per page and record, and counts it once', () => {
      const page = openPage();
      plant(page.storage, 'device', 'not json');

      for (let i = 0; i < 5; i += 1) page.stores.device.read();

      const lines = page.sink.lines.filter((line) => line.message.startsWith('STORE_UNREADABLE'));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toBe(
        'STORE_UNREADABLE: The device store exists but cannot be read; this page keeps its values in memory and ' +
          'leaves the record untouched',
      );
      expect(page.stores.device.state.diagnostics.issues.get('STORE_UNREADABLE')).toBe(1);
    });

    it('reads the record again on every read', () => {
      const page = openPage();
      plant(page.storage, 'device', '{}');
      expect(page.stores.device.read().status).toBe('unreadable');

      plant(page.storage, 'device', '{"v":1,"device_id":"kept"}');

      expect(page.stores.device.state.deviceId).toBe('kept');
    });

    describe('records left byte-identical', () => {
      it.each([
        ['corrupt JSON', 'not json'],
        ['a JSON array', '[1]'],
        ['a newer version', '{"v":3,"device_id":"0191"}'],
        ['no version', '{"device_id":"0191"}'],
        ['a version that is not a number', '{"v":"1","device_id":"0191"}'],
        ['a blank id', '{"v":1,"device_id":"  "}'],
        ['an id that is not a string', '{"v":1,"device_id":42}'],
        ['a counter that is not a number', '{"v":1,"device_id":"x","diagnostics":{"dropped":{"corrupt":"3"}}}'],
        ['a negative counter', '{"v":1,"device_id":"x","diagnostics":{"issues":{"QUEUE_FULL":-1}}}'],
        ['a step that is not a whole number', '{"v":1,"device_id":"x","retry":{"step":1.5}}'],
        ['a suspect that is not an object', '{"v":1,"device_id":"x","retry":{"suspects":{"p.1":5}}}'],
        ['retry that is not an object', '{"v":1,"device_id":"x","retry":[]}'],
        ['a time that is not a number', '{"v":1,"device_id":"x","last_logged":{"QUEUE_FULL":"now"}}'],
      ])('%s', (_name, content) => {
        const page = openPage();
        plant(page.storage, 'device', content);

        page.stores.device.countDropped('corrupt');
        page.stores.device.write((state) => ({ ...state, deviceId: 'other' }));
        page.stores.device.persist();
        page.stores.device.checkpointDiagnostics(page.stores.device.state.diagnostics, 1);

        expect(page.raw('device')).toBe(content);
        expect(page.logged('STORE_UNREADABLE')).toBe(true);
      });
    });

    it('a SecurityError on read is an unreadable record: memory, a warning, no write, no throw', () => {
      const page = openPage();
      plant(page.storage, 'device', `{"v":1,"device_id":"${DEVICE_ID}"}`);
      page.storage.failAccess = true;

      page.stores.device.countDropped('backpressure');

      expect(page.stores.device.read()).toEqual({ status: 'unreadable' });
      expect(page.stores.device.persist()).toBe('held');
      expect(page.stores.device.state.diagnostics.dropped.get('backpressure')).toBe(1);
      expect(page.sink.lines.find((line) => line.message.startsWith('STORE_UNREADABLE'))?.level).toBe('warn');

      page.storage.failAccess = false;
      expect(page.stores.device.persist()).toBe('written');
      expect(page.stored('device')).toMatchObject({
        device_id: DEVICE_ID,
        diagnostics: { dropped: { backpressure: 1 } },
      });
    });

    it('a QuotaExceededError on write logs STORAGE_WRITE_FAILED and keeps the change for the next write', () => {
      const page = openPage();
      page.storage.failWrites = true;
      page.stores.device.countDropped('oversize', 2);

      expect(page.stores.device.persist()).toBe('failed');
      expect(page.sink.lines.find((line) => line.message.startsWith('STORAGE_WRITE_FAILED'))).toEqual({
        level: 'error',
        message:
          'STORAGE_WRITE_FAILED: Could not write the device store; the change is kept in memory and written later',
        developerErrorForm: false,
      });
      expect(page.stores.device.state.diagnostics.dropped.get('oversize')).toBe(2);

      page.storage.failWrites = false;
      expect(page.stores.device.persist()).toBe('written');
      expect(openPage(page.storage.otherPage()).stores.device.state.diagnostics.dropped.get('oversize')).toBe(2);
    });
  });

  describe('writes', () => {
    it('many updates in a row produce one write', () => {
      const page = openPage();

      for (let i = 0; i < 100; i += 1) page.stores.device.countDropped('queue_full');
      page.stores.device.update((state) => ({ ...state, deviceId: DEVICE_ID }));
      page.stores.device.persist();

      expect(page.storage.writeCount).toBe(1);
      expect(page.stored('device')).toMatchObject({
        device_id: DEVICE_ID,
        diagnostics: { dropped: { queue_full: 100 } },
      });
    });

    it('nothing is written when nothing changed', () => {
      const page = openPage();
      page.stores.device.write(() => FULL);

      page.stores.device.update((state) => state);
      page.stores.device.update((state) => ({ ...state, deviceId: DEVICE_ID }));

      expect(page.stores.device.persist()).toBe('unchanged');
      expect(page.storage.writeCount).toBe(1);
      expect(page.stores.device.persist()).toBe('unchanged');
    });

    it('a change is visible in this page before it is written, and not in another', () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());

      page.stores.device.update((state) => ({ ...state, deviceId: 'mine' }));

      expect(page.stores.device.state.deviceId).toBe('mine');
      expect(other.stores.device.state.deviceId).toBeUndefined();
    });

    it("a page's write never undoes another page's change made since its own read (Web Disk 3)", () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());
      page.stores.device.write(() => FULL);
      expect(other.stores.device.state.retry.step).toBe(3);

      page.stores.device.write((state) => ({ ...state, retry: { ...state.retry, step: 4, rev: 42 } }));
      other.stores.device.write((state) => ({ ...state, deviceId: 'renewed' }));

      const state = openPage(page.storage.otherPage()).stores.device.state;
      expect(state.retry.step).toBe(4);
      expect(state.retry.rev).toBe(42);
      expect(state.deviceId).toBe('renewed');
    });
  });

  describe('diagnostics counters', () => {
    it('drops and issues add up and start the period', () => {
      const clock = new TestClock();
      const page = openPage(new MemoryStorage(), clock);

      page.stores.device.countDropped('queue_full', 3);
      page.stores.device.countDropped('queue_full');
      page.stores.device.countDropped('expired', 0);
      page.stores.device.issueCounter.increment('HTTP_REDIRECT');
      clock.advanceBy(5_000);
      page.stores.device.issueCounter.increment('HTTP_REDIRECT');

      const diagnostics = page.stores.device.state.diagnostics;
      expect(diagnostics.dropped).toEqual(new Map([['queue_full', 4]]));
      expect(diagnostics.issues).toEqual(new Map([['HTTP_REDIRECT', 2]]));
      expect(diagnostics.periodStart).toBe(TestClock.DEFAULT_START);
    });

    it("the instance's Log counts every WARN and ERROR through the store, whatever the level", () => {
      const page = openPage(new MemoryStorage(), new TestClock(), { level: 'off' });

      page.log.warn('QUEUE_FULL', () => 'full');
      page.log.warn('QUEUE_FULL', () => 'full');
      page.log.error('HTTP_REDIRECT', () => 'redirect');
      page.stores.device.persist();

      expect(page.stored('device')).toMatchObject({ diagnostics: { issues: { QUEUE_FULL: 2, HTTP_REDIRECT: 1 } } });
    });

    it('counts are increments: two pages counting in turn both count (Web Disk 3)', () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());

      page.stores.device.countDropped('corrupt', 2);
      other.stores.device.countDropped('corrupt', 3);
      other.stores.device.countDropped('expired');
      page.stores.device.persist();
      other.stores.device.persist();
      page.stores.device.countDropped('corrupt');
      page.stores.device.persist();

      expect(page.stored('device')).toMatchObject({ diagnostics: { dropped: { corrupt: 6, expired: 1 } } });
    });

    it('counts made while the stores may not be written are kept and merged later (Web Logging 5)', () => {
      const page = openPage(new MemoryStorage(), new TestClock(), { access: 'consent' });
      plant(page.storage, 'device', '{"v":1,"device_id":"stored","diagnostics":{"dropped":{"backpressure":5}}}');

      page.stores.device.countDropped('backpressure', 2);
      expect(page.stores.device.persist()).toBe('held');
      expect(page.stores.device.state.diagnostics.dropped.get('backpressure')).toBe(2);

      page.stores.accessLevel = 'full';
      expect(page.stores.device.persist()).toBe('written');
      expect(page.stored('device')).toMatchObject({
        device_id: 'stored',
        diagnostics: { dropped: { backpressure: 7 } },
      });
    });

    it('a count never wraps around', () => {
      const page = openPage();
      plant(page.storage, 'device', `{"v":1,"diagnostics":{"dropped":{"expired":${String(MAX_COUNT - 1)}}}}`);

      page.stores.device.countDropped('expired', 5);
      page.stores.device.persist();
      page.stores.device.countDropped('expired', 5);

      expect(page.stores.device.state.diagnostics.dropped.get('expired')).toBe(MAX_COUNT);
      expect(page.stored('device')).toMatchObject({ diagnostics: { dropped: { expired: MAX_COUNT } } });
    });

    it("the checkpoint subtracts the report and keeps another page's later counts (Web Logging 5)", () => {
      const clock = new TestClock();
      const page = openPage(new MemoryStorage(), clock);
      const other = openPage(page.storage.otherPage(), clock);
      page.stores.device.countDropped('queue_full', 4);
      page.stores.device.issueCounter.increment('QUEUE_FULL');
      page.stores.device.persist();
      const snapshot: DiagnosticsState = page.stores.device.state.diagnostics;

      other.stores.device.countDropped('queue_full', 2);
      other.stores.device.persist();
      clock.advanceBy(60_000);
      expect(page.stores.device.checkpointDiagnostics(snapshot, clock.now())).toBe('written');

      expect(page.stored('device')).toMatchObject({
        diagnostics: {
          dropped: { queue_full: 2 },
          issues: {},
          period_start: clock.now(),
          last_sent_at: clock.now(),
        },
      });
    });

    it('a failed checkpoint changes nothing, so the next flush reports again', () => {
      const page = openPage();
      page.stores.device.countDropped('corrupt', 3);
      page.stores.device.persist();
      const snapshot = page.stores.device.state.diagnostics;
      page.storage.failWrites = true;

      expect(page.stores.device.checkpointDiagnostics(snapshot, 1)).toBe('failed');
      page.storage.failWrites = false;
      page.stores.device.countDropped('corrupt');
      page.stores.device.persist();

      expect(page.stored('device')).toMatchObject({ diagnostics: { dropped: { corrupt: 4 } } });
      expect(page.stores.device.state.diagnostics.lastSentAt).toBeUndefined();
    });

    it('a checkpoint that cannot be written now is dropped, never applied later (step 6.6)', () => {
      const page = openPage();
      page.stores.device.countDropped('corrupt', 3);
      page.stores.device.persist();
      const snapshot = page.stores.device.state.diagnostics;
      page.stores.accessLevel = 'consent';

      expect(page.stores.device.checkpointDiagnostics(snapshot, 1)).toBe('held');
      page.stores.accessLevel = 'full';
      page.stores.device.countDropped('corrupt');
      page.stores.device.persist();

      expect(page.stored('device')).toMatchObject({ diagnostics: { dropped: { corrupt: 4 } } });
      expect(page.stores.device.state.diagnostics.lastSentAt).toBeUndefined();
    });
  });

  describe('the per_24h limit (Web Logging 2)', () => {
    const logged = (page: ReturnType<typeof openPage>, code: string): string[] =>
      page.sink.lines.filter((line) => line.message.startsWith(`${code}:`)).map((line) => line.level);

    it('is supplied to the Log by the stores', () => {
      const page = openPage();

      expect(page.log.dailyLimit).toBe(page.stores.device.dailyLogLimit);
    });

    it('logs a per_24h code once per device within 24 hours, across pages, and again after them', () => {
      const clock = new TestClock();
      const first = openPage(new MemoryStorage(), clock);
      first.log.warn('QUEUE_FULL', () => 'full');
      expect(first.stored('device')).toMatchObject({ last_logged: { QUEUE_FULL: clock.now() } });

      clock.advanceBy(DAILY_LOG_WINDOW_MS - 1);
      const second = openPage(first.storage.otherPage(), clock);
      second.log.warn('QUEUE_FULL', () => 'full');

      clock.advanceBy(1);
      const third = openPage(first.storage.otherPage(), clock);
      third.log.warn('QUEUE_FULL', () => 'full');

      expect(logged(first, 'QUEUE_FULL')).toEqual(['warn']);
      expect(logged(second, 'QUEUE_FULL')).toEqual(['debug']);
      expect(logged(third, 'QUEUE_FULL')).toEqual(['warn']);
      expect(third.stored('device')).toMatchObject({ last_logged: { QUEUE_FULL: clock.now() } });
    });

    it('limits each per_24h code on its own and never records a per_page code', () => {
      const clock = new TestClock();
      const first = openPage(new MemoryStorage(), clock);
      first.log.warn('QUEUE_FULL', () => 'full');
      first.log.warn('STORE_UNREADABLE', () => 'unreadable');

      const second = openPage(first.storage.otherPage(), clock);
      second.log.warn('EVENTS_EXPIRED', () => 'expired');
      second.log.warn('QUEUE_FULL', () => 'full');

      expect(logged(second, 'EVENTS_EXPIRED')).toEqual(['warn']);
      expect(logged(second, 'QUEUE_FULL')).toEqual(['debug']);
      expect(keysOf((second.stored('device')! as { last_logged: object }).last_logged)).toEqual([
        'EVENTS_EXPIRED',
        'QUEUE_FULL',
      ]);
    });

    it('is per page while consent is pending or refused and in the memory-only mode, and writes nothing', () => {
      for (const access of ['consent', 'none'] as const) {
        const storage = new MemoryStorage();
        const first = openPage(storage, new TestClock(), { access });
        first.log.warn('UPLOAD_FAILED_OPAQUE', () => 'opaque');
        const second = openPage(storage.otherPage(), new TestClock(), { access });
        second.log.warn('UPLOAD_FAILED_OPAQUE', () => 'opaque');
        second.log.warn('UPLOAD_FAILED_OPAQUE', () => 'opaque');

        expect(logged(first, 'UPLOAD_FAILED_OPAQUE')).toEqual(['warn']);
        expect(logged(second, 'UPLOAD_FAILED_OPAQUE')).toEqual(['warn', 'debug']);
        expect(storage.area.entries.size).toBe(0);
      }
    });

    it('is per page while the record is unreadable', () => {
      const storage = new MemoryStorage();
      plant(storage, 'device', '{"v":2}');
      const first = openPage(storage);
      first.log.warn('QUEUE_FULL', () => 'full');
      const second = openPage(storage.otherPage());
      second.log.warn('QUEUE_FULL', () => 'full');

      expect(logged(first, 'QUEUE_FULL')).toEqual(['warn']);
      expect(logged(second, 'QUEUE_FULL')).toEqual(['warn']);
      expect(first.raw('device')).toBe('{"v":2}');
    });

    it('a stored time later than now, after the clock was set back, does not hold the line back', () => {
      const clock = new TestClock();
      const first = openPage(new MemoryStorage(), clock);
      first.log.warn('QUEUE_FULL', () => 'full');

      clock.advanceBy(-60_000);
      const second = openPage(first.storage.otherPage(), clock);
      second.log.warn('QUEUE_FULL', () => 'full');

      expect(logged(second, 'QUEUE_FULL')).toEqual(['warn']);
      expect(second.stored('device')).toMatchObject({ last_logged: { QUEUE_FULL: clock.now() } });
    });

    it('a time that cannot be written still lets the line through, quietly', () => {
      const page = openPage();
      page.storage.failWrites = true;

      page.log.warn('EVENTS_EXPIRED', () => 'expired');

      expect(logged(page, 'EVENTS_EXPIRED')).toEqual(['warn']);
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(false);
    });

    it('a disabled level takes no turn', () => {
      const storage = new MemoryStorage();
      const quiet = openPage(storage, new TestClock(), { level: 'error' });
      quiet.log.warn('QUEUE_FULL', () => 'full');
      quiet.stores.device.persist();
      expect(quiet.stored('device')).toMatchObject({ diagnostics: { issues: { QUEUE_FULL: 1 } } });
      expect(quiet.stored('device')!.last_logged).toEqual({});

      const loud = openPage(storage.otherPage());
      loud.log.warn('QUEUE_FULL', () => 'full');

      expect(logged(loud, 'QUEUE_FULL')).toEqual(['warn']);
    });
  });
});
