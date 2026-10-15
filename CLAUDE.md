# Rubicon Web SDK

Analytics SDK for the browser in TypeScript. This file and each package's `CLAUDE.md` are the
contract for how code is written here; read them before changing anything.

- The design is decided in Confluence (space SD; Atlassian MCP, `cloudId` `rubiconn.atlassian.net`)
  and is binding. The web entry page is "Analytics SDK: Web" (id 12288001) with fourteen
  `Web: <block>` child pages; each inherits the Android decision page of the same block, and only
  what differs in the browser is written on the web page. A pointer such as (Queue 4) means decision
  4 on the Android Queue with Flush Policy page; (Web Queue 2) means decision 2 on the web page.
  Page ids are in section 1 of `docs/implementation-plan.md`. The reasoning lives there, not here.
- Work follows `docs/implementation-plan.md`: read its "Working agreement" and "Status" at the start
  of every session and take the first unchecked step.
- Never decide something the decisions do not cover: stop and ask, with options and a
  recommendation.
- The Android SDK (`~/Projects/rubicon/rubicon-android-sdk`) is the reference implementation of the
  same contract: its `sdk-core/CLAUDE.md` rules, golden wire files
  (`sdk-core/src/test/resources/golden/`), `docs/issue-codes.md` and implementation decisions log
  apply here unless a web page says otherwise. Port its code, do not reinvent it; the iOS SDK
  (`~/Projects/rubicon/rubicon-ios-sdk`) shows how a non-JVM port went. Where Android code and a web
  decision disagree, the web decision wins. The three contract changes of 2026-10-14 (nothing new
  uploaded, only the consent decision written, no remote configuration request while opted out) are
  on the pages but not yet in the Android and iOS code: follow the pages.
- The conversation with the user is in Turkish with technical terms in English; code, comments and
  documents are in English, without emoji.

## Packages

| Package | Role |
|---|---|
| `packages/core` (`rubicon-analytics-core`, private) | No DOM (`lib: ["es2017"]`): configuration, pipeline, queue, storage logic over key-value and cookie interfaces, identity, sessions, upload, HTTP, retry, privacy, diagnostics. Tested in plain Node. Bundled into `web`, never published in the first release (Web Public API 7). Rules: `packages/core/CLAUDE.md` |
| `packages/web` (`rubicon-analytics`, the package to publish; nothing published yet, D20) | The browser: `createAnalytics`, `createNoOpAnalytics`, `createTrackedFetch`, the browser implementations of the core interfaces, page views, the script build (`window.Rubicon`) and the snippet (`window.rubicon`). Tested with Vitest and jsdom, and with Playwright in Chromium, Firefox and WebKit. Rules: `packages/web/CLAUDE.md` |
| `packages/testing` (`rubicon-analytics-testing`, private) | Test support: `TestPlatform` fakes, the virtual-time scheduler, the test HTTP server, the golden loader. Never published; no `CLAUDE.md` of its own (the Android and iOS test modules have none). |

Package names are D2 of the plan (section 15); the private packages are linked with `workspace:*`,
never resolved from the registry. Apps add one package, `rubicon-analytics`, with `core` inside it.
Browser code lives only in `web`; what `core` needs of the platform is an interface `web`
implements. The demo app and its fake backend are a separate repository
(`rubicon-team/rubicon-web-demo`).

## Commands

Node 24 or later and pnpm 12 (`packageManager` pins the version). Dependencies resolve only to
versions at least seven days old (`minimumReleaseAge`, D6b); pin a new development dependency to the
newest such version.

| Command | What it does |
|---|---|
| `pnpm install` | Installs the workspace; the private packages link with `workspace:*` |
| `scripts/check.sh` | Everything CI runs, in order: format, lint, source rules (with `--self-test`), golden files, type check, build, ES2017 (with `--self-test`), tests with coverage, API report, size, SSR import, Playwright in Chromium, Firefox and WebKit. `--skip-browser` for a quick loop only |
| `scripts/check-clean.sh` | `check.sh` on a fresh clone of HEAD with a frozen lockfile; the gate while GitHub Actions minutes are exhausted (plan section 15) |
| `pnpm format` | Prettier in place; before every commit |
| `pnpm -r build` | `core` declarations, then `web`: `tsc` declarations, Rollup (ESM, CommonJS, IIFE `dist/rubicon.min.js`), api-extractor `.d.ts` rollup |
| `pnpm -r test`, `pnpm -r coverage` | Vitest: `core` and `testing` in Node, `web` unit tests in jsdom; coverage gates 90 and 80 percent of lines |
| `pnpm --filter rubicon-analytics-core exec vitest run test/<file>` | One test file (`-t "<name>"` for one test) |
| `pnpm browser` | Playwright (`packages/web/test/browser`), after a build; `pnpm --filter rubicon-analytics exec playwright install` once |
| `pnpm ssr` | The built package imported and required in plain Node, touching no browser global |
| `pnpm api`, `pnpm --filter rubicon-analytics api:update` | Fails when the public API differs from `packages/web/etc/rubicon-analytics.api.md` or lacks TSDoc; the update rewrites the report after an intended change |
| `pnpm size` | size-limit on the script build and the ESM entry, gzip |
| `node scripts/check-source-rules.mjs` | The static rules of plan section 5 that ESLint does not carry |
| `scripts/refresh-golden.sh` | Copies the Android golden files from its `origin/develop`; `--check` verifies |

`core` and `web` each have `tsconfig.src.json`, the compiler's fence for `src` (`core`:
`lib: ["es2017"]`, no DOM, no Node types), and a wider `tsconfig.json` for tests, configuration and
the editor.

## Non-negotiables

A pull request that breaks one does not merge. The Android root rules hold, read for the browser,
with the web additions folded in.

1. **Never crash the host app.** Every public entry point, listener, timer callback and Promise
   chain of the SDK catches, logs and degrades: a failure is an analytics gap, not a broken page. No
   `throw` into the host, ever, `debug` included (Web Public API 4), and no unhandled rejection (Web
   Lifecycle 6).
2. **No events lost silently.** Every way to lose an event has a `DropReason` and is counted; upload
   happens later, with retry and backoff; offline and a hidden page are normal states.
3. **Public API is forever.** Nothing public is removed or renamed; deprecate with the TSDoc
   `@deprecated` tag naming the replacement and keep it working for at least one major version.
4. **Everything internal unless it must be public.** Public is only what `packages/web/src/index.ts`
   exports; the `exports` map exposes nothing else (Web Public API 7). Documentation on every public
   symbol; a diff of the API report defines a public API change.
5. **Touch the page as little as possible.** Importing the package has no side effect and touches no
   `window`, `document` or `localStorage` (Web Public API 7). Never replace `fetch` or
   `XMLHttpRequest` (Web Lifecycle 6); `history` is wrapped only by the registry (Web Lifecycle 2);
   no element listeners (Web Lifecycle 7); no DOM node is kept.
6. **No new dependencies.** Zero runtime dependencies, `tslib` included (Web Public API 7); adding
   one is a design discussion, not a pull request detail.
7. **ES2017 syntax and library**, nothing newer without feature detection (Web Public API 6).
8. **Nothing from a caught error in a log line**; the log level is the only authority over what is
   written (Web Logging 1).
9. **No cookie or storage key that `docs/storage-declaration.md` does not list** (Web Privacy 5).
10. **Every change ships with tests.** No exceptions for small fixes.

## Public API

- `createAnalytics(config)` in `web` returns the `Analytics` interface of `core`, held by the
  developer; the implementation is not exported. No module-level instance, no default export that is
  an instance. One instance per page, enforced by the factory (Web Public API 1).
- The Android vocabulary: `track(name, properties?)`, `screen(name, properties?)`,
  `identify(userId, traits?)`, `reset()`, `register(key, value)`, `unregister(key)`, `flush()`,
  `optOut()`, `optIn()`, `clearLocalData()`, `readonly isOptedOut` and `readonly deviceId`; no
  `userId` getter. Methods return `void`: no chaining, no event ids, no `async` or Promise (Web
  Public API 3; rule `public-promise`). Public types are interfaces and type aliases, never classes.
- `createNoOpAnalytics()` returns a fresh object literal with its methods as own properties
  (`isOptedOut` true, `deviceId` `""`, Android log 3.3), so fakes are
  `{ ...createNoOpAnalytics(), track: vi.fn() }`; a new verb is added to it in the same change. A
  new `Analytics` method breaks `implements` fakes; the documentation recommends spread fakes.
- Properties are `Record<string, unknown>` at the door, default `{}`; `register` takes `unknown`.
  One pass during the call turns them into a `PropertyValue` tree (a deep copy; the caller's object
  is never kept), validated again after `beforeSend` (Web Public API 4, Event Model 3).
- Conversion (Web Serialization 2): strings, booleans, `null` and finite numbers as is (also beyond
  the safe range); `undefined` is an absent key in an object and `null` in an array (holes too); a
  safe `BigInt` as a number; boxed primitives as their value; a valid `Date` in the years 0000 to
  9999 through `toISOString()`; `Array`, `Set`, typed arrays as lists; a `Map` with string keys and
  a plain object (prototype `Object.prototype` or `null`, any realm) as objects of their own
  enumerable string keys; `URL` as `href`. Types are told by `Object.prototype.toString`, never
  `instanceof`.
- Rejected: `NaN`, `Infinity`, other `BigInt`s, invalid or out-of-range dates, `Temporal` and
  date-library objects (with a hint: a `Date`, epoch milliseconds or an ISO string), `ArrayBuffer`,
  `DataView`, `Blob`, other objects with a `toJSON` (never run), class instances, `Error`, `RegExp`,
  `Promise`, functions, `Symbol`, DOM nodes, a getter or `Proxy` that throws. Drop the key or the
  element only, WARN with key and type, never the value; keep the event; developer error.
  Properties that are neither a plain object nor a `Map`: `{}` and that WARN (section 15, step 2.5).
- Limits (Serialization 3, Web Serialization 1): event line 32 KB of UTF-8 by the scan, after the
  hooks (drop, `oversize`; a hook's own drop keeps `before_send`; the normalizer stops walking once
  its copy is surely over it and sets `oversize`, a web difference, section 15, steps 2.5 and 6.3b);
  name and key 1 to 255 UTF-16 code units, `length` (drop, never trim); string values 1024 code
  units (truncate outside a surrogate pair, no marker, WARN); 256 properties with super properties
  (those dropped first); nesting depth 3. Lone surrogates become U+FFFD, in names and keys too.
- Developer errors (unsupported value, blank name, invalid configuration, hook violation, an event
  over 32 KB, second instance) are WARN or ERROR lines with their code under the log level, `"off"`
  included; `debug: true` only makes the default sink write them as
  `console.error(new Error(message))` (Web Public API 4, Web Logging 1).
- `beforeSend?: readonly BeforeSend[]`, `type BeforeSend = (event: Event) => Event | null`, fixed at
  creation, run in order, synchronously, each on its own deep copy. `null` drops. A result must keep
  the input's `type`, `source`, ids, `timestamp` and `context` (by value; Android log 6.3); `"app"`:
  any name and data; `"auto"`: same name and top-level keys, values free, no `null` (Android log
  3.2). A breach, `undefined` or a Promise drops (`before_send`, `HOOK_VIOLATION`, developer error);
  a throw drops (`HOOK_THREW`). `SDK Diagnostics` never reaches hooks (Web Public API 5).
- Events are a discriminated union of `readonly` interfaces on `type`; closed sets are string
  literal unions of wire names, spelled out (internal `as const` arrays checked against them), never
  `enum`; both may grow in minor versions, so the documentation asks for a `default` branch (Web
  Event Model 1, 5). `AnalyticsConfig` is a plain object type: `apiKey` required, new settings only
  as optional members.
- TSDoc on every public symbol, with an example when it prevents misuse (`ae-undocumented`, D17).
  The committed `packages/web/etc/rubicon-analytics.api.md` is the record: a diff there defines a
  public API change and is named at the top of the pull request.

## Dependencies

- Runtime: none. A browser API above the floor (Chrome 55, Edge 15, Firefox 52, Safari 10.1, iOS
  10.3) is feature-detected with the fallback its block page names and listed in that page's table;
  a new detection is a design question, dropping a fallback a design discussion once the API is
  Baseline Widely available. No polyfills; the snippet is ES5 (Web Public API 6). CI checks the
  floor as syntax and library and tests behaviour on current engines (D13).
- Development dependencies are named with their reason in the pull request and section 15. Test
  tools: Vitest, jsdom, Playwright, Python 3 as the independent JSON parser.
- Never: `XMLHttpRequest` or `sendBeacon` for uploads, `unload`, `beforeunload` or `freeze` (Web
  Queue 3; rule `close-time`); `Math.random` (`RandomSource` over `crypto.getRandomValues`, Web
  Event Model 3); `crypto.subtle` (an own synchronous SHA-256, Web Identity 4); `sessionStorage`,
  `indexedDB`, `navigator.storage` (Web Disk 1, 7); `eval`, `new Function`, run-time code loading
  (Web HTTP 6); `globalPrivacyControl`, `doNotTrack` (Web Privacy 4).

## The single thread and the page lifecycle

- One thread. Every public method is non-blocking and takes effect in call order (Public API 9): the
  call does the cheap steps and queues one message; the writer runs after paint in slices (Web Queue
  1). No Web Worker, no lock, no blocking wait.
- Tabs are concurrent writers of one origin's storage. Shared state is read fresh on every call or
  before every upload and written by fresh read, merge and one `setItem` (Web Disk 3); events go
  into each page's own immutable chunks (Web Queue 2). No `BroadcastChannel` or Web Locks.
- Visibility replaces the foreground; hidden is not closed; a back/forward cache restore is a live
  page again. Timers are hints, never trusted to fire: state is evaluated at events, visibility
  changes and page load. Time comes from the injected `Clock` (`Date.now()`, rule `clock`).
- Objects are references: deep-copy at every boundary (properties and configuration in, hooks in and
  out, storage out); `readonly` is compile-time intent only.

## Testing

- Layers, tools and the rules for every test: plan section 5. Vitest for `core` in Node and `web` in
  jsdom; Playwright in Chromium, Firefox and WebKit for what jsdom cannot do. Fakes come from
  `rubicon-analytics-testing`, never a mocking library.
- Names are sentences grouped with `describe`. No real waiting in unit tests (virtual time through
  `Scheduler` and `Clock`); integration and browser tests wait on a condition with a timeout, never
  a fixed sleep. Each test has its own storage maps or browser context.
- Every developer error is tested with `debug: true`, `debug: false` and `logging.level: "off"`;
  every public entry point with a failure injected below it. Android test vectors are copied
  verbatim.
- Coverage (D11): 90 percent of lines in `core`, 80 in `web`; Playwright-only code is excluded with
  its covering browser test named. Upload, storage and identity changes get one manual run in the
  demo app against its fake server once it uses the SDK (step 9.2).

## Code style

- Prettier (2 spaces, single quotes, trailing commas, 120 columns), ESLint `strictTypeChecked`,
  `import type` for types; Markdown is not formatted and wraps at 100 columns. Readability over
  cleverness: small functions, one responsibility.
- No `any`, `enum` or non-null assertion in `src`. Data is plain objects typed by interfaces; closed
  hierarchies are discriminated unions; classes only internally where state is the point. Constants
  are module-level `const`, exported only when another module needs them.
- No top-level side effects; a call or `new` in a top-level initializer carries `/*#__PURE__*/`
  (rule `side-effect`). Browser globals only where rule `browser-global` allows (never in `core`).
- Log only through the internal logger, never `console` outside the default sink (rule `console`).
  Never log property or trait values, `userId`, `deviceId`, the session id, the API key, header
  values, bodies, query strings or anything from a caught error (`message`, `stack`, `name`, its
  text), at any level; names, keys, types, counts, codes and `message_id` are fine (Logging 4, Web
  Logging 1). Rule `log-content` rejects those identifiers in a log call; count outside the call.
- `TODO(step N.N)` only (rule `todo`). Comments say why and cite decisions ("Web Queue 2").

## Git and pull requests

- `master` holds releases, `develop` the next one; `feature/<topic>` branches into `develop`, merged
  by the user with a merge commit (D1). Steps 1.1 to 5.3 on `feature/repository-and-tooling`, 6.1 to
  8.5 on `feature/sdk-complete`, one commit per step (D18 as changed, section 15). Conventional
  Commits naming the step (`feat(core): ... (step 2.1)`).
- Before committing: `pnpm format`, then `scripts/check.sh` green, the Playwright suite included
  when the step touches `packages/web`. Push and open the pull request only after the user approves;
  never merge, never push to `develop` or `master`.
- The description follows `.github/pull_request_template.md`: public API changes first, then
  problem, change, how it was tested, decisions implemented.

## Keeping these files honest

They are loaded into every AI session and read by every contributor. When a rule stops matching the
code, fix one or the other in the same pull request. State each rule once; package detail goes into
the package's `CLAUDE.md`. Each file stays under 200 lines, except this one (under 230) and
`packages/core/CLAUDE.md` (under 270), whose counts are recorded in plan section 15 (step 1.2).
