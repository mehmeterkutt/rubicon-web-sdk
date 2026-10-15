// The SDK's public entry point (Public API 2, 5, 8; Web Public API 1, 3): an interface, so the
// implementation stays internal and a host test passes a fake. Methods return `void`, never a
// Promise or the instance (Public API 5, Web Public API 3); the two reads are `readonly`
// properties (iOS 7). Every verb added later is added to `createNoOpAnalytics` in the same change.

/**
 * The SDK's entry point. Create one per page with `createAnalytics(config)`, hold the result and
 * pass it to the code that tracks (Web Public API 1). In tests, pass a fake built from
 * {@link createNoOpAnalytics}.
 *
 * Every method returns at once and takes effect in call order: a `track` after `identify` carries
 * the new user. Events are written to storage and uploaded later, never during the call. Nothing is
 * thrown to your code: a mistake, such as a blank event name or a value the SDK cannot send, is a
 * log line with its issue code, which the default console output writes as
 * `console.error(new Error(...))` when `debug` is `true`.
 *
 * Properties and traits are plain objects, none when left out. Strings, booleans, `null`, finite
 * numbers, arrays and plain objects are sent as they are; a `Date` becomes its ISO string, a `Set` or
 * typed array a list, a `Map` with string keys an object, a `URL` its `href`. A key whose value is
 * `undefined` is left out. A value the SDK cannot send (a function, `NaN`, a class instance, ...)
 * drops that key only, with a warning naming the key and its type, never the value. The SDK copies
 * what you pass during the call and never keeps your object.
 *
 * Methods may be added in minor versions. A fake built by spreading the no-op gains them by itself;
 * a class that `implements Analytics` stops compiling.
 *
 * @example
 * ```ts
 * import { createAnalytics } from 'rubicon-analytics';
 *
 * const analytics = createAnalytics({ apiKey: 'api-key' });
 * analytics.track('Purchase Completed', { amount: 49.9, currency: 'EUR' });
 * ```
 */
export interface Analytics {
  /**
   * Records an action, such as `Purchase Completed`. A blank name, or one longer than 255 UTF-16
   * code units, drops the event with the warning `INVALID_EVENT_NAME`; names are never trimmed.
   * Plain Title Case names, as the automatic events use, and `snake_case` property keys are
   * recommended.
   */
  track(name: string, properties?: Record<string, unknown>): void;

  /**
   * Records a screen view under a fixed key from your tracking plan, the same on every platform
   * (`checkout`), never displayed text or a filled route. The SDK never sends one by itself; page
   * loads and route changes are sent as `Page Viewed` events.
   */
  screen(name: string, properties?: Record<string, unknown>): void;

  /**
   * Attaches the user `userId` to this and every later event, and sends `traits` once with an
   * identify event; traits are never stored. Calling it again with the same id and no traits does
   * nothing. A different id while identified starts a new user: super properties and the session are
   * cleared first. A blank id, or one longer than 255 UTF-16 code units, is ignored with the warning
   * `INVALID_USER_ID`.
   */
  identify(userId: string, traits?: Record<string, unknown>): void;

  /**
   * Returns to an anonymous user, for example on logout: clears the user id, super properties and
   * the session. {@link Analytics.deviceId} stays, events already tracked are still sent, and no
   * event of its own is produced.
   */
  reset(): void;

  /**
   * Adds a super property, sent with every later event of this user until
   * {@link Analytics.unregister} or {@link Analytics.reset}. A property of the event itself with the
   * same key wins. `value` follows the property rules; `null` is stored and sent.
   */
  register(key: string, value: unknown): void;

  /**
   * Removes the super property `key`.
   */
  unregister(key: string): void;

  /**
   * Asks for an upload of every event tracked so far and returns at once, without a Promise.
   * Uploads also happen by themselves, for example when the page is hidden; calling this is rarely
   * needed.
   */
  flush(): void;

  /**
   * Stops collection until {@link Analytics.optIn}: no new events of any kind and no new uploads.
   * Events already stored in the browser wait unsent for {@link Analytics.optIn} and are deleted
   * after three days; events held in memory while consent was pending are dropped. With
   * `privacy.persistConsent` (the default) the choice is stored and holds on later pages and visits.
   * To also delete the data in the browser, call {@link Analytics.clearLocalData} after this.
   */
  optOut(): void;

  /**
   * Resumes collection after {@link Analytics.optOut}, or gives consent when
   * `privacy.defaultConsent` is `'pending'`.
   */
  optIn(): void;

  /**
   * Whether nothing is being collected now: `true` after {@link Analytics.optOut} and while consent
   * is pending.
   */
  readonly isOptedOut: boolean;

  /**
   * Deletes everything in the browser that belongs to a person: events not yet sent (also those of
   * other tabs), the user id, super properties and the session, and renews
   * {@link Analytics.deviceId}. The consent choice is kept. An upload already in flight may still
   * complete. Collection goes on; "forget me" is {@link Analytics.optOut} then this.
   *
   * @example
   * ```ts
   * const oldId = analytics.deviceId; // read before clearing
   * myBackend.requestErasure(oldId);
   * analytics.optOut();
   * analytics.clearLocalData();
   * ```
   */
  clearLocalData(): void;

  /**
   * The id of this browser for your site, shared by its pages and tabs and sent with every event,
   * for example to request erasure on your backend. It changes with
   * {@link Analytics.clearLocalData} or when the browser's site data is cleared;
   * {@link Analytics.reset} keeps it.
   */
  readonly deviceId: string;
}
