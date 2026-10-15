import type { PropertyValue } from '../validation/property-value';
import type { EventContext } from './event-context';

// The event model (Event Model 1, 2, 6; Web Event Model 1, 2, 5): a discriminated union of
// `readonly` interfaces on the wire field `type`, never classes, so a hook narrows with
// `event.type === 'track'`, copies with spread, and two copies of the SDK on one page agree on what
// an event is. Only the SDK creates events; the types are public because hooks and the observer
// read them. The six shared fields are written out in each kind rather than in a base interface,
// which would be one more public name (plan section 15, step 3.2).

/**
 * Every {@link EventSource}, so the SDK can iterate them. Internal: the public union is spelled out,
 * as Web Event Model 5 writes it, and this array is checked against it (plan section 15, step 3.2).
 */
export const EVENT_SOURCES = ['app', 'auto'] as const satisfies readonly EventSource[];

/**
 * Who created an event, sent as `"source": "app"` or `"source": "auto"` (Lifecycle 5). Only the SDK
 * sets it.
 *
 * - `app`: a call by your code, `track`, `screen` or `identify`;
 * - `auto`: captured by the SDK itself, such as `Page Viewed`, `Session Started` or `Network Request`.
 *
 * Values may be added in minor versions; a `switch` over an `EventSource` should keep a `default`
 * branch.
 */
export type EventSource = 'app' | 'auto';

/**
 * An action, sent by `track` or captured automatically, such as `Page Viewed`. On the wire its name
 * is the field `event`.
 */
export interface TrackEvent {
  /** The kind of event, the discriminant of {@link Event}. */
  readonly type: 'track';
  /** The event name, such as `Purchase Completed`. */
  readonly name: string;
  /** Whether your code or the SDK created the event. */
  readonly source: EventSource;
  /** A UUIDv7 in lowercase, unique per event and never changed, also across retries. */
  readonly messageId: string;
  /** When the event was created, in epoch milliseconds, as `Date.now()` gives them. */
  readonly timestamp: number;
  /** The identified user, or `null` while anonymous. */
  readonly userId: string | null;
  /** The browser's id, shared by the site's pages and tabs. */
  readonly deviceId: string;
  /** The event's properties, super properties merged in. */
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** What the SDK measured when the event was created; read-only for hooks (Context 4). */
  readonly context: EventContext;
}

/** A screen view, sent by `screen`, such as `checkout`. The SDK never sends one by itself. */
export interface ScreenEvent {
  /** The kind of event, the discriminant of {@link Event}. */
  readonly type: 'screen';
  /** The screen name, the same key on every platform, such as `checkout`. */
  readonly name: string;
  /** Whether your code or the SDK created the event. */
  readonly source: EventSource;
  /** A UUIDv7 in lowercase, unique per event and never changed, also across retries. */
  readonly messageId: string;
  /** When the event was created, in epoch milliseconds, as `Date.now()` gives them. */
  readonly timestamp: number;
  /** The identified user, or `null` while anonymous. */
  readonly userId: string | null;
  /** The browser's id, shared by the site's pages and tabs. */
  readonly deviceId: string;
  /** The screen view's properties, super properties merged in. */
  readonly properties: Readonly<Record<string, PropertyValue>>;
  /** What the SDK measured when the event was created; read-only for hooks (Context 4). */
  readonly context: EventContext;
}

/** Who the user is, sent by `identify`. The traits are sent with this event only and never stored. */
export interface IdentifyEvent {
  /** The kind of event, the discriminant of {@link Event}. */
  readonly type: 'identify';
  /** Whether your code or the SDK created the event. */
  readonly source: EventSource;
  /** A UUIDv7 in lowercase, unique per event and never changed, also across retries. */
  readonly messageId: string;
  /** When the event was created, in epoch milliseconds, as `Date.now()` gives them. */
  readonly timestamp: number;
  /** The identified user, or `null` while anonymous. */
  readonly userId: string | null;
  /** The browser's id, shared by the site's pages and tabs. */
  readonly deviceId: string;
  /** The user's traits, as passed to `identify`. */
  readonly traits: Readonly<Record<string, PropertyValue>>;
  /** What the SDK measured when the event was created; read-only for hooks (Context 4). */
  readonly context: EventContext;
}

/**
 * An event as `beforeSend` hooks and the `eventObserver` see it (Event Model 1, 2; Web Event Model
 * 1), told apart by `type`. Only the SDK creates events. `readonly` states the intent; a hook
 * receives its own deep copy, and what it returns is checked, so changing the copy in place changes
 * nothing for the SDK (Web Public API 5).
 *
 * Kinds may be added in minor versions: a `switch` over `event.type` should keep a `default` branch
 * that returns the event unchanged.
 *
 * @example
 * ```ts
 * const tagTenant: BeforeSend = (event) => {
 *   switch (event.type) {
 *     case 'track':
 *       return { ...event, properties: { ...event.properties, tenant: tenants.current() } };
 *     default:
 *       return event;
 *   }
 * };
 * ```
 */
export type Event = TrackEvent | ScreenEvent | IdentifyEvent;
