/** The two requests of the contract: `POST {host}/v1/batch` and `GET {host}/v1/config` (Web HTTP 1). */
export type HttpMethod = 'GET' | 'POST';

/**
 * One request to the configured host. The core builds it whole, the SDK's own headers included; the
 * transport adds only what the platform decides (compression, Web HTTP 2).
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The uncompressed JSON text of a `POST`; absent for a `GET`. */
  readonly body?: string;
  /**
   * The request must survive the page (`fetch` with `keepalive`): the uploader sets it for a body
   * within the keepalive budget (Web Queue 5).
   */
  readonly keepalive: boolean;
}

/**
 * Why no HTTP status arrived (Web HTTP 3). The web has no `dns`, `tls`, `blocked` or `cancelled`:
 * `fetch` reports all of them as the same `TypeError`.
 */
export type FailureKind = 'timeout' | 'connect' | 'io' | 'unexpected';

/**
 * The outcome of one attempt (HTTP 4): the transport reports, the retry policy decides. Step 5.1 adds
 * the classification of real responses and the `Retry-After` parsing.
 */
export type HttpResult =
  | {
      readonly kind: 'success';
      readonly status: number;
      /** The body of a configuration answer; an upload's success body is never read (Retry 4). */
      readonly body?: string;
      readonly etag?: string;
    }
  | {
      readonly kind: 'http-error';
      readonly status: number;
      /** At most 4 KB of the error body; never logged. */
      readonly body?: string;
      /** `Retry-After` in milliseconds, when the backend exposes it (Web HTTP 4). */
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'network-failure';
      readonly failure: FailureKind;
    };

/** A request in flight. */
export interface HttpCall {
  /**
   * Stops waiting for the request: unless the result was reported already, it is reported as a
   * `timeout` failure on a later turn and a later answer is ignored. The transport cancels the
   * request itself where the platform can. The uploader's own 45-second watchdog uses it where
   * `AbortController` is missing (Web HTTP 1).
   */
  abort(): void;
}

/**
 * Sends one request, once, and reports what happened (Web HTTP 1, 3). It never throws, and every
 * failure is a result: `onResult` is called exactly once, never synchronously inside `send`, and is
 * not expected to throw. The result arrives by callback rather than as a Promise so that the core
 * owns no Promise chain that could reject into the host (root `CLAUDE.md`, non-negotiable 1), and so
 * that tests deliver it on the virtual-time scheduler.
 */
export interface HttpTransport {
  send(request: HttpRequest, onResult: (result: HttpResult) => void): HttpCall;
}
