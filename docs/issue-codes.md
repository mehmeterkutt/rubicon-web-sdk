# Issue codes

Every WARN and ERROR line of the SDK carries one of these codes (Logging decisions 1 and 2). Every
occurrence is counted, and `SDK Diagnostics` reports the counts in `issues` (Logging decision 5).

The names are part of the backend contract and are shared by the three SDKs. The catalogue is one
file, `docs/issue-codes.md` in `rubicon-android-sdk`, which gains the Platform, Web level and
Frequency columns (Web Logging 3); until it has them, this copy is the web's, refreshed from the
Android file with the columns filled for the web (plan section 15, steps 0 and 2.2). A code is never
renamed or reused; a new situation gets a new code, added to the catalogue and to `ISSUE_CODES`
(`packages/core/src/log/issue-code.ts`) in the same change. `issue-codes.test.ts` in `core` fails
when this file and `ISSUE_CODES` disagree, and when a code not produced on the web appears in `src`.

- **Level** is the level on Android and iOS, and on the web unless Web level says otherwise; for a
  web-only code it is the web's level.
- **Platform** lists where a code can occur: `Android`, `iOS`, `web`. `SWIZZLE_FAILED` is in the iOS
  catalogue only; it is listed here so the list is the one the backend sees.
- **Web level** is filled where the web's level differs (Web Logging 3); `-` for a code the web never
  produces.
- **Frequency** is the web's (Web Logging 2): `per_page` logs a code at its level once per page load
  and later occurrences at DEBUG, the web form of Android's "once per process"; `per_24h` once per
  device per sliding 24 hours, best-effort, the time kept in `.device` (per page while consent is
  pending or refused and in the memory-only mode); `-` for a code the web never produces. A line
  logged "once per key" (`PROPERTY_TRUNCATED`, Serialization 3) applies the frequency per key.
- **Meaning** is Android's, with the web's reading after "Web:" where it differs (Web Logging 3).

Status: approved for the SDK in Android step 2.2, pending backend review; the web codes and readings
are Web Logging 2 and 3.

Never produced on the web (Web Logging 3): `CONFIG_FROZEN`, `PROCESS_NAME_UNKNOWN`, `API_KEY_CHANGED`
with its drop reason `api_key_changed`, `UNREADABLE_SEGMENT`, `HOST_BLOCKED`, `TLS_FAILED` (a TLS
failure is `io` in a browser), `NETWORK_STATE_PERMISSION_MISSING`, `NETWORK_CALLBACK_FAILED`,
`LIFECYCLE_UNAVAILABLE`; and the iOS-only `SWIZZLE_FAILED`.

## Logging

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `LOGGER_THREW` | WARN | Android, iOS, web | | per_page | The developer's logger threw; the platform logger is used for the rest of the process. Web: also when it returns a Promise that rejects; the default sink is used for the rest of the page. | Logging 4b, Web Logging 1 |
| `OBSERVER_THREW` | ERROR | Android, iOS, web | | per_page | The developer's `eventObserver` threw; it is switched off for the rest of the process. Web: also when it returns a Promise that rejects; switched off for the rest of the page. | Logging 4b, Web Logging 1 |
| `WORKER_FAILED` | ERROR | Android, iOS, web | | per_page | An SDK coroutine failed with an unexpected exception; the SDK keeps running. Web: a writer slice or an uploader step threw. | Queue 1, Web Logging 3 |

## Configuration

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `INVALID_API_KEY` | ERROR | Android, iOS, web | | per_page | The API key is blank; the factory returns a no-op instance. | Configuration 3 |
| `INVALID_HOST` | ERROR | Android, iOS, web | | per_page | The host is not a valid base URL; the factory returns a no-op instance. | Configuration 3, Web Configuration 4 |
| `CLEARTEXT_HOST` | WARN | Android, iOS, web | WARN or ERROR | per_page | The host uses `http://`. Web: on an `https` page an ERROR, since the browser blocks the request as mixed content and nothing is sent until the host uses `https://`; on an `http` page a WARN, events travel unencrypted. | Configuration 3, Web Configuration 4, Web HTTP 3, Web Logging 3 |
| `SETTING_OUT_OF_BOUNDS` | WARN | Android, iOS, web | | per_page | A numeric setting was out of bounds and was clamped to the nearest bound. | Configuration 3 |
| `CONTRADICTING_SETTINGS` | WARN | Android, iOS, web | | per_page | Settings of a group contradict each other; the group's defaults are used. | Configuration 3 |
| `SETTING_WRONG_TYPE` | WARN | web | | per_page | A setting has the wrong type or a value outside its closed set; the default is used. | Web Configuration 1, Web Lifecycle 8, Web Logging 3 |
| `SETTING_NOT_SUPPORTED` | WARN | web | | per_page | Another platform's setting, such as `session.backgroundTimeoutMs`, was given; it is not applied. | Web Session 3, Web Logging 3 |
| `CONFIG_FROZEN` | WARN | Android | - | - | A setting was written after the SDK was created; the write is ignored. | Configuration 4 |
| `RESERVED_HEADER` | WARN | Android, iOS, web | | per_page | `network.headers` tried to override a reserved header; it is ignored. | Configuration 5 |
| `SECOND_INSTANCE` | ERROR | Android, iOS, web | | per_page | A second instance was created in the process; the first one is returned. Web: a second instance in the page, from any copy of the SDK; the message names both versions. | Configuration 3, Public API 1, Web Configuration 3, Web Logging 3 |
| `PROCESS_NAME_UNKNOWN` | WARN | Android | - | - | The process name could not be determined; the main process is assumed. | Disk 2d |
| `REMOTE_CONFIG_FAILED` | WARN | Android, iOS, web | | per_page | The remote configuration could not be fetched or read; the last valid values, or code, are used. | Configuration 1 |
| `REMOTE_CONFIG_INVALID_VALUE` | WARN | Android, iOS, web | | per_page | A remote configuration value was invalid and is ignored. | Configuration 3 |

## Events and properties

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `PROPERTY_DROPPED` | WARN | Android, iOS, web | | per_page | A property or trait was dropped: unsupported type, NaN or Infinity, `java.time`, invalid key or too deep. Web: the rejected values of Web Serialization 2. | Public API 3, Serialization 2, 3, Web Serialization 2 |
| `PROPERTY_TRUNCATED` | WARN | Android, iOS, web | | per_page | A string value was longer than 1024 characters and was truncated. Logged once per key. | Serialization 3 |
| `TOO_MANY_PROPERTIES` | WARN | Android, iOS, web | | per_page | An event had more than 256 properties; the extra ones were dropped, super properties first. | Serialization 3 |
| `INVALID_EVENT_NAME` | WARN | Android, iOS, web | | per_page | An event or screen name was blank or longer than 255 characters; the event was dropped. | Serialization 3 |
| `HOOK_THREW` | ERROR | Android, iOS, web | | per_page | A `beforeSend` hook threw; the event was dropped (`before_send`). | Public API 4 |
| `HOOK_VIOLATION` | ERROR | Android, iOS, web | | per_page | A `beforeSend` hook returned what its rules do not allow: a renamed automatic event, added or removed top-level keys, `null` for an automatic event, an invalid name, or an event that is not a `copy` of its input; the event was dropped (`before_send`). Web: also `undefined` or a Promise. | Public API 4, Web Public API 5 |

## Identity

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `INVALID_USER_ID` | WARN | Android, iOS, web | | per_page | `identify` was called with a blank user id or one longer than 255 characters; the call is ignored. | Identity 3 |
| `INVALID_COOKIE_DOMAIN` | WARN | web | | per_page | `identity.cookieDomain` is not a suffix of the host, or the browser refused it; the cookies are host-only and no domain is discovered. | Web Identity 2, Web Logging 3 |

## Storage

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `STORE_UNREADABLE` | WARN | Android, iOS, web | | per_page | `device.json`, `person.json` or `remote-config.json` exists but cannot be read; in-memory values are used and the file is left untouched. Web: a `localStorage` record or a cookie. | Identity 1, Disk 7, Web Disk 3, Web Logging 3 |
| `STORAGE_WRITE_FAILED` | ERROR | Android, iOS, web | | per_page | An event or a store could not be written, for example on a full disk; dropped events count as `storage_error`. Web: a chunk, a record or a cookie. | Disk 4, Logging 2, Web Logging 3 |
| `CORRUPT_LINE` | ERROR | Android, iOS, web | | per_page | A stored event line was corrupt and was skipped (`corrupt`). Web: a line of a chunk. | Disk 5, Web Disk 5, Web Logging 3 |
| `UNREADABLE_SEGMENT` | ERROR | Android, iOS | - | - | A segment could not be read; it is deleted after three consecutive failures. | Disk 5, Web Disk 5 |
| `UNKNOWN_FILE` | WARN | Android, iOS, web | | per_page | A file in the events directory that does not match the naming scheme was deleted. Web: a malformed chunk key under the exact prefix was deleted. | Disk 5, Web Disk 2, Web Logging 3 |
| `STORAGE_UNAVAILABLE` | WARN | web | | per_page | Storage cannot be used at start; the SDK runs from memory. | Web Disk 4, Web Logging 2, 3 |

## Dropped events

Each drop reason without a code of its own above (`CORRUPT_LINE`, `STORAGE_WRITE_FAILED`) or elsewhere
(`HOOK_THREW`, `HOOK_VIOLATION` for `before_send`) has one here; the event counts per reason are in
`dropped` (Queue 5, Logging 5).

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `QUEUE_FULL` | WARN | Android, iOS, web | | per_24h | More than 1000 events were pending; the oldest were dropped (`queue_full`). Web: also over the 1 MiB storage budget. | Queue 5, Web Queue 6, Web Logging 2 |
| `EVENTS_EXPIRED` | WARN | Android, iOS, web | | per_24h | Events older than 3 days were deleted unsent (`expired`). | Queue 5, Web Logging 2 |
| `API_KEY_CHANGED` | WARN | Android, iOS | - | - | Events tracked with another API key were deleted at startup (`api_key_changed`). | Disk 2c, Web Identity 4 |
| `BACKPRESSURE` | WARN | Android, iOS, web | | per_page | The write channel was full and an event was dropped (`backpressure`). Web: the bounded call queue of the writer. | Queue 1, Web Queue 1 |
| `EVENT_OVERSIZE` | WARN | Android, iOS, web | | per_page | A serialized event was larger than 32 KB and was dropped (`oversize`). | Serialization 3, Web Serialization 1 |
| `BATCH_REJECTED` | WARN | Android, iOS, web | | per_page | The server rejected a batch as malformed (400, 422 or another 4xx of group D); it was deleted (`rejected`). | Retry 1 |
| `RETRY_EXHAUSTED` | WARN | Android, iOS, web | | per_page | A batch failed 10 times while other batches were accepted; it was deleted (`retry_exhausted`). Web: a chunk, by the poison rule. | Retry 3, Web Retry 1 |
| `PAGE_CLOSED` | WARN | web | | per_page | Events accepted but not yet written when the page closed were dropped (`page_closed`). Counting is best-effort: nothing is counted while pending or refused, in the memory-only mode, when the tab is killed without `pagehide` or on a quota error. | Web Queue 1, Web Logging 3 |

## Upload

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `HOST_BLOCKED` | WARN | Android, iOS | - | - | The host resolves to a local address, as ad blockers and private DNS do. | HTTP 6, Web HTTP 3 |
| `HTTP_REDIRECT` | ERROR | Android, iOS, web | | per_page | The host answered with a redirect; `host` must be set to the final URL. Web: an `opaqueredirect` response, without the target; also an upload answered with a 3xx other than 304 that `fetch` does not report as a redirect (300 and other 3xx), logged by the retry policy with its status (group E); a 304 to an upload is group E without a line, as on Android and iOS. | HTTP 5, Retry 1, Web HTTP 3 |
| `TLS_FAILED` | ERROR | Android, iOS | - | - | The TLS handshake failed, for example on an untrusted certificate. | HTTP 4, Retry 1, Web Logging 3 |
| `HTTP_UNEXPECTED` | ERROR | Android, iOS, web | | per_page | The HTTP stack threw an unexpected exception. Web: comes with a pause local to the page. | HTTP 4, Retry 1, Web Retry 4, Web Logging 3 |
| `UPLOAD_UNAUTHORIZED` | ERROR | Android, iOS, web | | per_page | The server rejected the API key (401, 403). | Retry 1 |
| `UPLOAD_ENDPOINT_MISSING` | ERROR | Android, iOS, web | | per_page | The endpoint does not exist (404, 410); `host` is probably wrong. | Retry 1 |
| `UPLOAD_TOO_LARGE` | ERROR | Android, iOS, web | | per_page | A gateway rejected the request size (413). | Retry 1, 4 |
| `UPLOAD_NOT_SUPPORTED` | ERROR | Android, iOS, web | | per_page | The server does not support the request (501, 505). | Retry 1 |
| `COMPRESSION_FAILED` | WARN | Android, iOS, web | | per_page | Compressing a request failed; it was sent uncompressed. | HTTP 2, Web HTTP 2 |
| `CSP_BLOCKED` | ERROR | web | | per_page | A Content Security Policy blocked a request to the host (`securitypolicyviolation`). | Web HTTP 3, Web Logging 3 |
| `UPLOAD_FAILED_OPAQUE` | WARN | web | | per_24h | An upload failed with an error the browser does not explain: CORS, CSP, an ad blocker or a certificate. Uploads only; the configuration request keeps `REMOTE_CONFIG_FAILED`. | Web HTTP 3, Web Logging 2, 3 |

## Network

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `NETWORK_STATE_PERMISSION_MISSING` | WARN | Android | - | - | The app removed `ACCESS_NETWORK_STATE`; connectivity is assumed. | Retry 6, Logging 2, Web Retry 2 |
| `NETWORK_CALLBACK_FAILED` | WARN | Android | - | - | Registering the network callback failed; connectivity is queried before each flush. | Retry 6 |
| `INVALID_CAPTURE_HOST` | WARN | Android, iOS, web | | per_page | A host pattern of `RubiconNetworkInterceptor` is invalid (a scheme, path, port, or a wildcard other than a leading `*.` followed by two labels); it was ignored. Throws when `debug` is on. Web: a host of `createTrackedFetch`; a developer error, never thrown. | Privacy 5c, Web Lifecycle 6 |

## Lifecycle

| Code | Level | Platform | Web level | Frequency | Meaning | Decision |
|---|---|---|---|---|---|---|
| `LIFECYCLE_UNAVAILABLE` | WARN | Android | - | - | Neither `ProcessLifecycleOwner` nor the activity counter that replaces it could observe the app's foreground (no `Application`); no lifecycle events, sessions or background flush. | Lifecycle 2 |
| `SWIZZLE_FAILED` | WARN | iOS | - | - | The `viewDidAppear` swizzle could not be installed (class or selector not found); automatic screen views are absent. | iOS Lifecycle 1 |
