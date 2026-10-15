# core (`rubicon-analytics-core`)

TypeScript without DOM or Node types (`lib: ["es2017"]`; rule `browser-global` allows no browser
global here). The platform comes through the internal `Platform`: `Clock`, `RandomSource`,
`KeyValueStorage`, `StorageSignal`, `CookieJar`, `HttpTransport`, `LifecycleSource`,
`NetworkSignal`, `ContextProvider`, `Scheduler`, `UrlParser`, `pageScheme`, `pageHost`; `web`
implements them, tests replace them with `TestPlatform` from `rubicon-analytics-testing` through the
core factory (Configuration 5). The interfaces (`src/platform/`) keep the browser's behaviour:
storage and cookies throw and refuse silently as `localStorage` and `document.cookie` do, and the
caller catches; `HttpTransport` reports by callback, exactly once and never inside `send`, so the
core holds no Promise chain; timers from `Scheduler` are hints, checked against the `Clock` (section
15, 2.1). Folders are the Android packages: `platform`, `log`, `util`, `json`, `validation`,
`config`, `event`, `storage`, `queue`, `http`, `retry`, `identity`, `session`, `context`, `privacy`,
`remote`, `diagnostics`, `pipeline`. `src/index.ts` exports what `web` and `testing` need; public is
what `web` re-exports. Properties and `beforeSend`: root `CLAUDE.md`.

## Event model

- Top level is the event's identity (Event Model 1): `type`, `event` (track) or `name` (screen),
  `source` (`app`/`auto`, set only by the SDK), `message_id`, `timestamp`, `user_id` (always on the
  wire, `null` while anonymous), `device_id`. `properties` (track, screen) and `traits` (identify)
  belong to the developer; the SDK never writes into them. Super properties merge into `properties`,
  the event's own key wins; never into identify (Android log 6.3a). `context` belongs to the SDK (on
  the web `app`, `device`, `os`, `browser`, `screen`, `page`, `locale`, `timezone`, `session`,
  `library`; no `network`) and is read-only for hooks (Context 4). Wire keys are `snake_case`.
- `type Event = TrackEvent | ScreenEvent | IdentifyEvent` (`src/event/`), `readonly` interfaces on
  `type`, made only by the SDK; `EventContext` readonly groups, a missing value `undefined`, absent
  on the wire (`event-wire.ts`); hooks and their rules in `hook-rules.ts` (Web Event Model 1).
- `messageId`: 36 lowercase characters from the port of the Android `UuidV7Generator` (Android log
  2.3: 48-bit milliseconds, a 42-bit counter reseeded with its top bit clear, overflow moves the
  millisecond forward, a clock moving back keeps the last one), in `Number` arithmetic by division
  and modulo, never bit operations above 32 bits or `BigInt`; random from `RandomSource`. Created
  during the call, persisted, never regenerated; the same generator makes `device_id` and the
  session id (Web Event Model 3).
- Time is `number` epoch milliseconds from the `Clock` at call time; `timestamp`, `sent_at` and
  `context.session.started_at` need no conversion; no `Date` in events (Web Event Model 2).
  `sent_at` is in the envelope, rewritten on every attempt.
- Golden files: the Android files copied verbatim, compared structurally: ids checked and taken from
  the file, `library` taken from the file, the eight fields the web never produces removed from the
  file, `browser` and `page` removed from the output and pinned in a web-only fixture, `app.*` from
  the test configuration (Web Event Model 4, Web Context 5).

## Configuration

- `AnalyticsConfig`: `apiKey` (required, a publishable key), `host` (`DEFAULT_HOST`, the SaaS
  placeholder, D3), `debug`, `beforeSend`; groups `flush`, `session`, `autocapture`, `context`,
  `privacy`, `logging`, `network`, and the web's `identity` (Configuration 2). `core` holds the
  neutral groups; `web` extends the type, each browser-only setting in the group of the block that
  owns it (Web Configuration 6). Arrays where Android has sets; the snapshot holds a `Set`. Tuning
  values (limits, budgets, windows, backoff, timeouts) are internal; making one public is a design
  discussion. `createCore` reads nothing; an instance starts at its first use (step 6.7).
- `validateConfig(input: unknown, { urls, pageScheme })` (`src/config/`) reads every setting,
  browser-only ones too, once in a `try`, into one internal `ConfigSnapshot` built by hand:
  collections copied, functions by reference, nothing of the input kept; no freezing,
  `CONFIG_FROZEN` or `setConfig` (Web Configuration 1). Configuration 3: a missing or blank key, an
  invalid or non-string host -> none, ERROR (`INVALID_API_KEY`, `INVALID_HOST`); out of bounds ->
  clamped (`SETTING_OUT_OF_BOUNDS`); contradicting -> group defaults (`CONTRADICTING_SETTINGS`);
  `null`, a wrong type, a value outside a closed set -> the default (`SETTING_WRONG_TYPE`), a bad
  element drops itself; `session.backgroundTimeoutMs` -> `SETTING_NOT_SUPPORTED`; unknown keys
  ignored. All developer errors but `CLEARTEXT_HOST`.
- `host` (Web Configuration 4): no surrounding whitespace or control character, `^https?://`, no
  `?`, `#`, `@` or empty authority (Android exact); the platform's `new URL` has a host, empty
  `search`, `hash`, `username`, `password`. Trailing slashes removed; `{host}/v1/batch`,
  `/v1/config`; the host once at INFO. `http`: `CLEARTEXT_HOST`, an ERROR (`blocked`) from an
  `https` page unless to `localhost` or `127.0.0.1`.
- Remote configuration (`src/remote/`, Configuration 1, Web Configuration 5, Android log 5.3):
  `GET {host}/v1/config` with ETag, at most once per page; it only restricts (`enabled`,
  `autocapture_off`, `flush_at`, `flush_interval_ms`, `sample_rate`, `diagnostics_sample_rate`),
  from the next page load except the two stop flags. `.remote` keeps `fetched_at` of a 200 or 304
  (a 404 deletes it); a page load fetches only when it is over five minutes old, shared by the
  tabs. No request while pending or refused (Web Privacy 1, Web Logging 4); one after `optIn()`.
- `network.headers` never override `Authorization`, `Content-Type`, `Content-Encoding`,
  `Content-Length`, `User-Agent`, `Host`, `If-None-Match` or `X-Rubicon-*`, in any letter case
  (`RESERVED_HEADER`). No IP flag or header (Privacy 6).

## Identity and super properties

- `device_id`, a UUIDv7 made on first need; `user_id` from `identify`, `null` while anonymous; no
  identified flag, no alias, no group (Identity 1, 6). Merge is implicit: both ids on every event,
  two different non-null `user_id`s never merge (Identity 2).
- The identity cookie `rubicon_<keyHash>`, `1.<device_id>.<person_epoch>.<user_id>` (user id last,
  `encodeURIComponent`, empty while anonymous), is the authority; `.device` mirrors the device id,
  `.person` the user id (Web Identity 1, 4). `IDENTITY_MATRIX`: a valid id in either store is used,
  copied to the other, the cookie winning; both missing -> generate, write both; unreadable (throws,
  invalid) never overwritten; nothing readable -> a temporary id. A failed write keeps the id read.
- Every public call reads identity, consent and the session from storage. First-visit race: read
  again before generating, read back after writing; to the first upload rewrite the cookie read and
  move events to an id made within 1 s, a later one is an erasure (Web Identity 3; section 15, 8.1).
- `identify(userId, traits)` (Identity 3, 4): anonymous -> set, persist, send `IdentifyEvent`; same
  id with traits -> `IdentifyEvent` only; same id without -> nothing; another id while identified ->
  end the session, clear the person, then identify, INFO without ids. Blank or over 255 code units
  -> developer error, `INVALID_USER_ID`, ignored; never trim. Traits are set-only, never stored.
- Records (Web Identity 4, Web Disk 3, Web Retry 1, Web Privacy 2): `rubicon.<keyHash>.person`
  (`user_id`, super properties, the `device_id` and `person_epoch` it belongs to; stale and deleted
  when the cookie holds others), `.device` (`device_id`, retry state, counters, `last_logged`),
  `.remote` (`fetched_at`), `.consent` (mirror), `.pause` (server pauses); the session is in the
  session cookie. New value: "if another person logs in, should it carry over?" Yes ->
  device, else person. A test asserts each record's exact key set. `keyHash` is the first 16 hex of
  SHA-256 of the key; another key's stores and cookies are never touched (no `api_key_changed`).
- `reset()` clears the person (new `person_epoch`), keeps the device and the queue, sends no event
  of its own, never renews `device_id` (Identity 5). Super properties are validated at `register`;
  `null` is stored and sent; they stay per host (Web Identity 2).

## Consent

- `privacy.defaultConsent` granted (default) or pending; `privacy.persistConsent` (default `true`)
  stores the decision, which beats the default (Privacy 2, 4): the cookie `rubicon_<keyHash>_c`,
  `1.<granted|denied>.<decided_at>`, with `.consent` as its mirror, the later winning; read on every
  call and before every upload; an unreadable cookie yields to the mirror and the next decision. A
  pending tab reads it again on `storage`, on becoming visible and at its next call.
  `persistConsent: false` or memory-only: per page (Web Privacy 2; `src/privacy/`).
- Pending (Web Privacy 1): nothing written, only the consent records read, no remote configuration
  request. `optIn()`: a stored identity wins, held person changes are replayed onto it without
  events, its `device_id` is written into the waiting events, then write and send. `optOut()` drops
  the waiting events uncounted.
- Refused (Web Logging 4, the contract since 2026-10-14): only the decision is written; the identity
  cookie is read, never written; `identify`, `register`, `reset` change memory, replayed at
  `optIn()`; no new events (unwritten ones discarded), the session ends silently; no new upload, a
  request in flight settles its chunks by key; the queue waits for `optIn()` or the 3-day rule;
  counters (never stored), retry state and `.pause` in memory; no remote configuration request.
- `clearLocalData()` (Web Privacy 3): deletes every chunk and marker of the key, other tabs'
  included, the session cookie, `.person`, counters and transient retry state; renews `device_id`
  and `person_epoch` without `user_id`; keeps the consent records, `.remote`, `.pause`. Pending or
  refused: deletes the identity cookie and `.device` (refused: `.pause`), writes nothing, the new id
  waits for `optIn()`. No event, no count; writers and the uploader drop other `device_id`s.

## Session state

- An event in a session carries `context.session.id` (UUIDv7) and `started_at` (Session 1, 2).
- Visibility replaces the foreground; one inactivity timeout, `session.inactivityTimeoutMs` (30 min,
  1 min to 2 h, clamped, not remote), for visible and hidden pages; maximum 12 h (internal).
  Activity: a call from a visible tab, a tab becoming visible, a tab becoming hidden or `pagehide`.
  Hidden-tab events use a valid session but never extend it; without one they carry none and start
  none. A session starts with a visible tab's first event. No timers (Web Session 1, 3).
- One session per site in the cookie `rubicon_<keyHash>_s`, `1.<id>.<started_at>.<last>.<epoch>`
  (decimal ms), shared by tabs and subdomains. The tab that detects an end writes the new session
  (deletes it when none starts), reads back, only then emits `Session Ended` and `Session Started`;
  another tab's session read back is adopted silently (Web Session 2). Unusable cookie -> memory.
- `Date.now()` only; up to 60 s behind the last activity is no gap, further ends the session,
  backdated. Last activity written at most every 30 s per tab, at once on hiding, `pagehide` and a
  new session; a page's first activity always writes (Web Session 4).
- Membership of an event at `t` (call time, or the snippet's recorded time): epochs equal,
  `started_at <= t`, `t <= last activity + timeout`, `t - started_at <= 12 h`; only then the last
  activity moves, to the larger value. No write moves shared state back; a session that started
  after `t` -> no session on the event (Web Session 5).
- `sessions` (on): `Session Started` right before the event that starts one; `Session Ended` on
  detection, backdated, with `duration_ms` (Session 5). `reset()` and another user: `Session Ended`
  with the old identity first (now from a visible tab, else the last activity), then the identity
  cookie with a new epoch, the session cookie cleared.

## Writer, uploader and flushing

- The call queues one message in a bounded queue of 1000 (full -> `backpressure`). The writer
  (`device_id` check, hooks, second validation, serialization and the 32 KB scan, one chunk write
  per slice) runs after the next paint in yielding slices; on hiding or `pagehide` it drains
  synchronously within 50 ms, and `pagehide` drops the rest as `page_closed` with one write (Web
  Queue 1). It owns only the event store. `flush()` follows every earlier call and returns at once.
- Tabs (Web Queue 2): a random in-memory page id per page load; a page writes only its own immutable
  chunks and sends them first; another page may send a released or aged chunk in place and delete
  only it after the acknowledgement. Deletes by id, idempotent; batches from a fresh read.
  Duplicates possible, loss not.
- Triggers (Queue 2, 3, 7, Web Queue 3, 4): `flush.at` (30, 1 to 100); `flush.intervalMs` (5 s on
  the web, 1 s to 10 min, only while events are pending); hiding; `online`; `flush()`;
  `flush.immediateEvents` (final name after hooks). No flush at start; leftover chunks start the
  interval. No upload offline, waiting, opted out, pending or disabled. Remote values only make
  flushing rarer; `debug` changes no threshold.
- Batches: at most 100 events and 512 KB before gzip, oldest first, sequential, stop at the first
  failure (Queue 4). A chunk never exceeds the keepalive budget (about 48 KiB); a batch is whole
  chunks and fits the budget on hiding (Web Queue 5).
- Capacity (Queue 5, Web Queue 6): 1000 events and 3 days from `timestamp` over all pages' chunks;
  over the count oldest whole chunks go to at most 900, over 1 MiB below 90 percent (`queue_full`);
  expired ones deleted unsent (`expired`) at start and before uploads (refused: `expireStored()`;
  pending: never). `QuotaExceededError` drops the chunk (`storage_error`), never host data.

## Storage and JSON

- `localStorage` through `KeyValueStorage`, cookies through `CookieJar`; no encryption, no public
  storage interface (Web Disk 1, 7).
- Chunks (Web Disk 2): the key
  `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.<seq>.<count>.<chars>` (decimal, `seq`
  from 0, `chars` in UTF-16 units) holds JSON Lines, each ended by `\n`; the marker
  `rubicon.<keyHash>.q1r.<pageId>`, value empty. Capacity, age, adoption from key names only:
  `2 × Σ(key.length + value.length) ≤ 1 MiB`; `newestEventAt` strictly older than 3 days ->
  deleted unread, a future time never. A walk lists every key first (skipping `null`), then parses,
  sorts (`writtenAt`, `pageId`, `seq`), deletes. Body: `{"sent_at":..,"batch":[` + lines + `]}`.
- Cleanup only under the exact prefixes `rubicon.<keyHash>.q1.` and `.q1r.` (an unparsable key
  there: delete, WARN); another key hash's chunks older than 3 days deleted uncounted; other keys'
  stores and cookies never (Web Disk 6).
- A vanished chunk (`getItem` gives `null`): skipped, never recreated or counted, deleting it again
  a no-op; a throwing `getItem`: wait, delete nothing; no `UNREADABLE_SEGMENT` (Web Disk 1, 5).
- Stores (Disk 7, Web Disk 3; a `StoreRecord` each): JSON with `"v"`, grown by optional fields; a
  write is a fresh read, this page's changes applied (counters as increments, unknown fields kept),
  one `setItem`; coalesced in writer slices and on hiding; `.remote` whole. Unreadable or newer `v`:
  never written, changes held in memory (`STORE_UNREADABLE`), as under `StoreAccess` (pending,
  refused, memory-only). Raising `v` or `q1` is a design discussion; new formats read old ones.
- Memory-only mode (Web Disk 4): storage unusable at start -> the same rules in memory, one
  `STORAGE_UNAVAILABLE` per page, no `SDK Diagnostics`; it also holds pending and refused chunks.
- Bad lines are skipped (`corrupt`), logged with chunk key, line number and `message_id`, never the
  content (Disk 5).
- Only `json/` calls `JSON.stringify` and `JSON.parse` (rule `json`): over the normalized tree, so
  no `toJSON` runs; typed reads, unknown fields kept; nothing depends on key order. The 32 KB limit
  is a UTF-8 byte scan. Python parses every written line in the tests (Web Serialization 1, 3).

## HTTP and retry

- `src/http/`: `batchRequest` (`POST {host}/v1/batch`), `configRequest` (`GET {host}/v1/config`
  with `If-None-Match`); `Authorization: Bearer {apiKey}`, never in the body; one attempt, no backup
  host. `HttpTransport` (`fetch` in `web`) reports the raw `HttpOutcome`; `HttpClient` owns the 45 s
  deadline and classifies by Web HTTP 3 (`classifyOutcome`), never throwing: `success`,
  `http-error` (status, 4 KB body, `retryAfterMs`, `redirect`), `network-failure` (`timeout`,
  `connect`, `io`, `unexpected`), `keepalive-refused`. `Retry-After` in seconds or IMF-fixdate.
  Bodies never logged, success bodies never parsed (Web HTTP 1, 3).
- One `switch` (Retry 1, 4): 2xx delete. `timeout`, `connect`, `io`, 408, 5xx except 501 and 505,
  1xx: keep, back off. 429, or 503 with `Retry-After`: pause. 400, 422, other 4xx: delete
  (`rejected`). 401, 403, 404, 410, 413, 3xx, 501, 505, `unexpected`: keep, pause 1 h ±20 percent,
  ERROR once (a plain 3xx but 304: `HTTP_REDIRECT`). Offline is waiting (`src/retry/RetryPolicy`).
- Backoff 2 s, 10 s, 30 s, 2 min, 5 min, then 10 min, jitter x0.5 to 1.5, reset on success;
  `Retry-After` replaces it (cap 1 h, floor 1 s, jitter x1.0 to 1.1, never shortened) (Retry 2, 3).
  `online` ends only network waits, through one early attempt, and never writes (Web Retry 2).
- Shared by all pages, read fresh before every upload (Web Retry 1): the transient state in
  `.device` (`paused_until`, `step`, `last_failure`, `rev`, `probe_at`, `suspects`), merged with the
  later end winning, a success resetting it only if `rev` is unchanged; server pauses (429,
  server-caused group E) in `.pause` (`until`, `kind`, `keyHash(host)`), written only by a page that
  got one or by the clock guard, read back, never shortened. When a wait ends one page probes.
- Poison chunk (Web Retry 1, 4): `f` grows per chunk of a failed batch on server answers only (408,
  5xx, non-standard); at 5 it is a suspect, left out of the next attempt; a success without suspects
  raises their `cleared_by`; such a chunk then goes alone (`alone`); deleted as `retry_exhausted`
  only at `f` ≥ 10, `cleared_by` ≥ 1, `alone` ≥ 5.
- Page-local (Web Retry 4): `unexpected` pauses this page only, in memory; mixed content stops this
  page only; an unknown outcome at close writes nothing; another host's `.pause` is ignored.
- `Date.now()`, a clock guard on every read: a deadline beyond its kind's longest wait reads as that
  wait from now, written back once, never winning a comparison. Timers are hints; catch-up when
  visible again and on a back/forward cache restore; no timer without pending chunks (Web Retry 3).

## Logging and diagnostics

- `RubiconLogger = (level, message, error?) => void` and `EventObserver` over the `EventUpdate`
  union (`queued`, `sent`, `dropped`), owned by the instance; no `logging.logger` -> no-op in
  `core`, the console sink in `web`; a developer's logger is never replaced (Logging 1, Web Logging
  1). Every public call, timer and transport answer of an instance catches: `WORKER_FAILED`.
- `LogLevel` `"debug" | "info" | "warn" | "error" | "off"`, default `warn`, no runtime setter. ERROR
  = data lost or the SDK cannot work; WARN = misconfiguration, dropped or changed data; INFO = a few
  lifecycle lines; DEBUG = every step (Logging 2). The level alone decides; level and repeat limit
  are checked before the message function runs.
- A stable code per WARN or ERROR (`docs/issue-codes.md`, with Platform, Web level and Frequency),
  logged at its frequency, `per_page` or `per_24h` (`UPLOAD_FAILED_OPAQUE`, `QUEUE_FULL`,
  `EVENTS_EXPIRED`; the time in `.device`, best-effort), later at DEBUG; every occurrence counted
  (Logging 3, Web Logging 2). A new code enters `ISSUE_CODES` (`src/log/issue-code.ts`, levels and
  frequency) and the catalogue together; a code never produced on the web does not appear in `src`
  (Web Logging 3); `issue-codes.test.ts` checks both.
- `log.debug(() => msg)`, `log.warn(code, () => msg, { error, repeatKey, developerError })`. One
  safe string per line, starting with the code: fixed text and what Logging 4a allows (event names,
  keys and types, counts, HTTP codes, durations, hosts, masked paths); a caught error only as the
  `error` option, which reaches only a developer's logger (rule `log-content`).
- A module-level "inside a callback" flag ignores lines and updates caused by the logger or the
  observer; a throwing logger is replaced by the default sink for the page (`LOGGER_THREW`), a
  throwing observer switched off (`OBSERVER_THREW`); a returned Promise is not awaited and a
  rejection counts as a throw. `queued` arrives in the writing page, `sent` and `dropped` in the
  page that sent or deleted (Web Logging 1).
- `DropReason`: `queue_full`, `expired`, `backpressure`, `before_send`, `storage_error`, `corrupt`,
  `oversize`, `rejected`, `retry_exhausted`, and the web's `page_closed` (`PAGE_CLOSED`,
  best-effort); never `api_key_changed` (Queue 5, Web Logging 3). Counters in `.device`, increments.
- `SDK Diagnostics` (`src/diagnostics/`, Logging 5, Web Logging 5): before a flush, fresh read, a
  counter non-zero, an hour passed (a future time counts as now): one event of counts only
  (`period_start`, `dropped{total,...}`, `issues{CODE: n}`), captured as any automatic event (no
  session started on hiding), no hooks. After its chunk the snapshot is subtracted and the time set
  in one `setItem`; duplicates accepted. Sampled by `device_id`; off with `sendDiagnostics: false`;
  none while pending, refused, killed, memory-only or with `.device` unreadable (counters in memory;
  pending ones merge on `optIn()`).
