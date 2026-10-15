import type { Event } from './event';

/**
 * A hook set in `beforeSend`: it sees each event before it is stored and returns the event, a
 * changed copy of it, or `null` to drop it (Public API 4, Web Public API 5). Hooks run in order,
 * synchronously, each on its own deep copy of the event, and are fixed when the SDK is created. They
 * see your events and the automatic ones, never `SDK Diagnostics`.
 *
 * - For your own events (`source: 'app'`) return the event, a copy with any name and any
 *   properties or traits, or `null` to drop it.
 * - For automatic events (`source: 'auto'`) only the values of properties may change, for example to
 *   mask a token: the name stays, the same top-level keys come out as went in, and `null` is not
 *   allowed. To stop an automatic event, switch its type off in `autocapture.enabled`.
 * - `type`, `source`, `messageId`, `timestamp`, `userId`, `deviceId` and `context` never change.
 *
 * What a hook returns is validated again like the properties of a call. A hook that throws drops the
 * event with the code `HOOK_THREW`; one that returns `undefined` (a forgotten `return`), a Promise
 * (an `async` hook) or what these rules do not allow drops it with `HOOK_VIOLATION`. Nothing is
 * thrown to your code. A `switch` over `event.type` should keep a `default` branch that returns the
 * event, since kinds may be added in minor versions.
 *
 * @example
 * ```ts
 * const beforeSend: BeforeSend[] = [
 *   (event) => (event.type === 'track' && event.name.startsWith('debug_') ? null : event),
 *   (event) =>
 *     event.type === 'track' && event.source === 'auto'
 *       ? { ...event, properties: { ...event.properties, url: maskInviteCode(event.properties.url) } }
 *       : event,
 * ];
 * ```
 */
export type BeforeSend = (event: Event) => Event | null;
