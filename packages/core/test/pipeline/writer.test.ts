import {
  FakeContextProvider,
  FakeLifecycleSource,
  FakeNetworkSignal,
  MemoryStorage,
  parseWithPython,
  RecordingSink,
  SeededRandom,
  TestClock,
  TestScheduler,
} from 'rubicon-analytics-testing';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  BeforeSend,
  CapturedEvent,
  DropReason,
  Event,
  EventUpdate,
  IdentitySnapshot,
  IssueCode,
  LogOptions,
  PreparedEvent,
  PropertyValue,
  SessionOutcome,
  StoreAccess,
  UploadTrigger,
  WriterSettings,
} from '../../src';
import {
  ChunkStore,
  DRAIN_BUDGET_MS,
  eventLine,
  EventPipeline,
  Log,
  markerKey,
  MAX_EVENT_BYTES,
  RuntimeFlags,
  SESSION_STARTED,
  SLICE_BUDGET_MS,
  utf8ByteLength,
  UuidV7Generator,
  WRITE_QUEUE_CAPACITY,
  Writer,
} from '../../src';
import { DEVICE_ID } from '../event/sample-events';
import { KEY_HASH } from '../storage/store-test-support';

// The port of the Android WriterTest (Queue 1, 2, 7; Android log 6.3b) for Web Queue 1 to 6, Web
// Privacy 3 and Web Logging 3, with the Android size-limit tests that moved here from the pipeline
// (section 15, step 6.3a). Not ported: the context cache tests (the web reads the context in the
// call, step 6.3a), the app lifecycle tests (no such events on the web, Web Lifecycle 3, 4), the
// session tests (sessions are evaluated in the call, steps 6.2 and 6.3a; here only their order), and
// "many flushes during an upload collapse into one signal", which is the uploader's on the web
// (step 6.4): the writer asks once per flush and the uploader collapses.

const NOW = TestClock.DEFAULT_START;
const OTHER_DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-000000000000';

const IDENTITY: IdentitySnapshot = {
  deviceId: DEVICE_ID,
  userId: null,
  personEpoch: '0123456789abcdef',
  superProperties: {},
};

const NO_SESSION: SessionOutcome = { session: undefined, before: [] };

/** Every chunk value written in this file, for Python to parse in `afterAll` (Web Serialization 3). */
const written: string[] = [];

afterAll(() => {
  const lines = written.flatMap((value) => value.split('\n').filter((text) => text !== ''));
  parseWithPython(lines).forEach((answer, i) => {
    expect(answer, lines[i]).toEqual({ ok: true, value: JSON.parse(lines[i] ?? '') as unknown });
  });
});

interface HarnessOptions {
  readonly settings?: Partial<WriterSettings>;
  readonly hooks?: readonly BeforeSend[];
  readonly log?: Partial<LogOptions>;
  readonly storage?: MemoryStorage;
  readonly sessions?: () => SessionOutcome;
  readonly startup?: (flags: RuntimeFlags) => void;
  readonly process?: (prepared: PreparedEvent) => void;
  readonly start?: boolean;
}

class Harness {
  readonly clock = new TestClock(NOW);
  readonly scheduler = new TestScheduler(this.clock);
  readonly storage: MemoryStorage;
  readonly lifecycle = new FakeLifecycleSource();
  readonly network = new FakeNetworkSignal();
  readonly sink = new RecordingSink();
  readonly counted: IssueCode[] = [];
  readonly updates: EventUpdate[] = [];
  readonly uploads: UploadTrigger[] = [];
  /** How many lines were stored when each upload was asked for. */
  readonly storedAtUpload: number[] = [];
  readonly drops = new Map<DropReason, number>();
  /** `drop:<reason>`, `persist` and `upload:<trigger>` in the order they happened. */
  readonly actions: string[] = [];
  readonly flags = new RuntimeFlags();
  readonly access: StoreAccess = { level: 'full' };
  readonly log: Log;
  readonly chunks: ChunkStore;
  readonly pipeline: EventPipeline;
  readonly writer: Writer;
  deviceId = DEVICE_ID;
  startups = 0;
  persists = 0;
  private nextId = 0;
  private readonly ids = new UuidV7Generator(new TestClock(NOW), new SeededRandom(3));

  constructor(options: HarnessOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.log = new Log({
      level: 'debug',
      debug: false,
      sink: this.sink,
      eventObserver: (update) => {
        this.updates.push(update);
      },
      issues: { increment: (code) => this.counted.push(code) },
      ...options.log,
    });
    const drops = {
      count: (reason: DropReason, events: number) => {
        this.drops.set(reason, (this.drops.get(reason) ?? 0) + events);
        this.actions.push(`drop:${reason}`);
      },
    };
    this.chunks = new ChunkStore({
      keyHash: KEY_HASH,
      storage: this.storage,
      access: this.access,
      log: this.log,
      clock: this.clock,
      random: new SeededRandom(1),
      drops,
    });
    this.pipeline = new EventPipeline({
      config: {
        beforeSend: options.hooks ?? [],
        disabledFields: new Set(),
        app: {},
        pageQueryParams: [],
        pageTitle: false,
      },
      context: new FakeContextProvider(),
      sessions: { onEvent: () => (options.sessions ?? (() => NO_SESSION))() },
      ids: this.ids,
      log: this.log,
    });
    const process = options.process;
    this.writer = new Writer({
      pipeline: {
        process: (prepared) => {
          process?.(prepared);
          return this.pipeline.process(prepared);
        },
      },
      chunks: this.chunks,
      startup: () => {
        this.startups += 1;
        options.startup?.(this.flags);
        return {
          flushAt: 5,
          flushIntervalMs: 60_000,
          immediateEvents: new Set<string>(),
          ...options.settings,
        };
      },
      flags: this.flags,
      currentDeviceId: () => this.deviceId,
      drops,
      persist: () => {
        this.persists += 1;
        this.actions.push('persist');
      },
      upload: (trigger) => {
        this.uploads.push(trigger);
        this.storedAtUpload.push(this.lines().length);
        this.actions.push(`upload:${trigger}`);
      },
      scheduler: this.scheduler,
      clock: this.clock,
      lifecycle: this.lifecycle,
      network: this.network,
      log: this.log,
    });
    if (options.start !== false) this.writer.start();
  }

  /** The events of one public call, prepared as the call prepares them (step 6.3a). */
  prepare(
    name = 'E',
    properties: Readonly<Record<string, PropertyValue>> = {},
    overrides: Partial<CapturedEvent> = {},
  ) {
    this.nextId += 1;
    const captured = {
      type: 'track',
      name,
      properties,
      source: 'app',
      messageId: `m-${String(this.nextId)}`,
      timestamp: this.clock.now(),
      visible: true,
      identity: IDENTITY,
      callTime: {},
      ...overrides,
    } as CapturedEvent;
    return this.pipeline.capture(captured);
  }

  /** A `track` call: prepared, then queued for the writer. */
  track(name = 'E', properties: Readonly<Record<string, PropertyValue>> = {}, overrides: Partial<CapturedEvent> = {}) {
    return this.writer.enqueue(this.prepare(name, properties, overrides));
  }

  /** Lets the writer run every slice that is due. */
  run(): void {
    this.scheduler.runUntilIdle();
  }

  /** The stored lines of this key, oldest chunk first, read from storage. */
  lines(): string[] {
    const chunks = this.chunks.walk() ?? [];
    return chunks.flatMap((chunk) => {
      const value = this.storage.getItem(chunk.key) ?? '';
      written.push(value);
      return value.split('\n').filter((text) => text !== '');
    });
  }

  names(): string[] {
    return this.lines().map((line) => (JSON.parse(line) as { event?: string }).event ?? '');
  }

  chunkCounts(): number[] {
    return (this.chunks.walk() ?? []).map((chunk) => chunk.count);
  }

  /** Upload requests since the last call. */
  signals(): UploadTrigger[] {
    return this.uploads.splice(0);
  }

  queued(): string[] {
    return this.updates.flatMap((update) => (update.type === 'queued' ? [update.event.messageId] : []));
  }

  droppedUpdates(): { messageIds: readonly string[]; reason: DropReason }[] {
    return this.updates.flatMap((update) => (update.type === 'dropped' ? [update] : []));
  }

  warnings(code: IssueCode): { level: string; message: string; developerErrorForm?: boolean }[] {
    return this.sink.lines.filter((line) => line.message.startsWith(`${code}:`));
  }

  /** Plants a chunk as an earlier page would have written it. */
  plantLeftovers(count: number): void {
    const earlier = new Harness({ storage: this.storage, start: false });
    earlier.writer.start();
    for (let i = 0; i < count; i += 1) earlier.track('Old');
    earlier.run();
    earlier.writer.stop();
  }
}

/** A page whose one hook takes `millis` of its clock for every event. */
class SlowPage {
  readonly h: Harness;

  constructor(millis: number, settings: Partial<WriterSettings> = { flushAt: 100 }) {
    this.h = new Harness({
      settings,
      hooks: [
        (event) => {
          this.h.clock.advanceBy(millis);
          return event;
        },
      ],
    });
  }
}

function filler(count: number, length: number, letter: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 1; i <= count; i += 1) values[`k${String(i).padStart(2, '0')}`] = letter.repeat(length);
  return values;
}

describe('order and the first use (Queue 1, Web Queue 1)', () => {
  it('events from one page are stored in call order', () => {
    const h = new Harness({ settings: { flushAt: 100 } });
    for (let i = 0; i < 50; i += 1) h.track(`E${String(i)}`);
    h.run();

    expect(h.names()).toEqual(Array.from({ length: 50 }, (_, i) => `E${String(i)}`));
  });

  it('the call returns before anything is written: the writer runs after paint', () => {
    const h = new Harness();

    expect(h.track()).toBe(true);
    expect(h.lines()).toEqual([]);
    expect(h.queued()).toEqual([]);

    h.run();
    expect(h.lines()).toHaveLength(1);
  });

  it('calls made before the writer started keep their order', () => {
    const h = new Harness({ start: false, settings: { flushAt: 100 } });
    h.track('First');
    h.track('Second');
    h.run();
    expect(h.lines()).toEqual([]);

    h.writer.start();
    h.run();

    expect(h.names()).toEqual(['First', 'Second']);
  });

  it('the settings are asked once, at the first use, never when the writer is made or started', () => {
    const h = new Harness({ start: false });
    h.writer.start();
    expect(h.startups).toBe(0);

    h.run();
    h.track();
    h.run();
    h.track();
    h.run();

    expect(h.startups).toBe(1);
  });

  it('nothing is flushed at the first use', () => {
    const h = new Harness();
    h.run();

    expect(h.signals()).toEqual([]);
  });

  it('the stores are persisted after every slice, and a persist request wakes the writer', () => {
    const h = new Harness();
    h.run();
    const afterStart = h.persists;

    h.writer.requestPersist();
    expect(h.persists).toBe(afterStart);
    h.run();
    expect(h.persists).toBe(afterStart + 1);

    h.track();
    h.run();
    expect(h.persists).toBe(afterStart + 2);
  });

  it('session events prepared by a call are stored right before its event', () => {
    let first = true;
    const h = new Harness({
      sessions: () => {
        if (!first) return NO_SESSION;
        first = false;
        const session = {
          id: 'b9a1c2d3-0000-7000-8000-000000000001',
          startedAt: NOW,
          lastActivity: NOW,
          personEpoch: '0123456789abcdef',
        };
        return { session: { id: session.id, startedAt: NOW }, before: [{ kind: 'started', session }] };
      },
    });
    h.track('Opened');
    h.track('Next');
    h.run();

    expect(h.names()).toEqual([SESSION_STARTED, 'Opened', 'Next']);
  });
});

describe('slices (Web Queue 1)', () => {
  it('a long queue is written over several slices that yield to the page between them', () => {
    const h = new SlowPage(3).h;
    for (let i = 0; i < 12; i += 1) h.track(`E${String(i)}`);

    expect(h.scheduler.runNext()).toBe(true);
    // 3 ms each against a slice of SLICE_BUDGET_MS: the slice stops after four events.
    expect(SLICE_BUDGET_MS).toBe(10);
    expect(h.names()).toEqual(['E0', 'E1', 'E2', 'E3']);
    expect(h.scheduler.nextDueInMs).toBe(0);

    h.run();
    expect(h.names()).toHaveLength(12);
    // One chunk per slice: the slice's events are written together.
    expect(h.chunkCounts()).toEqual([4, 4, 4]);
  });

  it('a flush arriving in the middle of a slice covers exactly the events before it', () => {
    const h = new SlowPage(3).h;
    for (let i = 0; i < 10; i += 1) h.track(`Before${String(i)}`);
    h.scheduler.runNext();
    expect(h.lines()).toHaveLength(4);

    h.writer.flush();
    h.track('After');
    h.scheduler.runNext();
    expect(h.signals()).toEqual([]);

    h.scheduler.runNext();
    expect(h.signals()).toEqual(['flush']);
    expect(h.storedAtUpload).toEqual([10]);

    h.run();
    expect(h.names()).toEqual([...Array.from({ length: 10 }, (_, i) => `Before${String(i)}`), 'After']);
    expect(h.chunkCounts()).toEqual([4, 4, 2, 1]);
  });

  it('a clock set back during a slice ends the slice rather than stretching it', () => {
    let setBack = false;
    const h: Harness = new Harness({
      settings: { flushAt: 100 },
      hooks: [
        (event) => {
          if (!setBack) h.clock.set(h.clock.now() - 60_000);
          setBack = true;
          return event;
        },
      ],
    });
    h.track('A');
    h.track('B');
    h.scheduler.runNext();

    expect(h.names()).toEqual(['A']);
    h.run();
    expect(h.names()).toEqual(['A', 'B']);
  });
});

describe('the observer and drops (Queue 1, 5, Web Logging 1)', () => {
  it('sees queued for exactly the stored events, and dropped for a failed write', () => {
    const h = new Harness();
    h.track('A');
    h.run();
    h.storage.failWrites = true;
    h.track('B');
    h.run();

    expect(h.queued()).toEqual(['m-1']);
    expect(h.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ['m-2'], reason: 'storage_error' }]);
    expect(h.drops.get('storage_error')).toBe(1);
  });

  it('a hook drop is counted and reported as before_send', () => {
    const h = new Harness({ hooks: [() => null] });
    h.track();
    h.run();

    expect(h.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ['m-1'], reason: 'before_send' }]);
    expect(h.drops.get('before_send')).toBe(1);
    expect(h.lines()).toEqual([]);
  });

  it("a full queue drops the call's events as backpressure without blocking", () => {
    const h = new Harness();
    const accepted = Array.from({ length: WRITE_QUEUE_CAPACITY + 1 }, () => h.track());

    expect(accepted.filter((ok) => ok)).toHaveLength(WRITE_QUEUE_CAPACITY);
    expect(accepted[WRITE_QUEUE_CAPACITY]).toBe(false);
    expect(h.lines()).toEqual([]);
    expect(h.drops.get('backpressure')).toBe(1);
    expect(h.droppedUpdates()).toEqual([
      { type: 'dropped', messageIds: [`m-${String(WRITE_QUEUE_CAPACITY + 1)}`], reason: 'backpressure' },
    ]);
    expect(h.warnings('BACKPRESSURE').map((line) => line.level)).toEqual(['warn']);

    h.run();
    expect(h.lines()).toHaveLength(WRITE_QUEUE_CAPACITY);
    expect(h.track()).toBe(true);
  });

  it('a flush or a network signal is skipped with a DEBUG line while the queue is full', () => {
    const h = new Harness();
    for (let i = 0; i < WRITE_QUEUE_CAPACITY; i += 1) h.track();
    h.writer.flush();
    h.network.goOffline();
    h.network.goOnline();

    expect(h.sink.messages).toContain('The write queue is full; the flush message was skipped');
    expect(h.sink.messages).toContain('The write queue is full; the online message was skipped');
    h.run();
    expect(h.signals().filter((trigger) => trigger !== 'count')).toEqual([]);
  });

  it('is idle once every message is written', () => {
    const h = new Harness();
    expect(h.writer.idle).toBe(false);
    h.track();
    h.run();

    expect(h.writer.idle).toBe(true);
  });

  it('every event of a dropped call is counted, session events included', () => {
    const h = new Harness();
    for (let i = 0; i < WRITE_QUEUE_CAPACITY; i += 1) h.track();
    const session = {
      id: 'b9a1c2d3-0000-7000-8000-000000000001',
      startedAt: NOW,
      lastActivity: NOW,
      personEpoch: '0123456789abcdef',
    };
    const prepared = [
      ...h.pipeline.sessionEvents([{ kind: 'started', session }], IDENTITY, {}),
      ...h.prepare('Opened'),
    ];

    expect(h.writer.enqueue(prepared)).toBe(false);
    expect(h.drops.get('backpressure')).toBe(2);
  });

  it('nothing is created once collecting is off', () => {
    const h = new Harness();
    h.track('Before');
    h.run();
    h.flags.stopCollecting();
    h.track('After');
    h.run();

    expect(h.names()).toEqual(['Before']);
    expect(h.drops.size).toBe(0);
  });

  it('a kill switch set by the startup stops collection from the first event', () => {
    const h = new Harness({
      startup: (flags) => {
        flags.stopCollecting();
      },
    });
    h.track();
    h.run();

    expect(h.lines()).toEqual([]);
  });

  it('an event carrying an old device_id is dropped uncounted, before the hooks (Web Privacy 3)', () => {
    let hooked = 0;
    const h = new Harness({
      hooks: [
        (event) => {
          hooked += 1;
          return event;
        },
      ],
    });
    h.track('Old identity');
    h.deviceId = OTHER_DEVICE_ID;
    h.run();
    h.track('New identity', {}, { identity: { ...IDENTITY, deviceId: OTHER_DEVICE_ID } });
    h.run();

    expect(h.names()).toEqual(['New identity']);
    expect(hooked).toBe(1);
    expect(h.drops.size).toBe(0);
    expect(h.droppedUpdates()).toEqual([]);
    expect(h.queued()).toEqual(['m-2']);
  });

  it('the device id is read once per slice, not once per event', () => {
    const h = new Harness({ settings: { flushAt: 100 } });
    let reads = 0;
    Object.defineProperty(h, 'deviceId', {
      get: () => {
        reads += 1;
        return DEVICE_ID;
      },
    });
    for (let i = 0; i < 20; i += 1) h.track();
    h.run();

    expect(h.lines()).toHaveLength(20);
    expect(reads).toBe(1);
  });

  it('an unexpected failure is logged as WORKER_FAILED and the writer goes on', () => {
    const h = new Harness({
      process: (prepared) => {
        if (prepared.event.type === 'track' && prepared.event.name === 'Broken') throw new Error('broken');
      },
    });
    h.track('Broken');
    h.track('Fine');
    h.run();

    expect(h.names()).toEqual(['Fine']);
    expect(h.warnings('WORKER_FAILED').map((line) => line.level)).toEqual(['error']);
    expect(h.sink.messages.join('\n')).not.toContain('broken');
  });
});

describe('the size limit (Serialization 3, Web Serialization 1; section 15, steps 2.5 and 6.3b)', () => {
  it('an event over 32 KB is dropped as oversize with a warning', () => {
    const h = new Harness();
    h.track('Big', filler(40, 1000, 'x'));
    h.run();

    expect(h.lines()).toEqual([]);
    expect(h.drops.get('oversize')).toBe(1);
    expect(h.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ['m-1'], reason: 'oversize' }]);
    expect(h.warnings('EVENT_OVERSIZE').map((line) => line.level)).toEqual(['warn']);
  });

  it('the warning names the limit and never a byte count', () => {
    const h = new Harness();
    h.track('Big', filler(40, 1000, 'x'));
    h.run();

    expect(h.warnings('EVENT_OVERSIZE').map((line) => line.message)).toEqual([
      'EVENT_OVERSIZE: An event is over the limit of 32768 bytes; it was dropped',
    ]);
  });

  it('exactly 32 KB is kept, one byte more is dropped', () => {
    // Strings are cut at 1024 characters, so the size is built from many shorter values.
    const base = new Harness();
    const values = filler(31, 1000, 'y');
    const prepared = base.prepare('Fits', values)[0];
    if (prepared === undefined) throw new Error('nothing prepared');
    const result = base.pipeline.process(prepared);
    if (result.kind !== 'accepted') throw new Error('dropped');
    // Adding ,"z":"..." costs 7 bytes plus the value.
    const room = MAX_EVENT_BYTES - utf8ByteLength(eventLine(result.event)) - 7;

    const h = new Harness();
    h.track('Fits', { ...values, z: 'y'.repeat(room) });
    h.track('Fits', { ...values, z: 'y'.repeat(room + 1) });
    h.run();

    const stored = h.lines();
    expect(stored).toHaveLength(1);
    expect(utf8ByteLength(stored[0] ?? '')).toBe(MAX_EVENT_BYTES);
    expect(h.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ['m-2'], reason: 'oversize' }]);
  });

  it("the normalizer's flag drops the event after the hooks, as oversize", () => {
    let hooked = 0;
    const h = new Harness({
      hooks: [
        (event) => {
          hooked += 1;
          return event;
        },
      ],
    });
    h.writer.enqueue(h.prepare('Cut', { a: 1 }, { oversize: true }));
    h.run();

    expect(hooked).toBe(1);
    expect(h.lines()).toEqual([]);
    expect(h.drops.get('oversize')).toBe(1);
  });

  it("a hook's null on a flagged event keeps its own reason, before_send", () => {
    const h = new Harness({ hooks: [() => null] });
    h.writer.enqueue(h.prepare('Cut', { a: 1 }, { oversize: true }));
    h.run();

    expect(h.drops.get('before_send')).toBe(1);
    expect(h.drops.get('oversize')).toBeUndefined();
    expect(h.warnings('EVENT_OVERSIZE')).toEqual([]);
  });

  it('a flagged event stays dropped when a hook removes the large values', () => {
    const h = new Harness({
      hooks: [(event) => (event.type === 'track' ? { ...event, properties: {} } : event)],
    });
    h.writer.enqueue(h.prepare('Cut', { a: 1 }, { oversize: true }));
    h.run();

    expect(h.drops.get('oversize')).toBe(1);
  });

  it('with debug the warning is written in the error form, and nothing is thrown', () => {
    const h = new Harness({ log: { debug: true } });
    expect(() => {
      h.track('Big', filler(40, 1000, 'x'));
      h.run();
    }).not.toThrow();

    expect(h.warnings('EVENT_OVERSIZE')).toEqual([
      {
        level: 'error',
        message: 'EVENT_OVERSIZE: An event is over the limit of 32768 bytes; it was dropped',
        developerErrorForm: true,
      },
    ]);
  });

  it('without debug it is a plain WARN line', () => {
    const h = new Harness({ log: { debug: false } });
    h.track('Big', filler(40, 1000, 'x'));
    h.run();

    expect(h.warnings('EVENT_OVERSIZE').map((line) => [line.level, line.developerErrorForm])).toEqual([
      ['warn', false],
    ]);
  });

  it('off silences it, with debug true and false, and still counts it', () => {
    for (const debug of [true, false]) {
      const h = new Harness({ log: { level: 'off', debug } });
      h.track('Big', filler(40, 1000, 'x'));
      h.run();

      expect(h.sink.lines).toEqual([]);
      expect(h.counted).toEqual(['EVENT_OVERSIZE']);
      expect(h.drops.get('oversize')).toBe(1);
    }
  });
});

describe('flush triggers (Queue 2, 7, Web Queue 3, 4)', () => {
  it('the count fires once at flush.at events', () => {
    const h = new Harness();
    for (let i = 0; i < 4; i += 1) h.track();
    h.run();
    expect(h.signals()).toEqual([]);

    h.track();
    h.run();
    expect(h.signals()).toEqual(['count']);

    for (let i = 0; i < 4; i += 1) h.track();
    h.run();
    expect(h.signals()).toEqual([]);
  });

  it('the count fires inside a slice: the chunk closes at flush.at events', () => {
    const h = new Harness();
    for (let i = 0; i < 7; i += 1) h.track();
    h.run();

    expect(h.signals()).toEqual(['count']);
    expect(h.chunkCounts()).toEqual([5, 2]);
  });

  it('events left by earlier pages count, once', () => {
    const storage = new MemoryStorage();
    const h = new Harness({ storage, start: false });
    h.plantLeftovers(3);
    h.writer.start();
    h.run();
    expect(h.signals()).toEqual([]);

    h.track();
    h.track();
    h.run();
    expect(h.signals()).toEqual(['count']);
    h.track();
    h.run();
    expect(h.signals()).toEqual([]);
  });

  it('the interval runs from the first pending event and only while events are pending', () => {
    const h = new Harness();
    h.run();
    h.scheduler.advanceBy(600_000);
    expect(h.signals()).toEqual([]);

    h.track();
    h.run();
    h.scheduler.advanceBy(59_000);
    expect(h.signals()).toEqual([]);
    h.track();
    h.scheduler.advanceBy(1_001);
    expect(h.signals()).toEqual(['interval']);

    h.scheduler.advanceBy(600_000);
    expect(h.signals()).toEqual([]);
  });

  it('the interval starts at the first use when chunks were left over', () => {
    const h = new Harness({ start: false });
    h.plantLeftovers(1);
    h.writer.start();
    h.run();
    h.scheduler.advanceBy(60_001);

    expect(h.signals()).toEqual(['interval']);
  });

  it('any flush cancels the interval', () => {
    const h = new Harness();
    h.track();
    h.run();
    h.scheduler.advanceBy(30_000);
    h.writer.flush();
    h.run();
    expect(h.signals()).toEqual(['flush']);

    h.scheduler.advanceBy(40_000);
    expect(h.signals()).toEqual([]);
  });

  it('a timer that came late is caught up at the next call and on becoming visible (Web Retry 3)', () => {
    const atCall = new Harness();
    atCall.track();
    atCall.run();
    // The page was frozen: the clock moved, the timer did not run.
    atCall.clock.advanceBy(61_000);
    atCall.track();
    atCall.run();
    expect(atCall.signals()).toEqual(['interval']);

    const atVisible = new Harness();
    atVisible.track();
    atVisible.run();
    atVisible.lifecycle.hide();
    atVisible.signals();
    atVisible.track();
    atVisible.run();
    atVisible.clock.advanceBy(61_000);
    atVisible.lifecycle.show();
    atVisible.run();
    expect(atVisible.signals()).toEqual(['interval']);
  });

  it('the network coming back flushes only while chunks are pending', () => {
    const h = new Harness();
    h.run();
    h.network.goOffline();
    h.network.goOnline();
    h.run();
    expect(h.signals()).toEqual([]);

    h.track();
    h.run();
    h.network.goOffline();
    h.network.goOnline();
    h.run();
    expect(h.signals()).toEqual(['online']);
  });

  it('an immediate event flushes after it is stored, matched exactly', () => {
    const h = new Harness({ settings: { immediateEvents: new Set(['Purchase Completed']) } });
    h.track('purchase completed');
    h.run();
    expect(h.signals()).toEqual([]);

    h.track('Purchase Completed');
    h.run();

    expect(h.signals()).toEqual(['immediate']);
    expect(h.names()).toEqual(['purchase completed', 'Purchase Completed']);
    expect(h.sink.messages).toContain('Immediate event "Purchase Completed" accepted; flushing');
  });

  it('the name that counts is the final one, after the hooks', () => {
    const h = new Harness({
      settings: { immediateEvents: new Set(['Order Placed']) },
      hooks: [(event) => (event.type === 'track' ? { ...event, name: 'Order Placed' } : event)],
    });
    h.track('Checkout');
    h.run();

    expect(h.signals()).toEqual(['immediate']);
  });

  it('flush includes every earlier event and none after it', () => {
    const h = new Harness({ settings: { flushAt: 100 } });
    h.track('E0');
    h.track('E1');
    h.track('E2');
    h.writer.flush();
    h.track('After');
    h.run();

    expect(h.actions.filter((action) => action.startsWith('upload'))).toEqual(['upload:flush']);
    expect(h.chunkCounts()).toEqual([3, 1]);
  });
});

describe('hiding and pagehide (Web Queue 1, 3; Web Logging 3)', () => {
  it('hiding drains the queue synchronously and flushes on the hiding path', () => {
    const h = new Harness({ settings: { flushAt: 100 } });
    for (let i = 0; i < 3; i += 1) h.track();
    h.lifecycle.hide();

    expect(h.lines()).toHaveLength(3);
    expect(h.signals()).toEqual(['hidden']);
    expect(h.persists).toBe(1);
  });

  it('pagehide then hidden flush once; a visible page flushes again at the next hiding', () => {
    const h = new Harness();
    h.track();
    h.lifecycle.pagehide();
    h.lifecycle.hide();
    expect(h.signals()).toEqual(['pagehide']);

    h.lifecycle.show();
    h.track();
    h.lifecycle.hide();
    expect(h.signals()).toEqual(['hidden']);
  });

  it('a flush asked for during a drain is the hiding flush', () => {
    const h = new Harness({ settings: { immediateEvents: new Set(['Now']) } });
    h.track('Now');
    h.writer.flush();
    h.lifecycle.hide();

    expect(h.signals()).toEqual(['hidden']);
    h.track('Now');
    h.lifecycle.pagehide();
    expect(h.signals()).toEqual(['pagehide']);
  });

  it('a drain on hiding that runs out of time keeps the rest for later slices', () => {
    const page = new SlowPage(10);
    const h = page.h;
    for (let i = 0; i < 8; i += 1) h.track();
    h.lifecycle.hide();

    expect(DRAIN_BUDGET_MS).toBe(50);
    expect(h.lines()).toHaveLength(5);
    expect(h.drops.get('page_closed')).toBeUndefined();

    h.run();
    expect(h.lines()).toHaveLength(8);
  });

  it('a drain on pagehide that runs out of time counts the rest as page_closed with one store write', () => {
    const page = new SlowPage(10);
    const h = page.h;
    for (let i = 0; i < 8; i += 1) h.track();
    h.actions.length = 0;
    h.lifecycle.pagehide();

    expect(h.lines()).toHaveLength(5);
    expect(h.drops.get('page_closed')).toBe(3);
    expect(h.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ['m-6', 'm-7', 'm-8'], reason: 'page_closed' }]);
    expect(h.warnings('PAGE_CLOSED').map((line) => line.level)).toEqual(['warn']);
    // The count is in the one store write at the end of the drain.
    expect(h.actions).toEqual(['upload:pagehide', 'drop:page_closed', 'persist']);

    h.lifecycle.hide();
    h.run();
    expect(h.lines()).toHaveLength(5);
  });

  it('pagehide writes the released marker and a restore from the back/forward cache removes it', () => {
    const h = new Harness();
    h.track();
    h.lifecycle.pagehide();
    expect(h.storage.getItem(markerKey(KEY_HASH, h.chunks.pageId))).toBe('');

    h.lifecycle.pageshowPersisted();
    expect(h.storage.getItem(markerKey(KEY_HASH, h.chunks.pageId))).toBeNull();
  });

  it('a page restored from the back/forward cache flushes again at its next hiding', () => {
    const h = new Harness();
    h.track();
    h.lifecycle.pagehide();
    h.lifecycle.hide();
    h.signals();

    h.lifecycle.pageshowPersisted();
    h.track();
    h.lifecycle.hide();
    expect(h.signals()).toEqual(['hidden']);
  });

  it('events tracked after the drain of pagehide are drained by the hiding that follows', () => {
    const h = new Harness();
    h.lifecycle.pagehide();
    h.track('Late');
    h.lifecycle.hide();

    expect(h.names()).toEqual(['Late']);
  });

  it('hiding, showing, pagehide and a restore create no event of their own (Web Lifecycle 3, 4)', () => {
    const h = new Harness();
    h.run();
    h.lifecycle.hide();
    h.lifecycle.show();
    h.lifecycle.pagehide();
    h.lifecycle.hide();
    h.lifecycle.pageshowPersisted();
    h.run();

    expect(h.lines()).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  it('a stopped writer hears nothing', () => {
    const h = new Harness();
    h.writer.stop();
    h.track();
    h.lifecycle.hide();
    h.run();

    expect(h.lines()).toEqual([]);
    expect(h.lifecycle.listenerCount).toBe(0);
    expect(h.network.listenerCount).toBe(0);
  });
});

describe('never crashing the page', () => {
  it('a throwing upload, persist or store is logged and every entry point returns normally', () => {
    const h = new Harness();
    const failing = new Writer({
      pipeline: h.pipeline,
      chunks: {
        write: () => {
          throw new Error('w');
        },
        walk: () => {
          throw new Error('k');
        },
        release: () => {
          throw new Error('r');
        },
        unrelease: () => {
          throw new Error('u');
        },
      },
      startup: () => ({ flushAt: 1, flushIntervalMs: 1000, immediateEvents: new Set() }),
      flags: h.flags,
      currentDeviceId: () => DEVICE_ID,
      drops: { count: () => undefined },
      persist: () => {
        throw new Error('p');
      },
      upload: () => {
        throw new Error('u');
      },
      scheduler: h.scheduler,
      clock: h.clock,
      lifecycle: h.lifecycle,
      network: h.network,
      log: h.log,
    });
    h.writer.stop();
    expect(() => {
      failing.start();
      failing.enqueue(h.prepare());
      failing.flush();
      failing.requestPersist();
      h.run();
      h.lifecycle.pagehide();
      h.lifecycle.hide();
      h.lifecycle.pageshowPersisted();
      h.network.goOffline();
      h.network.goOnline();
      h.run();
      failing.stop();
    }).not.toThrow();
    expect(h.warnings('WORKER_FAILED').length).toBeGreaterThan(0);
  });

  it('a failing upload or marker on pagehide still counts the rest and writes the stores', () => {
    const h = new Harness();
    const failing = new Writer({
      pipeline: {
        process: (prepared) => {
          h.clock.advanceBy(DRAIN_BUDGET_MS);
          return h.pipeline.process(prepared);
        },
      },
      chunks: {
        write: (lines) => h.chunks.write(lines),
        walk: () => h.chunks.walk(),
        release: () => {
          throw new Error('r');
        },
        unrelease: () => undefined,
      },
      startup: () => ({ flushAt: 100, flushIntervalMs: 60_000, immediateEvents: new Set() }),
      flags: h.flags,
      currentDeviceId: () => DEVICE_ID,
      drops: {
        count: (reason, events) => {
          h.actions.push(`drop:${reason}:${String(events)}`);
        },
      },
      persist: () => {
        h.actions.push('persist');
      },
      upload: () => {
        throw new Error('u');
      },
      scheduler: h.scheduler,
      clock: h.clock,
      lifecycle: h.lifecycle,
      network: h.network,
      log: h.log,
    });
    h.writer.stop();
    failing.start();
    failing.enqueue(h.prepare());
    failing.enqueue(h.prepare());
    h.lifecycle.pagehide();

    expect(h.actions).toEqual(['drop:page_closed:1', 'persist']);
    expect(h.lines()).toHaveLength(1);
  });

  it('every update and line keeps the content rule: ids and names only, never values', () => {
    const h = new Harness({ hooks: [() => null] });
    h.track('Secret holder', { email: 'someone@example.com' });
    h.run();

    expect(h.sink.messages.join('\n')).not.toContain('someone@example.com');
  });
});

describe('the drained page and the event model', () => {
  it('stored lines are the wire lines of the events as the hooks left them', () => {
    const h = new Harness({
      hooks: [(event): Event => (event.type === 'track' ? { ...event, properties: { plan: 'pro' } } : event)],
    });
    h.track('Upgraded', { plan: 'free' });
    h.run();

    const line = JSON.parse(h.lines()[0] ?? '{}') as { properties?: unknown; message_id?: string };
    expect(line.properties).toEqual({ plan: 'pro' });
    expect(line.message_id).toBe('m-1');
  });
});
