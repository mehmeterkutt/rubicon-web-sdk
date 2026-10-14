# Rubicon Web SDK: Implementation Plan

This plan takes the Rubicon web (browser) analytics SDK from an empty repository to a release
candidate, one pull request at a time. It is written for an implementing session that starts with a
clean context: it names what to read, what to build, what to test and when a step is done. It does
not restate the design; the design lives in Confluence and is binding. It follows the Android plan
(`~/Projects/rubicon/rubicon-android-sdk/docs/implementation-plan.md`) and the iOS plan
(`~/Projects/rubicon/rubicon-ios-sdk/docs/implementation-plan.md`) step for step where the SDKs share
a block, so that the three code bases can be read side by side.

Written on 2026-10-14, the day the web design was completed. Dated facts in this file carry that
date and are checked again on the day they are used.

## 1. Sources of truth

| Source | What it holds | How to read it |
|---|---|---|
| Confluence, space SD, page "Analytics SDK: Web" (id `12288001`) and its 14 `Web: <block>` child pages | What differs in the browser, per block, with reasoning. Binding. Each page opens with what it inherits. The entry page also holds the terms table for readers from the JVM, the cross-block open questions, the contract questions decided during the web design, the items for the Android and iOS repositories and the notes for the backend team. | Atlassian MCP, `cloudId` `rubiconn.atlassian.net`, `getConfluencePage` with `contentFormat: "markdown"`; pages above the output limit are saved to a file, read them in parts |
| Confluence, page "Analytics SDK Design Decisions" (id `3112961`) and its 14 Android child pages | The contract all three SDKs implement. Everything a web page does not mention is inherited from here unchanged, read through the iOS page of the same block. | Same |
| Confluence, page "Analytics SDK: iOS" (id `8192025`) and its 14 `iOS: <block>` pages | The second reading of the contract; shows which Android decisions are platform-neutral. | Same |
| `~/Projects/rubicon/rubicon-android-sdk` | The reference implementation of the contract: `sdk-core/CLAUDE.md` and `sdk-android/CLAUDE.md` (rules as implemented), `sdk-core/src/test/resources/golden/` (the wire contract), `docs/issue-codes.md` (the code catalogue), `docs/remote-config.md`, `docs/wire-format.md`, and section 15 of its plan (platform-neutral rows are part of the contract) | Read-only. Port, do not reinvent; where Android code and a web decision disagree, the web decision wins. See the note on the contract questions below. |
| `~/Projects/rubicon/rubicon-ios-sdk` | The second implementation, already a port of the Android core; its plan and section 15 show how a non-JVM port of each step went | Read-only, for shape and for the places where a port needed a decision |
| `CLAUDE.md`, `packages/core/CLAUDE.md`, `packages/web/CLAUDE.md` | The day-to-day rules distilled from the pages, with pointers to the decisions. The root file is a seed until step 1.2. | Loaded at the start of every session |
| This file | Order of work, tests, done criteria, progress | Read the Status section at the start of every session |
| `~/Projects/analytics-sdk-web/{posthog-js, analytics-next, Amplitude-TypeScript, snowplow-javascript-tracker, mixpanel-js}` | Source of the five reference web SDKs (analytics-next is Segment), shallow clones of 2026-10-12, and the design workspace's `CLAUDE.md` | Read-only, for implementation patterns. Where a reference SDK and a decision disagree, the decision wins. Every claim about them is made with file:line. |
| `~/Projects/rubicon/demo-app/rubicon-web-demo` (repo `rubicon-team/rubicon-web-demo`, created empty on 2026-10-14) | The web demo app and its fake backend | Phase 9 |
| `~/Projects/rubicon/demo-app/rubicon-ios-demo` | The iOS demo app: `fake-server/server.py` (standard library, 261 lines), `docs/manual-checklist.md`, the README's tab layout | The template for phase 9 |

**The contract questions of 2026-10-14.** During the web design three contract changes were agreed
(entry page, section "Contract questions decided during the web design"): while opted out no new
upload starts on any platform, only the consent decision is written, and no remote configuration
request is made. The Android and iOS pages carry Changed on notes, but the Android and iOS code does
not implement them yet; that work was deferred by the user. When porting privacy, writer, uploader,
remote configuration or diagnostics code from Android, follow Web Logging 4 and 5, Web Privacy 1 to 3
and the Changed on notes on Android Privacy 1, 3, 4 and Android Logging 5, not the Android code.

Decision pages (link: `https://rubiconn.atlassian.net/wiki/spaces/SD/pages/<id>`):

| Block | Web page | iOS page | Android page |
|---|---|---|---|
| Public API | 12517377 | 7798805 | 3211265 |
| Event Model | 12910593 | 8945665 | 3407873 |
| Configuration | 13074433 | 8978442 | 2981890 |
| Identity Management | 13271041 | 9043969 | 3833857 |
| Context Enrichment | 13271073 | 8880130 | 3899401 |
| Session Management | 13565953 | 9175041 | 4161537 |
| Automatic Lifecycle Events | 13697025 | 8880160 | 4325379 |
| Queue with Flush Policy | 13828097 | 9240577 | 4161566 |
| Disk Persistence | 13926401 | 9633793 | 4587522 |
| Serialization | 13893634 | 9764865 | 4358166 |
| HTTP Client with Compression | 14352386 | 9895937 | 3964956 |
| Retry and Network Awareness | 14647297 | 9994241 | 4096005 |
| Privacy Controls | 14745601 | 10092545 | 4325427 |
| Logging | 15040513 | 9601026 | 4554779 |

In this plan "Web Queue 2" means decision 2 on the web Queue with Flush Policy page, "Queue 5"
decision 5 on the Android page, "iOS Queue 1" decision 1 on the iOS page, and so on. "Android log
5.1" means the rows of step 5.1 in section 15 of the Android plan, "iOS log 5.1" the same in the iOS
plan.

## 2. Working agreement for the implementing session

1. At the start of a session read `CLAUDE.md`, then section 14 (Status) of this file, and take the
   first unchecked step. Do not work on two steps at once.
2. Branches and pull requests follow D18 once it is answered. Until then: phase 1 is one branch and
   one pull request, reviewed step by step; every later step is one commit; a step that turns out too
   big is split, and the split is written into this file first.
3. Before writing code for a step, read the decisions listed under "Read" in full, web page first,
   then the Android page it inherits from, then the Android code named under "Port", then the iOS
   port of the same code where the step says so. Read the reference SDK code named there when the
   step says so.
4. Write the tests listed under "Tests" before or together with the code. A listed test may be
   renamed or merged; it may not be skipped. If a test cannot be written, stop and say why.
5. If a decision is missing, ambiguous, contradicts another decision, or cannot be implemented as
   written (a browser behaviour that differs from the page, an engine that refuses what the page
   assumes), stop and ask the user, with the options and a recommendation. Never decide silently.
   Record the answer in section 15 and, when it changes a decision, tell the user which Confluence
   page and which `CLAUDE.md` rule need the change; update them after approval. A change to the
   contract itself is a change to the Android and iOS pages and the backend as well, and is taken
   only with the user.
6. Done means every item of section 6 (Definition of done) holds. Then tick the step in section 14,
   fill its rows in the traceability table (section 13) and commit, or stop for review, as D18 says.
   Push and open the pull request only after the user approves. Never merge, and never push to
   `develop` or `master`.
7. The conversation is in Turkish with technical terms in English; documents, code and comments are
   in English, without emoji. The user is a Java backend developer new to browser JavaScript and
   TypeScript: a browser term that is not in the entry page's terms table is explained with its JVM,
   Android or iOS counterpart when it first comes up.
8. Dated facts (tool versions, Playwright's browser builds, Baseline status, npm name ownership,
   runner images) are checked on the day they are used and recorded with that date in section 15.

## 3. Open decisions to settle before step 1.1

These are not covered by the Confluence decisions and block the scaffold. Ask the user about each
in one message, with the recommendation, and record the answers in section 15. Facts marked
"2026-10-14" were fetched on that day; check them again before asking.

Answered on 2026-10-14. The table keeps the questions as they were asked; the answers, the facts
checked again that day and the corrections they brought are in section 15, and the rest of this
file follows the answers.

| # | Question | Recommendation and reason |
|---|---|---|
| D1 | Repository and branch model | `rubicon-team/rubicon-web-sdk`, private, local `~/Projects/rubicon/rubicon-web-sdk` (created empty on 2026-10-14). The model of the other two: `master`, `develop` as the default branch, `feature/*` branches squash-merged into `develop`. |
| D2 | npm package names and globals | Published package `@rubicon/analytics`, the `web` workspace package; the `core` workspace package `@rubicon/analytics-core`, private and bundled into it (Web Public API 7). The script build installs `window.Rubicon`, the snippet `window.rubicon` (Web Public API 2); `context.library.name` is `rubicon-web` (Web Context). On 2026-10-14 the registry answered 404 for `@rubicon/analytics`, `@rubicon/web`, `rubicon-analytics` and `rubicon-web`, which says no such package exists but not who owns the `@rubicon` scope (npmjs.com refuses scripted requests); the user confirms the scope belongs to the team, or the fallback is the unscoped `rubicon-analytics`. |
| D3 | Default SaaS host | The placeholder of the other two, `https://api.rubicon.example` (Android log D7, iOS D3), until the production URL is known. |
| D4 | License | Apache-2.0, as the other two. |
| D5 | Version numbering and the version constant | SemVer, first release `0.1.0`, the number line of the other two for the same contract. `package.json` holds the version; the build replaces a `__VERSION__` constant in `core` (used by `context.library.version`, the snippet sentinel and the second-instance message); CI fails when the tag differs from `package.json` (step 8.6). |
| D6 | Node, package manager and the local toolchain | Node 24 LTS ("Krypton", v24.22.0 released 2026-10-14; Node 22 "Jod" is the previous LTS) and pnpm (12.11.2 on 2026-10-14), pinned through `packageManager` in `package.json` and `engines`. Node is not installed on the user's Mac (checked 2026-10-14); the recommendation is `brew install node@24 pnpm`, run by the user. Node is a build and test tool only; the SDK runs in browsers. |
| D7 | TypeScript version | TypeScript 6.0.x (6.0.3 of 2026-04-16), the last compiler written in TypeScript, because api-extractor (7.59.4, which analyses with its own TypeScript 5.9.3), the Rollup TypeScript plugin and typescript-eslint use the compiler API. TypeScript 7 (7.0.2 of 2026-07-08) is the native compiler; revisit when the tools support it. Confirm in step 1.1 that 6.0 emits `target: "es2017"` and declarations as Web Public API 6 needs. |
| D8 | Build tool | Rollup 4 (4.64.6 on 2026-10-14) for the ESM, CommonJS and IIFE outputs, with `tsc` for type checking and declarations and api-extractor for the `.d.ts` rollup and the API report (Web Public API 7). Four of the five reference SDKs build with Rollup (PostHog `rollup.config.mjs`, Amplitude `scripts/build/rollup.config.js`, Snowplow `rollup.config.js`, Mixpanel `rollup.config.mjs`; Segment uses webpack). Alternatives: tsup (9.0.0) or plain esbuild, simpler but less control over the IIFE and the `exports` map. |
| D9 | Test runners | Vitest (5.0.4 on 2026-10-14) for `core` in plain Node and for `web` unit tests in jsdom (30.1.2); Playwright (1.64.1 on 2026-10-14, bundling Chromium 156, Firefox 157 and WebKit 27.2) for everything jsdom cannot do (Web Public API 7, Web Privacy 5, Web Serialization). Python 3 as the independent JSON parser of the wire tests (Web Serialization). |
| D10 | Lint, format and source rules | ESLint 10 with typescript-eslint, and Prettier 3, both development dependencies; the static rules of section 5 as ESLint `no-restricted-*` rules where they fit and a `scripts/check-source-rules.mjs` with a `--self-test` for the rest (the iOS shape). Alternative: Biome 2.5 alone, one tool, but custom rules such as the log content rule are harder to express. |
| D11 | Coverage | Vitest's V8 coverage, gated at 90 percent of lines in `core` and 80 percent in `web` (the Android and iOS thresholds); Playwright-only code (the real storage, transport and lifecycle implementations) is listed in the gate's exclusions with the browser test that covers it. |
| D12 | CI | GitHub Actions on `ubuntu-24.04` (Linux minutes count once): every pull request runs the whole `pnpm check` (format, lint, source rules, type check, build, ES2017 check, unit tests with coverage, API report, size gate, SSR import test) and the Playwright suite in the three engines; the multi-tab, subdomain and close-time suites run on every pull request that touches `packages/web` and nightly. A macOS runner only if a WebKit behaviour turns out to differ on Linux; check the runner image and Playwright's Linux WebKit on the day. |
| D13 | The browser floor in tests | Web Public API 6 records Chrome 55, Edge 15, Firefox 52, Safari 10.1 and iOS 10.3 as the tested floor. Playwright runs only the engines it bundles (Chromium 156, Firefox 157, WebKit 27.2 with 1.64.1, 2026-10-14), so the floor cannot be run in CI. Recommendation: (a) check the built output with `es-check` (9.8.1) for ES2017 syntax and keep the source rule against ES2019 and newer library calls; (b) run the floor builds by hand on a cloud browser service before a release, if the user wants to pay for one (price and coverage checked on the day); (c) a Changed on note on Web Public API 6 that the floor is syntax-checked in CI and behaviour-tested on current engines. (c) changes a page and needs the user's approval. |
| D14 | Test server for the SDK's own tests | A small HTTP server on `node:http` in the private `testing` package (no dependency): scripted responses (any status, `Retry-After`, delay, a redirect, a dropped connection), recorded requests with the gzip body decompressed, the CORS headers of Web HTTP 4 on every response, errors included, and fixture pages for Playwright. It is the counterpart of MockWebServer and the iOS `TestHTTPServer`. The demo's Python fake server stays the demo's (phase 9). |
| D15 | Several hostnames in browser tests | Identity 2 (subdomain cookies), Privacy 2 (consent across subdomains) and Retry 1 need pages on several hosts of one site. Recommendation: `a.rubicon.test` and `b.rubicon.test` mapped to `127.0.0.1` for the test browsers, with the mechanism (a host resolver rule per engine, or `/etc/hosts` on the CI runner) chosen in step 1.3 after a probe shows that each engine accepts a `Domain=rubicon.test` cookie there. If an engine refuses, the subdomain tests run in the engines that accept and the gap is written into section 15. |
| D16 | Script build hosting and SRI | Web HTTP 6 requires an immutable, version-pinned URL with an SRI hash and `Access-Control-Allow-Origin`, plus a floating major-version URL. Recommendation for the first releases: jsDelivr serving the npm package (`cdn.jsdelivr.net/npm/<package>@<version>/dist/rubicon.min.js`), verified on the day for CORS, immutability and SRI use; a CDN of our own later. The release step computes and publishes the SRI hash and the stub's hash. |
| D17 | Documentation build | api-extractor's `ae-undocumented` message as the gate that every public symbol has a TSDoc comment (the counterpart of the Dokka and DocC checks); TypeDoc (0.28.20) for an HTML reference only if the user wants one. The integration guide is the README (step 8.5). |
| D18 | Branch and commit granularity | The iOS model as it settled (iOS log 2026-10-11 and 2026-10-12): phase 1 one branch and pull request, each step reviewed before its commit; phases 2 to 5 one branch `feature/core-foundations`; steps 6.1 to 8.5 one branch `feature/sdk-complete`; one commit per step without a review stop inside those two, questions still asked when a decision is missing; step 8.6 and phase 9 after that. |
| D19 | Demo app technology | `rubicon-team/rubicon-web-demo` (created empty on 2026-10-14): a Vite and TypeScript app with real page loads (several HTML pages, for the back/forward cache and full navigations) and a single-page area on React Router, the router most customers use; Next.js and Vue Router are verified by small fixture apps in the SDK's nightly Playwright suite (step 8.1) rather than in the demo. The fake backend is the iOS demo's `server.py` with CORS added (step 9.1). |
| D20 | npm publishing | An npm organisation account for the scope of D2 with two-factor authentication, publishing from CI with provenance; the user sets up the account and the token. Needed only at step 8.6. |

## 4. Target layout

```
rubicon-web-sdk/
  CLAUDE.md                     root rules (seed now, full in step 1.2)
  README.md                     integration guide (step 8.5)
  CHANGELOG.md
  LICENSE
  package.json                  private root: scripts, packageManager, engines, development dependencies only
  pnpm-workspace.yaml
  tsconfig.base.json            target and lib es2017, strict, importHelpers false (Web Public API 6, 7)
  eslint.config.mjs, .prettierrc
  packages/
    core/                       rubicon-analytics-core, private, never published; no DOM: lib ["es2017"], tests in plain Node
      CLAUDE.md
      src/
        index.ts                the public types and the core factory, re-exported by web
        <area>/                 see the list below
      test/                     Vitest, Node environment
        fixtures/golden/        the Android golden wire files, copied verbatim, refreshed by a script
    web/                        rubicon-analytics, the package to publish (D2, D20)
      CLAUDE.md
      src/
        index.ts                createAnalytics, createNoOpAnalytics, createTrackedFetch, the public types
        platform/               the browser implementations of the core interfaces: storage, cookies, transport, clock, lifecycle, context
        autocapture/            page views and the history registry
        network/                createTrackedFetch
        script/                 the IIFE entry (window.Rubicon) and the snippet adapter
        snippet/                the two-tag snippet text (ES5) and its build
      test/
        unit/                   Vitest with jsdom
        browser/                Playwright specs, run in Chromium, Firefox and WebKit
        ssr/                    the plain-Node import-and-create test
      etc/rubicon-analytics.api.md  the api-extractor report, committed
      api-extractor.json, rollup.config.mjs, .size-limit.json
    testing/                    private: TestPlatform fakes, the virtual-time scheduler, the test server (D14), the golden loader, page fixtures
  scripts/
    check.sh                    everything CI runs, in order
    check-source-rules.mjs      the static rules of section 5, with --self-test
    check-es2017.sh             es-check over every built JavaScript file (D13)
    refresh-golden.sh           copies the Android golden files and fails when they changed
    release.sh                  step 8.6
  docs/
    implementation-plan.md      this file
    issue-codes.md              the catalogue, copied from Android with the Platform, Web level and Frequency columns (Web Logging 3)
    storage-declaration.md      every cookie and key the SDK writes (Web Privacy 5), checked by a Playwright test
    wire-format.md              points at the golden files; the web differences (Web Serialization 1, Web Context 5)
    csp.md                      what a host's Content Security Policy must allow (Web HTTP 6)
  .github/workflows/, .github/pull_request_template.md
```

Internal areas in `core`, one folder each, the names of the Android packages: `platform` (the
interfaces `Clock`, `RandomSource`, `KeyValueStorage`, `CookieJar`, `HttpTransport`,
`LifecycleSource`, `NetworkSignal`, `ContextProvider`, `Scheduler`), `log`, `util` (UUIDv7, ISO
time, HTTP date, SHA-256), `json`, `validation`, `config`, `event`, `storage` (stores, chunks,
capacity), `queue` (writer, uploader, triggers), `http`, `retry`, `identity`, `session`, `context`,
`privacy`, `remote`, `diagnostics`, `pipeline`. Only what `src/index.ts` exports is public; the
`exports` map of `web` exposes nothing else (Web Public API 7). Types the `web` and `testing`
packages need from `core` are imported through the workspace, never through the published package.

## 5. Test strategy

Every layer below is required; the step or phase that introduces it is in brackets.

| Layer | Where | Tools | Covers |
|---|---|---|---|
| Unit, core | `packages/core/test` | Vitest in plain Node; fakes from `testing`, never a mocking library | Every component in isolation through `TestPlatform` (clock, random, scheduler with virtual time, in-memory `KeyValueStorage` and `CookieJar` with fault injection and a second "tab" sharing the same maps, fake transport, lifecycle source, network signal, context provider) [2 onward] |
| Unit, web | `packages/web/test/unit` | Vitest with jsdom | The browser implementations where jsdom models them (`document.cookie`, `localStorage`, `history`, `visibilityState`), the factory, the snippet adapter [7] |
| Component integration | `packages/core/test/integration` | The core over the in-memory storage shared by two simulated pages, the real `fetch` transport of Node against the test server | The whole pipeline from `track` to the server, a page reload (a new instance over the same storage), two pages at once, crash leftovers [6] |
| Browser | `packages/web/test/browser` | Playwright in Chromium, Firefox and WebKit against the test server | Real storage, cookies and their domains, `fetch` with `keepalive` at close, `CompressionStream`, `visibilitychange`, `pagehide`, the back/forward cache, history wrapping, the snippet and the script build, CSP violations, mixed content [7, 8] |
| Several tabs and hosts | `packages/web/test/browser/multi` | Playwright with several pages in one context, and the hosts of D15 | Web Queue 2 chunk ownership and adoption, Web Retry 1 shared pauses and the probing page, Web Privacy 2 consent across tabs and subdomains, Web Identity 2 and 3, Web Session 2 and 5, Web Privacy 3 erasure across tabs [8] |
| Wire contract | `packages/core/test/fixtures/golden` | Structural comparison as Android and iOS do (Web Event Model 4): ids and `library` taken from the file, the eight fields the web never produces removed, the web-only groups pinned in their own fixture; Python 3 as the independent parser of every written line | One golden file per event type and the batch envelope, plus web-only fixtures for `Page Viewed` and the `browser` and `page` groups [3, completed in 8.4] |
| Serialization in engines | `packages/web/test/browser/serialization` | The conversion table and the UTF-8 size scan run in Node and in the three engines (Web Serialization) | Engine differences in `JSON.stringify`, `toISOString` and string handling [2.4, 8] |
| Packaging | `packages/web/test/ssr`, `scripts/check-es2017.sh`, size-limit, api-extractor | Plain Node `import` and `require` of the built package; es-check; size-limit; the API report | Import touches no `window`, `document` or `localStorage` and `createAnalytics` returns the no-op outside a browser; ES2017 output; the size gate; every public change visible (Web Public API 6, 7) [1, 8] |
| Robustness | unit and integration | Seeded random inputs (no new library), fault-injecting storage, cookie jar and transport | Validator and serializer never throw on arbitrary input; quota errors, `SecurityError` on storage access, a vanished chunk, unparsable stores degrade as decided [2, 4, 6] |
| Static rules | `scripts/check-source-rules.mjs` and ESLint | Source scan | No `console` outside the default sink; no `Date.now()` or `new Date()` outside `Clock`; no `Math.random`; no `window`, `document`, `navigator`, `localStorage` or `globalThis` in `core`, and in `web` only under `platform/`, `autocapture/`, `network/`, `script/` and the factory; no top-level side effects in any module; no ES2019 or newer library calls (`Object.fromEntries`, `flat`, `flatMap`, `allSettled`, `replaceAll`, `at`, `structuredClone`) (Web Public API 6); no `async` or Promise return in the public API (Web Public API 3); no `any` in `src`; no `enum` (Web Event Model 5); log calls never pass `properties`, `traits`, `userId`, `deviceId`, `apiKey`, `headers`, `body`, or a caught error's `message`, `stack`, `name` or text (Logging 4a, Web Logging 1); `fetch` and `XMLHttpRequest` are never assigned (Web Lifecycle 6), and `history.pushState` and `replaceState` are wrapped only by the registry of Web Lifecycle 2; no `sendBeacon`, `unload` or `beforeunload` (Web Queue 3); no `sessionStorage`, `indexedDB` or `navigator.storage` (Web Disk 1, 7, Web Privacy 5); no read of `globalPrivacyControl` or `doNotTrack` (Web Privacy 4); no `click`, `submit` or `input` listeners (Web Lifecycle 7); no `eval`, `new Function` or run-time script loading (Web HTTP 6) [1, extended as areas arrive] |
| API | `packages/web/etc/rubicon-analytics.api.md` | api-extractor report, committed; CI fails when it differs | Every public change is visible in the diff and named in the pull request; nothing is public by accident [1] |
| Coverage | `pnpm coverage` | Vitest V8 | The gates of D11 [1] |
| Manual | demo app with the fake backend | Checklist in step 9.3 | What a person must see once before a release [9] |

Rules that apply to every test:

- Test names are sentences; `describe` groups them. No real waiting in unit tests: time is virtual
  through the `Scheduler` and the `Clock`. Integration and Playwright tests may wait, with a timeout,
  on a condition (`expect.poll`, `waitForRequest`), never on a fixed sleep.
- Every test gets its own storage maps or its own browser context. No test depends on another's
  order; nothing is global, and the `globalThis` marker of Web Configuration 3 is reset between tests
  through a `testing` helper.
- Every drop reason and every issue code that the web produces has at least one test that produces
  it and asserts the counter; a test enumerates `DropReason` and the code list against
  `docs/issue-codes.md` and fails when one has no producing test, or when a code marked "never
  produced on the web" appears in `src` (Web Logging 3).
- Every developer error has a test with `debug: true` (the line becomes `console.error(new Error(...))`
  and nothing throws) and the same input with `debug: false` (the WARN line and its code), and a test
  that `logging.level: "off"` silences both (Web Public API 4, Web Logging 1).
- Every public entry point has a test that injects a failure below it (a throwing storage, transport,
  hook, logger or observer) and asserts that the host's call returns normally (never crash the host).
- The ports from Android (UUIDv7, ISO formatter, HTTP date, SHA-256, validator limits, retry table)
  run the Android test vectors, copied verbatim, so the three SDKs are proven equal where the
  decisions say they are.

## 6. Definition of done (every step)

- Every test listed for the step exists and passes; `scripts/check.sh` (format, lint, source rules,
  type check, build, ES2017 check, unit tests with coverage, API report, size gate, SSR import test,
  and the Playwright suite when the step touches `packages/web`) is green locally and in CI.
- A public API change has its API report diff in the pull request, a TSDoc comment on every new
  public symbol, and is named at the top of the pull request.
- No runtime dependency, ever (Web Public API 7); a development dependency added in a step is named in
  the pull request with its reason.
- Every new WARN or ERROR has a code listed in `docs/issue-codes.md` with its Platform, Web level and
  Frequency columns; every new way to lose an event uses a `DropReason` and is counted.
- No value, id, key, header, body, query string or caught error's text reaches a log line (Logging
  4a, Web Logging 1).
- Every cookie or storage key the step writes is listed in `docs/storage-declaration.md`, and the
  Playwright declaration test passes (Web Privacy 5).
- Every browser API above the floor that the step uses is feature-detected with the fallback its
  block page names, and appears in that page's table; a new detection is a design question.
- `CLAUDE.md` of the affected package updated if a rule was added, changed or clarified; this file
  updated: status ticked, traceability rows filled, decisions log extended.
- No `TODO` without the step that resolves it.
- The pull request follows the template: problem, change, how it was tested, and the decisions it
  implements (for example "Web Queue 2, Queue 4, Web Disk 2").

## 7. Phase 1: Repository and tooling

Android paths below are relative to `~/Projects/rubicon/rubicon-android-sdk/sdk-core/src/main/kotlin/com/rubicon/analytics/`
and written `internal/...` or `<File>.kt`; Android tests are under `sdk-core/src/test` and the
fixtures under `sdk-core/src/testFixtures`.

### 1.1 Scaffold

- Read: Web Public API 6 and 7; the D answers in section 15; Android plan step 1.1 and iOS plan step
  1.1 for the shape.
- Build: the pnpm workspace (`package.json` with `packageManager` and `engines`, `pnpm-workspace.yaml`),
  the three packages of section 4 with empty sources; `tsconfig.base.json` (`target` and `lib`
  `es2017`, `strict`, `importHelpers: false`, `isolatedModules`), `core` with `lib: ["es2017"]` and no
  DOM types, `web` with `lib: ["es2017", "dom"]`; Rollup for `web` producing ESM, CommonJS and the IIFE
  (`dist/rubicon.min.js`), with `core` bundled in; the `exports` map (`import`, `require`, `types`),
  `main`, `module`, `types`, `sideEffects: false`, `files`; api-extractor with the committed report and
  the `.d.ts` rollup; size-limit with a provisional limit of 20 KB gzip for the script build (Web
  Public API 7; final in step 8.2); ESLint and Prettier (D10); `scripts/check.sh` and the checks of
  section 5 as far as they can run on an empty package (format, lint, source rules with
  `--self-test`, type check, build, `check-es2017.sh`, unit tests with coverage, API report, size,
  SSR import); `refresh-golden.sh` copying the Android golden files into
  `packages/core/test/fixtures/golden`; GitHub Actions workflows (the pull request lane of D12, with
  the suites for `packages/web` and a manual `workflow_dispatch` run; no scheduled lane; Playwright's
  three engines installed in CI); pull request template; `LICENSE`,
  `CHANGELOG.md`.
- Tests: an empty test in each package runs; the built ESM and CommonJS entries load in plain Node
  (`import` and `require`) without touching `window`; the IIFE defines nothing but `window.Rubicon`;
  `check-es2017.sh` fails on a planted ES2018 construct and passes on the output; `check.sh` is green
  on the empty packages; one Playwright test opens a blank page in each engine.

### 1.2 CLAUDE.md files

- Read: the Android root, `sdk-core` and `sdk-android` `CLAUDE.md` and the iOS ones in full; every web
  page's Summary table and Changed on notes.
- Build: the root `CLAUDE.md` (packages, commands, non-negotiables, public API, dependencies, the
  single thread and the page lifecycle, testing, code style, git, keeping the files honest),
  `packages/core/CLAUDE.md` and `packages/web/CLAUDE.md`, each the Android rules rewritten for
  TypeScript with the web differences folded in and pointers to the pages. Property validation, the
  conversion table, the limits and the `beforeSend` rules go into the root file under Public API, as
  on Android and iOS (Android log 1.2, iOS log 1.2).
- Tests: none; reviewed by the user against the pages.

### 1.3 Test server and browser harness

- Read: Web HTTP 4 (the CORS requirement), D14, D15; Web Identity 2; Web Privacy 2; the iOS
  `TestHTTPServer` (`Sources/RubiconTesting`) for the scripted-response API.
- Build: the `node:http` test server in `testing` (scripted batch and config responses, recorded
  requests with the gzip body decompressed, the CORS headers on every response and the `OPTIONS`
  preflight answer of Web HTTP 4, a switch that omits them for the failure tests, fixture pages served
  from `packages/web/test/browser/pages`); the Playwright configuration that starts it; the several
  hostnames of D15 after a probe in each engine.
- Tests: a preflighted `fetch` from a page on another origin reaches the server in all three engines;
  without the CORS headers the page sees a `TypeError`; a cookie with `Domain=rubicon.test` set on
  `a.rubicon.test` is read on `b.rubicon.test` in each engine that accepts it (the result recorded in
  section 15).

### 1.4 Close-time measurements

- Read: Web HTTP 1, 2, 5; Web Queue 3 and 5; Web Disk 2 (the capacity formula); the HTTP page's
  experiment of 2026-10-14 (Chromium 148 and WebKit 26.4 delivered; Firefox not measured).
- Build: Playwright specs, kept in the suite, that send a preflighted `keepalive` POST of 40 KiB from a
  `visibilitychange` and from a `pagehide` handler and then (a) navigate away and (b) close the page,
  in each engine, and check that the server received the body; a spec that fills `localStorage` with
  keys of known length until `QuotaExceededError` in each engine.
- Tests: the specs themselves. Record the results with the date and the engine versions in section 15.
  If Firefox loses the request at close, stop and tell the user: Web HTTP 5 reopens the key-in-body
  question only in that case. If an engine's quota does not match the 2 × (key and value length) rule
  of Web Disk 2 within a margin, stop and ask.

## 8. Phase 2: Core foundations (no pipeline yet)

### 2.1 Platform interfaces and test fixtures

- Read: Web Queue 1 (one thread, slices), Web Disk 1 to 4 (key-value storage, vanished keys, merge
  writes, the memory-only mode), Web Identity 1 and 3, Web Session 1 and 4, Web Retry 2 and 3, Web
  Event Model 3; Android log 2.1 and 5.1; iOS plan step 2.1.
- Port: `internal/platform/*`, `sdk-core/src/testFixtures`.
- Build: the `core` interfaces `Clock` (wall time only, Web Session 4, Web Retry 3), `RandomSource`
  (`nextUint32()`, Web Event Model 3), `KeyValueStorage` (synchronous `getItem`, `setItem`,
  `removeItem`, `length`, `key(i)`, throwing like `localStorage`), `CookieJar` (read all, write one with
  domain, path, `Max-Age`, `SameSite`, `Secure`), `HttpTransport` (one request, a result, an abort, a
  `keepalive` flag), `LifecycleSource` (visible, hidden, `pagehide`, `pageshow` persisted),
  `NetworkSignal` (`onLine`, `online`, `offline`), `ContextProvider`, `Scheduler` (`after(ms, fn)`,
  `cancel`, `yield` for writer slices); `Platform` as an object of them; in `testing`: `TestPlatform`
  with `TestClock`, `SeededRandom`, `MemoryStorage` and `MemoryCookieJar` with fault injection
  (`SecurityError` on access, `QuotaExceededError` on write, a key that vanishes between `key(i)` and
  `getItem`) and a second "page" that shares the same maps, `FakeTransport`, `FakeLifecycleSource`,
  `FakeNetworkSignal`, `FakeContextProvider`, and the virtual-time `TestScheduler`.
- Tests: the virtual scheduler runs due work in order and never early; two pages over one
  `MemoryStorage` see each other's writes; fault injection produces each failure as the browser would.

### 2.2 Logging infrastructure

- Read: Web Logging 1 to 3; Logging 1 to 4; Android log 2.2; iOS plan step 2.2.
- Port: `internal/log/*` (`Log`, `Code`, `CallbackGuard`), `docs/issue-codes.md`.
- Build: `LogLevel`, `RubiconLogger`, `EventObserver`, `EventUpdate`, `DropReason` as string literal
  unions with `as const` arrays (Web Event Model 5); the code list with every Android code plus the
  eight web names of Web Logging 3; the internal `Log` with lazy message functions, the level checked
  first, the repeat frequency (`per_page` in memory, `per_24h` through a store field supplied later in
  4.1, per page until then); the guard with a module-level "in callback" flag, a throwing or rejecting
  logger replaced by the default sink for the page (`LOGGER_THREW`), a throwing or rejecting observer
  switched off (`OBSERVER_THREW`); the no-op default sink in `core` (the `console` sink is step 7.1);
  `debug` changing only the form of a developer-error line (Web Logging 1);
  `docs/issue-codes.md` copied from Android with the Platform, Web level and Frequency columns filled
  for the web (the Android file does not have them yet, see section 15).
- Tests: a disabled level never runs the message function; `per_page` logs once and later lines go to
  DEBUG; the guard ignores lines caused inside a callback; a logger that throws and one that returns a
  rejected Promise are both replaced once; `"off"` silences a developer error with and without
  `debug`; the code list matches the catalogue file and fails on a missing row; codes marked never
  produced on the web do not appear in `src`.

### 2.3 Identifiers, time and hashing

- Read: Web Event Model 2 and 3; Web Identity 4 (synchronous SHA-256); Web Serialization 2 (`Date`
  range); Retry 3 (HTTP dates); Android log 2.3; iOS log 2.3.
- Port: `internal/util/{UuidV7Generator, IsoDates, HttpDates, Hashing}.kt` with their tests and vectors.
- Build: the UUIDv7 generator with `Number` arithmetic (48-bit milliseconds, 42-bit counter, no bitwise
  operation above 32 bits, no `BigInt`), one per instance, used for `message_id`, `device_id` and the
  session id; the ISO formatter rule of Web Serialization 2 over `toISOString` with the 0000 to 9999
  range; the HTTP date parser (IMF-fixdate only, Android log 2.3); a synchronous SHA-256 over UTF-8
  (own code or a vendored audited implementation, zero dependencies) and `keyHash` as its first 16 hex
  characters; the 64-bit `person_epoch` as 16 lowercase hex from `RandomSource` (Web Session 5).
- Tests: the Android UUIDv7 vectors replayed through a scripted `RandomSource` (the same ids as
  Android), version and variant bits, 10 000 ids in one millisecond unique and ordered, a clock set
  back, counter overflow; the Android `IsoDates` table verbatim; RFC 9110 date examples and malformed
  inputs; the Android `Hashing` vectors and the NIST SHA-256 examples, including non-ASCII input.

### 2.4 JSON layer and the size scan

- Read: Web Serialization 1 and 3; Serialization 1 and 4; Web Disk 2 (JSON Lines in a chunk) and 3
  (stores); Android log 2.4.
- Port: `internal/json/Json.kt`, `internal/event/EventWire.kt`.
- Build: the only code that calls `JSON.stringify` and `JSON.parse`: write a compact line from a
  `PropertyValue` tree; parse store records with typed reads that keep unknown fields (Web Disk 5);
  check a stored line for corruption; the UTF-8 byte count by a code-unit scan (Web Serialization 1).
  Events are never parsed back into objects except for the corruption, age and `device_id` checks the
  pages name (Web Disk 2, Web Privacy 3).
- Tests: `{"coupon":null}` written as such; `1e+21` and `49.9` pinned; the byte scan equals
  `TextEncoder` on seeded random strings with surrogate pairs; a store with missing, extra and wrongly
  typed fields; trailing content after an object makes a line corrupt (Android log 2.4); every line
  parsed by Python's `json` with strict UTF-8 (the independent parser of Web Serialization 3).

### 2.5 Property validation and normalization

- Read: Web Public API 4; Web Serialization 2; Serialization 2 and 3; Android log 2.5; iOS plan step
  2.5.
- Port: `internal/validation/*` and its tests.
- Build: `PropertyValue`; the normalizer in the order of the Web Serialization 2 table (`undefined`
  absent in objects and `null` in arrays, finite numbers, `NaN` and `Infinity` rejected, safe `BigInt`,
  boxed primitives, `Date` in range through `toISOString`, `Temporal` and date-library objects rejected
  with the hint, `Set`, `Map` with string keys, typed arrays, `URL` as `href`, plain objects from any
  realm by `Object.prototype.toString`, foreign `toJSON` never run, a throwing getter or a `Proxy`
  rejected for that key, everything else rejected key by key); lone surrogates replaced with U+FFFD;
  the Android limits (32 KB in UTF-8, 255, 1024, 256 with super properties dropped first, depth 3,
  cycles); the WARN with key and type and the developer error of Web Public API 4; the second pass
  after the hooks.
- Tests: one test per row of the table, including an iframe-realm object in jsdom; the JavaScriptCore
  cases of Web Public API 4 (`undefined`, a function, `NaN`, `Infinity`, `BigInt`, a `Date`, `1.0`,
  nested arrays with holes); every Android limit test ported; seeded random values never throw. The
  same table runs again in the three engines in step 8.1 (Web Serialization 3).

## 9. Phases 3 to 6: Core

### 3.1 Configuration

- Read: Web Configuration 1 to 6 and its Changed on notes; Configuration 1 to 5; Android log 3.1.
- Port: `AnalyticsConfig.kt`, `ConfigGroups.kt`, `internal/config/{ConfigSnapshot, ConfigValidator, Hosts}.kt`.
- Build: the `core` configuration interfaces and the `web` `AnalyticsConfig` extending them (Web
  Configuration 6), with the groups of Web Configuration 1 plus `identity` (Web Identity 2), `session`
  with `inactivityTimeoutMs` (Web Session 3), `context` with `app`, `page.queryParams` and
  `page.title` (Web Context 2, 3), `autocapture` with the three web members (Web Lifecycle 8); the
  snapshot builder that copies arrays and maps and keeps function references; defaults merged per
  group; the validator (blank key, the host rules of Web Configuration 4 on the text and on the parsed
  `URL`, bounds clamped with WARN, wrong types with `SETTING_WRONG_TYPE`, another platform's settings
  with `SETTING_NOT_SUPPORTED`, reserved headers in any letter case, `CLEARTEXT_HOST` with its two
  messages of Web Logging 3 decided at creation from the page's scheme supplied by the platform);
  no freezing, no `setConfig`; `debug` default `false`, never read from the environment.
- Tests: every Android configuration test ported; mutating the caller's object, its groups, arrays and
  headers after creation changes nothing; a wrong type for every setting; an unknown `autocapture`
  member dropped with WARN; the host table accepted and rejected; logs and string forms show the host
  only.

### 3.2 Event model and public types

- Read: Web Event Model 1, 2, 5; Web Public API 5; Web Logging 1; Web Context 5; Event Model 1 to 5;
  Android log 3.2.
- Port: `Event.kt`, `EventContext.kt`, `EventSource.kt`, `DropReason.kt`, `ContextField.kt`,
  `Autocapture.kt`, `Consent.kt`, `LogLevel.kt`, `RubiconLogger.kt` and the hook rules.
- Build: `Event` as the discriminated union of `readonly` `TrackEvent`, `ScreenEvent`,
  `IdentifyEvent` on `type`; `EventContext` with the Android groups plus `browser` and `page` and
  without `network`; `ContextField` with the seventeen members of Web Context 5; `BeforeSend`; the
  hook-result rule (same `type`, source, ids, timestamp and context; on automatic events the same name
  and top-level keys); the deep copy given to a hook; `undefined`, a Promise and a rule breach as
  `HOOK_VIOLATION`, a throw as `HOOK_THREW`.
- Tests: a hook mutates its copy and the original is unchanged; a result of another kind, with a
  changed id, `undefined` or a Promise is dropped with the right code; an exhaustive `switch` over
  `Event` compiles; every closed set is a union with an `as const` array.

### 3.3 The `Analytics` interface and the no-op

- Read: Web Public API 1, 3, 4; Public API 2, 5, 8; Android log 3.3.
- Port: `Analytics.kt`, `internal/NoOpAnalytics.kt`.
- Build: `export interface Analytics` with the verbs of Web Public API 3, every method returning
  `void`, `readonly isOptedOut` and `readonly deviceId`; `createNoOpAnalytics()` returning a fresh
  object literal whose methods are own properties (`isOptedOut` true, `deviceId` the empty string).
- Tests: a spread-based fake (`{ ...createNoOpAnalytics(), track: spy }`) type-checks and gains a new
  verb automatically; every no-op method accepts any input and returns `undefined`; two calls return
  different objects.

### 4.1 Key-value stores

- Read: Web Disk 3, 4, 5, 6 and the Changed on notes; Web Identity 4; Web Retry 1 (the `retry` field
  and `.pause`); Web Privacy 2 (`.consent`); Web Logging 2 and 5 (the 24-hour times and the
  counters); Disk 4, 6; Android log 4.1.
- Port: `internal/store/{DeviceStore, PersonStore, StoreFields, StoreFile}.kt`, `internal/storage/KeyValueStore.kt`.
- Build: the stores `rubicon.<keyHash>.device`, `.person`, `.remote`, `.consent`, `.pause` over
  `KeyValueStorage`, with the Android record shapes of log row 4.1 plus the web fields (`retry` with
  `rev`, `probe_at` and `suspects`; the `per_24h` times; the diagnostics counters and checkpoint;
  `.person` carrying its `device_id`); every write as one synchronous fresh read, field-level merge and
  one `setItem`, counters as increments, unknown fields kept; an unreadable record never overwritten
  (`STORE_UNREADABLE`); a higher `v` held in memory; `.remote` written whole.
- Tests: every Android store test ported; two simulated pages writing the same store in an interleaved
  order keep both changes (two `register` calls survive, an opt-out is never undone by a counter
  write); a `SecurityError` on read and a `QuotaExceededError` on write each degrade as Web Disk 4 and
  5 say; each store's exact key set is asserted (Web Identity 4).

### 4.2 Event chunks

- Read: Web Disk 1, 2, 5, 6; Web Queue 2, 5, 6; Disk 3, 5; Queue 4, 5; Android log 4.2.
- Port: `internal/storage/{EventStore, FileEventStore}.kt`.
- Build: chunk keys `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.<seq>.<count>.<chars>`
  holding JSON Lines, the released marker `q1r.<pageId>`; the page id (16 hex from `RandomSource`) and
  the per-page sequence; the key walk (collect keys first, skip `null`, parse, sort by `writtenAt`,
  `pageId`, `seq`, then delete); expiry from `newestEventAt` without reading values; capacity as 2 ×
  the sum of key and value lengths ≤ 1 MiB and the 1000-event count, trimmed to 90 percent with
  `queue_full`; a vanished chunk skipped and never recreated or counted; idempotent deletes; malformed
  keys under the exact prefixes deleted with `UNKNOWN_FILE`; other keys' expired chunks deleted
  uncounted (Web Disk 6); a corrupt line counted once as `corrupt` with its chunk key, line number and
  `message_id`; `clear()` for deleting on purpose.
- Tests: every Android event store test that applies, ported; a chunk deleted by another page between
  the walk and the read, also in the middle of building a batch; ordering never depends on `key(i)`;
  a future `newestEventAt` never expires; a partly expired chunk filtered line by line at batch
  building; capacity computed from key names only; a `QuotaExceededError` drops the chunk as
  `storage_error` and touches no host key.

### 5.1 HTTP requests and results

- Read: Web HTTP 1 to 3; HTTP 2 to 6; Android log 5.1 and 5.3.
- Port: `internal/http/{Headers, HttpTransport}.kt` (`HttpResult`, `FailureKind`, `Retry-After` parsing).
- Build: in `core`, independent of `fetch`: the batch and configuration request descriptions of Web
  HTTP 1 (headers, the body joined from chunk lines, the `keepalive` decision supplied by the uploader,
  gzip requested or not per Web HTTP 2), the result model and the classification table of Web HTTP 3
  (`HttpError` with the body capped at 4 KB and `Retry-After`, `timeout` for our own abort, `connect`
  for a `TypeError` while offline, the `keepalive` refusal as its own result, `io`, `unexpected`), the
  45-second deadline owned by the core; reserved headers; the `X-Request-Id` DEBUG line. The `fetch`
  implementation is step 7.3.
- Tests: through `FakeTransport`: the request shape for a batch and a configuration GET with
  `If-None-Match`; every row of the classification table; `Retry-After` in both forms and the Android
  edge cases; a late answer after the deadline ignored; bodies never appear in log lines.

### 5.2 Retry policy and the shared state

- Read: Web Retry 1 to 4; Retry 1 to 5; Android log 5.2; iOS log 5.2.
- Port: `internal/upload/{RetryGroup, RetryPolicy}.kt`.
- Build: the Android table, caps and jitter; the shared transient state in `.device.retry` with `rev`
  (a success resets only when the stored `rev` equals the one read before the request), `.pause` for
  429 and the server-originated configuration group with the host hash (the later end wins, read back
  and rewritten if lower), `probe_at` with the 30-second window, the poison rule per chunk (`f`,
  `alone`, `cleared_by`, deletion with `retry_exhausted` at `f ≥ 10`, `cleared_by ≥ 1`, `alone ≥ 5`),
  only 408, 5xx and non-standard codes counting; the clock guard on every read (Web Retry 3);
  `unexpected` and mixed content as page-local states; an unknown outcome at close as waiting.
- Tests: every Android retry test ported; two simulated pages: a 429 seen by one pauses the other, a
  success in one never erases a newer failure written by the other, only one page probes when a wait
  ends; a suspect chunk deleted only after other batches succeeded; timeouts and `io` never grow `f`;
  a deadline beyond the longest wait is read as the longest wait from now.

### 5.3 Remote configuration

- Read: Web Configuration 5 and its Changed on note; Web Privacy 1; Web Logging 4; Configuration 1;
  Android log 5.3; `docs/remote-config.md` in the Android repository.
- Port: `internal/remote/{RemoteConfig, RemoteConfigClient, RuntimeFlags, Sampling}.kt`.
- Build: the contract of Android (`enabled`, `autocapture_off` with the web members, `flush_at`,
  `flush_interval_ms`, `sample_rate`, `diagnostics_sample_rate`), ETag handling, the runtime flags; the
  fetch at page load only when the saved record in `.remote` is older than five minutes, shared by the
  tabs; no request while consent is pending or refused (Web Privacy 1, Web Logging 4), run after
  `optIn()`; sampling buckets from `keyHash`'s SHA-256.
- Tests: every Android remote configuration test ported; two pages within five minutes make one
  request; no request while pending or opted out and one after `optIn()`; an unknown
  `autocapture_off` member ignored at DEBUG.

### 6.1 Identity and super properties

- Read: Web Identity 1 to 4 and the Changed on notes; Web Session 5 (`person_epoch`); Web Privacy 1 to
  3; Web Logging 3 (`INVALID_COOKIE_DOMAIN`); Identity 1 to 6; Android log 6.1.
- Port: `internal/identity/Identity.kt`.
- Build: the identity cookie `rubicon_<keyHash>` (`device_id`, `user_id`, `person_epoch`) over
  `CookieJar` with the `.device` mirror; the read matrix of Web Identity 1 as a table; read on every
  public call, read before generating, read after writing and adopting (Web Identity 3); the cookie
  written only on first visit, `identify`, `reset` and `clearLocalData`; the cookie grammar (compact,
  versioned; Web Session leaves the exact grammar to this plan: propose it to the user in this step
  before writing it); super properties in `.person` per host; the domain decision supplied by the
  platform (step 7.2).
- Tests: the matrix row by row; two simulated pages with interleaved writes never produce two ids;
  `identify` and `reset` rows of Android; the cookie size under 4096 bytes in the worst case (a
  255-character `user_id` of three-byte characters) with typical sizes snapshotted.

### 6.2 Session

- Read: Web Session 1 to 5 and the Changed on note; Session 1 to 5; Android log 6.2.
- Port: `internal/session/SessionManager.kt`.
- Build: the session cookie `rubicon_<keyHash>_s` (session id, `started_at`, last activity,
  `person_epoch`; `Max-Age` 12 hours renewed on write); visibility as the activity signal; the 30-minute
  inactivity timeout from `session.inactivityTimeoutMs` and the 12-hour maximum; the membership rule
  of Web Session 5 for every event, with the 60-second tolerance; last activity written at most every
  30 seconds per page and at once on hiding, `pagehide` and a new session, the first activity of a
  page always written; the end detected at an event, at becoming visible or at load, written, read
  back, then `Session Ended` and `Session Started` from the detecting page only; a person change
  ending the session with the old identity before the new epoch.
- Tests: every Android session test that applies, ported through `FakeLifecycleSource`; the Web Session
  5 tests (reset then heartbeat, an interleaved race in the memory cookie jar where an old `user_id`
  never returns, replay after another page's new session); a hidden page never extends a session; a
  clock 60 seconds back is a zero gap and 61 seconds ends the session backdated.

### 6.3a Event pipeline

- Read: Web Public API 5; Web Event Model 1; Public API 4; Android log 3.2 and 6.3a.
- Port: `internal/pipeline/EventPipeline.kt`.
- Build and tests: as on Android: hooks on the app's events and on automatic events, the deep copy,
  the result rules of step 3.2, `before_send` drops, `HOOK_VIOLATION` and `HOOK_THREW`, the developer
  error, `SDK Diagnostics` passing without hooks; the second validation pass.

### 6.3b Writer

- Read: Web Queue 1, 2, 5, 6; Web Disk 2; Web Privacy 1 and 3; Web Logging 3 (`page_closed`); Queue 1,
  2, 5; Android log 6.3b.
- Port: `internal/pipeline/Writer.kt` (without `AppLifecycle.kt`: the web has no app lifecycle events,
  Web Lifecycle 3, 4).
- Build: the bounded in-memory queue of 1000 fed by the public call (`backpressure` when full); the
  writer run by the `Scheduler` after paint in yielding slices; the synchronous drain on hiding and
  `pagehide` within 50 ms, what remains counted as `page_closed` with one store write; the page's own
  immutable chunks, closed at 100 events, 512 KB or the keepalive budget, never larger than the budget;
  the `device_id` check before writing (Web Privacy 3); the triggers of Android with the count trigger
  of `flush.at`; a `flush()` that follows every earlier call. The slice length and the 50 ms are
  provisional constants from the page, measured in step 9.3.
- Tests: every Android writer test that applies, ported over the virtual scheduler; a flush arriving
  in the middle of a slice; a drain on hiding that runs out of time counts `page_closed`; an event
  carrying an old `device_id` is dropped uncounted; the queue full counts `backpressure` without
  blocking the caller.

### 6.4 Uploader

- Read: Web Queue 2, 3, 5; Web HTTP 1 to 3; Web Retry 1 to 4; Web Privacy 2 and 3; Web Logging 4; Queue
  1 to 4; Retry 1, 2, 6; Android log 6.4.
- Port: `internal/upload/Uploader.kt`.
- Build: one request at a time; own chunks first, then released or aged chunks of other pages read in
  place, each deleted by id only after a 2xx; the fresh read of `.pause`, `.device` and the consent
  decision before every upload, the hiding path included; the `keepalive` budget of 48 KiB of sent
  body bytes, every request within it marked `keepalive`, one retry without it while the page lives
  and none on `pagehide`; gzip only outside the hiding path; uploads stopped while opted out with
  requests in flight completed (Web Logging 4); lines with a non-current `device_id` dropped when the
  batch is built; the `online` early attempt of Web Retry 2; the interval timer started by leftover
  chunks at load, never a startup flush. The age after which another page's chunk may be adopted has
  no value on the page ("set in the demo"): propose a provisional value to the user in this step and
  record it in section 15.
- Tests: every Android uploader test that applies, ported with the virtual scheduler; two simulated
  pages: a released chunk sent by the other page and deleted once, a chunk vanishing mid-batch, the
  same chunk sent twice tolerated; a refused `keepalive` retried once without it, never on
  `pagehide`; no request while a pause is in force or while opted out, and the queue sent after
  `optIn()`.

### 6.5 Privacy

- Read: Web Privacy 1 to 3 and both Changed on notes; Web Logging 4; Privacy 1 to 4 with the Changed
  on notes of 2026-10-14; Android log 6.5. Port the Android structure, not its opt-out behaviour (see
  section 1).
- Port: `internal/privacy/ConsentController.kt`.
- Build: consent as a state (`GRANTED`, `PENDING`, refused) from `defaultConsent`, `persistConsent`
  and the stored decision; the consent cookie `rubicon_<keyHash>_c` with `.consent` as its mirror, the
  later decision winning, read on every call and before every upload; the pending state writing
  nothing, holding identity, session and events in memory, `optIn()` writing and sending them and
  `optOut()` dropping them uncounted; the refused state of Web Logging 4 (only `{ state, decided_at }`
  written, `identify`, `register` and `reset` in memory, no new upload, no remote configuration
  request); `clearLocalData()` per Web Privacy 3 with its refused variant (deletes `.pause`, writes no
  identity until `optIn()`); the pending tab picking up a decision on the `storage` event, on becoming
  visible and at its next call.
- Tests: every row of Web Privacy 1 to 3 and Web Logging 4, including: nothing in storage after a
  pending page's whole flow; `optIn()` adopts the temporary id; a decision in one simulated page
  reaches the other; an opt-out leaves the queue unsent and an `optIn()` sends it; `clearLocalData()`
  while refused writes no identity.

### 6.6 SDK Diagnostics

- Read: Web Logging 2 and 5; Logging 5 with its Changed on note; Android log 6.6.
- Port: `internal/pipeline/Diagnostics.kt`.
- Build: the counters in `.device` as merged increments; production right before a flush (fresh read,
  the hourly limit, a future time counted as now, nothing when every counter is zero); the snapshot
  through the pipeline into a chunk; the checkpoint after the chunk is written, by subtraction from a
  fresh read; a hook drop counting as handled; memory-only counters while pending (merged on `optIn()`),
  while refused (never stored, no event) and in the memory-only mode (no event); sampling unchanged.
- Tests: the golden `sdk-diagnostics.json` shape; two simulated pages incrementing during a checkpoint
  keep their increments; a failed checkpoint write reports again at the next flush; no event while
  pending, refused or in the memory-only mode.

### 6.7 `DefaultAnalytics` and the core factory

- Read: Web Public API 1, 3, 4; Web Configuration 3; Public API 1, 2; Android log 6.7 and 7.1.
- Port: `internal/{DefaultAnalytics, RubiconCore, AutomaticCapture}.kt`.
- Build: `DefaultAnalytics` implementing `Analytics` over the components; the core factory taking a
  `Platform` and the snapshot; every public method wrapped so that nothing reaches the host
  (`WORKER_FAILED` for a failing slice); internal `flushAndWait` and `shutdown` for tests only, outside
  the `exports` map.
- Tests: the component integration suite: `track` to the test server through the real Node `fetch`,
  a reload over the same storage, two pages at once, leftovers of a page that died between writes;
  every public method with a failure injected below it returns normally.

## 10. Phase 7: The browser

### 7.1 Factory, second instance and the console sink

- Read: Web Public API 1, 7; Web Configuration 2 and 3; Web Logging 1; Android log 7.1.
- Port: `sdk-android` `AnalyticsFactory.kt` and `LogcatLogger.kt` for shape.
- Build: `createAnalytics(config)`: outside a browser the no-op with one INFO line; the module registry
  and the `globalThis[Symbol.for("rubicon.analytics")]` marker, touched only here, a second call from
  any copy returning the first instance with `SECOND_INSTANCE` naming both versions; the browser
  `Platform`; the `console` sink (`[Rubicon]` prefix, the level mapping, `debug` through `console.log`,
  `console` read per call and every call guarded, no objects passed, the developer-error form); the
  test-only marker reset outside the `exports` map.
- Tests: jsdom: a second call returns the first and logs once; the no-op never sets the marker;
  `console` removed or throwing; the SSR test in plain Node (import, create, call every verb).

### 7.2 Browser storage, cookies and the domain

- Read: Web Disk 1, 4; Web Identity 1 to 3; Web Privacy 2; Web Logging 3 (`INVALID_COOKIE_DOMAIN`,
  `STORAGE_UNAVAILABLE`); the reference clones for cookie writing (Snowplow
  `browser-tracker-core/src/tracker/index.ts`, PostHog `posthog-persistence.ts`), read with file:line.
- Build: `KeyValueStorage` over `localStorage` (every access guarded); `CookieJar` over
  `document.cookie` (attributes of Web Identity 1, `Secure` on `https`); the start probe choosing the
  memory-only mode with one `STORAGE_UNAVAILABLE` WARN; the domain probe with `__rubicon_dmn_<uuid>`
  from the last label upwards, host-only for `localhost`, an IP or no success, run once on the writer
  and deferred while pending; `cookieDomain` validated (an invalid one gives host-only cookies and
  `INVALID_COOKIE_DOMAIN`, no discovery); the `storage` event listener for consent.
- Tests: jsdom for the jar's parsing and attributes; Playwright: the probe finds `rubicon.test` on
  `a.rubicon.test`, host-only on `localhost`; a sandboxed iframe gives the memory-only mode; a
  `Domain` the browser refuses gives `INVALID_COOKIE_DOMAIN`.

### 7.3 The `fetch` transport

- Read: Web HTTP 1 to 3, 6; Web Queue 3, 5; Web Retry 4 (mixed content); Web Context 1 (the Safari
  version used to skip gzip).
- Build: `HttpTransport` over `fetch` with the options of Web HTTP 1, the 45-second `AbortController`
  and the fallback without it, gzip through `CompressionStream` except Safari 16.4 and 16.5 and never
  on the hiding path (requests started synchronously there); the classification of step 5.1 applied to
  real `fetch` outcomes; the mixed-content check before any request; the
  `securitypolicyviolation` listener (`CSP_BLOCKED` once per page, never reclassifying); the first
  unexplained failure of a page as one `UPLOAD_FAILED_OPAQUE` WARN.
- Tests: Playwright in the three engines against the test server: the request shape including the
  preflight; gzip decompressed by the server; a 302 is `HTTP_REDIRECT` without the target; a timeout;
  a page with `connect-src` excluding the host gives `CSP_BLOCKED` and `io`; an `http` host from an
  `https` page sends nothing; the CORS headers removed give `io` and the opaque WARN.

### 7.4 Lifecycle and network signals

- Read: Web Session 1; Web Queue 1 and 3; Web Retry 2 and 3; Web Lifecycle 2 (bfcache); Web Disk 2 (the
  released marker).
- Build: `LifecycleSource` over `visibilitychange`, `pagehide` and `pageshow` (with the read of
  `visibilityState` per call below Safari 14.1); the drain on hiding wired to the writer and the
  uploader; the released marker on `pagehide` and its removal on `pageshow` persisted; `NetworkSignal`
  over `navigator.onLine` and the `online` and `offline` events; timers as hints with catch-up on
  becoming visible and on restore; no `unload` or `beforeunload` listener.
- Tests: Playwright: hiding a page sends its chunks with `keepalive`; a back/forward restore resumes
  the same instance and removes the marker; the `online` event makes one early attempt; a page left
  hidden for longer than the interval catches up when shown.

### 7.5 Context provider

- Read: Web Context 1 to 5; Web Session 5 (the snippet's visibility); Context Enrichment pages for the
  inherited fields.
- Port: `internal/context/ContextProvider.kt`.
- Build: the user agent and low-entropy Client Hints parser of Web Context 1 (`os.name`, `browser.name`
  and major `version`, `device.type` with the two tablet rules, nothing sent raw); the `page` group
  with the id masking shared with step 7.7, `referrer` once per load, the viewport, `query` from
  `context.page.queryParams`, `title` only when enabled; `screen` in CSS pixels short side first,
  `density`; `locale`; `timezone`; `library` `rubicon-web` with the version; static values read lazily
  at the first call, page values per call, disabled fields never read.
- Tests: the fixed list of reduced and unreduced user agents; the tablet rules with stubbed
  `navigator`; masking (digits, UUIDs, hex longer than 16); nothing read at import; per-call values
  across `pushState`; the golden context fixtures of Web Context 5.

### 7.6 Page views

- Read: Web Lifecycle 1, 2, 5, 8; Web Context 4; Web Session 5.
- Build: `Page Viewed` at load once visible (from the snippet's record when there is one), the
  history registry under `globalThis[Symbol.for("rubicon.history")]` wrapping `pushState` and
  `replaceState` once per page and only when `page_views` is on, `popstate`, the per-entry coalescing
  with the 500 ms window (a provisional constant, verified in step 8.1), the hidden or `pagehide`
  flush of a pending view, the back/forward restore, the five `utm_*` from the view's own URL.
- Tests: the Web Lifecycle 2 test list (a redirect inside the window gives one view, two pushes give
  two, `popstate` one, a restore one, a hidden load one when shown and none if never shown, two SDK
  copies wrap once, `page_views` off leaves `history` untouched); `utm_*` never carried to later
  events.

### 7.7 `createTrackedFetch`

- Read: Web Lifecycle 6; Web HTTP 3 (the `error` values); Privacy 5c (masking); Android log 7.6.
- Port: `sdk-android` `RubiconNetworkInterceptor` for the event shape and the host rules.
- Build: `createTrackedFetch(analytics, { hosts, maskPathIds, fetch })` with `fetch`'s signature, the
  one-chain recording that returns the same `Response` and rethrows the same error, the input forms
  and the method rule, relative URLs against `location.href`, the sizes that never read or clone a
  body, the gate read at the start and before the event, the fixed `error` values.
- Tests: the Web Lifecycle 6 test list in jsdom and in one Playwright engine; axios 1.12 or later with
  the `fetch` adapter in a fixture (a development dependency of the test, named in the pull request).

### 7.8 Script build and snippet

- Read: Web Public API 2 and its Changed on note; Web HTTP 6; Web Context 4; Web Lifecycle 2 and 5; Web
  Session 5; D16.
- Build: the IIFE entry installing `window.Rubicon`; the ES5 stub text (the verb list, the queue, the
  per-call record of time, cleaned URL, viewport and visibility, the page-viewed record with the five
  `utm_*`, the double-load sentinel, no script creation); the adapter that creates the instance
  through `createAnalytics`, replays the queue in order and replaces the stub; the second library load
  refused with an error log; the stub's SHA-256 hash and the SRI hash of the built file produced by the
  build.
- Tests: Playwright: the two-tag snippet under a strict CSP with the stub's hash; replay order; a verb
  the stub does not know; a library that never arrives leaves the page working; a second load refused;
  `es-check es5` on the stub text.

## 11. Phase 8: Hardening and release readiness

### 8.1 The cross-engine suite

- Read: Web Queue 2, Web Retry 1, Web Privacy 2 and 3, Web Identity 2 and 3, Web Session 2 and 5, Web
  Serialization 3, Web Lifecycle 2.
- Build: the several-tab and several-host specs of section 5; the serialization table and the
  `IsoDates` vectors in the three engines, with iframe-realm values; framework fixtures (React Router,
  Next.js, Vue Router; development dependencies of the fixtures only) measuring the 500 ms window of
  Web Lifecycle 2; the close-time specs of step 1.4 kept green.
- Tests: the suite itself, on every pull request touching `packages/web` and on manual dispatch (D12); results that
  set or confirm a constant are recorded with the date in section 15.

### 8.2 Packaging and consumers

- Read: Web Public API 6 and 7; D13.
- Build: consumer fixtures that install the packed tarball: a Vite app, a webpack app, Node ESM and
  CommonJS, a TypeScript project with `moduleResolution` `bundler` and `node16`, compiled with
  TypeScript 5.0 (the consumer floor, section 15) and the newest TypeScript; a tree-shaking check
  that an app importing only `createNoOpAnalytics` drops the rest; the final size limits set from the
  measured build (Web Public API 7: under the smallest reference, the script build under 20 KB gzip),
  raising them later a design discussion; the floor handling decided in D13.
- Tests: every fixture builds and runs; `check-es2017.sh`; the size gate.

### 8.3 Storage declaration

- Read: Web Privacy 5; Web Disk 2; Web Identity 4.
- Build: `docs/storage-declaration.md` as the table of Web Privacy 5; the Playwright test that runs
  every flow (first visit, pending, `optIn`, `optOut`, `identify`, `reset`, `clearLocalData`, a
  retry pause, page views, a flush, a reload) and fails on any cookie or key the file does not list.
- Tests: the declaration test; a planted undeclared key makes it fail.

### 8.4 Wire contract complete

- Read: Web Event Model 4; Web Context 5; Web Serialization 1 and 3; Web Lifecycle 1.
- Build: one golden comparison per Android file and the batch envelope, structural, with the web
  removals; the web-only fixtures (`Page Viewed`, the `browser` and `page` groups, `device.type`
  `desktop`); `docs/wire-format.md` with the web differences; `refresh-golden.sh` failing CI when the
  Android files changed and the copies did not.
- Tests: every golden file has a producing test; Python parses every written line.

### 8.5 Documentation

- Read: every web page's guide items; the entry page's backend notes.
- Build: `README.md` as the integration guide: the three ways in (npm, script build, two-tag snippet
  with the pinned URL and SRI), `debug` wiring for Vite, webpack and the snippet, consent (both states,
  a consent platform example, the Global Privacy Control line), `docs/csp.md`, the first-party proxy,
  the error-tracker section (Sentry `beforeBreadcrumb` and `beforeSend`), `createTrackedFetch` with
  axios, the privacy checklist, the storage declaration, the property type list and hints; TSDoc on
  every public symbol; `CHANGELOG.md`.
- Tests: the api-extractor documentation gate (D17); the README snippets type-check in a fixture.

### 8.6 Release candidate (stops before publishing, D20)

- Build: `release.sh` (version from `package.json`, the tag, the API report baseline, the changelog
  check), the tarball from `npm pack` with the consumer fixtures of step 8.2 run against it, the SRI
  hash of `dist/rubicon.min.js` and the stub's hash computed and recorded with the release. Nothing is
  published: `npm publish`, the jsDelivr URLs of D16 and the published SRI hash wait for the user's
  publishing decision (D20 of 2026-10-14), which also settles the npm account and trusted publishing.
- Tests: CI's release lane runs `check.sh` on the tag, verifies the version and that the tarball
  holds exactly the files of the `files` list.

## 12. Phase 9: Demo app and backend (in the demo repository)

### 9.1 Fake backend

- Copy `fake-server/server.py` from the iOS demo repository; answer the `OPTIONS` preflight and add
  the CORS headers of Web HTTP 4 to every response, errors and the `drop` mode's alternatives included;
  accept the browser's own User-Agent (the web sends no SDK User-Agent, Web HTTP 1) while keeping the
  mobile check; serve the demo over the two hostnames of D15.

### 9.2 Demo app on the SDK

- The app of D19 with the tabs of the iOS demo: Events (quick events, every value type and every
  conversion row, hooks), Identity (`deviceId`, `identify`, `reset`, super properties, consent,
  `clearLocalData`, "forget me"), Capture (full page loads, the single-page area, `utm_*` links, the
  back/forward cache, `createTrackedFetch` calls), Server (the fake backend's controls), Logs (the
  observer and the log lines); a script-tag page with the two-tag snippet; a page on the second
  subdomain. The demo's own settings live under keys outside the SDK's prefixes.

### 9.3 Manual scenario checklist

- First visit and return; two tabs and two subdomains; a 429 seen by one tab; offline and online;
  hiding, closing and reopening; the back/forward cache; pending consent, opt-out, opt-in,
  `clearLocalData`; a private window and a sandboxed iframe (memory-only); a CSP that blocks the host;
  an `http` host from an `https` page; an ad blocker (`UPLOAD_FAILED_OPAQUE`); the console at each
  level.
- Measurements that set constants, each recorded with the date, device and engine in section 15: the
  writer's slice length and the 50 ms hiding budget on a slow device or with CPU throttling, the age
  threshold for other pages' chunks, the keepalive budget ratio (Web Queue 1, 2, 5); the 500 ms window
  if step 8.1 left it open; the iPad tablet rule on a physical iPad (Web Context 1); Firefox at close if
  step 1.4 could not run it.

## 13. Traceability

Every web decision is implemented in a step and verified by at least one named test; the inherited
Android decisions are traced through the ported tests, which keep the Android names where they
exist. When a step is done, fill the Tests column of its rows with the file and test names. A row
without a test blocks the release.

| Decision | In short | Steps | Tests |
|---|---|---|---|
| Web Public API 1 | `createAnalytics`, held instance, no module-level instance, one per page | 3.3, 6.7, 7.1 | |
| Web Public API 2 | npm, script build, two-tag snippet with a queue and a sentinel | 7.8 | |
| Web Public API 3 | camelCase verbs returning `void`, two `readonly` properties, `createNoOpAnalytics` | 3.3 | |
| Web Public API 4 | `Record<string, unknown>` in, `PropertyValue` inside, developer errors logged never thrown | 2.5, 2.2, 3.1 | |
| Web Public API 5 | `BeforeSend[]`, synchronous, deep copy, `undefined` and Promise as violations | 3.2, 6.3a | |
| Web Public API 6 | ES2017, the floor, ES5 snippet, feature detection | 1.1, 8.2 | 1.1: `scripts/check-es2017.sh --self-test`; `check-source-rules.mjs` rule `newer-library` (self-test) |
| Web Public API 7 | `core` and `web`, `exports`, `sideEffects: false`, IIFE, no dependencies, API report, size gate, SSR no-op | 1.1, 7.1, 8.2 | 1.1: `web/test/ssr/import.test.ts` (import, require, exports map, the guard); `web/test/browser/script-build.spec.ts`; `web/scripts/api.mjs check`; `web/.size-limit.json`; rules `browser-global` and `side-effect` (self-test) |
| Web Event Model 1 | Discriminated union of `readonly` interfaces | 3.2 | |
| Web Event Model 2 | `timestamp: number` | 3.2, 2.3 | |
| Web Event Model 3 | UUIDv7 port with `Number` arithmetic and `getRandomValues` | 2.3 | |
| Web Event Model 4 | Golden files compared structurally | 1.1, 8.4 | 1.1: `scripts/refresh-golden.sh --check` (copies and digest) |
| Web Event Model 5 | String literal unions, no `enum` | 2.2, 3.2 | |
| Web Configuration 1 | Plain object, own snapshot, no freezing, wrong-type row | 3.1 | |
| Web Configuration 2 | `debug` false by default, never from the environment, guarded `console` | 3.1, 7.1 | |
| Web Configuration 3 | Second instance through the `Symbol.for` marker | 7.1 | |
| Web Configuration 4 | `host` validated on text and `URL`, publishable key | 3.1 | |
| Web Configuration 5 | Remote configuration at page load, five minutes, shared | 5.3 | |
| Web Configuration 6 | Neutral groups in `core`, `AnalyticsConfig` in `web` | 3.1 | |
| Web Identity 1 | Cookie with a mirror, the read matrix, "device" per site and profile | 6.1, 7.2 | |
| Web Identity 2 | Across subdomains, the domain probe, `crossSubdomain`, `cookieDomain` | 7.2, 8.1 | |
| Web Identity 3 | Read on every call, read after write | 6.1, 8.1 | |
| Web Identity 4 | Store names, `keyHash`, no cleanup of other keys' stores | 2.3, 4.1 | |
| Web Context 1 | User agent and Client Hints parsed, `browser` group, `device.type` | 7.5 | |
| Web Context 2 | The `page` group with masking | 7.5 | |
| Web Context 3 | `app` from the configuration, CSS pixels, no `network` group | 7.5 | |
| Web Context 4 | Static once, page values per call, the snippet's record | 7.5, 7.8 | |
| Web Context 5 | Seventeen `ContextField` members, the golden removals | 3.2, 8.4 | |
| Web Session 1 | Visibility, one 30-minute timeout, no timers | 6.2, 7.4 | |
| Web Session 2 | One session per site in a cookie, write and read back | 6.2, 8.1 | |
| Web Session 3 | `session.inactivityTimeoutMs` | 3.1 | |
| Web Session 4 | `Date.now()`, 60-second tolerance, write frequency | 6.2 | |
| Web Session 5 | `person_epoch`, the membership rule, the snippet's visibility | 6.1, 6.2, 7.8 | |
| Web Lifecycle 1 | `Page Viewed` as a track event, no automatic screens | 7.6 | |
| Web Lifecycle 2 | When `Page Viewed` is produced, the history registry, the 500 ms window | 7.6, 8.1 | |
| Web Lifecycle 3 | No `Application Opened` or `Backgrounded` | 6.3b | |
| Web Lifecycle 4 | No install or update events, no version record | 6.3b | |
| Web Lifecycle 5 | `utm_*` on the view whose URL carries them | 7.6, 7.8 | |
| Web Lifecycle 6 | `createTrackedFetch`, never the global `fetch` | 7.7 | |
| Web Lifecycle 7 | No element interaction | 1.1 (source rule) | 1.1: rule `element-interaction` (self-test) |
| Web Lifecycle 8 | `Autocapture` with three members | 3.1, 5.3 | |
| Web Queue 1 | The writer in slices, the drain on hiding, `page_closed` | 6.3b, 7.4 | |
| Web Queue 2 | Own immutable chunks, adoption, delete by id | 4.2, 6.4, 8.1 | |
| Web Queue 3 | Triggers, `fetch` with `keepalive`, no `sendBeacon` | 6.4, 7.3, 7.4, 1.4 | |
| Web Queue 4 | `flush.at` 30, `flush.intervalMs` 5 s | 3.1 | |
| Web Queue 5 | Batch limits, the 48 KiB budget, whole chunks | 4.2, 6.3b, 6.4 | |
| Web Queue 6 | 1000 events, 3 days, 1 MiB | 4.2 | |
| Web Disk 1 | Chunks in `localStorage` | 4.2, 7.2 | |
| Web Disk 2 | Self-describing chunk keys, the walk, the marker | 4.2, 7.4 | |
| Web Disk 3 | Fresh read, merge, one `setItem` | 4.1 | |
| Web Disk 4 | Memory-only mode, `STORAGE_UNAVAILABLE` | 7.2 | |
| Web Disk 5 | Corruption and several SDK versions | 4.1, 4.2 | |
| Web Disk 6 | Other keys' expired chunks deleted, nothing else touched | 4.2 | |
| Web Disk 7 | No encryption, no `persist()`, no public storage interface | 1.1 (source rule) | 1.1: rule `storage` on `navigator.storage` (self-test) |
| Web Serialization 1 | `JSON.stringify`, the UTF-8 scan | 2.4 | |
| Web Serialization 2 | The conversion table | 2.5 | |
| Web Serialization 3 | Node, three engines, Python as the parser | 2.4, 8.1 | |
| Web HTTP 1 | The request shape, 45 s, no SDK User-Agent | 5.1, 7.3 | |
| Web HTTP 2 | gzip through `CompressionStream` with the exceptions | 5.1, 7.3 | |
| Web HTTP 3 | The classification table, CSP and mixed content, fixed `error` values | 5.1, 7.3, 7.7 | |
| Web HTTP 4 | The backend CORS requirement | 1.3, 9.1, 8.5 | |
| Web HTTP 5 | No ad-blocker evasion, the proxy guide | 1.4, 8.5 | |
| Web HTTP 6 | One file, the two-tag snippet, the pinned URL with SRI | 7.8, 8.6 | |
| Web Retry 1 | The shared retry state, `.pause`, the probe, the poison rule | 5.2, 6.4, 8.1 | |
| Web Retry 2 | `onLine`, the `online` signal | 6.4, 7.4 | |
| Web Retry 3 | `Date.now()`, the clock guard, timers as hints | 5.2, 7.4 | |
| Web Retry 4 | Page-local causes, counting only server answers | 5.2, 6.4 | |
| Web Privacy 1 | Nothing written while pending | 6.5, 8.3 | |
| Web Privacy 2 | The consent cookie and its mirror, fresh reads | 6.5, 7.2, 8.1 | |
| Web Privacy 3 | `clearLocalData()` across tabs and subdomains | 6.5, 6.3b, 6.4, 8.1 | |
| Web Privacy 4 | GPC and Do Not Track not read | 1.1 (source rule), 8.5 | 1.1: rule `privacy-signal` (self-test) |
| Web Privacy 5 | The storage declaration and its test, the session cookie lifetime | 6.2, 8.3, 8.5 | |
| Web Logging 1 | Function logger, `console` sink, safe strings, the level as the only authority | 2.2, 7.1 | |
| Web Logging 2 | `warn` default, `per_page` and `per_24h` | 2.2, 4.1 | |
| Web Logging 3 | The new names, the catalogue columns | 2.2 | |
| Web Logging 4 | Writes while opted out (the contract on all three platforms) | 6.5, 6.4, 5.3 | |
| Web Logging 5 | `SDK Diagnostics` across tabs | 6.6 | |
| Android decisions, all pages | Inherited unchanged | the ported tests of every step | |

## 14. Status

- [x] 0 Open decisions D1 to D20 answered and recorded in section 15
- [x] 1.1 Scaffold (CI half of the definition of done pending the Actions minutes, section 15)
- [ ] 1.2 CLAUDE.md files
- [ ] 1.3 Test server and browser harness
- [ ] 1.4 Close-time measurements
- [ ] 2.1 Platform interfaces and test fixtures
- [ ] 2.2 Logging infrastructure
- [ ] 2.3 Identifiers, time and hashing
- [ ] 2.4 JSON layer and the size scan
- [ ] 2.5 Property validation and normalization
- [ ] 3.1 Configuration
- [ ] 3.2 Event model and public types
- [ ] 3.3 The `Analytics` interface and the no-op
- [ ] 4.1 Key-value stores
- [ ] 4.2 Event chunks
- [ ] 5.1 HTTP requests and results
- [ ] 5.2 Retry policy and the shared state
- [ ] 5.3 Remote configuration
- [ ] 6.1 Identity and super properties
- [ ] 6.2 Session
- [ ] 6.3a Event pipeline
- [ ] 6.3b Writer
- [ ] 6.4 Uploader
- [ ] 6.5 Privacy
- [ ] 6.6 SDK Diagnostics
- [ ] 6.7 `DefaultAnalytics` and the core factory
- [ ] 7.1 Factory, second instance and the console sink
- [ ] 7.2 Browser storage, cookies and the domain
- [ ] 7.3 The `fetch` transport
- [ ] 7.4 Lifecycle and network signals
- [ ] 7.5 Context provider
- [ ] 7.6 Page views
- [ ] 7.7 `createTrackedFetch`
- [ ] 7.8 Script build and snippet
- [ ] 8.1 The cross-engine suite
- [ ] 8.2 Packaging and consumers
- [ ] 8.3 Storage declaration
- [ ] 8.4 Wire contract complete
- [ ] 8.5 Documentation
- [ ] 8.6 Release candidate (no publishing, D20)
- [ ] 9.1 Fake backend
- [ ] 9.2 Demo app on the SDK
- [ ] 9.3 Manual scenario checklist

## 15. Implementation decisions log

Decisions taken during implementation that the Confluence pages do not cover, and changes to
decisions. One row each: date, step, question, answer, pages or rules updated. Rows that affect all
three SDKs are mirrored into the Android and iOS plans' logs after the user agrees.

| Date | Step | Question | Answer | Updated |
|---|---|---|---|---|
| 2026-10-14 | 0 | Where the repository lives | `rubicon-team/rubicon-web-sdk`, private, created empty on 2026-10-14 and cloned to `~/Projects/rubicon/rubicon-web-sdk`; the demo repository `rubicon-team/rubicon-web-demo` likewise, at `~/Projects/rubicon/demo-app/rubicon-web-demo`. This plan and the `CLAUDE.md` seed are its first commit, made by the user. Branch model pending D1. | - |
| 2026-10-14 | 0 | The contract changes of the day and the Android and iOS code | Three contract changes were agreed during the web design (no new upload, only the consent decision written, no remote configuration request while opted out). The Android and iOS pages carry Changed on notes; the code of both SDKs does not implement them yet, deferred by the user. The web follows the pages; ports of privacy, writer, uploader, remote configuration and diagnostics code take the structure from Android and the behaviour from the pages. | Section 1 |
| 2026-10-14 | 0 | The issue code catalogue | Web Logging 3 keeps one catalogue, `docs/issue-codes.md` in the Android repository, with three new columns (Platform, Web level, Frequency). The Android file does not have the columns yet (an item for the Android repository, deferred with the contract work). The web keeps a copy with the columns filled for the web, refreshed from Android; the difference is resolved when the Android file gains the columns. | Step 2.2 |
| 2026-10-14 | 0 | Tool facts used for section 3 | Fetched 2026-10-14: Node LTS 24.22.0 ("Krypton"), pnpm 12.11.2, TypeScript 6.0.3 (last JS-based) and 7.0.2 (native), Vitest 5.0.4, Playwright 1.64.1 (Chromium 156, Firefox 157, WebKit 27.2), api-extractor 7.59.4 (TypeScript 5.9.3 inside), Rollup 4.64.6, ESLint 10.12.0, Prettier 3.9.10, Biome 2.5.15, es-check 9.8.1, jsdom 30.1.2, TypeDoc 0.28.20. Node is not installed on the user's Mac. Check again before step 1.1. | Section 3 |
| 2026-10-14 | 0 | Tool facts checked again before asking D1 to D20 | Unchanged from the row above: pnpm 12.11.2, TypeScript 6.0.3 and 7.0.2, Vitest 5.0.4, jsdom 30.1.2, Playwright 1.64.1 (published 2026-10-14; Chromium 156.0.8078.4, Firefox 157.0, WebKit 27.2, the same builds as 1.64.0), api-extractor 7.59.4 (TypeScript 5.9.3 inside), Rollup 4.64.6, tsup 9.0.0, ESLint 10.12.0, typescript-eslint 8.71.2, Prettier 3.9.10, Biome 2.5.15, es-check 9.8.1, TypeDoc 0.28.20, size-limit 14.2.0. New: the Node schedule, the `@rubicon` scope, Rolldown, the runner images, the jsDelivr headers and npm provenance, recorded in the rows of D2, D6, D8, D12, D16 and D20 below. The 14 `Web: <block>` pages under 12288001 exist with the ids of section 1. | Section 3 |
| 2026-10-14 | 0 | D1 Repository and branch model | `rubicon-team/rubicon-web-sdk`, `master` and `develop` (default) as on Android and iOS; `feature/*` branches into `develop` by pull request, merged by the user with a merge commit as on iOS (`rubicon-ios-sdk` `d6f429c`), not squashed as on Android (`99f27a4`), so that the per-step commits of D18 survive. The seed commit `ae39e00` was on a local `main` with the GitHub repository empty; the user renamed it to `master`, pushed `master` and `develop` and made `develop` the default (verified 2026-10-14). | Section 3 |
| 2026-10-14 | 0 | D2 npm package names and globals | The package to publish is the unscoped `rubicon-analytics`. The `@rubicon` scope exists on npm (`registry.npmjs.org/-/org/rubicon/package` answers 200 with no public package, an unknown scope 404 "Scope not found") and is not the team's. The private workspace packages are `rubicon-analytics-core` and `rubicon-analytics-testing` (follow-up question, user's choice), linked with `workspace:*` so they are never resolved from the registry. Unchanged: `window.Rubicon` for the script build, `window.rubicon` for the snippet, `context.library.name` `rubicon-web`. The api-extractor report is `packages/web/etc/rubicon-analytics.api.md`. | Sections 4, 5; root `CLAUDE.md` packages table |
| 2026-10-14 | 0 | D3 Default SaaS host | `https://api.rubicon.example` until the production URL is known, as Android log D7 and iOS D3. | - |
| 2026-10-14 | 0 | D4 License | Apache-2.0. | - |
| 2026-10-14 | 0 | D5 Version numbering | SemVer, first release `0.1.0`; `package.json` holds the version, the build replaces `__VERSION__` in `core`; CI fails when the tag differs (step 8.6). | - |
| 2026-10-14 | 0 | D6 Node, package manager, local toolchain | Node 24 LTS "Krypton", `engines.node` `>=24`; pnpm 12.11.2 pinned through `packageManager`. Node 24 enters maintenance on 2026-10-20 (supported to 2028-04-30) and Node 26 becomes Active LTS on 2026-10-28 (nodejs/Release `schedule.json`); moving to 26 is a small change asked after that date. Installed on the user's Mac on 2026-10-14 with Homebrew (`brew install node@24 pnpm`, run by the implementing session at the user's request): Node 24.21.0 (24.22.0 of the same day not yet bottled), pnpm 12.11.2. | - |
| 2026-10-14 | 0 | D6b Minimum release age of dependencies (asked with D6; not in the original list) | `minimumReleaseAge: 10080` (seven days) in `pnpm-workspace.yaml`, as PostHog (`posthog-js/pnpm-workspace.yaml:50`); Amplitude uses three days (`Amplitude-TypeScript/pnpm-workspace.yaml:13`). Development dependencies are pinned to the newest release at least seven days old on the day they are added; on 2026-10-14 that is Playwright 1.64.0, Vitest 5.0.3, Rollup 4.64.2, typescript-eslint 8.71.1 and Prettier 3.9.9, the others at the versions of the facts row. | Step 1.1 reads this row |
| 2026-10-14 | 0 | D7 TypeScript version | TypeScript 6.0.3. TypeScript 7 is still unsupported by the tools on 2026-10-14: typescript-eslint 8.71.2 declares `typescript >=4.8.4 <6.1.0`, TypeDoc 0.28.20 up to `6.0.x`, api-extractor 7.59.4 bundles 5.9.3. Step 1.1 confirms the ES2017 emit and declarations. | - |
| 2026-10-14 | 0 | D8 Build tool | Rollup 4 for ESM, CommonJS and the IIFE, `tsc` for type checking and declarations, api-extractor for the `.d.ts` rollup and the report. Correction to section 3: three of the five references build with Rollup (Amplitude `scripts/build/rollup.config.js:1`, `:103`; Snowplow `trackers/javascript-tracker/rollup.config.js:66`; Mixpanel `rollup.config.mjs:167`); PostHog runs its `rollup.config.mjs` with Rolldown (`posthog-js/packages/browser/package.json:22`) and Segment uses webpack (`analytics-next/packages/browser/webpack.config.js:55`). Rolldown (1.0.0 on 2026-05-07, 1.2.14 on 2026-10-14) is the alternative noted, not taken; the Rollup configuration stays close to what Rolldown accepts. | - |
| 2026-10-14 | 0 | D9 Test runners | Vitest for `core` in Node and `web` in jsdom, Playwright in Chromium, Firefox and WebKit, Python 3 as the independent JSON parser (3.9.6 on the user's Mac). Versions per D6b. | - |
| 2026-10-14 | 0 | D10 Lint, format, source rules | ESLint 10 with typescript-eslint and Prettier 3; `scripts/check-source-rules.mjs` with `--self-test` for the rules ESLint cannot express. | - |
| 2026-10-14 | 0 | D11 Coverage | Vitest V8 coverage, 90 percent of lines in `core`, 80 in `web`; Playwright-only code excluded with the browser test that covers it named. | - |
| 2026-10-14 | 0 | D12 CI | GitHub Actions on `ubuntu-24.04` (still `ubuntu-latest` on 2026-10-14; `ubuntu-26.04` exists and Playwright 1.64.1 has WebKit builds for both). Every pull request runs `pnpm check` and Playwright in the three engines; the several-tab, several-host and close-time suites and the framework fixtures of D19 run on every pull request touching `packages/web` and on a manual `workflow_dispatch` (follow-up question). No nightly or other scheduled lane (the user's answer). A macOS runner only if a WebKit behaviour differs on Linux. | Steps 1.1, 8.1 |
| 2026-10-14 | 0 | D13 The browser floor in tests | (a) es-check over every built file and the source rule against ES2019 and newer library calls, now; (c) a Changed on note on Web Public API 6 that the floor is syntax-checked in CI and behaviour-tested on current engines, text approved by the user; (b) a cloud browser service for the floor versions decided before a release, price checked then. | Confluence Web: Public API (12517377), the Changed on note under decision 6, written 2026-10-14 (page version 3; the HTML diff against version 2 is that paragraph only) |
| 2026-10-14 | 0 | D14 Test server | `node:http` server in the private `testing` package, no dependency, as recommended in section 3. | - |
| 2026-10-14 | 0 | D15 Several hostnames | `a.rubicon.test` and `b.rubicon.test` on `127.0.0.1`; the mechanism chosen in step 1.3 after the probe in each engine. | - |
| 2026-10-14 | 0 | D16 Script build hosting and SRI | jsDelivr serving the npm package, a CDN of our own later. Checked on 2026-10-14 on a published package: the version-pinned URL answers `cache-control: public, max-age=31536000, s-maxage=31536000, immutable`, `access-control-allow-origin: *` and `cross-origin-resource-policy: cross-origin`; the floating major URL `max-age=604800, s-maxage=43200`. Usable only once the package is published (D20). | - |
| 2026-10-14 | 0 | D17 Documentation build | api-extractor's `ae-undocumented` as the gate; no TypeDoc; the README is the integration guide. | - |
| 2026-10-14 | 0 | D18 Branch and commit granularity | The iOS model: phase 1 on `feature/repository-and-tooling` (the iOS name) with one pull request, each step reviewed before its commit; phases 2 to 5 on `feature/core-foundations`; steps 6.1 to 8.5 on `feature/sdk-complete`, one commit per step without a review stop; 8.6 and phase 9 after that. Commit messages in the Conventional Commits form of both repositories (`feat(core): ...`, `build: ...`). Push and pull request after the user's approval; never merge. | Section 2 item 2 applies as written |
| 2026-10-14 | 0 | D19 Demo app technology | As recommended: Vite and TypeScript, several HTML pages and a React Router area; Next.js and Vue Router as fixtures in the SDK's Playwright suite, run in the lanes of D12 (no nightly). | - |
| 2026-10-14 | 0 | D20 npm publishing | Nothing is published for now. Step 8.6 stops before publishing (follow-up question): release script, tag, tarball and its consumer tests, SRI and stub hashes computed; `npm publish`, the jsDelivr URLs and the published hash wait for the user's decision. For that decision, checked on 2026-10-14: trusted publishing (OIDC from GitHub Actions, no token) works, but "Provenance generation is not supported for private repositories" (docs.npmjs.com/trusted-publishers); `rubicon-analytics` is free on npm but not reserved. | Step 8.6, Status |
| 2026-10-14 | 1.1 | GitHub Actions minutes (not a decision page question) | The `rubicon-team` organisation is on the Free plan (2000 minutes a month for private repositories, macOS counted ten times). October usage on 2026-10-14: 249 Linux minutes and 169.45 macOS minutes (1694.5 counted), about 1943 of 2000; jobs are refused with "your spending limit needs to be increased" (the iOS Nightly runs of 2026-10-12 to 14 never started). The quota resets on 2026-11-01. Until CI can run, `scripts/check-clean.sh` (`check.sh` on a fresh clone of HEAD with a frozen lockfile) is the local gate and its output goes into the pull request; the CI half of the definition of done is met by the first CI run after the reset, recorded here. The user chose the local gate on 2026-10-14 (over a small Actions budget or a self-hosted runner). Whether the iOS repository's scheduled Nightly is stopped before the reset is asked separately. | Section 6 (CI half pending), `CLAUDE.md` Commands |
| 2026-10-14 | 1.1 | Versions under the seven-day rule | pnpm compares release times to the hour (now minus 7 × 24 hours), so on 2026-10-14 at 17:43 UTC four pins of D6b moved one release back: Playwright 1.63.0 (Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6; 1.64.0 is eligible from 2026-10-15 20:43 UTC and is taken in step 1.3), Rollup 4.64.1, size-limit and `@size-limit/file` 14.1.0. The rest as D6b. Node on the Mac is Homebrew's 24.21.0. | - |
| 2026-10-14 | 1.1 | Playwright's Firefox on macOS 27 | Playwright's Firefox (and stock Firefox from a terminal) fails at launch with "Could not find profile folder" because macOS 27 protects `~/Library/Application Support/Firefox` with TCC and Gecko reads it even with `-profile` (microsoft/playwright#42768; fixed upstream in Firefox 158, not expected in Playwright 1.64). Seen here with the sandbox on and off. Workaround, as in embrace-io/embrace-web-sdk#1547: on macOS the Firefox project launches with `CFFIXED_USER_HOME` set to a temporary directory (`packages/web/playwright.config.ts`); nothing changes on Linux. Remove it when Playwright ships Firefox 158 or later. | - |
| 2026-10-14 | 1.1 | es-check with `--checkFeatures` | es-check 9.8.1 with `--checkFeatures` accepts ES2018 syntax (object rest, regular expression lookbehind) that it rejects without the flag. `scripts/check-es2017.sh` runs a syntax pass and a feature pass; its `--self-test` plants object rest, async iteration, lookbehind, optional catch binding, `Object.fromEntries`, `flat()` and `Promise.allSettled`, and checks that an ES2017 file passes. | Plan section 5 |
| 2026-10-14 | 1.1 | How the packages are wired | The private packages are not built for consumption: `exports` gives a `source` condition and `default` pointing at `src/index.ts` and a `types` condition pointing at `dist-types/index.d.ts`. Type checking, Vitest and Rollup read the sources (`customConditions: ["source"]` in the `tsconfig.json` files, `default` for the bundlers); the declaration build reads `core`'s emitted declarations so api-extractor can inline them (`bundledPackages`). `core` is a development dependency of `web`, so the package to publish has no dependency. The exports map gives `import` (`index.mjs`, `index.d.mts`) and `require` (`index.cjs`, `index.d.cts`); the two declaration files are the same rollup. Proven on 2026-10-14 by a temporary re-export of a `core` constant: bundled, `__VERSION__` replaced, the type inlined, an undocumented export rejected by `ae-undocumented`. | Plan section 4 |
| 2026-10-14 | 1.1 | The script build of an empty package | Rollup emits nothing for an entry without exports, so `window.Rubicon` appears with the first export (step 3.3). The step's test asserts what holds now: the script build defines no global other than `Rubicon`; step 7.8 asserts `window.Rubicon` and its contents. | Step 7.8 |
| 2026-10-14 | 1.1 | Code style | Prettier with 2-space indentation, single quotes, trailing commas and 120 columns: 2 spaces and single quotes as in the three references with a configuration (`Amplitude-TypeScript/.prettierrc.json:2-5`, `analytics-next/.prettierrc:3-5`, `snowplow-javascript-tracker/.prettierrc:3-5`), 120 columns as Amplitude and Snowplow and as the iOS SDK. Markdown is not formatted by Prettier (the documents keep their 100-column wrap). typescript-eslint's `strictTypeChecked` with `no-explicit-any` and the `enum` rule. | - |
| 2026-10-14 | 1.1 | Source rules: the side-effect rule and file exemptions | The top-level side-effect rule relies on Prettier: a line at column 0 with nothing open starts a statement; declarations pass, an expression statement fails, and a call or `new` in a top-level initializer needs a `/*#__PURE__*/` annotation (which also lets the bundler drop it). Rules that exempt a file name the file a later step creates (`platform/console-sink.ts` 7.1, `platform/clock.ts` 2.1, `autocapture/history-registry.ts` 7.6, `create-analytics.ts` 7.1); the step that creates it may rename it in the script. The log-content rule looks at `log.<level>(...)` and `logger.<level>(...)`; step 2.2 aligns it with the real logger. Promises in the public API are read from the API report. A TODO must read `TODO(step N.N)`. | Plan section 5 |
| 2026-10-14 | 1.1 | GitHub Actions and the license | The workflow pins each action to a commit with its version in a comment: `actions/checkout` v7.0.1, `pnpm/action-setup` v6.1.0, `actions/setup-node` v7.0.0 (v7.1.0 of 2026-10-08 is younger than seven days), `actions/upload-artifact` v7.0.1. Triggers: `pull_request` and `workflow_dispatch`. `LICENSE` is the verbatim Apache-2.0 text from apache.org without a copyright line, identical to the iOS file; the legal entity for a `NOTICE`, if any, is for the user (iOS log 1.1). TypeScript 6.0 rejects `esModuleInterop: false` as deprecated; the option is left at its default. size-limit's "20 kB" is 20 000 bytes, provisional until step 8.2. | D4, D7, D12 |
| 2026-10-14 | 1.1 | The TypeScript version floor for consumers (Web Public API 7 leaves it to this plan; not among D1 to D20) | TypeScript 5.0, the first version with `moduleResolution: "bundler"`. Step 8.2 proves it with the consumer fixtures compiled by TypeScript 5.0 and by the newest TypeScript. The user's answer to the recommendation. | Step 8.2 |
| 2026-10-14 | 1.2 | D18 changed by the user | Steps 1.2 to 5.3 are done on `feature/repository-and-tooling`, one commit per step, in pull request #1 with phase 1; no review stop between steps (questions are still asked when a decision is missing). This replaces D18's separate `feature/core-foundations` branch for phases 2 to 5 and the per-step review of phase 1. Branch and pull request for 6.1 onward as D18 says unless the user changes it again. | Section 2 item 2 applies as written |
| 2026-10-14 | 1.2 | The iOS Nightly schedule | Asked by the Actions quota row of step 1.1: the user removed the daily schedule of the iOS repository's Nightly workflow (rubicon-team/rubicon-ios-sdk pull request #4, `workflow_dispatch` only, recorded in the iOS plan's section 15). Until it is merged into `develop`, the schedule stays active. | - |

## 16. Out of scope for the first release

Recorded on the Confluence pages as rejected or deferred; not implemented until decided: a published
`core` package and a React or React Native package (Web Public API 7); UMD (Web Public API 7); a
Promise from `flush()` (Web Public API 3); an IndexedDB event store (Web Disk 1); `sendBeacon` (Web
Queue 3); a route-template mechanism for `page.url` (Web Context 2); declared clicks, form events, a
page-leave event, `appinstalled`, the Navigation API and an axios interceptor helper (Web Lifecycle
2, 6, 7); `privacy.pendingStorage` and `privacy.respectGpc` (Web Privacy 1, 4); per-page diagnostics
counter keys (Web Logging 5); Web Locks or `BroadcastChannel` for the two Session races (entry page,
open questions); ad-blocker evasion (Web HTTP 5); a Trusted Types policy (Web HTTP 6). The Android
and iOS lists apply as well: wrapper SDK boundaries, SDK lifecycle states and `shutdown()` in the
public API, performance and reliability budgets, the versioned backend contract document and
deduplication window, a diagnostic API beyond `SDK Diagnostics`, typed property overloads, `group`.
