import {
  FakeLifecycleSource,
  FakeNetworkSignal,
  FakeTransport,
  fetchTypeError,
  MemoryStorage,
  RecordingSink,
  rejectedOutcome,
  responseOutcome,
  SeededRandom,
  TestClock,
  TestScheduler,
  WhatwgUrlParser,
} from 'rubicon-analytics-testing';
import type { DelayedOutcome } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import type {
  ChunkLine,
  ChunkStore,
  DropReason,
  EventUpdate,
  HostSecurity,
  HttpCall,
  HttpOutcome,
  HttpRequest,
  HttpTransport,
  IssueCode,
  UploadTrigger,
} from '../../src';
import {
  ADOPT_AFTER_MS,
  ChunkStore as Chunks,
  HttpClient,
  KEEPALIVE_BUDGET_BYTES,
  Log,
  markerKey,
  ONLINE_DELAY_MS,
  RetryPolicy,
  RuntimeFlags,
  Stores,
  storeKey,
  Uploader,
  utf8ByteLength,
  Writer,
} from '../../src';
import { DEVICE_ID } from '../event/sample-events';
import { KEY_HASH } from '../storage/store-test-support';

// The port of the Android UploaderTest (Queue 1, 4; Retry 1 to 3; Android log 6.4) for Web Queue 2,
// 3 and 5, Web HTTP 1 to 3, Web Retry 1 to 4, Web Privacy 3 and Web Logging 4. Not ported: "nothing
// starts before the writer has loaded the stores" (every call reads storage on the web; the
// uploader sends nothing before `start()` and nothing at start) and the remote configuration tests
// (the fetch belongs to the page load and `optIn()` on the web, plan section 15, step 5.3).

const HOST = 'https://api.rubicon.example';
const NOW = TestClock.DEFAULT_START;
const OTHER_DEVICE_ID = '0191d0c2-1a2b-7c3d-9e4f-000000000000';

/** One browser: the clock, the scheduler's virtual time, the origin's storage and the network. */
class Browser {
  readonly clock = new TestClock(NOW);
  readonly scheduler = new TestScheduler(this.clock);
  readonly network = new FakeNetworkSignal();
  readonly storage = new MemoryStorage();
  private pages = 0;

  page(options: PageOptions = {}): Page {
    const storage = this.pages === 0 ? this.storage : this.storage.otherPage();
    this.pages += 1;
    return new Page(this, storage, this.pages, options);
  }

  /** Runs what is due now. */
  run(): void {
    this.scheduler.runUntilIdle();
  }
}

interface PageOptions {
  readonly hostSecurity?: HostSecurity;
  /** Answers by request instead of the transport's script. */
  readonly answer?: (request: HttpRequest) => HttpOutcome;
  readonly start?: boolean;
}

/** An `HttpTransport` over the fake that counts the requests in flight at once. */
class CountingTransport implements HttpTransport {
  maxInFlight = 0;

  constructor(
    private readonly inner: HttpTransport,
    private readonly fake: FakeTransport,
  ) {}

  send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
    const call = this.inner.send(request, onOutcome);
    this.maxInFlight = Math.max(this.maxInFlight, this.fake.inFlight);
    return call;
  }
}

/** A transport that answers each request by its content, on the next turn. */
class AnsweringTransport implements HttpTransport {
  constructor(
    private readonly fake: FakeTransport,
    private readonly answer: (request: HttpRequest) => HttpOutcome,
  ) {}

  send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
    this.fake.enqueue(this.answer(request));
    return this.fake.send(request, onOutcome);
  }
}

/** One simulated page: its stores, chunk store, policy, transport and uploader over the browser's storage. */
class Page {
  readonly sink = new RecordingSink();
  readonly updates: EventUpdate[] = [];
  readonly counted: IssueCode[] = [];
  readonly drops = new Map<DropReason, number>();
  readonly lifecycle = new FakeLifecycleSource();
  readonly flags = new RuntimeFlags();
  readonly fake: FakeTransport;
  readonly transport: CountingTransport;
  readonly log: Log;
  readonly stores: Stores;
  readonly chunks: ChunkStore;
  readonly policy: RetryPolicy;
  readonly uploader: Uploader;
  allowed = true;
  deviceId: string | undefined = DEVICE_ID;
  persists = 0;
  private nextId = 0;

  constructor(
    readonly browser: Browser,
    readonly storage: MemoryStorage,
    readonly number: number,
    options: PageOptions,
  ) {
    const { clock, scheduler, network } = browser;
    this.log = new Log({
      level: 'debug',
      debug: false,
      sink: this.sink,
      eventObserver: (update) => {
        this.updates.push(update);
      },
      issues: { increment: (code) => this.counted.push(code) },
    });
    this.stores = new Stores({ keyHash: KEY_HASH, storage, log: this.log, clock });
    const drops = {
      count: (reason: DropReason, events: number) => {
        this.drops.set(reason, (this.drops.get(reason) ?? 0) + events);
      },
    };
    this.chunks = new Chunks({
      keyHash: KEY_HASH,
      storage,
      access: { level: 'full' },
      log: this.log,
      clock,
      random: new SeededRandom(number),
      drops,
    });
    this.policy = new RetryPolicy({
      device: this.stores.device,
      pause: this.stores.pause,
      clock,
      random: new SeededRandom(7),
      log: this.log,
      config: { host: HOST, hostSecurity: options.hostSecurity ?? 'encrypted' },
    });
    this.fake = new FakeTransport(scheduler);
    const answer = options.answer;
    const inner = answer === undefined ? this.fake : new AnsweringTransport(this.fake, answer);
    this.transport = new CountingTransport(inner, this.fake);
    const http = new HttpClient({
      transport: this.transport,
      scheduler,
      clock,
      network,
      urls: new WhatwgUrlParser(),
      log: this.log,
    });
    this.uploader = new Uploader({
      chunks: this.chunks,
      http,
      config: { apiKey: 'test-api-key', batchUrl: `${HOST}/v1/batch`, configUrl: `${HOST}/v1/config`, headers: {} },
      policy: this.policy,
      flags: this.flags,
      uploadsAllowed: () => this.allowed,
      currentDeviceId: () => this.deviceId,
      drops,
      persist: () => {
        this.persists += 1;
        this.stores.device.persist();
      },
      scheduler,
      clock,
      network,
      lifecycle: this.lifecycle,
      log: this.log,
    });
    if (options.start !== false) this.uploader.start();
  }

  /** Writes `count` events as one write of this page, so in as few chunks as fit; returns their ids. */
  write(count: number, options: { readonly deviceId?: string; readonly pad?: number } = {}): string[] {
    const ids: string[] = [];
    const lines: ChunkLine[] = [];
    for (let i = 0; i < count; i += 1) {
      this.nextId += 1;
      const id = `p${String(this.number)}-${String(this.nextId)}`;
      ids.push(id);
      lines.push(line(id, this.browser.clock.now(), options.deviceId ?? DEVICE_ID, options.pad ?? 0));
    }
    this.chunks.write(lines);
    return ids;
  }

  upload(trigger: UploadTrigger = 'flush'): void {
    this.uploader.upload(trigger);
  }

  get requests(): readonly HttpRequest[] {
    return this.fake.requests;
  }

  /** The `message_id`s of every request's body, one list per request. */
  sent(): string[][] {
    return this.requests.map(idsOf);
  }

  /** Every stored `message_id` of the key, all pages' chunks, oldest first. */
  stored(): string[] {
    return (this.chunks.walk() ?? []).flatMap((chunk) =>
      (this.storage.getItem(chunk.key) ?? '')
        .split('\n')
        .filter((text) => text !== '')
        .map((text) => (JSON.parse(text) as { message_id: string }).message_id),
    );
  }

  sentUpdates(): string[][] {
    return this.updates.flatMap((update) => (update.type === 'sent' ? [update.messageIds.slice()] : []));
  }

  droppedUpdates(): { messageIds: readonly string[]; reason: DropReason }[] {
    return this.updates.flatMap((update) => (update.type === 'dropped' ? [update] : []));
  }

  /** The stored `.device` `retry` object. */
  retry(): Record<string, unknown> {
    const text = this.storage.area.entries.get(storeKey(KEY_HASH, 'device'));
    if (text === undefined) return {};
    return (JSON.parse(text) as { retry?: Record<string, unknown> }).retry ?? {};
  }

  /** Lines of `code` at their own level. */
  logged(code: IssueCode): number {
    return this.sink.lines.filter((entry) => entry.level !== 'debug' && entry.message.startsWith(`${code}:`)).length;
  }
}

function line(id: string, timestamp: number, deviceId: string, pad: number): ChunkLine {
  const padding = pad > 0 ? `,"properties":{"p":"${'x'.repeat(pad)}"}` : '';
  return {
    text: `{"type":"track","event":"E","message_id":"${id}","timestamp":${String(timestamp)},"device_id":"${deviceId}"${padding}}`,
    timestamp,
  };
}

function bodyOf(request: HttpRequest): { sent_at: number; batch: { message_id: string }[] } {
  return JSON.parse(request.body ?? '') as { sent_at: number; batch: { message_id: string }[] };
}

function idsOf(request: HttpRequest): string[] {
  return bodyOf(request).batch.map((event) => event.message_id);
}

function delayed(outcome: HttpOutcome, delayMs: number): DelayedOutcome {
  return { outcome, delayMs };
}

const OK = responseOutcome(200);

/** Whether the page wrote a failure, a step or a revision into the shared retry state. */
function recorded(page: Page): boolean {
  const retry = page.retry();
  return retry.last_failure !== undefined || (retry.step ?? 0) !== 0 || (retry.rev ?? 0) !== 0;
}
const REFUSED = rejectedOutcome(fetchTypeError());

describe('sending (Queue 1, 4)', () => {
  it('batches go oldest first, are deleted after a 2xx, and sent lists their ids', () => {
    const browser = new Browser();
    const page = browser.page();
    const first = page.write(60);
    const second = page.write(60);
    const third = page.write(50);

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([first, second, third]);
    expect(page.stored()).toEqual([]);
    expect(page.sentUpdates()).toEqual([first, second, third]);
  });

  it('a batch is whole chunks up to 100 events', () => {
    const browser = new Browser();
    const page = browser.page();
    const a = page.write(40);
    const b = page.write(40);
    const c = page.write(40);

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([[...a, ...b], c]);
  });

  it('the body is the envelope with sent_at, posted to the batch endpoint with the wire headers', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);

    page.upload();

    const request = page.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`${HOST}/v1/batch`);
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer test-api-key',
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(request === undefined ? undefined : bodyOf(request).sent_at).toBe(browser.clock.now());
  });

  it('a batch is kept on failure, tried again by itself after the wait with a new sent_at, and deleted after a 2xx', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(503));

    page.upload();
    browser.run();
    expect(page.requests).toHaveLength(1);
    expect(page.stored()).toHaveLength(1);

    browser.scheduler.advanceBy(3_000);
    browser.run();

    expect(page.requests).toHaveLength(2);
    const sentAts = page.requests.map((request) => bodyOf(request).sent_at);
    expect(sentAts[1]).toBeGreaterThan(sentAts[0] ?? Infinity);
    expect(page.stored()).toEqual([]);
  });

  it('it stops at the first failure', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(60);
    page.write(60);
    page.write(60);
    page.fake.enqueue(OK, responseOutcome(500));

    page.upload();
    browser.run();

    expect(page.requests).toHaveLength(2);
    expect(page.stored()).toHaveLength(120);
  });

  it('a rejected batch is deleted, counted and reported', () => {
    const browser = new Browser();
    const page = browser.page();
    const ids = page.write(2);
    page.fake.enqueue(responseOutcome(400));

    page.upload();
    browser.run();

    expect(page.stored()).toEqual([]);
    expect(page.drops.get('rejected')).toBe(2);
    expect(page.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: ids, reason: 'rejected' }]);
    expect(page.logged('BATCH_REJECTED')).toBe(1);
  });

  it('a chunk of only corrupt lines is deleted without a request, its lines counted as corrupt', () => {
    const browser = new Browser();
    const page = browser.page();
    page.chunks.write([{ text: 'not json', timestamp: NOW }]);
    const ok = page.write(1);

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([ok]);
    expect(page.stored()).toEqual([]);
    expect(page.drops.get('corrupt')).toBe(1);
  });

  it('the retry state is written and the stores persisted after a result', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    const chunk = page.chunks.walk()?.[0];
    page.fake.enqueue(responseOutcome(503));

    page.upload();
    browser.run();

    expect(page.persists).toBeGreaterThanOrEqual(1);
    expect(page.retry()).toMatchObject({
      step: 1,
      last_failure: 'http_503',
      suspects: { [chunk?.id ?? '']: { f: 1 } },
    });
  });
});

describe('one request at a time (Queue 1)', () => {
  it('no two requests overlap under a burst of triggers', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(60);
    page.write(60);
    page.write(60);
    page.fake.enqueue(delayed(OK, 500), delayed(OK, 500), delayed(OK, 500));

    for (let i = 0; i < 50; i += 1) page.upload(i % 2 === 0 ? 'count' : 'flush');
    expect(page.requests).toHaveLength(1);
    browser.scheduler.runAll();

    expect(page.requests).toHaveLength(3);
    expect(page.transport.maxInFlight).toBe(1);
  });

  it('a trigger during a request sends what was written meanwhile right after it', () => {
    const browser = new Browser();
    const page = browser.page();
    const first = page.write(1);
    page.fake.enqueue(delayed(OK, 1_000));
    page.upload();
    const later = page.write(1);
    page.upload('immediate');

    browser.scheduler.advanceBy(1_000);
    browser.run();

    expect(page.sent()).toEqual([first, later]);
  });

  it('an online attempt that falls due during a request waits for its result', () => {
    const browser = new Browser();
    const page = browser.page();
    const first = page.write(1);
    page.fake.enqueue(delayed(OK, 2_000));

    page.upload('online');
    page.upload();
    const later = page.write(1);
    browser.scheduler.advanceBy(ONLINE_DELAY_MS);
    expect(page.requests).toHaveLength(1);
    browser.scheduler.advanceBy(2_000);
    browser.run();

    expect(page.sent()).toEqual([first, later]);
    expect(page.transport.maxInFlight).toBe(1);
  });

  it('leftovers wait for a trigger: nothing is sent at start', () => {
    const browser = new Browser();
    const earlier = browser.page();
    earlier.write(3);
    earlier.chunks.release();
    const page = browser.page({ start: false });

    page.uploader.start();
    browser.scheduler.advanceBy(60_000);
    expect(page.requests).toHaveLength(0);

    page.upload('interval');
    browser.run();
    expect(page.requests).toHaveLength(1);
  });

  it('nothing is sent before start or after stop', () => {
    const browser = new Browser();
    const page = browser.page({ start: false });
    page.write(1);

    page.upload();
    page.uploader.start();
    page.uploader.stop();
    page.upload();
    browser.run();

    expect(page.requests).toHaveLength(0);
  });
});

describe('gates (Queue 2, Web Retry 1, 2, Web Logging 4)', () => {
  it('offline blocks without a failure, and the network coming back sends after the short delay', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    browser.network.goOffline();

    page.upload();
    browser.run();
    expect(page.requests).toHaveLength(0);
    expect(recorded(page)).toBe(false);

    browser.network.goOnline();
    page.upload('online');
    browser.scheduler.advanceBy(ONLINE_DELAY_MS - 1);
    expect(page.requests).toHaveLength(0);
    browser.scheduler.advanceBy(1);
    browser.run();
    expect(page.requests).toHaveLength(1);
    expect(page.stored()).toEqual([]);
  });

  it('the kill switch blocks uploads', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.flags.stopCollecting();

    page.upload();
    browser.run();

    expect(page.requests).toHaveLength(0);
    expect(page.stored()).toHaveLength(1);
  });

  it('no request while opted out, and the queue is sent at the next trigger after optIn()', () => {
    const browser = new Browser();
    const page = browser.page();
    const ids = page.write(3);
    page.allowed = false;

    page.upload();
    page.upload('hidden');
    browser.run();
    expect(page.requests).toHaveLength(0);

    page.allowed = true;
    page.upload();
    browser.run();
    expect(page.sent()).toEqual([ids]);
  });

  it('a request in flight at an opt-out completes and no new upload starts', () => {
    const browser = new Browser();
    const page = browser.page();
    const first = page.write(60);
    const second = page.write(60);
    page.fake.enqueue(delayed(OK, 1_000));

    page.upload();
    page.allowed = false;
    expect(page.uploader.busy).toBe(true);
    browser.scheduler.advanceBy(1_000);
    browser.run();

    expect(page.uploader.busy).toBe(false);
    expect(page.sent()).toEqual([first]);
    expect(page.sentUpdates()).toEqual([first]);
    expect(page.stored()).toEqual(second);
  });

  it('a pause in force means no request, the hiding path included, and the timer sends when it ends', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(429, { headers: { 'Retry-After': '60' } }));

    page.upload();
    browser.run();
    for (const trigger of ['count', 'interval', 'flush', 'immediate', 'hidden', 'pagehide'] as const)
      page.upload(trigger);
    browser.scheduler.advanceBy(59_000);
    expect(page.requests).toHaveLength(1);

    browser.scheduler.advanceBy(7_000);
    browser.run();
    expect(page.requests).toHaveLength(2);
    expect(page.stored()).toEqual([]);
  });

  it('a page whose host is blocked as mixed content sends nothing', () => {
    const browser = new Browser();
    const page = browser.page({ hostSecurity: 'blocked' });
    page.write(1);

    page.upload();
    page.upload('hidden');
    browser.run();

    expect(page.requests).toHaveLength(0);
    expect(page.stored()).toHaveLength(1);
  });
});

describe('the network returning (Web Retry 2)', () => {
  it('ends a wait caused by the network with one early attempt', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    // Each attempt is refused with keepalive and fails as `io` without it (Web HTTP 3).
    page.fake.enqueue(REFUSED, REFUSED, REFUSED, REFUSED);

    page.upload();
    browser.run();
    browser.scheduler.advanceBy(3_000);
    browser.run();
    expect(page.requests).toHaveLength(4);
    const waitEnd = page.retry().paused_until as number;
    expect(page.retry()).toMatchObject({ step: 2, last_failure: 'io' });
    expect(waitEnd - browser.clock.now()).toBeGreaterThan(ONLINE_DELAY_MS);

    page.upload('online');
    browser.scheduler.advanceBy(ONLINE_DELAY_MS);
    browser.run();

    expect(page.requests).toHaveLength(5);
    expect(browser.clock.now()).toBeLessThan(waitEnd);
    expect(page.stored()).toEqual([]);
  });

  it('never shortens a server pause', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(429, { headers: { 'Retry-After': '60' } }));
    page.upload();
    browser.run();

    page.upload('online');
    browser.scheduler.advanceBy(ONLINE_DELAY_MS);
    browser.run();

    expect(page.requests).toHaveLength(1);
  });

  it('without a network wait, goes through the gate like any trigger', () => {
    const browser = new Browser();
    const page = browser.page();
    const ids = page.write(1);

    page.upload('online');
    browser.scheduler.advanceBy(ONLINE_DELAY_MS);
    browser.run();

    expect(page.sent()).toEqual([ids]);
  });
});

describe('timers are hints (Web Retry 3)', () => {
  it('a wait that ended while the timer did not fire is tried when the page becomes visible', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(503));
    page.upload();
    browser.run();
    page.lifecycle.hide();

    // A hidden page's timer comes late: the clock moves, the timer has not run.
    browser.clock.advanceBy(5_000);
    expect(page.requests).toHaveLength(1);
    page.lifecycle.show();

    expect(page.requests).toHaveLength(2);
  });

  it('and when the page returns from the back/forward cache', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(503));
    page.upload();
    browser.run();

    browser.clock.advanceBy(5_000);
    page.lifecycle.pageshowPersisted();

    expect(page.requests).toHaveLength(2);
  });

  it('becoming visible during a wait sends nothing early', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(503));
    page.upload();
    browser.run();

    page.lifecycle.hide();
    page.lifecycle.show();

    expect(page.requests).toHaveLength(1);
  });

  it('no timer without pending chunks', () => {
    const browser = new Browser();
    const page = browser.page();
    const other = browser.page();
    page.write(1);
    page.fake.enqueue(responseOutcome(503));
    page.upload();
    browser.run();

    // Another page sends the chunk meanwhile and deletes it.
    other.chunks.clear();
    browser.scheduler.runAll();

    expect(page.requests).toHaveLength(1);
    expect(browser.scheduler.pendingCount).toBe(0);
  });
});

describe('the keepalive budget and the hiding path (Web Queue 5, Web HTTP 2, 3)', () => {
  it('a body within 48 KiB is keepalive and may be compressed', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(10);

    page.upload();

    expect(page.requests[0]).toMatchObject({ keepalive: true, compress: true });
  });

  it('a larger batch goes without keepalive', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(90, { pad: 1_000 });

    page.upload();

    const request = page.requests[0] as HttpRequest;
    expect(request.keepalive).toBe(false);
    expect(idsOf(request)).toHaveLength(90);
    expect(utf8ByteLength(request.body ?? '')).toBeGreaterThan(KEEPALIVE_BUDGET_BYTES);
  });

  it('on hiding the request starts inside the event, uncompressed, within the budget; the rest follows while the page lives', () => {
    const browser = new Browser();
    const page = browser.page();
    const ids = page.write(90, { pad: 1_000 });

    page.upload('hidden');

    expect(page.requests).toHaveLength(1);
    const first = page.requests[0] as HttpRequest;
    expect(first).toMatchObject({ keepalive: true, compress: false });
    expect(utf8ByteLength(first.body ?? '')).toBeLessThanOrEqual(KEEPALIVE_BUDGET_BYTES);

    browser.run();

    expect(page.sent().flat()).toEqual(ids);
    expect(page.requests[1]?.compress).toBe(true);
    expect(page.stored()).toEqual([]);
  });

  it('pagehide starts its request inside the event as well', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);

    page.upload('pagehide');

    expect(page.requests[0]).toMatchObject({ keepalive: true, compress: false });
  });

  it('a refused keepalive request is tried once without keepalive while the page lives', () => {
    const browser = new Browser();
    const page = browser.page();
    const ids = page.write(1);
    page.fake.enqueue(REFUSED);

    page.upload('hidden');
    browser.run();

    expect(page.requests.map((request) => request.keepalive)).toEqual([true, false]);
    expect(page.sent()).toEqual([ids, ids]);
    expect(page.stored()).toEqual([]);
    expect(recorded(page)).toBe(false);
  });

  it('a refused keepalive request is not tried again on pagehide, and nothing is recorded', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(REFUSED);

    page.upload('pagehide');
    browser.scheduler.runAll();

    expect(page.requests).toHaveLength(1);
    expect(page.stored()).toHaveLength(1);
    expect(recorded(page)).toBe(false);
  });

  it('the attempt without keepalive is a normal failure when it fails too', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(REFUSED, REFUSED);

    page.upload();
    browser.run();

    expect(page.requests.map((request) => request.keepalive)).toEqual([true, false]);
    expect(page.retry()).toMatchObject({ step: 1, last_failure: 'io' });
  });

  it('no attempt without keepalive after an opt-out', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.enqueue(delayed(REFUSED, 100));

    page.upload();
    page.allowed = false;
    browser.scheduler.advanceBy(100);
    browser.run();

    expect(page.requests).toHaveLength(1);
    expect(page.stored()).toHaveLength(1);
  });
});

describe('an old device id is never sent (Web Privacy 3)', () => {
  it('lines of another device id are left out of the body and leave with their chunk, uncounted', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2, { deviceId: OTHER_DEVICE_ID });
    const current = page.write(2);

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([current]);
    expect(page.stored()).toEqual([]);
    expect(page.drops.size).toBe(0);
    expect(page.droppedUpdates()).toEqual([]);
    expect(page.sentUpdates()).toEqual([current]);
  });

  it('a chunk of only old lines is deleted without a request', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2, { deviceId: OTHER_DEVICE_ID });

    page.upload();
    browser.run();

    expect(page.requests).toHaveLength(0);
    expect(page.stored()).toEqual([]);
  });

  it('when no stored identity can be read the upload waits and nothing is deleted', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2);
    page.deviceId = undefined;

    page.upload();
    browser.run();

    expect(page.requests).toHaveLength(0);
    expect(page.stored()).toHaveLength(2);
  });
});

describe('two pages (Web Queue 2)', () => {
  it("a page sends its own chunks first, then other pages' released ones", () => {
    const browser = new Browser();
    const other = browser.page();
    const theirs = other.write(60);
    other.chunks.release();
    browser.scheduler.advanceBy(1_000);
    const page = browser.page();
    const own = page.write(60);

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([own, theirs]);
  });

  it('a released chunk is sent by the other page and deleted once, its marker with it', () => {
    const browser = new Browser();
    const closed = browser.page();
    const ids = closed.write(3);
    closed.chunks.release();
    closed.uploader.stop();
    const page = browser.page();

    page.upload();
    browser.run();
    page.chunks.walk();

    expect(page.sent()).toEqual([ids]);
    expect(page.sentUpdates()).toEqual([ids]);
    expect(closed.updates).toEqual([]);
    expect(page.stored()).toEqual([]);
    expect(browser.storage.area.entries.has(markerKey(KEY_HASH, closed.chunks.pageId))).toBe(false);
  });

  it("another page's chunk is left alone until it is released or older than the age threshold", () => {
    const browser = new Browser();
    const other = browser.page();
    const ids = other.write(3);
    const page = browser.page();

    page.upload();
    browser.run();
    expect(page.requests).toHaveLength(0);

    browser.scheduler.advanceBy(ADOPT_AFTER_MS - 1);
    page.upload();
    browser.run();
    expect(page.requests).toHaveLength(0);

    browser.scheduler.advanceBy(1);
    page.upload();
    browser.run();
    expect(page.sent()).toEqual([ids]);
  });

  it('a chunk that vanishes between the walk and the read is skipped', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2);
    page.write(2);
    const [gone, kept] = page.chunks.walk() ?? [];
    const keptIds = page.stored().slice(2);
    page.storage.vanishAfterListing(gone?.key ?? '');

    page.upload();
    browser.run();

    expect(page.sent()).toEqual([keptIds]);
    expect(kept).toBeDefined();
    expect(page.stored()).toEqual([]);
    expect(page.logged('WORKER_FAILED')).toBe(0);
  });

  it('the same chunk sent by two pages is tolerated: deleted once, nothing fails', () => {
    const browser = new Browser();
    const owner = browser.page();
    const ids = owner.write(3);
    owner.fake.enqueue(delayed(OK, 1_000));
    owner.upload();
    owner.chunks.release();
    const page = browser.page();
    page.fake.enqueue(delayed(OK, 500));

    page.upload();
    browser.scheduler.advanceBy(1_000);
    browser.run();

    expect(owner.sent()).toEqual([ids]);
    expect(page.sent()).toEqual([ids]);
    expect(page.stored()).toEqual([]);
    expect(owner.sentUpdates()).toEqual([ids]);
    expect(page.sentUpdates()).toEqual([ids]);
    expect([...owner.sink.lines, ...page.sink.lines].filter((entry) => entry.level !== 'debug')).toEqual([]);
  });

  it('a 429 seen by one page pauses the other', () => {
    const browser = new Browser();
    const first = browser.page();
    const second = browser.page();
    first.write(1);
    second.write(1);
    first.fake.enqueue(responseOutcome(429, { headers: { 'Retry-After': '60' } }));

    first.upload();
    browser.run();
    second.upload();
    second.upload('hidden');
    browser.run();

    expect(second.requests).toHaveLength(0);
  });
});

describe('a poison chunk (Web Retry 1.6)', () => {
  it('is deleted as retry_exhausted only after other batches succeed, counted and reported by the page that deleted it', () => {
    const browser = new Browser();
    let poison: string[] = [];
    const page = browser.page({
      answer: (request) => (idsOf(request).some((id) => poison.includes(id)) ? responseOutcome(500) : OK),
    });
    poison = page.write(60);
    browser.scheduler.advanceBy(1);
    const healthy = page.write(60);

    page.upload();
    browser.scheduler.runAll();

    expect(page.sent()).toEqual([...Array<string[]>(5).fill(poison), healthy, ...Array<string[]>(5).fill(poison)]);
    expect(page.stored()).toEqual([]);
    expect(page.drops.get('retry_exhausted')).toBe(60);
    expect(page.droppedUpdates()).toEqual([{ type: 'dropped', messageIds: poison, reason: 'retry_exhausted' }]);
    expect(page.logged('RETRY_EXHAUSTED')).toBe(1);
    expect(page.retry().suspects).toEqual({});
  });
});

describe('with the writer (Queue 2, Web Queue 3)', () => {
  function wire(page: Page, settings = { flushAt: 30, flushIntervalMs: 5_000 }): Writer {
    const writer = new Writer({
      pipeline: {
        process: () => {
          throw new Error('no events in these tests');
        },
      },
      chunks: page.chunks,
      startup: () => ({ ...settings, immediateEvents: new Set<string>() }),
      flags: page.flags,
      eventsAllowed: () => true,
      currentDeviceId: () => DEVICE_ID,
      drops: { count: () => undefined },
      persist: () => undefined,
      upload: (trigger) => {
        page.upload(trigger);
      },
      scheduler: page.browser.scheduler,
      clock: page.browser.clock,
      lifecycle: page.lifecycle,
      network: page.browser.network,
      log: page.log,
    });
    writer.start();
    return writer;
  }

  it('leftover chunks start the interval at load, and its flush sends them; never a flush at start', () => {
    const browser = new Browser();
    const earlier = browser.page();
    const ids = earlier.write(3);
    earlier.chunks.release();
    const page = browser.page();
    wire(page);

    browser.run();
    expect(page.requests).toHaveLength(0);
    browser.scheduler.advanceBy(4_999);
    expect(page.requests).toHaveLength(0);
    browser.scheduler.advanceBy(1);
    browser.run();

    expect(page.sent()).toEqual([ids]);
  });

  it('hiding sends synchronously inside the visibilitychange event', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2);
    wire(page);
    browser.run();

    page.lifecycle.hide();

    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({ keepalive: true, compress: false });
  });

  it('online sends what is pending after the short delay', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(2);
    wire(page);
    browser.run();
    browser.network.goOffline();

    browser.network.goOnline();
    browser.run();
    expect(page.requests).toHaveLength(0);
    browser.scheduler.advanceBy(ONLINE_DELAY_MS);
    browser.run();

    expect(page.requests).toHaveLength(1);
  });
});

describe('failures never reach the caller', () => {
  it('a throwing chunk store is WORKER_FAILED and the upload returns normally', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.chunks.walk = () => {
      throw new Error('broken');
    };

    expect(() => {
      page.upload();
      page.upload('hidden');
    }).not.toThrow();
    browser.run();

    expect(page.requests).toHaveLength(0);
    expect(page.logged('WORKER_FAILED')).toBe(1);
    expect(page.sink.lines.some((entry) => entry.message.includes('broken'))).toBe(false);
  });

  it('a throwing transport is a failure of the request, never an exception', () => {
    const browser = new Browser();
    const page = browser.page();
    page.write(1);
    page.fake.send = () => {
      throw new Error('broken');
    };

    expect(() => {
      page.upload();
    }).not.toThrow();
    browser.run();

    expect(page.stored()).toHaveLength(1);
    expect(page.logged('HTTP_UNEXPECTED')).toBe(1);
  });
});
