import type { JsonObject, JsonValue } from '../json/json';
import { writeJson } from '../json/json';
import type { Event } from './event';
import type { EventContext } from './event-context';

// The wire form of events, the port of the Android `EventWire` (Event Model 1, 2, 5; Serialization
// 4; Web Event Model 1, 2): `snake_case` keys written by hand, so the contract is visible here, and
// epoch milliseconds for times, which need no conversion (Web Event Model 2). The closed sets are
// their wire strings already, so Android's `wireName` helpers have no counterpart. The golden files
// under `test/fixtures/golden` pin the shape (Web Event Model 4).
//
// - `user_id` is always present, `null` while anonymous: it is part of the event's identity.
// - A context value that is `undefined` is left out by the JSON layer, and so is a context group
//   with no value (Android log 3.2).

/** The compact JSON line of `event`: exactly what is stored in a chunk and sent (Web Disk 2). */
export function eventLine(event: Event): string {
  return writeJson(eventToWire(event));
}

/** The wire object of `event`, keys in the Android order (not part of the contract). */
export function eventToWire(event: Event): JsonObject {
  const head =
    event.type === 'track'
      ? { type: event.type, event: event.name }
      : event.type === 'screen'
        ? { type: event.type, name: event.name }
        : { type: event.type };
  return {
    ...head,
    source: event.source,
    message_id: event.messageId,
    timestamp: event.timestamp,
    user_id: event.userId,
    device_id: event.deviceId,
    ...(event.type === 'identify' ? { traits: event.traits } : { properties: event.properties }),
    context: contextToWire(event.context),
  };
}

function contextToWire(context: EventContext): JsonObject {
  const { app, device, os, browser, screen, page, session, library } = context;
  return {
    app: group({ name: app.name, version: app.version, namespace: app.namespace }),
    device: group({ type: device.type }),
    os: group({ name: os.name }),
    browser: group({ name: browser.name, version: browser.version }),
    screen: group({ width: screen.width, height: screen.height, density: screen.density }),
    page: group({
      url: page.url,
      referrer: page.referrer,
      viewport_width: page.viewportWidth,
      viewport_height: page.viewportHeight,
      query: page.query,
      title: page.title,
    }),
    locale: context.locale,
    timezone: context.timezone,
    session: session === undefined ? undefined : { id: session.id, started_at: session.startedAt },
    library: { name: library.name, version: library.version },
  };
}

// The group, or `undefined` (left out) when none of its values is present.
function group(fields: Readonly<Record<string, JsonValue | undefined>>): JsonObject | undefined {
  return Object.keys(fields).some((key) => fields[key] !== undefined) ? fields : undefined;
}
