import type { Log } from '../log/log';
import type { Clock } from '../platform/clock';
import type { HttpCall, HttpOutcome, HttpRequest, HttpTransport } from '../platform/http-transport';
import type { NetworkSignal } from '../platform/network-signal';
import type { UrlParser } from '../platform/page';
import type { Scheduler } from '../platform/scheduler';
import { classifyOutcome } from './classify';
import { headerValue, REQUEST_ID } from './headers';
import type { HttpResult } from './http-result';

/**
 * The whole-request limit (HTTP 3, Web HTTP 1): `fetch` has no connect or read split, and 45 s is
 * Android's whole-request watchdog. Internal (Configuration 2).
 */
export const REQUEST_TIMEOUT_MS = 45_000;

/** What an {@link HttpClient} is made of: parts of the `Platform` and the instance's `Log`. */
export interface HttpClientOptions {
  readonly transport: HttpTransport;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly network: NetworkSignal;
  readonly urls: UrlParser;
  readonly log: Log;
}

/**
 * Sends the SDK's requests through the platform's `HttpTransport` and reports one classified
 * {@link HttpResult} per request (Web HTTP 1, 3): the core's half of the Android
 * `HttpURLConnectionTransport`, which `fetch` in `web` (step 7.3) does not repeat.
 *
 * - One attempt, never a retry; the uploader decides on a `keepalive-refused` and Retry on the rest.
 * - The 45-second deadline is the core's: when it passes, the result is a `timeout`, the transport is
 *   asked to abort, and whatever it reports later is ignored, so a browser without `AbortController`
 *   behaves the same (Web HTTP 1).
 * - `onResult` is called exactly once and never inside `send`; nothing throws into the caller, a
 *   transport that throws included (`unexpected`).
 * - `HTTP_REDIRECT` and `HTTP_UNEXPECTED` are logged here at ERROR; every request ends with one DEBUG
 *   line: method, endpoint, result, duration, bytes sent and the server's `X-Request-Id` when the
 *   page can read it (HTTP 6, Android log 5.1). Bodies, headers and the key never appear in a line.
 */
export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  send(request: HttpRequest, onResult: (result: HttpResult) => void): void {
    const { transport, scheduler, clock } = this.options;
    const started = clock.now();
    let done = false;
    let inSend = true;
    let call: HttpCall | undefined;

    const finish = (result: HttpResult, outcome: HttpOutcome | undefined): void => {
      if (done) return;
      done = true;
      deadline.cancel();
      this.logResult(request, result, outcome, clock.now() - started);
      onResult(result);
    };
    const handle = (outcome: HttpOutcome): void => {
      if (done) return;
      const result = classifyOutcome(outcome, {
        method: request.method,
        keepalive: request.keepalive,
        online: this.options.network.isOnline(),
        now: clock.now(),
      });
      if (result.kind === 'http-error' && result.redirect === true) this.logRedirect(request);
      if (outcome.kind === 'rejected' && result.kind === 'network-failure' && result.failure === 'unexpected')
        this.logUnexpected(outcome.error);
      finish(result, outcome);
    };

    const deadline = scheduler.after(REQUEST_TIMEOUT_MS, () => {
      if (done) return;
      finish({ kind: 'network-failure', failure: 'timeout' }, undefined);
      try {
        call?.abort();
      } catch {
        // The result is reported; a transport that cannot abort only keeps its request open.
      }
    });
    try {
      call = transport.send(request, (outcome) => {
        // A late answer after the deadline, or a second report, changes nothing; an answer inside
        // `send` would break the contract, so it is moved to a later turn.
        if (done) return;
        if (inSend) {
          scheduler.yield(() => {
            handle(outcome);
          });
        } else {
          handle(outcome);
        }
      });
    } catch (error) {
      scheduler.yield(() => {
        handle({ kind: 'rejected', error });
      });
    }
    inSend = false;
  }

  private logRedirect(request: HttpRequest): void {
    const host = this.options.urls.parse(request.url)?.hostname ?? 'The host';
    // `redirect: "manual"` hides the target (Web HTTP 1), so the line cannot name it.
    this.options.log.error('HTTP_REDIRECT', () => `${host} answered with a redirect; set host to the final URL`);
  }

  private logUnexpected(error: unknown): void {
    this.options.log.error('HTTP_UNEXPECTED', () => 'The request failed with an unexpected error', { error });
  }

  private logResult(request: HttpRequest, result: HttpResult, outcome: HttpOutcome | undefined, elapsed: number): void {
    const response = outcome?.kind === 'response' ? outcome : undefined;
    const requestId = headerValue(response?.headers, REQUEST_ID);
    const sent = response?.sentBytes;
    this.options.log.debug(() => {
      const bytes = sent === undefined ? '' : `, ${String(sent)} bytes sent`;
      const id = requestId === undefined ? '' : ` (request id ${requestId})`;
      return `${request.method} ${endpoint(request)}: ${describe(result)} in ${String(Math.max(0, elapsed))} ms${bytes}${id}`;
    });
  }
}

// The contract has one request per method, so the endpoint names the path without the host's own
// path, which belongs to the configuration.
function endpoint(request: HttpRequest): string {
  return request.method === 'GET' ? '/v1/config' : '/v1/batch';
}

function describe(result: HttpResult): string {
  switch (result.kind) {
    case 'success':
      return String(result.status);
    case 'http-error':
      return result.redirect === true ? 'redirect' : String(result.status);
    case 'network-failure':
      return result.failure;
    case 'keepalive-refused':
      return 'keepalive refused';
  }
}
