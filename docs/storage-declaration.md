# Storage declaration

Every cookie and `localStorage` key the SDK writes, as Web Privacy 5 decides it, for customers to
build their cookie policy from. `<keyHash>` is the first 16 hexadecimal characters of the SHA-256 of
the API key (Web Identity 4), so two API keys never share a record. The SDK writes no other cookie
or key, no `sessionStorage` and no IndexedDB (Web Disk 1, 7). A Playwright test that runs every flow
and fails on any name this file does not list arrives in step 8.3; until then each step that adds a
name adds it here (plan section 6).

The declaration states purposes: the consent cookie and its mirror remember the visitor's choice,
everything else serves analytics. The category is left to the customer's consent platform and
counsel.

| Name | Type | Scope | Lifetime | Contents | Written |
| --- | --- | --- | --- | --- | --- |
| `rubicon_<keyHash>` | Cookie | The site's registrable domain (Web Identity 2) | 365 days | `device_id`, `user_id`, `person_epoch` | With consent (Web Privacy 1) |
| `rubicon_<keyHash>_s` | Cookie | The same | 12 hours, renewed on every write | Session id, start, last activity, epoch | With consent |
| `rubicon_<keyHash>_c` | Cookie | The same | 365 days | The decision and its time | When the user decides, with `persistConsent` |
| `__rubicon_dmn_<uuid>` | Cookie | The domain being tried | Seconds, deleted at once | Empty | With consent, once (Web Identity 2) |
| `rubicon.<keyHash>.device` | `localStorage` | The origin | Until removed | See below | With consent |
| `rubicon.<keyHash>.person` | `localStorage` | The origin | Until removed | See below | With consent |
| `rubicon.<keyHash>.remote` | `localStorage` | The origin | Until removed | See below | With consent |
| `rubicon.<keyHash>.pause` | `localStorage` | The origin | Until removed | See below | With consent |
| `rubicon.<keyHash>.consent` | `localStorage` | The origin | Until removed | Mirror of the decision, see below | When the user decides |
| `rubicon.<keyHash>.q1.<writtenAt>.<newestEventAt>.<pageId>.<seq>.<count>.<chars>` | `localStorage` | The origin | At most 3 days | Events not yet sent, one per line | With consent |
| `rubicon.<keyHash>.q1r.<pageId>` | `localStorage` | The origin | At most 3 days | The marker of a closed page that released its events to other pages | With consent |

## The `localStorage` records

Each record is one JSON object with the format version `"v": 1`. Times are epoch milliseconds. A
field without a value is left out, except `user_id`, which is `null` while anonymous. Fields a later
SDK version adds are kept by this one (Web Disk 5). Written since step 4.1.

| Record | Fields | Decided by |
| --- | --- | --- |
| `.device` | `device_id` (the mirror of the identity cookie's id); `retry` (`paused_until`, `step`, `last_failure`, `rev`, `probe_at`, `suspects` with `f`, `alone` and `cleared_by` per chunk); `diagnostics` (`period_start`, `last_sent_at`, `dropped` and `issues` counts); `last_logged` (the time of the last line of each code logged once a day) | Web Identity 4, Web Retry 1, Web Logging 2 and 5, Android log 4.1 |
| `.person` | `user_id` (`null` while anonymous), `super_properties`, `device_id` (the id the record belongs to) | Web Identity 4, Web Privacy 3 |
| `.remote` | `etag`, `values` (the remote configuration as received), `fetched_at` (the last successful fetch) | Web Configuration 5, Android log 4.1 |
| `.pause` | `until`, `kind` (`throttle` or `config`), `host` (the first 16 hex characters of the SHA-256 of the configured host) | Web Retry 1 and 4 |
| `.consent` | `state` (`granted` or `denied`), `decided_at`; never an identifier | Web Privacy 2, Web Logging 4 |

No record holds an event, a property value other than the super properties the developer
registered, or a trait.
