# Rubicon Web SDK

The Rubicon analytics SDK for the browser: a TypeScript library that records what happens on your
site, keeps it in the browser's storage and uploads it in batches to your Rubicon backend. It
implements the same contract as the Android and iOS SDKs, so one backend serves all three.

- Chrome 55, Edge 15, Firefox 52, Safari 10.1 and iOS 10.3 or later. The code is ES2017; no
  polyfill is needed or shipped.
- No runtime dependency. One package, `rubicon-analytics`, for npm, a script tag and a two-tag
  snippet.
- TypeScript 5.0 or later for the declarations. Importing the package does nothing until you call
  it, and it is safe in server-side rendering.

Version 0.1.0 is not published yet. Until it is, the npm command below does not work, and
`RUBICON_SCRIPT_URL` and `RUBICON_SCRIPT_INTEGRITY` stand for the URL and the integrity hash each
release publishes.

## Contents

- [Installation](#installation): npm, the script build, the snippet
- [Quick start](#quick-start)
- [What the SDK sends](#what-the-sdk-sends): page views, sessions, network requests
- [Configuration](#configuration): the settings, `debug`, hooks, values
- [Consent](#consent): pending and granted, a consent platform, Global Privacy Control
- [Identity, tabs and subdomains](#identity-tabs-and-subdomains)
- [Logging and error trackers](#logging-and-error-trackers)
- [Hosts, proxies and Content Security Policy](#hosts-proxies-and-content-security-policy)
- [Privacy checklist](#privacy-checklist)
- [Testing your code](#testing-your-code)
- [Behaviour worth knowing](#behaviour-worth-knowing)
- [Repository](#repository)

## Installation

There are three ways in. Use one per page: a second copy of the SDK on the same page, for example
a tag manager adding the snippet to a site that already bundles the npm package, gets the first
copy's instance and logs the error `SECOND_INSTANCE`.

### npm

```sh
npm install rubicon-analytics
```

The package has ES module and CommonJS entries and is marked free of side effects, so a bundler
drops what you do not import. TypeScript projects need the `dom` library in `lib`, as every browser
project has, or a current `@types/node`: the declarations of `createTrackedFetch` name
`typeof fetch`.

### Script build

`rubicon.min.js` installs one global, `window.Rubicon`, holding `createAnalytics`,
`createNoOpAnalytics` and `createTrackedFetch`.

```html
<script src="RUBICON_SCRIPT_URL" integrity="RUBICON_SCRIPT_INTEGRITY" crossorigin="anonymous"></script>
<script>
  var analytics = Rubicon.createAnalytics({ apiKey: 'your-publishable-key' });
</script>
```

Each release publishes an immutable URL pinned to its exact version together with its integrity
(SRI) hash; use both. A floating major-version URL, which picks up fixes without an edit, and a copy
hosted on your own domain are the alternatives; with a floating URL drop the `integrity` attribute,
since the file changes. A second load of the file on the same page changes nothing and logs
`SECOND_INSTANCE`; so does a page whose own code already uses the name `Rubicon`.

### Two-tag snippet

The snippet lets the page call the SDK before the file has arrived. Paste the three tags as one
block in the `<head>`:

```html
<script>(function(w,d){if(w.rubicon)return;var r=w.rubicon={__SV:1,_q:[]};function at(){try{var l=w.location;return{t:Date.now(),o:l.origin,p:l.pathname,w:w.innerWidth,h:w.innerHeight,v:d.visibilityState}}catch(e){return{t:Date.now()}}}function q(n,a){try{r._q.push([n,Array.prototype.slice.call(a),at()])}catch(e){}}function verb(n){r[n]=function(){q(n,arguments)}}var v="init track screen identify reset register unregister flush optOut optIn clearLocalData".split(" ");for(var i=0;i<v.length;i++)verb(v[i]);var u=[],m,x=/[?&](utm_(?:source|medium|campaign|term|content)=[^&]*)/g;try{while((m=x.exec(w.location.search)))u.push(m[1])}catch(e){}q("pageViewed",[u.join("&")])})(window,document);</script>
<script>
  rubicon.init({ apiKey: 'your-publishable-key', debug: false });
</script>
<script async src="RUBICON_SCRIPT_URL" integrity="RUBICON_SCRIPT_INTEGRITY" crossorigin="anonymous"></script>
```

- The first tag is the stub, version 1. Its text is frozen and the same on every site and in every
  release; copy it exactly. Its Content Security Policy hash is
  `sha256-mywLhcK4TH7k1aho9iPYn0R3UrCoasuducthS/F4UEQ=`. It reads nothing but the clock, the page's
  origin and path, the viewport, the visibility and the five `utm_*` parameters, stores nothing and
  loads no script.
- The second tag is yours: `rubicon.init(config)` takes the same configuration as
  `createAnalytics`, hooks and a logger included. It may also be called later from your own code;
  until it is, calls stay queued.
- The third tag loads the script build. When it arrives, the first `init` creates the instance and
  every queued call is replayed in order, with the time, page and visibility recorded when it was
  made. From then on `window.rubicon` is the instance, with `rubicon.isOptedOut` and
  `rubicon.deviceId` readable.
- **Do not change an object after passing it to `window.rubicon` before the library has loaded.**
  The stub keeps the arguments of a queued call by reference and the library copies them only when
  it replays the call, so a change made in between is what gets sent.
- If the file never arrives (an ad blocker, a network error), the calls stay queued and the page
  works as before.
- Pasting the snippet twice keeps the first stub. A navigation made before the file arrives gives no
  `Page Viewed` of its own.

## Quick start

Create one instance per page, early, and hold it. There is no global instance in the npm package:
export it from a module of yours or put it where your application keeps shared services.

```ts
import { createAnalytics } from 'rubicon-analytics';

export const analytics = createAnalytics({
  apiKey: 'your-publishable-key',
  host: 'https://analytics.example.com', // your Rubicon backend; the default is the SaaS host
  debug: import.meta.env.DEV,
});

analytics.track('Purchase Completed', { amount: 49.9, currency: 'EUR', items: ['A-1', 'B-7'] });
analytics.screen('checkout');
analytics.identify('user-42', { plan: 'pro' });
```

| Member | What it does |
| --- | --- |
| `track(name, properties?)` | Records an action. Title Case names and `snake_case` keys are recommended. |
| `screen(name, properties?)` | Records a screen under a key of your tracking plan (`checkout`, or a route template such as `/orders/:id`), never displayed text or a filled route such as `/orders/4521`. Never sent by the SDK itself. |
| `identify(userId, traits?)` | Attaches the user to this and every later event and sends the traits once; traits are never stored. Another id while identified starts a new user: the session and super properties are cleared first. |
| `reset()` | Back to an anonymous user, for example at logout: clears the user, super properties and the session; keeps `deviceId` and the events not yet sent. |
| `register(key, value)`, `unregister(key)` | Super properties, sent with every later event of this user until `unregister` or `reset`. An event's own key wins. |
| `flush()` | Asks for an upload of every event tracked before the call and returns at once. It does not wait, returns no Promise and gives no delivery guarantee; uploads also happen by themselves, so you rarely need it. |
| `optOut()`, `optIn()`, `isOptedOut` | Consent, below. |
| `clearLocalData()` | Deletes what the browser holds about the person and renews `deviceId`, below. |
| `deviceId` | The id of this browser for your site, sent with every event. |

Every method returns `void` at once and takes effect in call order: a `track` after `identify`
carries the new user. Nothing is ever thrown to your code. A mistake, such as a blank event name or
a value the SDK cannot send, drops what is wrong and writes a warning with its code; `debug: true`
writes it as `console.error(new Error(...))`, red and with a stack.

Outside a browser (server-side rendering, a web worker, Node) `createAnalytics` returns an instance
that does nothing, with one `info` line, so the same module can run on the server.

## What the SDK sends

Three event kinds, `track`, `screen` and `identify`, each with a message id, a timestamp, the
device id, the user id (`null` while anonymous), your properties and a `context` object: the app
you describe in `context.app`, the operating system and browser name, the browser's major version,
the device type, the screen, the page, the locale, the time zone, the session and the library. The
exact JSON is in [`docs/wire-format.md`](docs/wire-format.md).

- `page.url` and `page.referrer` are the origin and the path, with ids masked (all-digit segments,
  UUIDs and hexadecimal segments over 16 characters become `:id`); never the query or the fragment.
- `page.query` holds only the parameters you name in `context.page.queryParams`; `page.title` is
  sent only with `context.page.title: true`.
- `device.type` is `phone`, `tablet` or `desktop`, best effort. Two tablet cases are recognised by
  heuristics and can still be missed: an Android tablet showing desktop sites, and an iPad whose
  Safari presents itself as a Mac. Without a signal the field is left out.
- `screen.width` and `screen.height` are CSS pixels, short side first; `screen.density` is
  `devicePixelRatio` read once per page load, which page zoom changes. It is not a physical density.
- Never sent: the raw user agent, the operating system version, the device model, any network or
  carrier field, cookies, and anything you do not pass.

### Automatic events

All have `source: "auto"` and can be switched off with `autocapture.enabled` or by your backend's
remote configuration.

| `Autocapture` member | Events | Default |
| --- | --- | --- |
| `page_views` | `Page Viewed` | on |
| `sessions` | `Session Started`, `Session Ended` | on |
| `network_requests` | `Network Request`, for requests made through `createTrackedFetch` only | on |

```ts
import { createAnalytics } from 'rubicon-analytics';

const analytics = createAnalytics({
  apiKey: 'your-publishable-key',
  autocapture: { enabled: ['sessions', 'network_requests'] }, // no Page Viewed
});
```

**Page views.** `Page Viewed` is a `track` event; its page is in `context.page.url` and its only
properties are the `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` of its
URL. It is sent:

- for the load, once the page is first visible; a page opened in the background and never shown
  sends none;
- for each `pushState`, `replaceState` or `popstate` that changes the origin or the path; a change
  of the query or the fragment alone sends none. A navigation and the redirects that follow it
  within half a second, the load's included, give one view of the page the visitor sees;
- when a page is restored from the back/forward cache.

Returning to a tab sends nothing. Hash-based routing (`#/orders`) is not tracked: call `screen()`
from your router instead. If your router also calls `screen()` on every navigation, you get both
events; keep both, or remove `page_views` from `autocapture.enabled`. The SDK wraps
`history.pushState` and `history.replaceState` once per page, only when `page_views` is on, and
never touches anything else of the page.

**Sessions.** A session starts with the first event of a visible page and ends after 30 minutes
without activity (`session.inactivityTimeoutMs`) or after 12 hours. Activity is a call from a
visible page, a page becoming visible or hidden, and a page being left. One session is shared by
the site's tabs and, with the identity cookie, by its subdomains. Events from a hidden page join an
open session but never extend it. `Session Ended` is sent when an end is found, backdated to the
last activity, so a session nobody returns to within 12 hours ends without one; the backend closes
it at its last event.

**Network requests.** The SDK never replaces `fetch` or `XMLHttpRequest`. To record requests to
your own APIs, use the function `createTrackedFetch` returns wherever you would call `fetch`:

```ts
import axios from 'axios';
import { createAnalytics, createTrackedFetch } from 'rubicon-analytics';

const analytics = createAnalytics({ apiKey: 'your-publishable-key' });
const trackedFetch = createTrackedFetch(analytics, {
  hosts: ['api.shop.example.com', '*.cdn.shop.example.com'],
});

// Plain fetch:
const response = await trackedFetch('https://api.shop.example.com/orders/4521');

// A client that accepts a fetch function, such as axios 1.12 or later with its fetch adapter:
const client = axios.create({ adapter: 'fetch', env: { fetch: trackedFetch } });
```

- Sent: `method`, `url` and `path` without query or fragment and with ids masked, `host`,
  `status_code`, `error` (`canceled`, `timeout`, `network` or `unknown`, never a message),
  `duration_ms` to the response headers, `request_bytes` (for a `Blob`, `ArrayBuffer` or typed
  array body) and `response_bytes` (from `Content-Length`) when known.
- Never sent: headers, bodies, query strings, fragments. Bodies are never read or cloned. The SDK's
  own host is never captured. `maskPathIds: false` keeps the path as it is.
- The function behaves as `fetch`: the same `Response`, a 404 is not an error, and a rejection is
  the same error object. It passes requests through unmeasured for other hosts, while the user is
  opted out or consent is pending, and when `network_requests` is off.
- Not captured: code that calls the page's `fetch` or `XMLHttpRequest` directly, third-party
  scripts, and axios with its default `XMLHttpRequest` adapter. Switching axios to the fetch
  adapter can change its behaviour, upload progress for example; that choice is yours.
- With two copies of the SDK on a page, use the `createTrackedFetch` of the copy that created the
  instance; the other copy's passes every request through without an event.

**SDK Diagnostics.** At most once an hour, and only when events were dropped or problems were
logged, the SDK sends an event of counts only: per drop reason and per issue code.
`logging.sendDiagnostics: false` switches it off.

## Configuration

`createAnalytics` takes a plain object. Only `apiKey` is required; a group given in part is
completed from its defaults. The SDK copies what it needs, so changing your object later changes
nothing; what changes at runtime goes through the methods.

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | The project's publishable key; it is visible in the page and its requests by nature |
| `host` | the SaaS host | Base URL of your backend, `https://`, with an optional path; see [Hosts](#hosts-proxies-and-content-security-policy) |
| `debug` | `false` | Developer mistakes written as `console.error(new Error(...))`; below |
| `beforeSend` | `[]` | Hooks, below |
| `flush.at` | 30 (1 to 100) | Upload when this many events wait |
| `flush.intervalMs` | 5 000 (1 000 to 600 000) | Upload this long after the first waiting event; the mobile SDKs wait 60 seconds |
| `flush.immediateEvents` | `[]` | Event names uploaded right after they are stored |
| `session.inactivityTimeoutMs` | 1 800 000 (60 000 to 7 200 000) | Inactivity that ends a session, visible or hidden; the web has no `backgroundTimeoutMs` |
| `autocapture.enabled` | all three | The table above |
| `context.disabledFields` | `[]` | Fields never read or sent, such as `'page.referrer'` or `'locale'` |
| `context.app` | none | `name`, `version`, `namespace` of your application, sent as `context.app` |
| `context.page.queryParams` | `[]` | Query parameters copied into `context.page.query` |
| `context.page.title` | `false` | Whether `document.title` is sent |
| `identity.crossSubdomain` | `true` | Share the ids across the site's subdomains |
| `identity.cookieDomain` | discovered | An explicit cookie domain, the host or a suffix of it |
| `privacy.defaultConsent` | `'granted'` | `'granted'` or `'pending'`; consent, below |
| `privacy.persistConsent` | `true` | Store the user's decision in the browser |
| `logging.level` | `'warn'` | `debug`, `info`, `warn`, `error` or `off` |
| `logging.logger` | the console | Where log lines go |
| `logging.eventObserver` | none | What became of each event |
| `logging.sendDiagnostics` | `true` | The `SDK Diagnostics` event |
| `network.headers` | `{}` | Headers added to every SDK request, for a gateway |

Numbers out of range are clamped and settings of the wrong type replaced by their default, each
with a warning. A missing or blank `apiKey`, or an invalid `host`, gives an instance that does
nothing (`isOptedOut` is `true`, `deviceId` is empty) with an error line. Your backend can only
restrict the configuration remotely: switch automatic events off, upload less often, sample or stop
collection; its values apply from the next page load, a stop at once.

### `debug`

`debug` is `false` unless you set it, and the SDK never reads it from the environment. Wire it from
your build:

```ts
import { createAnalytics } from 'rubicon-analytics';

// Vite
const analytics = createAnalytics({ apiKey: 'your-publishable-key', debug: import.meta.env.DEV });
```

```ts
import { createAnalytics } from 'rubicon-analytics';

// webpack, Next.js and other bundlers that replace process.env.NODE_ENV
const analytics = createAnalytics({
  apiKey: 'your-publishable-key',
  debug: process.env.NODE_ENV !== 'production',
});
```

With the snippet, set it in `rubicon.init({ apiKey: '...', debug: true })` on your development
pages. `debug` adds no line and changes no level: `logging.level` alone decides what is written,
and `'off'` silences everything, with or without `debug`.

### Hooks

`beforeSend` hooks see each event, in order, before it is stored, each on its own copy. Return the
event, a changed copy, or `null` to drop it. They run synchronously on the page's main thread,
shortly after the call (after the next paint), so keep them cheap.

```ts
import { createAnalytics } from 'rubicon-analytics';
import type { BeforeSend } from 'rubicon-analytics';

const beforeSend: BeforeSend[] = [
  (event) => (event.type === 'track' && event.name.startsWith('debug_') ? null : event),
  (event) => {
    switch (event.type) {
      case 'track':
        return { ...event, properties: { ...event.properties, tenant: 'acme' } };
      default:
        // Event kinds may be added in minor versions: let unknown ones pass unchanged.
        return event;
    }
  },
];

const analytics = createAnalytics({ apiKey: 'your-publishable-key', beforeSend });
```

- Your own events (`source: 'app'`) may get any name and any properties, or be dropped.
- Automatic events (`source: 'auto'`) may change the values of their properties, to mask a token
  for example, but keep their name and keys; returning `null` for one is not allowed. To stop an
  automatic event, switch its type off.
- `type`, `source`, `messageId`, `timestamp`, `userId`, `deviceId` and `context` never change.
- A hook that throws drops the event (`HOOK_THREW`); one that returns `undefined`, a Promise (an
  `async` hook) or what these rules do not allow drops it too (`HOOK_VIOLATION`).
- `SDK Diagnostics` never reaches a hook.

### Values

Properties, traits and super properties take plain objects. The SDK copies them during the call.

| You pass | Sent as |
| --- | --- |
| string, boolean, `null`, finite number | as is |
| `undefined` as an object's value | the key is left out |
| `undefined` or a hole in an array | `null` |
| `BigInt` within the safe integer range | a number |
| `new Number(5)` and other boxed primitives | their value |
| a valid `Date` in the years 0000 to 9999 | its ISO string, `2026-10-14T08:00:00.000Z` |
| `Array`, `Set`, typed array | a list |
| `Map` with string keys, plain object | an object |
| `URL` | its `href` |

Not supported, and dropped with a warning that names the key and the type, never the value: `NaN`
and `Infinity`, other `BigInt`s, invalid dates, `Temporal`, moment, Day.js and Luxon objects (pass a
`Date`, epoch milliseconds or an ISO string instead), `ArrayBuffer`, `DataView`, `Blob`, objects
with their own `toJSON` (it never runs), class instances, `Error`, `RegExp`, `Promise`, functions,
`Symbol`, DOM nodes, and a getter or `Proxy` that throws. Only that key or element is dropped; the
event is kept.

Limits: event names and keys 1 to 255 characters, never trimmed (a longer or blank name drops the
event, such a key drops itself); strings truncated at 1024 characters; 256 properties per event, super properties dropped first; nesting
three levels deep; 32 KB per event, larger events dropped. Lengths count UTF-16 code units, a
string's `length`.

## Consent

The SDK collects from the first call unless you say otherwise. Two states can hold while no
decision is stored, set with `privacy.defaultConsent`:

- `'granted'` (the default): events are collected, stored and sent.
- `'pending'`: nothing at all is written to the browser, no cookie and no `localStorage` key, and
  nothing is sent. Events wait in the page's memory under a temporary `deviceId`. `optIn()` writes
  and sends them; `optOut()` drops them. A visitor who navigates before deciding loses that page's
  waiting events and gets a new temporary id on the next page, so call `optIn()` or `optOut()` as
  soon as your consent platform knows the answer, which for a returning visitor is at page start.

`optOut()` stops collection: no new events of any kind, and no new uploads, in every tab and on
every subdomain that shares the cookie. Only the decision is written. Events stored before it wait
unsent for `optIn()` and are deleted after three days; an upload already on its way may complete.
`isOptedOut` is `true` while opted out and while consent is pending.

With `privacy.persistConsent` (the default) the decision is stored in a cookie and its
`localStorage` mirror, to remember the visitor's choice as consent platforms remember theirs, and it
wins over `defaultConsent` on later pages and visits. Whether that storage counts as strictly
necessary is your counsel's reading. Set `persistConsent: false` when your consent platform keeps
the decision; then pass it on every page.

```ts
import { createAnalytics } from 'rubicon-analytics';

// `cmp` stands for your consent platform's API; each vendor names its calls differently.
const analytics = createAnalytics({
  apiKey: 'your-publishable-key',
  privacy: { defaultConsent: 'pending', persistConsent: false },
});

cmp.onConsentChange((choices) => {
  if (choices.analytics) analytics.optIn();
  else analytics.optOut();
});
```

**Global Privacy Control and Do Not Track.** The SDK reads neither signal. Global Privacy Control
asks a site not to sell or share data, and how it ranks against a stored opt-in depends on the law
that applies to you; a consent platform usually reads it itself. If you must honour it without one,
this line opts the visitor out and stores the decision:

```ts
import type { Analytics } from 'rubicon-analytics';

// TypeScript's DOM library does not declare the signal yet.
declare global {
  interface Navigator {
    readonly globalPrivacyControl?: boolean;
  }
}

function honourGlobalPrivacyControl(analytics: Analytics): void {
  if (navigator.globalPrivacyControl === true) analytics.optOut();
}
```

Do Not Track is deprecated and has no legal meaning; the SDK ignores it. If you come from Mixpanel,
which respects it by default, note that Rubicon does not.

**Erasure.** `clearLocalData()` deletes everything the browser holds about the person, events not
yet sent included (also those of other tabs), renews `deviceId` and keeps the consent decision.
Collection goes on afterwards. For "forget me", read the id first, ask your backend to erase it,
then opt out and clear:

```ts
import type { Analytics } from 'rubicon-analytics';

function forgetMe(analytics: Analytics, requestErasure: (deviceId: string) => void): void {
  requestErasure(analytics.deviceId); // read before clearing
  analytics.optOut();
  analytics.clearLocalData();
}
```

## Identity, tabs and subdomains

`deviceId` identifies one site in one browser profile. It lives in a first-party cookie
`rubicon_<keyHash>` with a copy in `localStorage`; the user id from `identify` travels in the same
cookie. Clearing the site's data, another browser or profile, a private window, or in Safari seven
days of use without interacting with the site (Safari's limit for anything a script stores) makes a
new device, as a reinstall does on a phone. Device counts from Safari therefore exceed real devices, for
every browser SDK.

- **Subdomains.** The ids are shared by the site's subdomains by default: the SDK finds the
  registrable domain with a probe cookie, so the browser's own public suffix list decides
  (`shop.example.co.uk` shares with `www.example.co.uk`, `you.github.io` stays alone). Super
  properties stay per host: a visitor who moves from `www` to `shop` keeps the device and the user,
  not the super properties. `identity.crossSubdomain: false` keeps the cookies host-only, and
  `identity.cookieDomain` sets their scope yourself: for a site on a shared hosting domain, one that
  wants host-only identity, or one whose cookies are already near the 8 KB request header limit of
  nginx and Apache. A `cookieDomain` that is not the host or a suffix of it gives host-only cookies
  and the warning `INVALID_COOKIE_DOMAIN`; given, it wins over `crossSubdomain`.
- **Tabs.** Every call reads the shared state, so a `track` in another tab after `identify` carries
  the new user. Two tabs that change the identity at the same moment, `identify` in one and
  `reset()` in the other, end with the last write. In WebKit, Safari's engine, a cookie another
  tab wrote can reach this tab a few milliseconds later, so a call made in that instant still
  sees the previous decision, identity or session. Events from several tabs reach the backend in no
  particular order across tabs.
- **Storage.** The SDK writes exactly the cookies and keys listed in
  [`docs/storage-declaration.md`](docs/storage-declaration.md), with their lifetimes, and nothing in
  `sessionStorage` or IndexedDB. It never calls `navigator.storage.persist()`, which acts on your
  whole origin and can show a prompt in Firefox; call it yourself if you want persistent storage.
  Where storage cannot be used (blocked site data, a sandboxed iframe), the SDK runs from memory for
  the page with the warning `STORAGE_UNAVAILABLE`.

## Logging and error trackers

The SDK writes to the console, each line prefixed `[Rubicon]`: `error` to `console.error`, `warn`
to `console.warn`, `info` to `console.info`, `debug` to `console.log` (Chrome hides
`console.debug`). The default level `warn` is silent on a healthy page. Every warning and error
starts with a stable code from [`docs/issue-codes.md`](docs/issue-codes.md); most are logged once
per page load and later as `debug` lines, and the three a visitor's ad blocker or a long offline
period can cause (`UPLOAD_FAILED_OPAQUE`, `QUEUE_FULL`, `EVENTS_EXPIRED`) once a day per browser.
Messages never contain property values, ids, the key, headers, bodies, query strings or the text of
a caught error.

```ts
import { createAnalytics } from 'rubicon-analytics';
import type { EventObserver, RubiconLogger } from 'rubicon-analytics';

// `myLogger` stands for your application's own logging.
const logger: RubiconLogger = (level, message, error) => {
  // `error` is the caught error, when there is one; only your logger receives it.
  myLogger.log(level, message, error);
};

const eventObserver: EventObserver = (update) => {
  switch (update.type) {
    case 'queued':
      console.info('stored', update.event.messageId);
      break;
    case 'sent':
      console.info('sent', update.messageIds.length);
      break;
    case 'dropped':
      console.info('dropped', update.messageIds.length, update.reason);
      break;
    default:
      break;
  }
};

const analytics = createAnalytics({
  apiKey: 'your-publishable-key',
  logging: { level: 'info', logger, eventObserver },
});
```

A logger or observer that throws is replaced by the console, or switched off, for the rest of the
page; calls to the SDK from inside them are ignored.

**Error trackers.** Tools that read the console see the SDK's lines. Sentry's `consoleIntegration`,
on by default, keeps them as breadcrumbs, which `beforeBreadcrumb` can drop by the console category
and the prefix; its opt-in `captureConsoleIntegration` turns console calls into events, which
`beforeSend` can drop. Alternatively set `logging.level: 'error'` in production, or route the lines
to your tracker with `logging.logger`.

```ts
import * as Sentry from '@sentry/browser';

const fromRubicon = (text: string | undefined): boolean =>
  text !== undefined && text.startsWith('[Rubicon]');

Sentry.init({
  dsn: 'your-dsn',
  beforeBreadcrumb: (breadcrumb) =>
    breadcrumb.category === 'console' && fromRubicon(breadcrumb.message) ? null : breadcrumb,
  beforeSend: (event) =>
    fromRubicon(event.message) || fromRubicon(event.exception?.values?.[0]?.value) ? null : event,
});
```

## Hosts, proxies and Content Security Policy

The SDK sends `POST {host}/v1/batch` (JSON, gzip where the browser compresses reliably) and
`GET {host}/v1/config` with `Authorization: Bearer {apiKey}`, no cookies and no referrer. With that
header, a request to a backend on another origin is preceded by a CORS preflight.

- **Your backend or gateway** must answer CORS on both paths and on every response, errors and
  pages from load balancers and firewalls included: the preflight with
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST, GET`,
  `Access-Control-Allow-Headers` listing `Authorization`, `Content-Type`, `Content-Encoding`,
  `If-None-Match` and every name in `network.headers`, and `Access-Control-Max-Age: 7200`; every
  other response with `Access-Control-Allow-Origin: *` and
  `Access-Control-Expose-Headers: ETag, Retry-After, X-Request-Id`. A response without these
  headers looks like a network failure to the SDK: a 429 loses its `Retry-After`, a 401 looks like
  an outage, and the warning `UPLOAD_FAILED_OPAQUE` names the possible causes. Do not log the
  `Referer` header on these paths: Safari 10.1 to 11.0 send the page's full URL in it although the
  SDK asks for none.
- **`network.headers`** are added to every request. A name your backend's preflight does not allow
  stops every upload before it is sent.
- **Mixed content.** An `https` page cannot reach an `http` host: nothing is sent and the error
  `CLEARTEXT_HOST` is logged. `http` works only from an `http` page, or to `localhost` and
  `127.0.0.1` during development.
- **Redirects** are not followed; point `host` at the final URL.

**A first-party proxy.** Ad blockers stop requests to analytics hosts, and the SDK does nothing to
evade them. To route around them, serve the backend from a path on your own domain and set
`host: 'https://shop.example.com/rb'`; requests then go to `https://shop.example.com/rb/v1/batch`.
The proxy forwards `Authorization` and `Content-Encoding` unchanged, never redirects, and passes the
visitor's address in `X-Forwarded-For`, which the backend uses for anything derived from the
address. A proxy on the page's own origin needs no CORS and no preflight. Consent works through it
unchanged. With the script build, host the file on your domain as well.

**Content Security Policy.** A page with a policy allows the backend's origin in `connect-src`
(`'self'` behind a same-origin proxy) and, for the script build and the snippet, the file's URL and
the stub's hash in `script-src`. The SDK needs no `'unsafe-eval'`, no `'unsafe-inline'` and no
`style-src` entry, loads no other script and has no Trusted Types sink. A blocked request logs the
error `CSP_BLOCKED`. The details, with an example policy, are in [`docs/csp.md`](docs/csp.md).

## Privacy checklist

The web form of the checklist of the Android and iOS SDKs. The legal assessment is yours and your
counsel's; this is what the SDK lets you control.

- **Consent.** `privacy.defaultConsent: 'pending'` where consent is required; `optIn()` and
  `optOut()` called as soon as your consent platform knows; `persistConsent: false` when the
  platform stores the decision itself; the Global Privacy Control line where you must honour it.
- **Pages.** `page.url` and `page.referrer` disabled (`context.disabledFields`) where paths carry
  personal data that id masking does not catch, such as `/users/<e-mail>` or `/invite/<token>`;
  `page.title` left off; no parameter that can carry a token or personal data in
  `context.page.queryParams`; no personal data in the `utm_*` values of your campaign links, since
  they are sent as they are.
- **Network capture.** `createTrackedFetch` given only the hosts you need; headers and bodies are
  never recorded and ids in paths are masked.
- **Location.** `locale` and `timezone` disabled where needed; no carrier on the web; IP
  anonymisation enabled in your project's settings on the backend; `X-Forwarded-For` forwarded by a
  first-party proxy.
- **Erasure.** Read `deviceId`, ask your backend to erase it, then `optOut()` and
  `clearLocalData()`.
- **Storage.** Build your cookie policy from
  [`docs/storage-declaration.md`](docs/storage-declaration.md): every cookie and key the SDK
  writes, its lifetime and its purpose, kept true by a test in three browser engines. The consent
  cookie and its mirror remember the visitor's choice; everything else serves analytics. The
  category is your consent platform's and your counsel's call.

## Testing your code

Pass the instance to the code that tracks, and give it a fake in tests. Build fakes by spreading
the no-op, which has every method as an own property: methods added to `Analytics` in a later minor
version then exist on your fake by themselves, while a class that `implements Analytics` stops
compiling. With Vitest or Jest, `{ ...createNoOpAnalytics(), track: vi.fn() }` is the usual form.

```ts
import { createNoOpAnalytics } from 'rubicon-analytics';
import type { Analytics } from 'rubicon-analytics';

const tracked: string[] = [];
const fake: Analytics = {
  ...createNoOpAnalytics(),
  track: (name) => {
    tracked.push(name);
  },
};
```

The no-op reports `isOptedOut` as `true` and `deviceId` as an empty string.

## Behaviour worth knowing

- A returned `track()` is not yet stored: events are written after the next paint, in short slices.
  When the page is hidden or left, what is waiting is written at once within a small budget; events
  a closing page could not write are lost and counted as `page_closed`.
- Offline, nothing is sent and nothing is lost: events wait in `localStorage` (at most 1000 events,
  about 1 MiB and three days, the oldest dropped first and counted) and go when the network returns
  or on the next visit. The last events of a visitor who leaves offline and never returns stay
  unsent.
- Failed uploads are retried with backoff (2 s up to 10 minutes) and `Retry-After` is honoured;
  every tab and page of your site shares the wait. A page reload does not bypass it.
- The same event can reach the backend twice, after a lost response or from two tabs; it carries
  the same `message_id` both times. Two tabs that find a session's end at the same moment can each
  send its `Session Ended`, which the backend counts once by the session id.
- Uploads made while the page is hidden or closing go uncompressed with `keepalive`. Bodies are
  never compressed in browsers without `CompressionStream`, nor in Safari 16.4 and 16.5 and every
  browser on iOS and iPadOS 16.4 and 16.5, whose compressor is broken.
- A page restored from the back/forward cache is live again: it sends a `Page Viewed` and goes on
  where it stopped.
- Numbers are sent as JavaScript writes them (`1e+21`, `5` for `5.0`); the backend parses numbers
  and never compares their text ([`docs/wire-format.md`](docs/wire-format.md)).

## Repository

| Path | What it is |
| --- | --- |
| `packages/core` | The platform-free core: configuration, pipeline, queue, storage, identity, sessions, upload, retry, privacy, logging. Bundled into the package, never published on its own. |
| `packages/web` | `rubicon-analytics`: the factories, the browser implementations, page views, network capture, the script build and the snippet |
| `packages/testing` | Test support: fakes, virtual time, the test server, the golden files loader |
| `docs/` | `wire-format.md`, `issue-codes.md`, `storage-declaration.md`, `csp.md`, `implementation-plan.md` |
| `packages/web/etc/rubicon-analytics.api.md` | The recorded public API; a change here is a public API change |

The design is decided in Confluence (space SD, "Analytics SDK: Web" and its fourteen `Web: <block>`
pages); the Android SDK's decision pages are the contract all three platforms implement. Work
follows [`docs/implementation-plan.md`](docs/implementation-plan.md). Development needs Node 24 and
pnpm: `pnpm install`, then `scripts/check.sh` runs what CI runs.

## License

Apache License 2.0; see [`LICENSE`](LICENSE).
