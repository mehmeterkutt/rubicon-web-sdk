import { parseWithPython } from 'rubicon-analytics-testing';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Autocapture,
  Consent,
  ContextField,
  DropReason,
  Event,
  EventSource,
  EventUpdate,
  HookViolation,
  LogLevel,
} from '../../src';
import {
  AUTOCAPTURE_TYPES,
  CONSENTS,
  CONTEXT_FIELDS,
  DROP_REASONS,
  EVENT_SOURCES,
  eventLine,
  eventToWire,
  HOOK_VIOLATIONS,
  LOG_LEVELS,
} from '../../src';
import { comparable, forTheWeb, golden, webFixture } from './golden-support';
import type { Json } from './golden-support';
import { fullContext, identify, screen, sessionStarted, sparseContext, track } from './sample-events';

// The port of the Android EventModelTest (Event Model 1, 2, 5, 6; Android log 3.2) for Web Event
// Model 1, 4 and 5: the union and its narrowing, the closed sets, and the wire form against the
// Android golden files, compared structurally (Web Event Model 4, Web Context 5). The Android tests
// of the limited `copy`, the missing setters and `toString` have no counterpart: the web events are
// plain readonly objects, protected by the deep copy and the hook rules (hook-rules.test.ts).

const written: string[] = [];

function line(event: Event): string {
  const text = eventLine(event);
  written.push(text);
  return text;
}

afterAll(() => {
  // Every line this file writes is standard JSON and valid UTF-8 to Python (Web Serialization 3).
  parseWithPython(written).forEach((answer, i) => {
    const text = written[i] ?? '';
    expect(answer, text).toEqual({ ok: true, value: JSON.parse(text) as unknown });
  });
});

describe('the event union (Web Event Model 1)', () => {
  it('an exhaustive switch over Event compiles and narrows each kind', () => {
    function describeEvent(event: Event): string {
      switch (event.type) {
        case 'track':
          return `track ${event.name} with ${String(Object.keys(event.properties).length)} properties`;
        case 'screen':
          return `screen ${event.name}`;
        case 'identify':
          return `identify with ${String(Object.keys(event.traits).length)} traits`;
        default: {
          // A new kind fails to compile here, which is how a hook can choose to notice one.
          const unknownKind: never = event;
          return String(unknownKind);
        }
      }
    }

    expect([track, screen, identify].map(describeEvent)).toEqual([
      'track Purchase Completed with 6 properties',
      'screen Checkout',
      'identify with 2 traits',
    ]);
  });

  it('narrows on type: only track and screen events have a name, only identify events traits', () => {
    expectTypeOf<Extract<Event, { type: 'identify' }>>().not.toHaveProperty('name');
    expectTypeOf<Extract<Event, { type: 'track' }>>().toHaveProperty('properties');
    expectTypeOf<Extract<Event, { type: 'identify' }>>().toHaveProperty('traits');
    expectTypeOf<Event['userId']>().toEqualTypeOf<string | null>();
    expectTypeOf<Event['timestamp']>().toEqualTypeOf<number>();
  });

  it('every field is readonly, so a hook that assigns does not compile', () => {
    // A copy of the sample: `readonly` is compile-time only, so the assignments do run.
    const event = JSON.parse(JSON.stringify(track)) as Event;
    // @ts-expect-error events are readonly (Web Event Model 1)
    event.messageId = 'x';
    // @ts-expect-error context groups are readonly (Context 4)
    event.context.page.url = 'x';
    expect(event.messageId).toBe('x');
    expect(fullContext.page.url).toBe('https://shop.example.com/orders/:id');
  });

  it('the observer receives the same union', () => {
    const update: EventUpdate = { type: 'queued', event: identify };
    expectTypeOf(update).toExtend<EventUpdate>();
    expect(update.event.type).toBe('identify');
  });
});

describe('closed sets (Web Event Model 5)', () => {
  // The public unions are spelled out and the internal arrays checked against them in both
  // directions, so a member added to one and not the other fails to compile here.
  it('every closed set is a union with an as const array naming the same members', () => {
    expectTypeOf<(typeof LOG_LEVELS)[number]>().toEqualTypeOf<LogLevel>();
    expectTypeOf<(typeof DROP_REASONS)[number]>().toEqualTypeOf<DropReason>();
    expectTypeOf<(typeof CONTEXT_FIELDS)[number]>().toEqualTypeOf<ContextField>();
    expectTypeOf<(typeof AUTOCAPTURE_TYPES)[number]>().toEqualTypeOf<Autocapture>();
    expectTypeOf<(typeof CONSENTS)[number]>().toEqualTypeOf<Consent>();
    expectTypeOf<(typeof EVENT_SOURCES)[number]>().toEqualTypeOf<EventSource>();
    expectTypeOf<(typeof HOOK_VIOLATIONS)[number]>().toEqualTypeOf<HookViolation>();
  });

  it('each array holds its members once, as the wire names', () => {
    const sets: readonly (readonly string[])[] = [
      LOG_LEVELS,
      DROP_REASONS,
      CONTEXT_FIELDS,
      AUTOCAPTURE_TYPES,
      CONSENTS,
      EVENT_SOURCES,
      HOOK_VIOLATIONS,
    ];
    for (const set of sets) expect(new Set(set).size).toBe(set.length);
    expect(EVENT_SOURCES).toEqual(['app', 'auto']);
    expect(CONTEXT_FIELDS).toHaveLength(17);
  });

  it('sources are written as their wire names', () => {
    expect(eventToWire(track).source).toBe('app');
    expect(eventToWire(screen).source).toBe('auto');
  });
});

describe('the wire form and the golden files (Web Event Model 4, Web Context 5)', () => {
  it('a track event matches track.json', () => {
    const file = golden('track');
    expect(comparable(line(track), file)).toEqual(forTheWeb(file));
  });

  it('a screen event matches screen.json', () => {
    const file = golden('screen');
    expect(comparable(line(screen), file)).toEqual(forTheWeb(file));
  });

  it('an identify event matches identify.json', () => {
    const file = golden('identify');
    expect(comparable(line(identify), file)).toEqual(forTheWeb(file));
  });

  it('an automatic track event matches session-started.json', () => {
    const file = golden('session-started');
    expect(comparable(line(sessionStarted), file)).toEqual(forTheWeb(file));
  });

  it('the removal list leaves the web fields of the files in place', () => {
    const context = forTheWeb(golden('track')).context as Json;
    expect(context).toEqual({
      app: { name: 'Rubicon', version: '1.4.0', namespace: 'com.rubicon.demo' },
      device: { type: 'phone' },
      os: { name: 'Android' },
      screen: { width: 1080, height: 2400, density: 2.625 },
      locale: 'tr-TR',
      timezone: 'Europe/Istanbul',
      session: { id: '0192e49f-0b1c-7d2e-8f3a-4b5c6d7e8f90', started_at: 1759147082000 },
      library: { name: 'rubicon-android', version: '0.1.0' },
    });
  });

  it('the web-only groups are written with their wire names', () => {
    const context = eventToWire(track).context as Json;
    expect(context.browser).toEqual({ name: 'Chrome', version: '141' });
    expect(context.page).toEqual({
      url: 'https://shop.example.com/orders/:id',
      referrer: 'https://www.example.com/',
      viewport_width: 412,
      viewport_height: 915,
      query: { page: '2' },
      title: 'Checkout',
    });
    expect(context).not.toHaveProperty('network');
  });

  it('the web-only groups of the example of Web Context 2 match the web fixture', () => {
    const example = {
      ...track,
      context: {
        ...fullContext,
        browser: { name: 'Chrome', version: '141' },
        page: {
          url: 'https://shop.example.com/orders/:id/items',
          referrer: 'https://www.example.com/',
          viewportWidth: 1280,
          viewportHeight: 720,
          query: { page: '2', sort: 'price' },
        },
      },
    };
    const context = (JSON.parse(line(example)) as Json).context as Json;
    expect({ browser: context.browser, page: context.page }).toEqual(webFixture('context'));
  });

  it('an anonymous user is sent as a null user id, and times as epoch milliseconds', () => {
    const wire = JSON.parse(line(screen)) as Json;
    expect(wire.user_id).toBeNull();
    expect(wire.timestamp).toBe(1759147190000);
    expect((JSON.parse(line(track)) as { context: { session: Json } }).context.session.started_at).toBe(1759147082000);
  });

  it('unknown context values and empty groups are left out', () => {
    const context = (JSON.parse(line(identify)) as Json).context as Json;
    expect(Object.keys(context).sort()).toEqual(['library', 'os']);

    const partial = line({
      ...track,
      context: { ...sparseContext, page: { url: 'https://shop.example.com/' }, browser: { name: 'Firefox' } },
    });
    expect((JSON.parse(partial) as Json).context).toEqual({
      os: { name: 'Android' },
      browser: { name: 'Firefox' },
      page: { url: 'https://shop.example.com/' },
      library: { name: 'rubicon-web', version: expect.any(String) as unknown },
    });
  });

  it('track names go to event, screen names to name, identify has neither', () => {
    const wire = (event: Event) => JSON.parse(line(event)) as Json;
    expect(wire(track)).toMatchObject({ type: 'track', event: 'Purchase Completed' });
    expect(wire(track)).not.toHaveProperty('name');
    expect(wire(screen)).toMatchObject({ type: 'screen', name: 'Checkout' });
    expect(wire(screen)).not.toHaveProperty('event');
    expect(wire(identify)).not.toHaveProperty('event');
    expect(wire(identify)).not.toHaveProperty('name');
    expect(wire(identify)).not.toHaveProperty('properties');
    expect(wire(track)).not.toHaveProperty('traits');
  });

  it('each line is one compact line', () => {
    for (const event of [track, screen, identify, sessionStarted]) {
      const text = line(event);
      expect(text).not.toContain('\n');
      expect(text).not.toMatch(/": /);
    }
  });

  it('a __proto__ property is written as a property', () => {
    const properties = JSON.parse('{"__proto__":{"admin":true}}') as Record<string, never>;
    const text = line({ ...track, properties });
    expect(text).toContain('"properties":{"__proto__":{"admin":true}}');
  });
});
