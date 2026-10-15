# web (`rubicon-analytics`)

The browser side and the package to publish: the factories, the browser implementations of the core
interfaces (storage, cookies, transport, clock, random, lifecycle, network signal, context, the
console sink), page views and the history registry, `createTrackedFetch`, the script build and the
snippet. Public API is what `src/index.ts` exports and nothing else; implementations live under
`src/platform/`, `src/autocapture/`, `src/network/`, `src/script/` and `src/snippet/`, the only
places besides the factory where browser globals are allowed (source rule `browser-global`).
Pointers such as (Web Lifecycle 2) name the Confluence decision.

## Factory and the page

- `createAnalytics(config)` (`src/create-analytics.ts`) validates the configuration, builds the
  snapshot, makes the browser `Platform` and calls the core factory. It reads no storage and no
  cookie; the probes run on the writer at first use (Web Identity 1). Outside a browser (no
  `window`, `document` or `localStorage`, no `crypto.getRandomValues`) it returns the no-op instance
  with one INFO line (Web Public API 7).
- `AnalyticsConfig` (`src/analytics-config.ts`) extends the core's `CoreConfig` with `session`,
  `context.app`, `context.page` and `identity`; the core's `validateConfig` knows every setting.
- The second instance (Web Configuration 3): a module registry and the page marker
  `window[Symbol.for("rubicon.analytics")]` (`globalThis` is ES2020), `{ version, analytics }` for
  every version, touched only inside the factory. A second call from any copy returns the first
  instance with `SECOND_INSTANCE` (ERROR, a developer error, `per_page`) naming both versions. The
  no-op never fills the marker. Tests reset it with `resetForTests` (`src/testing.ts`, unbundled).
- `debug` defaults to `false` and is never read from the environment: the SDK never reads `process`,
  `import.meta` or `location` for it; the guide shows the Vite, webpack and snippet wiring (Web
  Configuration 2).
- `logging.logger` absent: the default sink (`src/platform/console-sink.ts`), the only code that
  calls `console` (Web Logging 1, see `packages/core/CLAUDE.md`). Every call is guarded with
  `typeof console !== "undefined"` and `try/catch`, since a host may remove or replace `console`.

## Storage and cookies (`src/platform/`)

- `localStorage` behind the core's `KeyValueStorage`, `document.cookie` behind `CookieJar`. Every
  access is in `try/catch`: a throw (`SecurityError`, `QuotaExceededError`) is a result the core
  handles, never an exception into the host. Never `sessionStorage`, IndexedDB or
  `navigator.storage` (Web Disk 1, 7); never `persist()`.
- Keys and cookies the SDK writes are exactly those of `docs/storage-declaration.md` (Web Privacy
  5): the stores `rubicon.<keyHash>.device`, `.person`, `.remote`, `.consent`, `.pause`, the chunks
  `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.<seq>.<count>.<chars>` and markers
  `rubicon.<keyHash>.q1r.<pageId>`; the cookies `rubicon_<keyHash>` (identity), `_s` (session) and
  `_c` (consent), and the instant probes `__rubicon_dmn_<uuid>` and `rubicon.<keyHash>.probe`. A
  Playwright test compares what a run writes with the declaration.
- Cookie attributes (Web Identity 1, Web Session 2, Web Privacy 5): `SameSite=Lax`, `Secure` on an
  `https` page, the domain of the probe; the identity cookie 365 days, the session cookie `Max-Age`
  12 hours renewed on every write, the consent cookie 365 days. Every cookie with its attributes
  stays below 4096 bytes at the worst case; a test proves it.
- Domain (Web Identity 2; the core's `CookieDomain`, once per page at the first cookie written or
  deleted, any consent state): `identity.crossSubdomain` (default `true`) probes each candidate from
  the last label up, deleted at once; the first kept is the registrable domain. `localhost`, an IP,
  or none kept: host-only. `identity.cookieDomain` skips discovery, beats `crossSubdomain: false`;
  not a suffix or refused: host-only, `INVALID_COOKIE_DOMAIN`. One scope per name (`SiteCookies`).
- Start probe (Web Disk 4, core `storageReadable`, `storageWritable`): a read in every state, and
  only for a page starting granted a write, read back and removal of `rubicon.<keyHash>.probe`;
  failure: the core's memory-only mode, one `STORAGE_UNAVAILABLE` WARN (section 15, step 7.2).

## Transport (`src/platform/`)

- `HttpTransport` over `fetch` (Web HTTP 1): `mode: "cors"`, `credentials: "omit"`,
  `redirect: "manual"`, `referrerPolicy: "no-referrer"`, `cache: "no-store"`, `priority: "low"`,
  `keepalive` for a body within the budget (Web Queue 5); `Authorization: Bearer {apiKey}`,
  `Content-Type`, `Content-Encoding` only when compressed, then `network.headers`; no User-Agent or
  version header. One 45 s timeout through `AbortController`; without it the uploader stops waiting
  after 45 s, counts a timeout and ignores a late answer. Never `XMLHttpRequest` or `sendBeacon`.
- gzip through `CompressionStream` when present, not Safari or any iOS browser 16.4 or 16.5 (user
  agent, never sent) and compressing works; otherwise uncompressed. Requests started from the hiding
  or `pagehide` handler are never compressed and start synchronously inside it (Web HTTP 2).
- Classification (Web HTTP 3) is the core's (`HttpClient`, step 5.1): the transport reports what
  `fetch` gave as an `HttpOutcome` and never throws. 2xx and a 304 on `/v1/config` `Success`;
  `opaqueredirect` `HttpError` with `HTTP_REDIRECT`, no target; other statuses `HttpError` (body up
  to 4 KB, `Retry-After` when exposed); our own abort `timeout`; a `TypeError` while offline
  `connect`; one on a `keepalive` request `keepalive-refused`: one attempt without `keepalive` while
  the page lives, none on `pagehide`; any other `TypeError` `io`; anything else `unexpected`. No
  `cancelled` kind, no blocked-host check (no DNS API). Chunks go only after a 2xx.
- An `https` page and an `http` host other than `localhost` or `127.0.0.1`: no request; mixed
  content makes `CLEARTEXT_HOST` an ERROR and the uploader is in configuration failure.
- A `securitypolicyviolation` (enforce, `connect-src`, the host's origin and endpoint path; core
  option `watchPolicyViolations`) logs `CSP_BLOCKED` once per page, never reclassifying. An upload's
  `io` logs `UPLOAD_FAILED_OPAQUE` in `HttpClient` (`per_24h`) naming the possible causes.
- Every request is preflighted; the backend's CORS answer (Web HTTP 4) is part of the contract, on
  error responses too; the test server answers it (step 1.3). The key stays in `Authorization`.
- One file: no script loaded at run time, no `eval` or `new Function`, no inline style or handler,
  no Trusted Types sink (Web HTTP 6). No ad-blocker evasion; the guide documents a first-party proxy
  (Web HTTP 5).

## Lifecycle and network signals

- `LifecycleSource` (`page-lifecycle.ts`): `visibilitychange` on `document`, reported only on a
  change, is the background and foreground; `pagehide` always (alone below Safari 14.1); `pageshow`
  with `persisted` a back/forward cache return (Web Session 1, Web Queue 3); `visibilityState` read
  in each call; never `unload`, `beforeunload` or `freeze` (rule `close-time`).
- `NetworkSignal`: `navigator.onLine !== false`, `online` a hint for one early attempt, no write
  (Web Retry 2); `StorageSignal`: the `storage` key (Web Privacy 2); DOM listeners while subscribed.
- Timers (`setTimeout`) are hints: catch-up runs on becoming visible and on a restore from the
  back/forward cache (Web Retry 3). The `Scheduler` and `Clock` implementations are the only code
  here that reads `Date.now()` or schedules.

## Context (`src/platform/`)

- `ContextProvider` (`browser-context.ts`, Web Context 1 to 4); every read guarded, a throw or a
  value the browser does not give leaves the field out. Static, read once at the first event, never
  at import or in the factory: `os.name`, `browser.name` and major `browser.version`, `device.type`
  (`phone`, `tablet`, `desktop`) from the user agent and the low-entropy `navigator.userAgentData`
  (`user-agent.ts`); `screen.width` and `height` in CSS pixels, short side first; `screen.density`
  as `devicePixelRatio`; `page.referrer`. `app.*` and `library` are the core's. Read inside every
  call: `page.url`, the viewport, `page.query`, `page.title` when enabled, `locale`, `timezone`.
- `device.type` is best effort: the tablet heuristics (Android in desktop mode by the short screen
  side, an iPad as a Mac with `maxTouchPoints > 1`) are unit-tested with `navigator` stubs; no
  signal, no field. No `getHighEntropyValues`; never `app.build`, `device.manufacturer`, `.model`,
  `.is_emulator`, `os.version`, `os.api_level` or a `network` group; no raw user agent on the wire.
- `page.url` and `page.referrer`: origin plus path, ids masked by the core's `maskPathIds` (digits,
  UUID, hex over 16 characters become `:id`, Privacy 5c; shared with step 7.7), no query or
  fragment, nothing for an opaque origin. `page.query`: only the names in `queryParams`, parsed as
  `URLSearchParams` does (`page-query.ts`; it is Edge 17), a repeated name's first value, validated
  as properties by the pipeline. `page.title` only when enabled. No `resize` or `popstate` listener.
- A disabled field (`context.disabledFields`, seventeen `ContextField` members by wire path, Web
  Context 5) is never read.

## Page views and the history registry (`src/autocapture/`)

- `Page Viewed` is a `track` event with `source: "auto"`, its page in `context.page.url`, its only
  properties the five `utm_*` present in its URL (`utm_source`, `utm_medium`, `utm_campaign`,
  `utm_term`, `utm_content`; empty ones left out; never click ids; nothing carried to later events).
  No automatic `screen` events, no `name_source` (Web Lifecycle 1, 5).
- When (Web Lifecycle 2): the load, once, when first visible (a page never shown sends none); from
  the snippet's queued record when there is one, else read at `createAnalytics`. Single-page
  navigations: `pushState` and `replaceState` wrapped, `popstate` listened to; only a change of
  origin or path counts; a `pushState` or `popstate` sends any pending view and opens a new one; a
  `replaceState` within the pending window updates it; the window is 500 ms (internal), and hiding
  or `pagehide` sends at once. A `pageshow` with `persisted` is a page view; a tab becoming visible
  is not. Hash routes are not tracked.
- The registry (`src/autocapture/history-registry.ts`, the only code that touches `history` methods;
  rule `history-wrap`): `window[Symbol.for("rubicon.history")]`, installed by the first instance
  only when `page_views` is enabled, once per page; the wrapper calls the original first, then
  dispatches to the registry's current instance inside `try/catch`; never undone.
- No `Application Opened`, `Backgrounded`, `Installed`, `Updated` or `Deep Link Opened`; no version
  record (Web Lifecycle 3, 4, 5). No `click`, `submit` or `input` listeners (Web Lifecycle 7; rule
  `element-interaction`).
- `Autocapture` is `"sessions" | "page_views" | "network_requests"`, all on by default; a remote
  switch-off of `network_requests` applies at once, the others at the next page load (Web Lifecycle
  8).

## Network capture (`src/network/`)

- `createTrackedFetch(analytics, { hosts, maskPathIds?, fetch? })` returns a function with the
  signature of `fetch` that produces `Network Request`; the SDK never assigns `fetch` or
  `XMLHttpRequest` (Web Lifecycle 6; rule `replace-transport`).
- Behaviour equivalence is the contract: the same `Response` (a 4xx or 5xx is not an error), the
  same `AbortSignal`, the same rejection object; one chain
  `original.then(record and return, record and rethrow)`; recording in `try/catch`. The base `fetch`
  is called with `globalThis` as `this`; by default `globalThis.fetch` is read at each call.
- `input` as string, `URL` or `Request` with an optional `init`; method from `init`, else the
  `Request`, else `GET`, upper-cased; a relative URL resolved against `location.href`. The gate
  (`network_requests`, consent, a non-SDK `Analytics`) is read at the start and again before the
  event is made.
- Properties as Android (`method`, `url` and `path` with ids masked and no query or fragment,
  `host`, `status_code`, `error`, `duration_ms` to the response headers, `request_bytes`,
  `response_bytes`). `request_bytes` only from `Blob.size` or `byteLength`; `response_bytes` from a
  readable `Content-Length`; the body is never read or cloned. `error`: `canceled`, `timeout`,
  `network`, `unknown`, never the error's `name` (Web HTTP 3). Hosts: exact names or `*.domain`; the
  SDK's own host is never captured; headers and bodies never.

## Script build and snippet (`src/script/`, `src/snippet/`)

- The IIFE `dist/rubicon.min.js` installs `window.Rubicon`, holding the package's runtime exports
  (the same `createAnalytics`), and no other global (Web Public API 2; section 15, step 3.3). The
  snippet is two tags (Web HTTP 6): an inline ES5 stub that installs `window.rubicon`, queues
  calls, carries the double-load sentinel and inserts no script, and
  `<script async src integrity crossorigin>` for the version-pinned file. On load the library
  creates the instance through the factory, replays the queue in order and replaces the stub.
- The stub records with each queued call the time, the cleaned URL (`origin + pathname`, never the
  raw `href`), the viewport and `visibilityState`, plus one queued "page viewed" record with the
  five `utm_*`; it stores nothing and reads no configuration (Web Context 4, Web Session 5, Web
  Privacy 1). Replay uses the recorded time and visibility; ids are generated at replay.
- The stub's text, its verb list and its sentinel are public API, frozen like any other; its hash is
  published. A second load of the library is refused with an error line.

## Tests

- Unit tests in Vitest with jsdom (`test/unit`) for what jsdom models: `document.cookie`,
  `localStorage`, `history`, `visibilityState`, the factory, the snippet adapter. Playwright
  (`test/browser`) in Chromium, Firefox and WebKit for the rest; several tabs and the hosts
  `a.rubicon.test` and `b.rubicon.test` for subdomains (D15, step 1.3); `test/ssr` imports the built
  package in plain Node.
- A browser spec that needs the network imports `test` and `expect` from `test/browser/fixtures.ts`:
  `server`, the worker's `TestServer` (D14), reset after every test; pages from `test/browser/pages`
  under `/pages/`, the API under `/v1/`; the page on `TEST_HOST_A` and the API on `127.0.0.1` are two
  origins. The hosts resolve through a Chromium resolver rule, a Firefox preference and, in WebKit,
  the server as proxy (section 15, step 1.3); never `/etc/hosts`.
- Playwright's WebKit is the engine, not Safari: iPad detection and Safari's storage rules are not
  proven there. On macOS Playwright's Firefox runs with `CFFIXED_USER_HOME` set (section 15, step
  1.1).
- Close-time tests (`test/browser/close-time`, section 15, step 1.4): under Playwright no page
  handler runs in WebKit on a cross-site navigation, any `page.goto()` or `window.close()`, nor in
  Firefox on `page.close()` of a tab the browser opened. Leave a page by a same-site link click or
  `page.close()` (WebKit) and `window.close()` of a script-opened tab (Firefox); assert the
  handler's own trace before blaming the transport.
- Every browser global is stubbed or provided per test; nothing leaks between tests (the markers,
  `history` wrappers, cookies, storage).
