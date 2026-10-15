import { captureOf } from 'rubicon-analytics-core';
import type { Analytics, AutomaticCapture } from 'rubicon-analytics-core';
import { parseHostPatterns } from './host-patterns';
import type { HostPatterns } from './host-patterns';
import { NETWORK_REQUEST, networkRequestProperties, requestBytesOf } from './network-request';
import type { FetchOutcome, TrackedRequest } from './network-request';

// `createTrackedFetch` (Web Lifecycle 6), the counterpart of the Android `RubiconNetworkInterceptor`:
// a function with the signature of `fetch` that the application installs in its own client. The SDK
// never assigns `fetch` or `XMLHttpRequest` (rule `replace-transport`).
//
// Behaviour equivalence is the contract. The base `fetch` gets the caller's arguments as they are, so
// the same `AbortSignal` takes effect; a captured call returns the one chain
// `original.then(record and return the response, record and rethrow the error)`, so a 4xx or 5xx is
// the same `Response` and a rejection the same error object, with no second branch that could leave
// a rejection unhandled. Everything the SDK does runs in `try/catch` and never affects the request.
// The gate is read at the start, so nothing is measured while capture is off, and again before the
// event is made, so a request that completes after a remote switch-off or an opt-out produces
// nothing.

/** The options of {@link createTrackedFetch}. */
export interface TrackedFetchOptions {
  /**
   * The hosts whose requests are captured: an exact host name (`api.shop.example.com`) or a leading
   * wildcard for every subdomain (`*.shop.example.com`, which does not match `shop.example.com`
   * itself), ignoring case. Nothing else is captured. An invalid entry (a scheme, a path, a port, a
   * wildcard such as `*.com`) is ignored with the warning `INVALID_CAPTURE_HOST`.
   */
  readonly hosts: readonly string[];

  /**
   * Whether path segments that are all digits, a UUID or hexadecimal longer than 16 characters are
   * sent as `:id`. Default `true`; only `false` switches it off.
   */
  readonly maskPathIds?: boolean;

  /**
   * The `fetch` the tracked function calls. By default the page's `fetch` is read at every call, so a
   * polyfill or another tool's wrapper installed later stays in effect.
   */
  readonly fetch?: typeof fetch;
}

/**
 * Returns a function with the signature of `fetch` that sends a `Network Request` event for each
 * request to the hosts you choose (an automatic event, `source: "auto"`). Use it in your own HTTP
 * client; the SDK never replaces the page's `fetch` or `XMLHttpRequest`, so code that calls them
 * directly, and clients built on `XMLHttpRequest`, are not captured.
 *
 * - **Sent**: `method`, `url` and `path` without query or fragment, `host`, `status_code` (absent
 *   when the request failed), `error` (`canceled`, `timeout`, `network` or `unknown`, never a
 *   message), `duration_ms` to the response headers, `request_bytes` (only for a `Blob`,
 *   `ArrayBuffer` or typed array body) and `response_bytes` (from `Content-Length`) when known.
 * - **Never sent**: headers, bodies, query parameters, fragments. Bodies are never read or cloned.
 * - **Unchanged**: the request goes to `fetch` with your arguments as they are; you get the same
 *   `Response` (a 404 or 500 is not turned into an error), and a rejection is the same error object.
 * - **Passed through** without measuring when `network_requests` is not in `autocapture.enabled` or
 *   was switched off remotely (at once), while the user is opted out or consent is pending, for the
 *   SDK's own host, for other hosts, and when `analytics` is not an instance made by
 *   `createAnalytics`, such as {@link createNoOpAnalytics} or a test double.
 * - It never throws anything `fetch` did not throw.
 *
 * @param analytics - The instance returned by `createAnalytics`.
 * @param options - The hosts to capture, and optionally the masking switch and the base `fetch`.
 * @returns A function to use wherever you would call `fetch`.
 *
 * @example
 * ```ts
 * import { createAnalytics, createTrackedFetch } from 'rubicon-analytics';
 *
 * const analytics = createAnalytics({ apiKey: 'your-publishable-key' });
 * const trackedFetch = createTrackedFetch(analytics, { hosts: ['api.shop.example.com', '*.cdn.shop.example.com'] });
 *
 * const response = await trackedFetch('https://api.shop.example.com/orders/4521');
 *
 * // axios 1.12 or later, with its fetch adapter:
 * const client = axios.create({ adapter: 'fetch', env: { fetch: trackedFetch } });
 * ```
 */
export function createTrackedFetch(analytics: Analytics, options: TrackedFetchOptions): typeof fetch {
  const settings = readOptions(analytics, options);
  // The caller's arguments are passed on as they are, however many there are.
  return function trackedFetch(...args: unknown[]): Promise<Response> {
    const base = settings.base ?? pageFetch();
    const recording = settings.tracker?.begin(args[0], args[1]);
    // The base `fetch` is called as the page would call it, with the window as `this` ("Illegal
    // invocation" otherwise); a synchronous throw reaches the caller as it would without the SDK.
    // A missing `fetch` throws the `TypeError` calling it would.
    const original: unknown = Reflect.apply(base as (...given: unknown[]) => unknown, windowOrUndefined(), args);
    if (recording === undefined || !isThenable(original)) return original as Promise<Response>;
    return original.then(
      (response: Response) => {
        recording.end({ kind: 'response', response });
        return response;
      },
      (error: unknown) => {
        recording.end({ kind: 'error', error });
        throw error;
      },
    );
  };
}

/** The settings read once, when the tracked function is made. */
interface Settings {
  readonly base: unknown;
  readonly tracker: Tracker | undefined;
}

/** One captured request, from the call to the outcome. */
interface Recording {
  end(outcome: FetchOutcome): void;
}

interface Tracker {
  /** A recording when the request is captured, read at the start; `undefined` to pass through. */
  begin(input: unknown, init: unknown): Recording | undefined;
}

// Nothing here throws: options that cannot be read give a pass-through.
function readOptions(analytics: Analytics, options: TrackedFetchOptions): Settings {
  let base: unknown;
  let tracker: Tracker | undefined;
  try {
    const given: unknown = options;
    const record = typeof given === 'object' && given !== null ? given : {};
    const fetchOption: unknown = Reflect.get(record, 'fetch');
    if (typeof fetchOption === 'function') base = fetchOption;
    const capture = captureOf(analytics);
    const patterns = parseHostPatterns(Reflect.get(record, 'hosts'), capture?.log);
    if (capture !== undefined) {
      tracker = createTracker(capture, patterns, Reflect.get(record, 'maskPathIds') !== false);
    }
  } catch {
    // A throwing getter on the options: the function passes every request through.
  }
  return { base, tracker };
}

/**
 * The capture of one tracked function, over the instance's {@link AutomaticCapture}; exported for
 * the unit tests, which give it a fake capture as Android's tests give the interceptor a fake SDK.
 */
export function createTracker(capture: AutomaticCapture, patterns: HostPatterns, masking: boolean): Tracker {
  return {
    begin(input, init) {
      let request: TrackedRequest | undefined;
      let start = 0;
      try {
        // The flag first: a pass-through while capture is off costs one read (Web Lifecycle 6).
        if (!capture.capturesNetworkRequests) return undefined;
        request = resolveRequest(input, init);
        if (request === undefined) return undefined;
        const host = request.url.hostname;
        if (host === '' || host === capture.sdkHost.toLowerCase() || !patterns.matches(host)) return undefined;
        start = capture.now();
      } catch {
        return undefined;
      }
      const captured = request;
      return {
        end(outcome) {
          try {
            // The second read: a switch-off or an opt-out during the request sends nothing.
            if (!capture.capturesNetworkRequests) return;
            const duration = capture.now() - start;
            capture.track(
              'network_requests',
              NETWORK_REQUEST,
              networkRequestProperties(captured, outcome, duration, masking),
            );
          } catch {
            // The event is lost; the application's request is unaffected.
          }
        },
      };
    },
  };
}

/**
 * The method, the resolved URL and the declared body size of a `fetch` call (Web Lifecycle 6), or
 * `undefined` when the request cannot be read without running the application's code: `input` is a
 * string, a `URL` or a `Request` (told by `Object.prototype.toString`, so one of another frame
 * counts), and anything else passes through. The method is `init.method`, else the `Request`'s, else
 * `GET`, upper-cased; a relative URL is resolved against `location.href`.
 */
export function resolveRequest(input: unknown, init: unknown): TrackedRequest | undefined {
  const options = typeof init === 'object' && init !== null ? init : undefined;
  let text: string;
  let requestMethod: unknown;
  if (typeof input === 'string') {
    text = input;
  } else {
    const tag = Object.prototype.toString.call(input);
    if (tag === '[object URL]') {
      text = String(Reflect.get(input as object, 'href'));
    } else if (tag === '[object Request]') {
      text = String(Reflect.get(input as object, 'url'));
      requestMethod = Reflect.get(input as object, 'method');
    } else {
      return undefined;
    }
  }
  const url = resolveUrl(text);
  if (url === undefined) return undefined;
  const initMethod: unknown = options === undefined ? undefined : Reflect.get(options, 'method');
  const method =
    typeof initMethod === 'string' ? initMethod : typeof requestMethod === 'string' ? requestMethod : 'GET';
  // A body given in `init` replaces the `Request`'s, whose size is never known without reading it.
  const body: unknown = options === undefined ? undefined : Reflect.get(options, 'body');
  return { method: method.toUpperCase(), url, requestBytes: requestBytesOf(body) };
}

// `location.href` is read at every call, as `fetch` resolves against the document's current URL.
function resolveUrl(text: string): URL | undefined {
  try {
    return typeof location === 'undefined' ? new URL(text) : new URL(text, location.href);
  } catch {
    return undefined;
  }
}

// The page's `fetch` now, read at every call (Web Lifecycle 6). Through `window` in a page, where
// `globalThis` (ES2020, above the floor of Web Public API 6) is the same object; outside a page, the
// global `fetch` of the environment.
function pageFetch(): unknown {
  return typeof window === 'undefined' ? fetch : Reflect.get(window, 'fetch');
}

function windowOrUndefined(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

function isThenable(value: unknown): value is Promise<Response> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}
