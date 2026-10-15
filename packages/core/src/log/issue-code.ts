/**
 * The stable code of every WARN and ERROR line (Logging 1, 2; Web Logging 2, 3), with the level or
 * levels it is logged at on the web and its repeat frequency. The names are part of the backend
 * contract: `SDK Diagnostics` reports them in `issues` (Logging 5) and `docs/issue-codes.md`
 * documents each one. A code is never renamed or reused; a new situation gets a new code, added here
 * and to the catalogue together. A code the web never produces is not listed here and must not
 * appear in `src` (Web Logging 3); the catalogue test checks both.
 *
 * `per_page` logs a code at its level once per page load and later occurrences at `debug`;
 * `per_24h` once per device per sliding 24 hours, best-effort (Web Logging 2). Every occurrence is
 * counted, whatever the level.
 */
export const ISSUE_CODES = {
  // Logging

  /** The developer's logger threw or rejected; the default sink is used for the rest of the page. */
  LOGGER_THREW: { levels: ['warn'], frequency: 'per_page' },
  /** The developer's event observer threw or rejected; it is switched off for the rest of the page. */
  OBSERVER_THREW: { levels: ['error'], frequency: 'per_page' },
  /** A writer slice threw unexpectedly; the SDK keeps running (Web Logging 3). */
  WORKER_FAILED: { levels: ['error'], frequency: 'per_page' },

  // Configuration

  /** The API key is blank; the factory returns a no-op instance. */
  INVALID_API_KEY: { levels: ['error'], frequency: 'per_page' },
  /** The host is not a valid base URL; the factory returns a no-op instance. */
  INVALID_HOST: { levels: ['error'], frequency: 'per_page' },
  /** The host uses `http://`: an error on an `https` page (mixed content), a warning on an `http` page. */
  CLEARTEXT_HOST: { levels: ['warn', 'error'], frequency: 'per_page' },
  /** A numeric setting was out of bounds and was clamped to the nearest bound. */
  SETTING_OUT_OF_BOUNDS: { levels: ['warn'], frequency: 'per_page' },
  /** Settings of a group contradict each other; the group's defaults are used. */
  CONTRADICTING_SETTINGS: { levels: ['warn'], frequency: 'per_page' },
  /** A setting has the wrong type or a value outside its closed set; the default is used. */
  SETTING_WRONG_TYPE: { levels: ['warn'], frequency: 'per_page' },
  /** Another platform's setting was given; it is not applied. */
  SETTING_NOT_SUPPORTED: { levels: ['warn'], frequency: 'per_page' },
  /** `network.headers` tried to override a reserved header; it is ignored. */
  RESERVED_HEADER: { levels: ['warn'], frequency: 'per_page' },
  /** A second instance was created in the page; the first one is returned. */
  SECOND_INSTANCE: { levels: ['error'], frequency: 'per_page' },
  /** The remote configuration could not be fetched or read; the last valid values are kept. */
  REMOTE_CONFIG_FAILED: { levels: ['warn'], frequency: 'per_page' },
  /** A remote configuration value was invalid and is ignored. */
  REMOTE_CONFIG_INVALID_VALUE: { levels: ['warn'], frequency: 'per_page' },

  // Events and properties

  /** A property or trait was dropped: unsupported type, invalid key or too deep. */
  PROPERTY_DROPPED: { levels: ['warn'], frequency: 'per_page' },
  /** A string value was longer than 1024 code units and was truncated. */
  PROPERTY_TRUNCATED: { levels: ['warn'], frequency: 'per_page' },
  /** An event had more than 256 properties; the extra ones were dropped. */
  TOO_MANY_PROPERTIES: { levels: ['warn'], frequency: 'per_page' },
  /** An event or screen name was blank or longer than 255 code units; the event was dropped. */
  INVALID_EVENT_NAME: { levels: ['warn'], frequency: 'per_page' },
  /** A `beforeSend` hook threw; the event was dropped. */
  HOOK_THREW: { levels: ['error'], frequency: 'per_page' },
  /** A `beforeSend` hook returned what its rules do not allow; the event was dropped. */
  HOOK_VIOLATION: { levels: ['error'], frequency: 'per_page' },

  // Identity

  /** `identify` was called with a blank user id or one longer than 255 code units. */
  INVALID_USER_ID: { levels: ['warn'], frequency: 'per_page' },
  /** `identity.cookieDomain` is not a suffix of the host or was refused; cookies are host-only. */
  INVALID_COOKIE_DOMAIN: { levels: ['warn'], frequency: 'per_page' },

  // Storage

  /** A store record or cookie exists but cannot be read; it is left untouched. */
  STORE_UNREADABLE: { levels: ['warn'], frequency: 'per_page' },
  /** An event chunk, a store record or a cookie could not be written. */
  STORAGE_WRITE_FAILED: { levels: ['error'], frequency: 'per_page' },
  /** A stored event line was corrupt and was skipped. */
  CORRUPT_LINE: { levels: ['error'], frequency: 'per_page' },
  /** A malformed chunk key under the SDK's exact prefix was deleted. */
  UNKNOWN_FILE: { levels: ['warn'], frequency: 'per_page' },
  /** Storage cannot be used at start; the SDK runs from memory. */
  STORAGE_UNAVAILABLE: { levels: ['warn'], frequency: 'per_page' },

  // Dropped events

  /** More than 1000 events, or more than the storage budget, were pending; the oldest were dropped. */
  QUEUE_FULL: { levels: ['warn'], frequency: 'per_24h' },
  /** Events older than 3 days were deleted unsent. */
  EVENTS_EXPIRED: { levels: ['warn'], frequency: 'per_24h' },
  /** The bounded call queue was full; the event was dropped. */
  BACKPRESSURE: { levels: ['warn'], frequency: 'per_page' },
  /** A serialized event was larger than 32 KB; it was dropped. */
  EVENT_OVERSIZE: { levels: ['warn'], frequency: 'per_page' },
  /** The server rejected a batch as malformed; it was deleted. */
  BATCH_REJECTED: { levels: ['warn'], frequency: 'per_page' },
  /** A chunk kept failing while others were accepted; it was deleted. */
  RETRY_EXHAUSTED: { levels: ['warn'], frequency: 'per_page' },
  /** Events accepted but not yet written when the page closed were dropped; best-effort. */
  PAGE_CLOSED: { levels: ['warn'], frequency: 'per_page' },

  // Upload

  /** The host answered with a redirect; `host` must be set to the final URL. */
  HTTP_REDIRECT: { levels: ['error'], frequency: 'per_page' },
  /** The transport failed unexpectedly; this page pauses its uploads. */
  HTTP_UNEXPECTED: { levels: ['error'], frequency: 'per_page' },
  /** The server rejected the API key (401, 403). */
  UPLOAD_UNAUTHORIZED: { levels: ['error'], frequency: 'per_page' },
  /** The endpoint does not exist (404, 410); `host` is probably wrong. */
  UPLOAD_ENDPOINT_MISSING: { levels: ['error'], frequency: 'per_page' },
  /** A gateway rejected the request size (413). */
  UPLOAD_TOO_LARGE: { levels: ['error'], frequency: 'per_page' },
  /** The server does not support the request (501, 505). */
  UPLOAD_NOT_SUPPORTED: { levels: ['error'], frequency: 'per_page' },
  /** Compressing a request failed; it was sent uncompressed. */
  COMPRESSION_FAILED: { levels: ['warn'], frequency: 'per_page' },
  /** A Content Security Policy blocked a request to the host. */
  CSP_BLOCKED: { levels: ['error'], frequency: 'per_page' },
  /** An upload failed with an error the browser does not explain: CORS, CSP, an ad blocker, a certificate. */
  UPLOAD_FAILED_OPAQUE: { levels: ['warn'], frequency: 'per_24h' },

  // Network capture

  /** A host pattern of `createTrackedFetch` is invalid; it was ignored. */
  INVALID_CAPTURE_HOST: { levels: ['warn'], frequency: 'per_page' },
} as const;

/** The stable code of a WARN or ERROR line, its wire name in `SDK Diagnostics`. */
export type IssueCode = keyof typeof ISSUE_CODES;

/** How often a code is logged at its own level (Web Logging 2). */
export type IssueFrequency = (typeof ISSUE_CODES)[IssueCode]['frequency'];

/** The codes that may be logged at `level`: `log.warn` and `log.error` accept only these. */
export type IssueCodeAt<L extends 'warn' | 'error'> = {
  [C in IssueCode]: L extends (typeof ISSUE_CODES)[C]['levels'][number] ? C : never;
}[IssueCode];

/** Every code, in catalogue order. */
export function issueCodes(): IssueCode[] {
  return Object.keys(ISSUE_CODES) as IssueCode[];
}
