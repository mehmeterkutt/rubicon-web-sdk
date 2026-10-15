/**
 * Why no HTTP status arrived (Web HTTP 3). The web has no `dns`, `tls`, `blocked` or `cancelled`:
 * `fetch` reports all of them as the same `TypeError`.
 */
export type FailureKind = 'timeout' | 'connect' | 'io' | 'unexpected';

/**
 * The outcome of one attempt, classified (HTTP 4, Web HTTP 3): the core's `HttpClient` reports, the
 * retry policy and the uploader decide.
 */
export type HttpResult =
  | {
      /** A 2xx, or a 304 to the configuration request (unchanged, Android log 5.1). */
      readonly kind: 'success';
      readonly status: number;
      /** The body of a configuration answer, at most 64 KB; an upload's success body is never read (Retry 4). */
      readonly body?: string;
      /** The `ETag` of a configuration answer. */
      readonly etag?: string;
    }
  | {
      /** Any other status, or a redirect. */
      readonly kind: 'http-error';
      /** The HTTP status; `0` for a redirect, whose status the page cannot see. */
      readonly status: number;
      /**
       * `true` for an `opaqueredirect` (Web HTTP 1, 3): a configuration problem (group E,
       * `HTTP_REDIRECT`), without the target.
       */
      readonly redirect?: boolean;
      /** At most 4 KB of the error body; never logged. */
      readonly body?: string;
      /** `Retry-After` in milliseconds, when the backend exposes it (Web HTTP 4). */
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'network-failure';
      readonly failure: FailureKind;
    }
  | {
      /**
       * A `TypeError` on a `keepalive` request while online (Web HTTP 3): a recovery case, not a
       * diagnosis. While the page lives the uploader tries once without `keepalive`; on the
       * `pagehide` path it does not, the chunks stay and nothing is written (Web Retry 4).
       */
      readonly kind: 'keepalive-refused';
    };
