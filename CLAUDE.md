# Rubicon Web SDK

Analytics SDK for the browser in TypeScript. This file and each package's `CLAUDE.md` (written in
step 1.2) are the contract for how code is written here; read them before changing anything.

- The design is decided in Confluence (space SD; Atlassian MCP, `cloudId` `rubiconn.atlassian.net`)
  and is binding. The web entry page is "Analytics SDK: Web" (id 12288001) with fourteen
  `Web: <block>` child pages; each inherits the Android decision page of the same block, and only
  what differs in the browser is written on the web page. A pointer such as (Queue 4) means decision 4
  on the Android Queue with Flush Policy page; (Web Queue 2) means decision 2 on the web page. Page
  ids are in section 1 of `docs/implementation-plan.md`. The reasoning lives there, not here.
- Work follows `docs/implementation-plan.md`: read its "Working agreement" and "Status" at the start
  of every session and take the first unchecked step.
- Never decide something the decisions do not cover: stop and ask, with options and a recommendation.
- The Android SDK (`~/Projects/rubicon/rubicon-android-sdk`) is the reference implementation of the
  same contract: its `sdk-core/CLAUDE.md` rules, golden wire files
  (`sdk-core/src/test/resources/golden/`), `docs/issue-codes.md` and implementation decisions log
  apply here unless a web page says otherwise. Where Android code and a web decision disagree, the
  web decision wins. The three contract changes of 2026-10-14 (nothing new uploaded, only the consent
  decision written, no remote configuration request while opted out) are on the pages but not yet in
  the Android and iOS code: follow the pages.
- The conversation with the user is in Turkish with technical terms in English; code, comments and
  documents are in English, without emoji.

## Packages

| Package | Role |
|---|---|
| `packages/core` (`rubicon-analytics-core`, private) | No DOM (`lib: ["es2017"]`): configuration, pipeline, queue, storage logic over key-value and cookie interfaces, identity, sessions, upload, HTTP, retry, privacy, diagnostics. Tested in plain Node. Bundled into `web`, never published in the first release (Web Public API 7). |
| `packages/web` (`rubicon-analytics`, the package to publish; nothing published yet, D20) | The browser: `createAnalytics`, `createNoOpAnalytics`, `createTrackedFetch`, the browser implementations of the core interfaces, page views, the script build (`window.Rubicon`) and the snippet (`window.rubicon`). Tested with Vitest and jsdom, and with Playwright in Chromium, Firefox and WebKit. |
| `packages/testing` (`rubicon-analytics-testing`, private) | Test support: `TestPlatform` fakes, the virtual-time scheduler, the test HTTP server, the golden loader. Never published. |

Package names are D2 of the plan (section 15); the private packages are linked with
`workspace:*`. Rules per package are written in step 1.2 (`packages/<name>/CLAUDE.md`). Until then
the Android `sdk-core/CLAUDE.md` and `sdk-android/CLAUDE.md` are read for the rules, with the web
pages for the differences.

## Commands

Filled in step 1.1 (`scripts/check.sh` runs format, lint, source rules, type check, build, the
ES2017 check, tests with coverage, the API report, the size gate and the SSR import test; the
individual commands are listed there).

## Non-negotiables

Inherited from the Android root `CLAUDE.md` unchanged: never crash the host app, public API is
forever, everything internal unless it must be public, no new dependencies, documentation on every
public symbol, a diff that defines a public API change. Web additions: zero runtime dependencies,
`tslib` included (Web Public API 7); importing the package has no side effect and touches no
`window`, `document` or `localStorage` (Web Public API 7); ES2017 syntax and library, nothing newer
without feature detection (Web Public API 6); no `throw` into the host, ever, `debug` included (Web
Public API 4); nothing from a caught error in a log line, and the log level is the only authority
over what is written (Web Logging 1); no cookie or storage key that `docs/storage-declaration.md`
does not list (Web Privacy 5); never replace `fetch` or `XMLHttpRequest` (Web Lifecycle 6).
