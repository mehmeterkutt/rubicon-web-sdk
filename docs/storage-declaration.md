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
| `.person` | `user_id` (`null` while anonymous), `super_properties`, `device_id` and `person_epoch` (the identity the record belongs to; when the identity cookie holds another device id or epoch, after `clearLocalData()` or a change of person on another subdomain, the record is deleted) | Web Identity 4, Web Privacy 3, plan section 15 (step 6.1) |
| `.remote` | `etag`, `values` (the remote configuration as received), `fetched_at` (the time of the last 200 or 304; a 404 deletes the record) | Web Configuration 5, Android log 4.1 |
| `.pause` | `until`, `kind` (`throttle` or `config`), `host` (the first 16 hex characters of the SHA-256 of the configured host) | Web Retry 1 and 4 |
| `.consent` | `state` (`granted` or `denied`), `decided_at`; never an identifier | Web Privacy 2, Web Logging 4 |

No record holds an event, a property value other than the super properties the developer
registered, or a trait.

## The identity cookie

`rubicon_<keyHash>` holds `<version>.<device_id>.<person_epoch>.<user_id>`, for example
`1.0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f.0123456789abcdef.jane.doe%40example.com` (Web Identity 1 and
4, Web Session 5). The version is `1`; `device_id` is the 36 lowercase characters of a UUIDv7;
`person_epoch` 16 lowercase hexadecimal characters, renewed on `reset()`, a change of user and
`clearLocalData()`; `user_id` comes last, percent-encoded as UTF-8 (`encodeURIComponent`), and is
empty while the visitor is anonymous. The cookie is set with `Path=/`, `SameSite=Lax`, `Secure` on
an `https` page, `Max-Age` of 365 days and the domain of Web Identity 2; it is written on the first
visit, `identify`, `reset()` and `clearLocalData()` only. A value of another version, or one that
breaks this grammar, is never overwritten except by `clearLocalData()`. Name and value are 81 bytes
for an anonymous visitor and 117 with a UUID user id; at most 2376 bytes with a 255-character user
id of three-byte characters. Written since step 6.1.

## The session cookie

`rubicon_<keyHash>_s` holds `<version>.<session_id>.<started_at>.<last_activity>.<person_epoch>`,
for example `1.0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f.1759147200000.1759147290000.0123456789abcdef`
(Web Session 2, 4 and 5). The version is `1`; `session_id` is the 36 lowercase characters of a
UUIDv7; `started_at` and `last_activity` are epoch milliseconds in decimal; `person_epoch` is the
identity cookie's epoch when the session started, and a session whose epoch differs from the
identity cookie's is ignored. No field holds free text, so nothing is percent-encoded. The cookie is
set with the attributes and domain of the identity cookie and a `Max-Age` of 12 hours renewed on
every write; it is written when a session starts, with the last activity at most every 30 seconds
per tab and at once when a tab is hidden or left, and deleted when a session ends without a
successor, on `reset()`, a change of user, an opt-out and `clearLocalData()`. A value of another
version, or one that breaks this grammar, is never overwritten except by `clearLocalData()`. Name
and value are 110 bytes. While consent is pending, and when the cookie cannot be used, the session
is kept in the page's memory. Written since step 6.2.

## The event chunks

Events wait in `localStorage` as immutable chunks, one key and value each, written once by the page
that tracked them and deleted after the server acknowledged them or after 3 days (Web Disk 2, Web
Queue 2). Every part of the key is plain text, so the SDK decides capacity, age and which page may
send a chunk without reading values. Written since step 4.2.

| Part | Meaning |
| --- | --- |
| `q1` | The format version; another format uses another name and leaves these keys alone |
| `<writtenAt>` | When the chunk was written, epoch milliseconds in decimal |
| `<newestEventAt>` | The `timestamp` of the chunk's newest event, epoch milliseconds in decimal |
| `<pageId>` | A random id of the page load that wrote it, 16 lowercase hexadecimal characters, kept in memory only |
| `<seq>` | The page's chunk counter, from 0, in decimal |
| `<count>` | The number of events, in decimal |
| `<chars>` | The value's length in UTF-16 code units, in decimal |

The value holds one event per line exactly as it is sent (JSON Lines), each line ended by a line
break. A chunk holds at most 100 events and fits the 48 KiB keepalive budget. All chunks and markers
of a key together stay within 2 × Σ(key and value length) ≤ 1 MiB and 1000 events (Web Queue 6).

The released marker `rubicon.<keyHash>.q1r.<pageId>` has an empty value: its key alone tells other
pages that the page went away and they may send its chunks. It is removed by its page when it
returns from the back/forward cache, or by the first page that finds no chunk of that page id.

While consent is pending, and when storage cannot be used, the page's events stay in its memory
and nothing of the queue in storage is read, written or deleted except by `clearLocalData()` (Web
Privacy 1 and 3, Web Disk 4). While
consent is refused nothing is written either, but stored chunks older than 3 days are still
deleted, so no chunk outlives its 3 days (Web Privacy 3, Web Logging 4).
