# Changelog

All notable changes to `rubicon-analytics` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (D5).

## [Unreleased]

### Added

- The first release of the Rubicon web SDK, the browser implementation of the contract the Android
  and iOS SDKs implement: `createAnalytics` with `track`, `screen`, `identify`, `reset`, super
  properties (`register`, `unregister`), `flush`, consent (`optOut`, `optIn`, `isOptedOut`),
  `clearLocalData` and `deviceId`; `createNoOpAnalytics` for tests and unsupported environments;
  one instance per page, across copies of the SDK.
- Three ways in: the npm package (ES module and CommonJS, no runtime dependency, free of side
  effects on import and safe in server-side rendering), the script build `rubicon.min.js`
  installing `window.Rubicon`, and the two-tag snippet (a frozen stub with a published CSP hash,
  `init(config)`, and the script build loaded `async` with an integrity hash).
- Automatic events: `Page Viewed` on the load, on history navigations and on back/forward cache
  restores, with the five `utm_*` parameters; `Session Started` and `Session Ended` with one
  inactivity timeout shared by tabs and subdomains; `Network Request` for requests made through
  `createTrackedFetch`; `SDK Diagnostics`.
- Storage in first-party cookies and `localStorage` only, shared safely by the tabs of a site, with
  every cookie and key listed in `docs/storage-declaration.md`; a memory-only mode where storage
  cannot be used.
- Batched uploads with `fetch`, gzip through `CompressionStream` where it works, `keepalive` when a
  page is hidden or closed, retry with backoff and `Retry-After` shared by every page of the site,
  and remote configuration that can only restrict.
- Consent with a pending state that writes nothing until the user decides; while opted out only the
  decision is written and nothing new is uploaded, stored events waiting for `optIn()` or three
  days.
- `beforeSend` hooks, a configurable logger with stable issue codes (`docs/issue-codes.md`), an
  event observer, and `debug` that writes developer mistakes as `console.error(new Error(...))`
  without ever throwing.
- The integration guide (`README.md`), `docs/csp.md`, `docs/wire-format.md` and the storage
  declaration.
