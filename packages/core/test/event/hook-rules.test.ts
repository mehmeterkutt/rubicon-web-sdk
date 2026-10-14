import { RecordingLogger, RecordingSink, SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import type { BeforeSend, Event, HookOutcome, IssueCode, LogOptions, TrackEvent } from '../../src';
import { checkHookResult, copyEvent, eventLine, Log, MAX_EVENT_BYTES, runHooks } from '../../src';
import { identify, screen, sessionStarted, track } from './sample-events';

// The hook rules of Public API 4 and Web Public API 5, ported from the hook tests of the Android
// EventPipelineTest and the iOS EventModelTests (Android log 3.2, 6.3, 6.3a; iOS log 3.2): each
// hook gets its own deep copy, a result is accepted only as the input's kind with its fixed fields,
// and `undefined`, a Promise or a breach drops the event with HOOK_VIOLATION, a throw with
// HOOK_THREW, never throwing into the host.

function setup(options: Partial<LogOptions> = {}) {
  const sink = new RecordingSink();
  const counted: IssueCode[] = [];
  const log = new Log({
    level: 'debug',
    debug: false,
    sink,
    issues: { increment: (code) => counted.push(code) },
    ...options,
  });
  return { log, sink, counted };
}

function run(hooks: readonly BeforeSend[], event: Event = track, options: Partial<LogOptions> = {}) {
  const context = setup(options);
  const outcome = runHooks(hooks, event, context.log);
  return { ...context, outcome };
}

function kept(outcome: HookOutcome): Event {
  if (!outcome.kept) throw new Error('the event was dropped');
  return outcome.event;
}

// A hook written as a JavaScript caller could write it: any result, typed away.
function loose(hook: (event: Event) => unknown): BeforeSend {
  return hook as BeforeSend;
}

const snapshot = (event: Event): string => JSON.stringify(event);

describe('the copy a hook gets (Web Public API 5)', () => {
  it('a hook mutates its copy and the original is unchanged', () => {
    const before = snapshot(track);
    const mutate = loose((event) => {
      const copy = event as unknown as {
        name: string;
        properties: { items: { qty: number }[]; added?: string };
        context: { page: { query: Record<string, string> }; session: { id: string } };
      };
      copy.name = 'Order Placed';
      copy.properties.items[0] = { qty: 99 };
      copy.properties.added = 'yes';
      copy.context.page.query.page = '3';
      copy.context.session.id = 'another';
      return null;
    });

    const { outcome } = run([mutate]);

    expect(outcome.kept).toBe(false);
    expect(snapshot(track)).toBe(before);
  });

  it('every hook gets a new copy: the second sees the first one changes, never its objects', () => {
    let first: Event | undefined;
    let second: Event | undefined;
    const hooks: BeforeSend[] = [
      (event) => {
        first = event;
        return event.type === 'track' ? { ...event, properties: { ...event.properties, step: 1 } } : event;
      },
      (event) => {
        second = event;
        return event;
      },
    ];

    const { outcome } = run(hooks);

    expect(second).not.toBe(first);
    expect(second?.context).not.toBe(first?.context);
    expect(second?.context).not.toBe(track.context);
    expect(second?.type === 'track' && second.properties.step).toBe(1);
    expect(kept(outcome)).toEqual({ ...track, properties: { ...track.properties, step: 1 } });
  });

  it('a copy is deep: lists, objects and the context groups are new, values equal', () => {
    const copy = copyEvent(track) as TrackEvent;

    expect(copy).toEqual(track);
    expect(copy).not.toBe(track);
    expect(copy.properties).not.toBe(track.properties);
    expect(copy.properties.items).not.toBe(track.properties.items);
    expect(copy.context).not.toBe(track.context);
    expect(copy.context.page).not.toBe(track.context.page);
    expect(copy.context.page.query).not.toBe(track.context.page.query);
    expect(copy.context.library).not.toBe(track.context.library);
    expect(copyEvent(identify)).toEqual(identify);
  });

  it('a __proto__ property is copied as a property', () => {
    const properties = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, never>;
    const copy = copyEvent({ ...track, properties }) as TrackEvent;

    expect(Object.keys(copy.properties)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(copy.properties)).toBe(Object.prototype);
  });

  it('nothing the hook returned is kept: a later change to it changes nothing', () => {
    let returned: { properties: Record<string, unknown> } | undefined;
    const keepsIt = loose((event) => {
      const result = { ...event, properties: { plan: 'pro' } };
      returned = result;
      return result;
    });

    const event = kept(run([keepsIt]).outcome) as TrackEvent;
    if (returned !== undefined) returned.properties.plan = 'free';

    expect(event.properties).toEqual({ plan: 'pro' });
    expect(event.context).toBe(track.context);
  });

  it('without hooks the event goes on as it is', () => {
    const { outcome } = run([]);
    expect(outcome).toEqual({ kept: true, event: track, oversize: false });
    expect(kept(outcome)).toBe(track);
  });
});

describe('what a hook may return for an app event', () => {
  it('the event itself and a changed copy are accepted', () => {
    expect(kept(run([(event) => event]).outcome)).toEqual(track);

    const renamed = kept(run([(event) => ({ ...event, name: 'Order Placed', properties: { a: 1 } })]).outcome);
    expect(renamed).toEqual({ ...track, name: 'Order Placed', properties: { a: 1 } });

    const traits = kept(run([(event) => ({ ...event, traits: { plan: 'free' } })], identify).outcome);
    expect(traits).toEqual({ ...identify, traits: { plan: 'free' } });
  });

  it('a copy changed in place is accepted with its name and values', () => {
    const inPlace = loose((event) => {
      const copy = event as unknown as { name: string; properties: Record<string, unknown> };
      copy.name = 'Order Placed';
      copy.properties.currency = 'EUR';
      return copy;
    });

    const event = kept(run([inPlace]).outcome) as TrackEvent;

    expect(event.name).toBe('Order Placed');
    expect(event.properties.currency).toBe('EUR');
  });

  it('null drops the event quietly, with a debug line naming its message_id', () => {
    const later: BeforeSend[] = [];
    const { outcome, sink, counted } = run([() => null, ...later]);

    expect(outcome).toEqual({ kept: false });
    expect(sink.lines).toEqual([
      { level: 'debug', message: `A beforeSend hook dropped ${track.messageId}`, developerErrorForm: false },
    ]);
    expect(counted).toEqual([]);
  });

  it('a hook after a drop does not run', () => {
    let calls = 0;
    run([
      () => null,
      (event) => {
        calls += 1;
        return event;
      },
    ]);
    expect(calls).toBe(0);
  });

  it('a context given back as a copy, or without its undefined values, is the same context', () => {
    const spread = kept(
      run([(event) => ({ ...event, context: { ...event.context, page: { ...event.context.page } } })]).outcome,
    );
    expect(spread.context).toBe(track.context);

    const withUndefined: Event = { ...track, context: { ...track.context, locale: undefined } };
    const context = { ...withUndefined.context } as Record<string, unknown>;
    delete context.locale;
    expect(checkHookResult({ ...withUndefined, context }, withUndefined).kind).toBe('accepted');
  });

  it('a name with a lone surrogate goes on with U+FFFD', () => {
    const event = kept(run([(event) => ({ ...event, name: 'Order \uD800' })]).outcome) as TrackEvent;
    expect(event.name).toBe('Order �');
  });

  it('values a hook puts back are validated again, as a call is (Event Model 3)', () => {
    const { outcome, sink } = run([
      loose((event) => ({ ...event, properties: { ok: 1, bad: Number.NaN, map: new Map([['k', 'v']]) } })),
    ]);

    expect((kept(outcome) as TrackEvent).properties).toEqual({ ok: 1, map: { k: 'v' } });
    expect(sink.messages).toEqual([expect.stringMatching(/^PROPERTY_DROPPED: Property "bad"/) as unknown]);
  });

  it('the second pass reports when a hook made the properties larger than an event may be', () => {
    const huge = 'x'.repeat(1000);
    const { outcome } = run([
      (event) => ({
        ...event,
        properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${String(i)}`, huge])),
      }),
    ]);

    expect(outcome.kept && outcome.oversize).toBe(true);
    expect(MAX_EVENT_BYTES).toBe(32 * 1024);
  });
});

describe('results that are dropped with HOOK_VIOLATION', () => {
  const violations: [string, BeforeSend, Event, string][] = [
    ['undefined', loose(() => undefined), track, 'returned undefined instead of the event or null'],
    ['a Promise', loose((event) => Promise.resolve(event)), track, 'returned a Promise; hooks must be synchronous'],
    ['a thenable', loose(() => ({ then: () => undefined })), track, 'returned a Promise; hooks must be synchronous'],
    ['a string', loose(() => 'track'), track, 'returned something that is not an event of its input type'],
    ['a function', loose(() => () => track), track, 'returned something that is not an event of its input type'],
    [
      'another kind',
      (event) => ({ ...identify, context: event.context }),
      track,
      'returned something that is not an event of its input type',
    ],
    [
      'a screen for a track',
      loose((event) => ({ ...event, type: 'screen' })),
      track,
      'returned something that is not an event of its input type',
    ],
    [
      'a changed message id',
      (event) => ({ ...event, messageId: '0192e4a1-0000-7000-8000-000000000000' }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a changed source',
      (event) => ({ ...event, source: 'auto' }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a changed timestamp',
      (event) => ({ ...event, timestamp: event.timestamp + 1 }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a changed user id',
      (event) => ({ ...event, userId: null }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a changed device id',
      (event) => ({ ...event, deviceId: 'other' }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a context without a group',
      loose((event) => ({ ...event, context: { ...event.context, page: undefined } })),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a missing context',
      loose((event) => ({ ...event, context: undefined })),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a context value changed in place',
      loose((event) => {
        (event.context.page as { url?: string }).url = 'https://other.example.com/';
        return event;
      }),
      track,
      'changed the source, ids, timestamp or context of an event',
    ],
    [
      'a context value added in place',
      loose((event) => {
        (event.context.page as { title?: string }).title = 'Secret';
        return event;
      }),
      identify,
      'changed the source, ids, timestamp or context of an event',
    ],
    ['a blank name', (event) => ({ ...event, name: ' ' }), track, 'returned an invalid event name'],
    [
      'a name over 255 code units',
      (event) => ({ ...event, name: 'x'.repeat(256) }),
      screen,
      'returned an invalid event name',
    ],
    [
      'a name that is not a string',
      loose((event) => ({ ...event, name: 42 })),
      track,
      'returned an invalid event name',
    ],
    ['null for an automatic event', () => null, sessionStarted, 'returned null for an automatic event'],
    [
      'a renamed automatic event',
      (event) => ({ ...event, name: 'Session Begun' }),
      sessionStarted,
      'renamed an automatic event',
    ],
    [
      'an added key on an automatic event',
      loose((event) => ({ ...event, properties: { extra: 1 } })),
      sessionStarted,
      'added or removed top-level keys of an automatic event',
    ],
    [
      'a removed key on an automatic event',
      loose((event) => ({ ...event, properties: {} })),
      screen,
      'added or removed top-level keys of an automatic event',
    ],
    [
      'a replaced key on an automatic event',
      loose((event) => ({ ...event, properties: { other: 'annotation' } })),
      screen,
      'added or removed top-level keys of an automatic event',
    ],
    [
      'unsupported properties on an automatic event',
      loose((event) => ({ ...event, properties: 'none' })),
      screen,
      'added or removed top-level keys of an automatic event',
    ],
    [
      'a throwing getter',
      loose((event) => ({
        ...event,
        get deviceId(): string {
          throw new Error('secret');
        },
      })),
      track,
      'returned an event that could not be read',
    ],
    [
      'a revoked Proxy',
      loose((event) => {
        const { proxy, revoke } = Proxy.revocable(event, {});
        revoke();
        return proxy;
      }),
      track,
      'returned an event that could not be read',
    ],
  ];

  it.each(violations)('%s', (_, hook, event, text) => {
    const { outcome, sink, counted } = run([hook], event);

    expect(outcome).toEqual({ kept: false });
    expect(sink.lines).toEqual([
      {
        level: 'error',
        message: `HOOK_VIOLATION: A beforeSend hook ${text}; the event was dropped`,
        developerErrorForm: false,
      },
    ]);
    expect(counted).toEqual(['HOOK_VIOLATION']);
  });

  it('a rejected Promise is never awaited and never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { outcome } = run([loose(() => Promise.reject(new Error('secret')))]);
      expect(outcome).toEqual({ kept: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('a thenable whose then throws is still dropped, and nothing is thrown', () => {
    const hook = loose(() => ({
      then: () => {
        throw new Error('secret');
      },
    }));
    expect(() => run([hook])).not.toThrow();
    expect(run([hook]).outcome).toEqual({ kept: false });
  });

  it('an automatic event may change values: to null, to another type, nested', () => {
    const event = kept(
      run([loose((event) => ({ ...event, properties: { name_source: { masked: [null, 1] } } }))], screen).outcome,
    ) as TrackEvent;

    expect(event.properties).toEqual({ name_source: { masked: [null, 1] } });
    expect(kept(run([(event) => ({ ...event, properties: { name_source: null } })], screen).outcome)).toEqual({
      ...screen,
      properties: { name_source: null },
    });
  });

  it('an automatic event may give its keys back in another order or as a Map', () => {
    const twoKeys: TrackEvent = { ...sessionStarted, properties: { a: 1, b: 2 } };
    expect(kept(run([(event) => ({ ...event, properties: { b: 3, a: 4 } })], twoKeys).outcome)).toEqual({
      ...twoKeys,
      properties: { b: 3, a: 4 },
    });
    const map = loose((event) => ({
      ...event,
      properties: new Map([
        ['b', 1],
        ['a', 2],
      ]),
    }));
    expect(kept(run([map], twoKeys).outcome)).toEqual({ ...twoKeys, properties: { b: 1, a: 2 } });
  });

  it('a hook after a violation does not run', () => {
    let calls = 0;
    run([
      loose(() => undefined),
      (event) => {
        calls += 1;
        return event;
      },
    ]);
    expect(calls).toBe(0);
  });
});

describe('a hook that throws (HOOK_THREW)', () => {
  it('drops the event with an ERROR, and later hooks do not run', () => {
    let calls = 0;
    const { outcome, sink, counted } = run([
      () => {
        throw new TypeError('secret');
      },
      (event) => {
        calls += 1;
        return event;
      },
    ]);

    expect(outcome).toEqual({ kept: false });
    expect(sink.lines).toEqual([
      {
        level: 'error',
        message: 'HOOK_THREW: A beforeSend hook threw; the event was dropped',
        developerErrorForm: false,
      },
    ]);
    expect(counted).toEqual(['HOOK_THREW']);
    expect(calls).toBe(0);
  });

  it('the error reaches the developer logger only as its argument, never in the message', () => {
    const recording = new RecordingLogger();
    const error = new TypeError('secret');
    const { outcome } = run(
      [
        () => {
          throw error;
        },
      ],
      track,
      { logger: recording.logger },
    );

    expect(outcome.kept).toBe(false);
    expect(recording.lines).toEqual([
      { level: 'error', message: 'HOOK_THREW: A beforeSend hook threw; the event was dropped', error },
    ]);
    expect(recording.messages.join('\n')).not.toMatch(/secret|TypeError/);
  });

  it('is not a developer error: debug does not change its form', () => {
    const { sink } = run(
      [
        () => {
          throw new Error('x');
        },
      ],
      track,
      { debug: true },
    );
    expect(sink.lines[0]?.developerErrorForm).toBe(false);
  });
});

describe('debug and developer errors (Web Public API 4, Web Logging 1)', () => {
  it('with debug a violation is written in the error form, and nothing is thrown', () => {
    let result: ReturnType<typeof run> | undefined;
    expect(() => {
      result = run([loose(() => undefined)], track, { debug: true });
    }).not.toThrow();
    expect(result?.outcome).toEqual({ kept: false });
    expect(result?.sink.lines).toEqual([
      {
        level: 'error',
        message:
          'HOOK_VIOLATION: A beforeSend hook returned undefined instead of the event or null; the event was dropped',
        developerErrorForm: true,
      },
    ]);
  });

  it('without debug the same violation is a plain ERROR line', () => {
    expect(run([loose(() => undefined)]).sink.lines[0]?.developerErrorForm).toBe(false);
  });

  it('a developer logger gets the normal line with or without debug', () => {
    const recording = new RecordingLogger();
    run([loose(() => undefined)], track, { debug: true, logger: recording.logger });
    expect(recording.lines).toEqual([
      {
        level: 'error',
        message:
          'HOOK_VIOLATION: A beforeSend hook returned undefined instead of the event or null; the event was dropped',
        error: undefined,
      },
    ]);
  });

  it('off silences violations and throws, with debug true and false', () => {
    for (const debug of [true, false]) {
      const violation = run([loose(() => undefined)], track, { level: 'off', debug });
      const thrown = run(
        [
          () => {
            throw new Error('x');
          },
        ],
        track,
        { level: 'off', debug },
      );
      expect(violation.outcome).toEqual({ kept: false });
      expect(thrown.outcome).toEqual({ kept: false });
      expect([...violation.sink.lines, ...thrown.sink.lines]).toEqual([]);
      expect([...violation.counted, ...thrown.counted]).toEqual(['HOOK_VIOLATION', 'HOOK_THREW']);
    }
  });

  it('a repeated violation is an ERROR once per page, then a debug line', () => {
    const { log, sink } = setup();
    runHooks([loose(() => undefined)], track, log);
    runHooks([loose(() => undefined)], track, log);
    expect(sink.lines.map((line) => line.level)).toEqual(['error', 'debug']);
  });
});

describe('robustness', () => {
  it('seeded random results never throw, and an accepted event is always the SDK own and writable', () => {
    const random = new SeededRandom(7);
    const pick = <T>(values: readonly T[]): T => values[random.nextUint32() % values.length] as T;
    const candidates = (event: Event): unknown[] => [
      undefined,
      null,
      0,
      'x',
      [],
      event,
      { ...event },
      { ...event, type: pick(['track', 'screen', 'identify', 'page']) },
      { ...event, name: pick(['', 'ok', 42, undefined, 'x'.repeat(300)]) },
      { ...event, properties: pick([undefined, null, {}, { a: Number.NaN }, new Map(), [1], 'p']) },
      { ...event, traits: pick([undefined, null, {}, { a: () => 1 }]) },
      { ...event, context: pick([undefined, null, {}, event.context, { ...event.context, locale: 'en' }]) },
      new Proxy(event, {
        get() {
          throw new Error('trap');
        },
      }),
    ];

    for (let i = 0; i < 2000; i += 1) {
      const input = pick([track, screen, identify, sessionStarted]);
      const results = candidates(input);
      const hook = loose(() => pick(results));
      const { outcome } = run([hook], input);
      if (outcome.kept) {
        expect(outcome.event.messageId).toBe(input.messageId);
        expect(outcome.event.context).toBe(input.context);
        expect(() => eventLine(outcome.event)).not.toThrow();
      }
    }
  });
});
