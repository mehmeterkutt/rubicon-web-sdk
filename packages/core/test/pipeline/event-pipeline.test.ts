import { FakeContextProvider, RecordingSink, SeededRandom, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import type {
  BeforeSend,
  CallTimeContextRequest,
  CallTimeContextValues,
  CapturedEvent,
  ContextField,
  ContextProvider,
  Event,
  EventPipelineOptions,
  IdentitySnapshot,
  IssueCode,
  LogOptions,
  PipelineResult,
  PreparedEvent,
  SessionOutcome,
  StaticContextValues,
  TrackEvent,
} from '../../src';
import {
  eventLine,
  EventPipeline,
  LIBRARY_NAME,
  Log,
  MAX_EVENT_BYTES,
  SDK_VERSION,
  SESSION_ENDED,
  SESSION_STARTED,
  UuidV7Generator,
} from '../../src';
import { DEVICE_ID, fullContext, identify as goldenIdentify, track as goldenTrack } from '../event/sample-events';
import { browser, endedOf, openSessionPage, TIMEOUT } from '../session/session-test-support';
import type { SessionPage } from '../session/session-test-support';

// The port of the Android EventPipelineTest (Public API 4, Event Model 1, 3, Context 2, 6, Session 5;
// Android log 6.3a) for Web Public API 5, Web Event Model 1 and Web Queue 1: the event built at the
// call with its session, context and super properties, then the hooks and the second validation on
// the writer. The hook rules themselves are tested one by one in event/hook-rules.test.ts (step
// 3.2); here they are seen through the pipeline. The Android size-limit tests belong to the writer
// (step 6.3b), which owns the 32 KB scan and the `oversize` drop on the web (section 15, step 2.5);
// "throws in debug" is the developer-error form of Web Public API 4 instead.

const NOW = 1_759_147_200_123;

/** The golden file's values as the browser provider and the configuration give them. */
const STATIC: StaticContextValues = {
  osName: 'Android',
  browserName: 'Chrome',
  browserVersion: '141',
  deviceType: 'phone',
  screenWidth: 1080,
  screenHeight: 2400,
  screenDensity: 2.625,
  pageReferrer: 'https://www.example.com/',
};

const CALL_TIME: CallTimeContextValues = {
  pageUrl: 'https://shop.example.com/orders/:id',
  viewportWidth: 412,
  viewportHeight: 915,
  pageQuery: { page: '2', utm_source: 'mail' },
  pageTitle: 'Checkout',
  locale: 'tr-TR',
  timezone: 'Europe/Istanbul',
};

const APP = { name: 'Rubicon', version: '1.4.0', namespace: 'com.rubicon.demo' };

const IDENTITY: IdentitySnapshot = {
  deviceId: DEVICE_ID,
  userId: 'user-42',
  personEpoch: '0123456789abcdef',
  superProperties: {},
};

const NO_SESSION: SessionOutcome = { session: undefined, before: [] };

interface Setup {
  readonly pipeline: EventPipeline;
  readonly sink: RecordingSink;
  readonly counted: IssueCode[];
  readonly provider: FakeContextProvider;
}

interface SetupOptions {
  readonly hooks?: readonly BeforeSend[];
  readonly disabled?: readonly ContextField[];
  readonly pageTitle?: boolean;
  readonly context?: ContextProvider;
  readonly session?: SessionOutcome;
  readonly log?: Partial<LogOptions>;
}

// A pipeline over a session that answers `options.session` for every event, so the event's own
// steps are seen alone; the session tests below use the real session manager.
function setup(options: SetupOptions = {}): Setup {
  const sink = new RecordingSink();
  const counted: IssueCode[] = [];
  const log = new Log({
    level: 'debug',
    debug: false,
    sink,
    issues: { increment: (code) => counted.push(code) },
    ...options.log,
  });
  const provider = new FakeContextProvider(STATIC, CALL_TIME);
  const pipeline = new EventPipeline({
    config: config(options),
    context: options.context ?? provider,
    sessions: { onEvent: () => options.session ?? NO_SESSION },
    ids: new UuidV7Generator(new TestClock(NOW), new SeededRandom(7)),
    log,
  });
  return { pipeline, sink, counted, provider };
}

function config(options: SetupOptions): EventPipelineOptions['config'] {
  return {
    beforeSend: options.hooks ?? [],
    disabledFields: new Set(options.disabled ?? []),
    app: APP,
    pageQueryParams: ['page'],
    pageTitle: options.pageTitle ?? true,
  };
}

function captured(overrides: Partial<Extract<CapturedEvent, { type: 'track' | 'screen' }>> = {}): CapturedEvent {
  return {
    type: 'track',
    name: 'Purchase Completed',
    properties: { amount: 9.99 },
    source: 'app',
    messageId: 'm-1',
    timestamp: NOW,
    visible: true,
    identity: IDENTITY,
    callTime: CALL_TIME,
    ...overrides,
  };
}

function automatic(): CapturedEvent {
  return captured({
    name: 'Page Viewed',
    properties: { utm_source: 'mail', nested: { x: 1 } },
    source: 'auto',
  });
}

/** The one event `capture` built. */
function single(prepared: readonly PreparedEvent[]): PreparedEvent {
  expect(prepared).toHaveLength(1);
  return prepared[0] as PreparedEvent;
}

/** The event through the whole pipeline: built at the call, then processed on the writer. */
function through(setupResult: Setup, event: CapturedEvent = captured()): PipelineResult {
  return setupResult.pipeline.process(single(setupResult.pipeline.capture(event)));
}

function accepted(result: PipelineResult): Event {
  if (result.kind !== 'accepted') throw new Error(`the event was dropped as ${result.reason}`);
  return result.event;
}

function asTrack(event: Event | undefined): TrackEvent {
  if (event?.type !== 'track') throw new Error('not a track event');
  return event;
}

// A hook written as a JavaScript caller could write it: any result, typed away.
function loose(hook: (event: Event) => unknown): BeforeSend {
  return hook as BeforeSend;
}

function errors(sink: RecordingSink, code: IssueCode): number {
  return sink.lines.filter((line) => line.level === 'error' && line.message.startsWith(`${code}:`)).length;
}

describe('building the event at the call (Event Model 1, Web Queue 1)', () => {
  it('a track event is the event of the golden file', () => {
    const { pipeline } = setup({
      session: { session: { id: '0192e49f-0b1c-7d2e-8f3a-4b5c6d7e8f90', startedAt: 1_759_147_082_000 }, before: [] },
    });

    const prepared = single(
      pipeline.capture(
        captured({
          messageId: goldenTrack.messageId,
          timestamp: goldenTrack.timestamp,
          properties: goldenTrack.properties,
          callTime: pipeline.callTimeValues(),
        }),
      ),
    );

    // sample-events' track is compared with track.json in event-model.test.ts.
    expect(prepared.event).toEqual(goldenTrack);
    expect(eventLine(prepared.event)).toBe(eventLine(goldenTrack));
    expect(prepared).toMatchObject({ oversize: false, skipsHooks: false });
  });

  it('every event carries this library, by name and version', () => {
    const { pipeline } = setup();

    expect(single(pipeline.capture(captured())).event.context.library).toEqual({
      name: LIBRARY_NAME,
      version: SDK_VERSION,
    });
    expect(LIBRARY_NAME).toBe('rubicon-web');
  });

  it('static context is read once, at the first event, never when the pipeline is made', () => {
    const { pipeline, provider } = setup();
    expect(provider.staticReads).toBe(0);

    for (let i = 0; i < 3; i += 1) pipeline.capture(captured());

    expect(provider.staticReads).toBe(1);
  });

  it('call-time values are read with the disabled fields, the query parameters and the title switch', () => {
    const { pipeline, provider } = setup({ disabled: ['locale'], pageTitle: false });

    const values = pipeline.callTimeValues();

    expect(provider.callTimeReads).toBe(1);
    expect(provider.lastDisabled).toEqual(new Set(['locale']));
    expect(values).toEqual({
      pageUrl: CALL_TIME.pageUrl,
      viewportWidth: 412,
      viewportHeight: 915,
      pageQuery: { page: '2' },
      timezone: 'Europe/Istanbul',
    });
  });

  it('disabled fields are passed to the provider and left out of the event, whatever it returns', () => {
    const disabled: ContextField[] = ['app.version', 'device.type', 'browser.version', 'page.query', 'timezone'];
    const seen: (readonly string[])[] = [];
    // A provider that ignores the disabled fields: the pipeline still leaves them out (Context 6).
    const careless: ContextProvider = {
      staticValues: (fields) => {
        seen.push([...fields]);
        return STATIC;
      },
      callTimeValues: (request: CallTimeContextRequest) => {
        seen.push([...request.disabled]);
        return CALL_TIME;
      },
    };
    const { pipeline } = setup({ disabled, context: careless });

    const event = single(pipeline.capture(captured({ callTime: pipeline.callTimeValues() }))).event;

    expect(seen).toEqual([disabled, disabled]);
    expect(event.context.app).toEqual({ name: 'Rubicon', namespace: 'com.rubicon.demo' });
    expect(event.context.device.type).toBeUndefined();
    expect(event.context.browser).toEqual({ name: 'Chrome' });
    expect(event.context.page.query).toBeUndefined();
    expect(event.context.timezone).toBeUndefined();
    expect(event.context.locale).toBe('tr-TR');
    expect(eventLine(event)).not.toContain('timezone');
  });

  it('page.title is sent only with context.page.title, whatever the provider returns', () => {
    const { pipeline } = setup({ pageTitle: false });

    expect(single(pipeline.capture(captured())).event.context.page.title).toBeUndefined();
  });

  it("the event's query object is its own, not the call-time values'", () => {
    const { pipeline } = setup();
    const callTime = { ...CALL_TIME, pageQuery: { page: '2' } };

    const event = single(pipeline.capture(captured({ callTime }))).event;

    expect(event.context.page.query).toEqual({ page: '2' });
    expect(event.context.page.query).not.toBe(callTime.pageQuery);
  });

  it('page.query values are validated as properties: over 1024 code units truncated, once per name', () => {
    const long = 'x'.repeat(1500);
    const {
      pipeline: validating,
      sink,
      counted,
    } = setup({
      context: new FakeContextProvider(STATIC, { ...CALL_TIME, pageQuery: { page: long } }),
    });

    const first = validating.callTimeValues();
    const second = validating.callTimeValues();

    expect(first.pageQuery).toEqual({ page: 'x'.repeat(1024) });
    expect(second.pageQuery).toEqual({ page: 'x'.repeat(1024) });
    const warnings = sink.lines.filter((line) => line.level === 'warn');
    expect(warnings.map((line) => line.message)).toEqual([
      'PROPERTY_TRUNCATED: Property "page.query.page" truncated to 1024 characters.',
    ]);
    expect(warnings.some((line) => line.message.includes('xxx'))).toBe(false);
    expect(counted).toEqual(['PROPERTY_TRUNCATED', 'PROPERTY_TRUNCATED']);
  });

  it('a page.query name that is no valid key is dropped with PROPERTY_DROPPED, the others kept', () => {
    const { sink } = setup();
    const careless: ContextProvider = {
      staticValues: () => STATIC,
      callTimeValues: () => ({ pageQuery: { '': 'a', page: '2', ['n'.repeat(256)]: 'b' } }),
    };
    const { pipeline } = setup({ context: careless, log: { sink } });

    expect(pipeline.callTimeValues().pageQuery).toEqual({ page: '2' });
    expect(sink.lines.filter((line) => line.message.startsWith('PROPERTY_DROPPED:')).length).toBeGreaterThan(0);
  });

  it('a page.query with nothing valid left is absent, and __proto__ stays a field', () => {
    const blank: ContextProvider = {
      staticValues: () => STATIC,
      callTimeValues: () => ({ pageQuery: { '': 'a' } }),
    };
    expect(setup({ context: blank }).pipeline.callTimeValues().pageQuery).toBeUndefined();

    const proto: Record<string, string> = {};
    Object.defineProperty(proto, '__proto__', { value: 'x', enumerable: true });
    const odd: ContextProvider = { staticValues: () => STATIC, callTimeValues: () => ({ pageQuery: proto }) };
    const query = setup({ context: odd }).pipeline.callTimeValues().pageQuery;
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(Object.keys(query ?? {})).toEqual(['__proto__']);
  });

  it("super properties merge, the event's own key wins", () => {
    const { pipeline } = setup();
    const identity = { ...IDENTITY, superProperties: { plan: 'pro', amount: 1 } };

    const event = asTrack(single(pipeline.capture(captured({ identity }))).event);

    expect(event.properties).toEqual({ plan: 'pro', amount: 9.99 });
  });

  it('above 256 properties the super properties are dropped first, with TOO_MANY_PROPERTIES', () => {
    const { pipeline, sink } = setup();
    const own: Record<string, number> = {};
    for (let i = 0; i < 250; i += 1) own[`own_${String(i)}`] = i;
    const supers: Record<string, number> = {};
    for (let i = 0; i < 10; i += 1) supers[`super_${String(i)}`] = i;

    const event = asTrack(
      single(pipeline.capture(captured({ properties: own, identity: { ...IDENTITY, superProperties: supers } }))).event,
    );

    expect(Object.keys(event.properties)).toHaveLength(256);
    expect(Object.keys(event.properties).filter((key) => key.startsWith('own_'))).toHaveLength(250);
    expect(sink.lines.some((line) => line.message.startsWith('TOO_MANY_PROPERTIES:'))).toBe(true);
  });

  it('identify carries traits only, never super properties', () => {
    const { pipeline } = setup();
    const identity = { ...IDENTITY, superProperties: { plan: 'pro' } };

    const event = single(
      pipeline.capture({
        type: 'identify',
        traits: goldenIdentify.traits,
        source: 'app',
        messageId: 'm-1',
        timestamp: NOW,
        visible: true,
        identity,
        callTime: CALL_TIME,
      }),
    ).event;

    expect(event.type).toBe('identify');
    expect(event.type === 'identify' ? event.traits : undefined).toEqual(goldenIdentify.traits);
    expect(event).toMatchObject({ userId: 'user-42', deviceId: DEVICE_ID });
  });

  it('screen events carry their name and merged properties', () => {
    const { pipeline } = setup();
    const identity = { ...IDENTITY, superProperties: { plan: 'pro' } };

    const event = single(
      pipeline.capture(captured({ type: 'screen', name: 'checkout', properties: {}, identity })),
    ).event;

    expect(event).toMatchObject({ type: 'screen', name: 'checkout', properties: { plan: 'pro' } });
  });

  it("the caller's identity and time are the event's", () => {
    const { pipeline } = setup();
    const anonymous = { ...IDENTITY, userId: null };

    const event = single(pipeline.capture(captured({ identity: anonymous, timestamp: NOW - 5000 }))).event;

    expect(event).toMatchObject({ userId: null, deviceId: DEVICE_ID, timestamp: NOW - 5000, messageId: 'm-1' });
  });
});

describe('session events (Session 5, Web Session 1 to 5)', () => {
  function pageWithPipeline(hooks: readonly BeforeSend[] = []): { page: SessionPage; pipeline: EventPipeline } {
    const page = openSessionPage(browser());
    const pipeline = new EventPipeline({
      config: config({ hooks }),
      context: new FakeContextProvider(STATIC, CALL_TIME),
      sessions: page.sessions,
      ids: new UuidV7Generator(page.clock, new SeededRandom(11)),
      log: page.log,
    });
    return { page, pipeline };
  }

  function call(
    page: SessionPage,
    overrides: Partial<Extract<CapturedEvent, { type: 'track' | 'screen' }>> = {},
  ): CapturedEvent {
    return captured({ timestamp: page.clock.now(), identity: page.identity.snapshot(), ...overrides });
  }

  it('the first visible event gets Session Started right before it, in the new session', () => {
    const { page, pipeline } = pageWithPipeline();

    const [started, event, ...rest] = pipeline.capture(call(page));

    expect(rest).toEqual([]);
    const startedEvent = asTrack(started?.event);
    const start = page.clock.now();
    expect(startedEvent).toMatchObject({ name: SESSION_STARTED, source: 'auto', properties: {}, timestamp: start });
    expect(startedEvent.messageId).not.toBe('m-1');
    expect(event?.event.context.session).toEqual({ id: startedEvent.context.session?.id, startedAt: start });
    expect(event?.event.messageId).toBe('m-1');
  });

  it('a later event in the same session gets none and carries the session', () => {
    const { page, pipeline } = pageWithPipeline();
    const first = pipeline.capture(call(page));
    page.clock.advanceBy(1000);

    const second = single(pipeline.capture(call(page, { messageId: 'm-2' })));

    expect(second.event.context.session).toEqual(first[1]?.event.context.session);
  });

  it('session events take the call-time context of the event that caused them', () => {
    const { page, pipeline } = pageWithPipeline();
    const callTime = { ...CALL_TIME, pageUrl: 'https://shop.example.com/cart' };

    const [started] = pipeline.capture(call(page, { callTime }));

    expect(started?.event.context.page.url).toBe('https://shop.example.com/cart');
  });

  it('Session Ended is backdated, carries the duration and the ended session', () => {
    const { page, pipeline } = pageWithPipeline();
    const start = page.clock.now();
    const first = pipeline.capture(call(page));
    page.clock.advanceBy(60_000);
    pipeline.capture(call(page, { messageId: 'm-2' }));
    page.clock.advanceBy(TIMEOUT + 1);

    const prepared = pipeline.sessionEvents(page.load(), page.identity.snapshot(), CALL_TIME);

    const ended = asTrack(single(prepared).event);
    expect(ended).toMatchObject({
      name: SESSION_ENDED,
      source: 'auto',
      timestamp: start + 60_000,
      properties: { duration_ms: 60_000 },
    });
    expect(ended.context.session).toEqual(first[1]?.event.context.session);
    const next = pipeline.capture(call(page, { messageId: 'm-3' }));
    expect(asTrack(next[0]?.event).name).toBe(SESSION_STARTED);
  });

  it('an end found at an event comes before Session Started and the event', () => {
    const { page, pipeline } = pageWithPipeline();
    pipeline.capture(call(page));
    page.clock.advanceBy(TIMEOUT + 1);

    const names = pipeline.capture(call(page, { messageId: 'm-2' })).map((prepared) => asTrack(prepared.event).name);

    expect(names).toEqual([SESSION_ENDED, SESSION_STARTED, 'Purchase Completed']);
  });

  it('a session ended by a person change carries the previous user and super properties', () => {
    const { page, pipeline } = pageWithPipeline();
    page.identity.identify('user-42', undefined);
    page.identity.register('plan', 'pro');
    pipeline.capture(call(page));
    page.events.length = 0;

    page.identity.identify('user-43', undefined);
    const prepared = pipeline.sessionEvents([endedOf(page.events)], page.identity.snapshot(), CALL_TIME);

    const ended = asTrack(single(prepared).event);
    expect(ended.name).toBe(SESSION_ENDED);
    expect(ended.userId).toBe('user-42');
    expect(ended.properties.plan).toBe('pro');
    expect(page.identity.snapshot().userId).toBe('user-43');
  });

  it('session events reach the hooks as automatic events, before the event', () => {
    const seen: string[] = [];
    const { page, pipeline } = pageWithPipeline([
      (event) => {
        seen.push(`${event.type === 'track' ? event.name : event.type}/${event.source}`);
        return event;
      },
    ]);

    for (const prepared of pipeline.capture(call(page))) pipeline.process(prepared);

    expect(seen).toEqual(['Session Started/auto', 'Purchase Completed/app']);
  });

  it('a hidden event without a session has no session context and starts none', () => {
    const { page, pipeline } = pageWithPipeline();

    const event = single(pipeline.capture(call(page, { visible: false }))).event;

    expect(event.context.session).toBeUndefined();
    expect(eventLine(event)).not.toContain('"session"');
  });
});

describe('hooks on the app events (Public API 4, Web Public API 5)', () => {
  it('without hooks the event passes as built', () => {
    const setupResult = setup();
    const prepared = single(setupResult.pipeline.capture(captured()));

    expect(setupResult.pipeline.process(prepared)).toEqual({
      kind: 'accepted',
      event: prepared.event,
      oversize: false,
    });
  });

  it('run in list order, each seeing the previous result', () => {
    const order: number[] = [];
    const hooks: BeforeSend[] = [
      (event) => {
        order.push(1);
        return event.type === 'track' ? { ...event, properties: { ...event.properties, a: 1 } } : event;
      },
      (event) => {
        order.push(2);
        if (event.type !== 'track') return event;
        const a = event.properties.a;
        return {
          ...event,
          name: 'Order Placed',
          properties: { ...event.properties, b: typeof a === 'number' ? a + 1 : 0 },
        };
      },
    ];

    const event = asTrack(accepted(through(setup({ hooks }))));

    expect(order).toEqual([1, 2]);
    expect(event.name).toBe('Order Placed');
    expect(event.properties).toEqual({ amount: 9.99, a: 1, b: 2 });
  });

  it('null drops the event as before_send, quietly', () => {
    const setupResult = setup({ hooks: [() => null] });

    expect(through(setupResult)).toEqual({ kind: 'dropped', messageId: 'm-1', reason: 'before_send' });
    expect(setupResult.sink.lines.map((line) => line.level)).toEqual(['debug']);
    expect(setupResult.counted).toEqual([]);
  });

  it('a throwing hook drops the event with HOOK_THREW, and later hooks do not run', () => {
    let later = false;
    const setupResult = setup({
      hooks: [
        () => {
          throw new Error('bug');
        },
        (event) => {
          later = true;
          return event;
        },
      ],
    });

    expect(through(setupResult)).toMatchObject({ kind: 'dropped', reason: 'before_send' });
    expect(errors(setupResult.sink, 'HOOK_THREW')).toBe(1);
    expect(later).toBe(false);
  });

  it('an invalid property from a hook is dropped by the second validation, the event kept', () => {
    const setupResult = setup({
      hooks: [
        loose((event) => (event.type === 'track' ? { ...event, properties: { ...event.properties, at: NaN } } : event)),
      ],
    });

    const event = asTrack(accepted(through(setupResult)));

    expect(event.properties).toEqual({ amount: 9.99 });
    expect(
      setupResult.sink.lines.some((line) => line.level === 'warn' && line.message.startsWith('PROPERTY_DROPPED:')),
    ).toBe(true);
  });

  it('a renamed event with an invalid name is a violation', () => {
    const setupResult = setup({ hooks: [(event) => (event.type === 'track' ? { ...event, name: ' ' } : event)] });

    expect(through(setupResult)).toMatchObject({ kind: 'dropped', reason: 'before_send' });
    expect(errors(setupResult.sink, 'HOOK_VIOLATION')).toBe(1);
  });

  it('a hook changes only its own copy: the prepared event stays as built', () => {
    const setupResult = setup({
      hooks: [
        loose((event) => {
          (event as unknown as { properties: Record<string, unknown> }).properties.amount = 0;
          return null;
        }),
      ],
    });
    const prepared = single(setupResult.pipeline.capture(captured()));
    const before = eventLine(prepared.event);

    setupResult.pipeline.process(prepared);

    expect(eventLine(prepared.event)).toBe(before);
  });
});

describe('hooks on automatic events (Public API 4, Android log 3.2)', () => {
  it('may change values, to null, to another type and nested', () => {
    const setupResult = setup({
      hooks: [
        (event) =>
          event.type === 'track' ? { ...event, properties: { utm_source: null, nested: { y: [1, 2] } } } : event,
      ],
    });

    const event = asTrack(accepted(through(setupResult, automatic())));

    expect(event.properties).toEqual({ utm_source: null, nested: { y: [1, 2] } });
    expect(setupResult.counted).toEqual([]);
  });

  it('renaming, adding or removing a top-level key, or returning null drops it with HOOK_VIOLATION', () => {
    const breaches: BeforeSend[] = [
      (event) => (event.type === 'track' ? { ...event, name: 'Page Seen' } : event),
      (event) => (event.type === 'track' ? { ...event, properties: { ...event.properties, extra: 1 } } : event),
      (event) => (event.type === 'track' ? { ...event, properties: { utm_source: 'mail' } } : event),
      () => null,
    ];

    for (const breach of breaches) {
      const setupResult = setup({ hooks: [breach] });
      expect(through(setupResult, automatic())).toMatchObject({ kind: 'dropped', reason: 'before_send' });
      expect(setupResult.counted).toEqual(['HOOK_VIOLATION']);
    }
  });
});

describe('results that are not a copy (Android log 6.3)', () => {
  it('an event of another kind is dropped', () => {
    const other = single(
      setup().pipeline.capture(captured({ type: 'screen', name: 'checkout', properties: {} })),
    ).event;
    const setupResult = setup({ hooks: [() => other] });

    expect(through(setupResult)).toMatchObject({ kind: 'dropped', reason: 'before_send' });
    expect(errors(setupResult.sink, 'HOOK_VIOLATION')).toBe(1);
  });

  it('an event with another message id is dropped', () => {
    const impostor = single(setup().pipeline.capture(captured({ messageId: 'm-2' }))).event;

    expect(through(setup({ hooks: [() => impostor] }))).toMatchObject({ kind: 'dropped' });
  });

  it('an event built from scratch with another context is dropped', () => {
    const built: BeforeSend = (event) => ({
      type: 'track',
      name: 'Purchase Completed',
      source: event.source,
      messageId: event.messageId,
      timestamp: event.timestamp,
      userId: event.userId,
      deviceId: event.deviceId,
      properties: {},
      context: fullContext,
    });

    expect(through(setup({ hooks: [built] }))).toMatchObject({ kind: 'dropped', reason: 'before_send' });
  });
});

describe('SDK Diagnostics (Logging 5)', () => {
  it('never reaches a hook and passes as built', () => {
    let called = false;
    const setupResult = setup({
      hooks: [
        () => {
          called = true;
          return null;
        },
      ],
    });
    const prepared = single(
      setupResult.pipeline.capture(
        captured({
          name: 'SDK Diagnostics',
          properties: { dropped: { total: 1 } },
          source: 'auto',
          skipsHooks: true,
        }),
      ),
    );

    const result = setupResult.pipeline.process(prepared);

    expect(called).toBe(false);
    expect(prepared.skipsHooks).toBe(true);
    expect(result).toEqual({ kind: 'accepted', event: prepared.event, oversize: false });
  });
});

describe('the size flag (section 15, step 2.5; the drop is the writer, step 6.3b)', () => {
  it("the call's flag is carried to the writer and nothing is dropped for it here", () => {
    const setupResult = setup();
    const prepared = single(setupResult.pipeline.capture(captured({ oversize: true })));

    expect(prepared.oversize).toBe(true);
    expect(setupResult.pipeline.process(prepared)).toMatchObject({ kind: 'accepted', oversize: true });
  });

  it("a hook's values over the limit set the flag through the second pass", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) big[`k${String(i)}`] = 'x'.repeat(1000);
    const setupResult = setup({
      hooks: [(event) => (event.type === 'track' ? { ...event, properties: { ...event.properties, ...big } } : event)],
    });

    expect(40 * 1000).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(through(setupResult)).toMatchObject({ kind: 'accepted', oversize: true });
  });
});

describe('developer errors (Web Public API 4, Web Logging 1)', () => {
  const forgotten = loose(() => undefined);

  it('with debug a hook violation is written in the error form, and nothing is thrown', () => {
    const setupResult = setup({ hooks: [forgotten], log: { debug: true } });

    let result: PipelineResult | undefined;
    expect(() => {
      result = through(setupResult);
    }).not.toThrow();

    expect(result).toMatchObject({ kind: 'dropped', reason: 'before_send' });
    expect(setupResult.sink.lines).toEqual([
      {
        level: 'error',
        message:
          'HOOK_VIOLATION: A beforeSend hook returned undefined instead of the event or null; the event was dropped',
        developerErrorForm: true,
      },
    ]);
  });

  it('without debug the same violation is a plain ERROR line', () => {
    const setupResult = setup({ hooks: [forgotten] });

    through(setupResult);

    expect(setupResult.sink.lines.map((line) => [line.level, line.developerErrorForm])).toEqual([['error', false]]);
  });

  it('off silences violations and throws, with debug true and false, and still counts them', () => {
    for (const debug of [true, false]) {
      const thrown: BeforeSend = () => {
        throw new Error('x');
      };
      const violation = setup({ hooks: [forgotten], log: { level: 'off', debug } });
      const threw = setup({ hooks: [thrown], log: { level: 'off', debug } });

      expect(through(violation)).toMatchObject({ kind: 'dropped' });
      expect(through(threw)).toMatchObject({ kind: 'dropped' });
      expect([...violation.sink.lines, ...threw.sink.lines]).toEqual([]);
      expect([...violation.counted, ...threw.counted]).toEqual(['HOOK_VIOLATION', 'HOOK_THREW']);
    }
  });
});
