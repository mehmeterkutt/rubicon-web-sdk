/** The two requests of the contract: `POST {host}/v1/batch` and `GET {host}/v1/config` (Web HTTP 1). */
export type HttpMethod = 'GET' | 'POST';

/**
 * One request to the configured host, built whole by the core (`batchRequest`, `configRequest`),
 * the SDK's own headers included; the transport adds only what the platform decides: compression
 * and its `Content-Encoding` (Web HTTP 2).
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
  /**
   * Whether the body may be gzipped (Web HTTP 2): `false` for a request started while the page goes
   * away, which is sent uncompressed and started synchronously, and for a `GET`. The transport
   * compresses only where the browser can (`CompressionStream`, not Safari 16.4 or 16.5).
   */
  readonly compress: boolean;
}

/**
 * What the platform's HTTP stack gave for one request, unclassified: the core turns it into an
 * `HttpResult` with the table of Web HTTP 3 (`classifyOutcome`), so the table is the same for every
 * transport and is tested without a browser.
 */
export type HttpOutcome =
  | {
      readonly kind: 'response';
      /** The HTTP status; `0` with `opaqueRedirect`. */
      readonly status: number;
      /**
       * `fetch` gave `type: "opaqueredirect"`: a redirect under `redirect: "manual"`, status 0 and no
       * readable target (Web HTTP 1).
       */
      readonly opaqueRedirect?: boolean;
      /**
       * The response headers the page can read, names in any letter case: from another origin only
       * those the backend exposes (Web HTTP 4). The core reads `Retry-After`, `ETag` and
       * `X-Request-Id`.
       */
      readonly headers?: Readonly<Record<string, string>>;
      /**
       * The body text of an error status and of a `GET` success; never read for an upload's success
       * (Retry 4). The core keeps at most 4 KB of an error body and 64 KB of a configuration body;
       * the transport need not read more.
       */
      readonly body?: string;
      /** The body bytes as sent, after compression, for the DEBUG line (HTTP 6). */
      readonly sentBytes?: number;
    }
  | {
      readonly kind: 'rejected';
      /**
       * What `fetch` rejected with, or what the transport caught. The core tells the rows of Web HTTP
       * 3 apart by its `name`, compared as a string, and never logs it: it reaches only a developer's
       * logger, as the `error` of `HTTP_UNEXPECTED` (Web Logging 1).
       */
      readonly error: unknown;
    };

/** A request in flight. */
export interface HttpCall {
  /**
   * Cancels the request where the platform can (`AbortController`). The core calls it only at its
   * own 45-second deadline, after it has reported the `timeout` itself, and ignores whatever the
   * transport reports afterwards; a transport without a way to cancel may do nothing (Web HTTP 1).
   */
  abort(): void;
}

/**
 * Sends one request, once, and reports what happened (Web HTTP 1, 3). It never throws, and every
 * failure is an outcome: `onOutcome` is called exactly once, never synchronously inside `send`, and
 * is not expected to throw. The outcome arrives by callback rather than as a Promise so that the core
 * owns no Promise chain that could reject into the host (root `CLAUDE.md`, non-negotiable 1), and so
 * that tests deliver it on the virtual-time scheduler. The core's `HttpClient` owns the deadline and
 * the classification; nothing else calls a transport.
 */
export interface HttpTransport {
  send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall;
}
