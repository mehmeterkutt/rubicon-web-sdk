# Wire format

What the web SDK sends to `{host}/v1/batch`: the contract with the backend, the same contract the
Android and iOS SDKs implement. The golden files in `packages/core/test/fixtures/golden/` are
copies of the Android files (`scripts/refresh-golden.sh`), the normative examples; the tests compare
what the SDK writes with them structurally and parse every line with an independent parser, Python's
`json` (Web Event Model 4, Web Serialization 3). When this page and a golden file disagree, the
golden file is right and this page is fixed. The Android `docs/wire-format.md` describes the shared
parts in full; this page lists what the web sends and where it differs. Two web fixtures in
`packages/core/test/fixtures/web/` pin what the Android files cannot hold.

Status: complete for the first release (step 8.4), pending backend review.

## Request

- `POST {host}/v1/batch`, `Content-Type: application/json; charset=utf-8`,
  `Authorization: Bearer {apiKey}`, then the configured `network.headers` (Web HTTP 1). The key is a
  publishable key and never travels in the body.
- No `User-Agent` or version header of the SDK's own: the browser sends its own `User-Agent`, which
  the SDK does not set or read for the wire (Web HTTP 1).
- The body is gzipped through `CompressionStream` with `Content-Encoding: gzip`, or sent
  uncompressed: where `CompressionStream` is missing or failed, on Safari and every iOS browser 16.4
  and 16.5, and for a request started while the page is hidden or goes away (Web HTTP 2). Either
  form has a fixed length, never chunked.
- `credentials: "omit"` and `referrerPolicy: "no-referrer"`: no cookie of the site or of the host
  and no `Referer` travel with the request.
- Every request is preflighted (`Authorization` and the JSON type are not simple), so the backend
  answers every response, errors included, with the CORS headers of Web HTTP 4: the preflight with
  `Access-Control-Allow-Methods: POST, GET` and `Access-Control-Allow-Headers` naming
  `Authorization`, `Content-Type`, `Content-Encoding` and `If-None-Match` (and any
  `network.headers` names), every response with `Access-Control-Allow-Origin` and
  `Access-Control-Expose-Headers: ETag, Retry-After, X-Request-Id`. Without them the browser hides
  the answer and the SDK sees a network failure.
- One batch holds at most 100 events and 512 KB before compression, whole chunks oldest first
  (Queue 4, Web Queue 5). A body within the keepalive budget, 48 KiB, is sent with `keepalive`; a
  batch started while the page is hidden or goes away holds at most that budget.
- The server answers 200 for every well-formed batch; a success body is never read. Status codes
  and `Retry-After` are handled as the HTTP and Retry decisions say (`packages/core/CLAUDE.md`).

## Envelope

Golden file: `envelope.json`.

```json
{ "sent_at": 1759147260000, "batch": [ { ...event... }, { ...event... } ] }
```

| Key | Type | Meaning |
|---|---|---|
| `sent_at` | number | Epoch milliseconds when this attempt was sent; rewritten on every retry, so the backend can correct device clock skew against `timestamp` |
| `batch` | array | The events, each exactly as stored in the browser |

The same event can arrive more than once (at-least-once delivery: a retry after a lost response, a
request at page close whose answer never arrived, another tab sending a chunk its writer was still
sending, Web Queue 2). It always carries the same `message_id`; the backend deduplicates on it.

## Event

| Key | Type | Present | Meaning |
|---|---|---|---|
| `type` | string | always | `track`, `screen` or `identify` |
| `event` | string | `track` | The event name, 1 to 255 UTF-16 code units |
| `name` | string | `screen` | The screen name, 1 to 255 UTF-16 code units |
| `source` | string | always | `app` for the developer's calls, `auto` for what the SDK captures; new values may come in minor versions. A web `screen` is always `app` |
| `message_id` | string | always | UUIDv7, unique per event, never regenerated |
| `timestamp` | number | always | Epoch milliseconds (`Date.now()`) when the event was created: the call's time, the time the snippet recorded a call made before the library loaded, or the moment an automatic event belongs to |
| `user_id` | string or null | always | The identified user; `null` while anonymous |
| `device_id` | string | always | UUIDv7 of this browser profile on this site, kept in a first-party cookie; renewed by `clearLocalData()` |
| `properties` | object | `track`, `screen` | The developer's or the SDK's properties; may be empty |
| `traits` | object | `identify` | The user's traits |
| `context` | object | always | What the SDK measured; below |

Property and trait values are strings, booleans, numbers, `null`, lists and objects of those, at
most three levels deep, converted from JavaScript values by the table of Web Serialization 2 (a
`Date` becomes its `toISOString()` text, `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` in UTC, the proleptic
Gregorian calendar as on Android; a `Map` an object, a `Set` or typed array a list, a safe `BigInt`
a number, a `URL` its `href`). A string is at most 1024 UTF-16 code units, a line at most 32 KB of
UTF-8. A lone surrogate never reaches the wire: it is replaced by U+FFFD, in names and keys too.

**Number text.** The web writes numbers with `JSON.stringify`, the shortest text that reads back as
the same double, as Android does; only the exponent is spelled differently: `1e+21` and `1e-7`
where Android writes `1.0E21` and `1.0E-7`. Integral values are written as integers (`50`, never
`50.0`). Numbers beyond `Number.MAX_SAFE_INTEGER` are sent as the doubles they are. A backend parses
numbers as IEEE 754 doubles and never compares the raw text (Web Serialization 1). Key order means
nothing: JavaScript writes integer-like keys first.

Golden files: `track.json`, `screen.json`, `identify.json`.

## Context

A value the SDK could not read is left out, never sent as `null` or `""`; a group with no value is
left out. The app can switch fields off (`context.disabledFields`, the seventeen members of Web
Context 5); `library` is always sent. `browser` and `page` are groups only the web sends.

| Key | Type | Web value |
|---|---|---|
| `app.name`, `app.version`, `app.namespace` | string | From the configuration (`context.app`); absent when not given. No `app.build` |
| `device.type` | string | `phone`, `tablet` or `desktop`, best effort from the user agent and the low-entropy Client Hints; absent without a signal (Web Context 1) |
| `os.name` | string | `Windows`, `macOS`, `iOS`, `Android`, `Chrome OS` or `Linux`; an iPad that reports a Mac is `iOS` |
| `browser.name` | string | `Chrome`, `Edge`, `Opera`, `Samsung Internet`, `Firefox`, `Safari` or `HeadlessChrome` |
| `browser.version` | string | The major version, such as `141` |
| `screen.width`, `screen.height` | number | The screen in CSS pixels, the short side as width; not physical pixels as on Android and iOS |
| `screen.density` | number | `devicePixelRatio`, the CSS-to-device pixel ratio, which desktop zoom changes; read once per page load |
| `page.url` | string | Origin and path, ids masked as `:id` (digits, UUIDs, hex over 16 characters); never the query or the fragment |
| `page.referrer` | string | `document.referrer` under the same rule |
| `page.viewport_width`, `page.viewport_height` | number | `innerWidth`, `innerHeight` in CSS pixels |
| `page.query` | object | Only the query parameters named in `context.page.queryParams`, name to value |
| `page.title` | string | `document.title`, only with `context.page.title: true` |
| `locale` | string | `navigator.language` (BCP 47), the browser's preferred language |
| `timezone` | string | `Intl.DateTimeFormat().resolvedOptions().timeZone` (IANA) |
| `session.id` | string | UUIDv7; absent outside a session |
| `session.started_at` | number | Epoch milliseconds |
| `library.name`, `library.version` | string | `rubicon-web`, `0.1.0` |

Not sent by the web: `app.build`, `device.manufacturer`, `device.model`, `device.is_emulator`,
`os.version`, `os.api_level` and the `network` group (`network.type`, `network.carrier`). The golden
files carry them; the web tests remove those keys from the file before comparing and remove
`browser` and `page` from the output, which the web fixtures pin instead.

Web fixture: `context.json`, the `browser` and `page` groups of the example of Web Context 2.

## Automatic events

All have `source: "auto"`. Each type can be switched off by the app (`autocapture.enabled`, the
members `sessions`, `page_views` and `network_requests`) or by remote configuration.

| Event | Type | Properties | File |
|---|---|---|---|
| `Session Started` | track | none; right before the event that starts the session, which only a visible page's event does | golden `session-started.json` |
| `Session Ended` | track | `duration_ms`; timestamped at the session's last activity, with the ended session in `context.session`; sent when an end is found (an event, the tab becoming visible, the next page load), so a session no page finds within 12 hours has none | golden `session-ended.json` |
| `Page Viewed` | track | the five `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` present in the page's URL, nothing else; the page is `context.page.url`. Web only (Web Lifecycle 1, 2, 5) | web fixture `page-viewed.json` |
| `Network Request` | track | `method`, `url` and `path` without query or fragment and with ids as `:id`, `host`, `status_code` (`0` for an opaque response, absent when the call failed), `error` (`canceled`, `timeout`, `network` or `unknown`, absent with a response), `duration_ms` to the response headers, `request_bytes` and `response_bytes` when known; only requests made through `createTrackedFetch` | golden `network-request.json` |
| `SDK Diagnostics` | track | `period_start` (date), `dropped` (`total` and a count per reason, the web's `page_closed` included), `issues` (a count per code of `docs/issue-codes.md`); never through `beforeSend` | golden `sdk-diagnostics.json` |

Not sent by the web: `Application Installed`, `Application Updated`, `Application Opened`,
`Application Backgrounded` (Web Lifecycle 3, 4), `Deep Link Opened` (Web Lifecycle 5: its campaign
parameters are properties of the landing `Page Viewed`) and automatic screen views with
`name_source` (Web Lifecycle 1). Their golden files stay in the copied set; the web tests show that
the scenarios which make them on Android make none in a browser.

A developer may send events with the same names; `source` tells them apart. The backend shows
`source` as a breakdown rather than merging both into one row.

## Which test produces each file

| File | Test |
|---|---|
| `track.json`, `screen.json`, `identify.json` | `packages/core/test/event/event-model.test.ts` |
| `session-started.json`, `session-ended.json`, `network-request.json`, `envelope.json` | `packages/core/test/event/golden-files.test.ts` (the real core, the chunk store) |
| `network-request.json` properties | `packages/web/test/unit/tracked-fetch.test.ts` |
| `sdk-diagnostics.json` | `packages/core/test/diagnostics/diagnostics.test.ts` |
| the five Android-only files | `packages/core/test/event/golden-files.test.ts` (none produced; every file parsed by Python) |
| web `page-viewed.json` | `packages/web/test/unit/wire-fixtures.test.ts` |
| web `context.json` | `packages/core/test/event/event-model.test.ts`, `packages/web/test/unit/browser-context.test.ts` |

## Keeping the copies true

`scripts/refresh-golden.sh` copies the Android files from the Android repository's `origin/develop`
and records their digest in `packages/core/test/fixtures/golden/SOURCE.sha256` and the commit in
`SOURCE.commit`; `refresh-golden.sh --check`, run by `scripts/check.sh`, fails when the copies no
longer match the recorded digest (a copy was edited by hand) and, when the Android repository is
present on the machine, when its files no longer produce that digest (the contract changed on
Android and the copies were not refreshed). `--self-test`, also run by `check.sh`, proves both
failures on scratch copies. CI has no Android checkout, so the second half runs on a developer's
machine, before a release at the latest. The web fixtures are not copies: they change only with a
decided wire change.
