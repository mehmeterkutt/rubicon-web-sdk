import type { HttpResult } from '../http/http-result';

/**
 * The groups of Retry 1, asked of every upload result: is the problem in this batch or somewhere
 * else? Only `bad-batch` deletes a batch the server did not accept. `unknown` is the web's addition
 * (Web Retry 4c, the counterpart of the iOS `interrupted`): an outcome that says nothing about the
 * server, which writes nothing.
 *
 * - `success` (A): 2xx; delete the batch.
 * - `transient` (B): `timeout`, `connect`, `io`; 408; 5xx except 501, 505 and a 503 with
 *   `Retry-After`; 1xx and non-standard codes. Keep, back off.
 * - `throttle` (C): 429; 503 with `Retry-After`. Keep, pause every page of the host.
 * - `bad-batch` (D): 400, 422 and every other 4xx not listed elsewhere. Delete, counted `rejected`.
 * - `config` (E): 401, 403, 404, 410, 413, 3xx (a redirect included), 501, 505; `unexpected`. Keep,
 *   pause an hour, ERROR once.
 * - `unknown`: a refused `keepalive` request (Web HTTP 3); the uploader decides what follows.
 */
export type RetryGroup = 'success' | 'transient' | 'throttle' | 'bad-batch' | 'config' | 'unknown';

/** One `switch` over the result (Retry 1, 4; Web Retry 4). */
export function retryGroupOf(result: HttpResult): RetryGroup {
  switch (result.kind) {
    case 'success':
      return 'success';
    case 'keepalive-refused':
      return 'unknown';
    case 'network-failure':
      return result.failure === 'unexpected' ? 'config' : 'transient';
    case 'http-error':
      return result.redirect === true ? 'config' : groupOfStatus(result.status, result.retryAfterMs !== undefined);
  }
}

function groupOfStatus(status: number, hasRetryAfter: boolean): RetryGroup {
  if (status >= 200 && status <= 299) return 'success';
  if (status === 429) return 'throttle';
  if (status === 503) return hasRetryAfter ? 'throttle' : 'transient';
  if (CONFIG_STATUSES.indexOf(status) >= 0 || (status >= 300 && status <= 399)) return 'config';
  if (status === 408) return 'transient';
  if (status >= 400 && status <= 499) return 'bad-batch';
  // 5xx, and 1xx and non-standard codes.
  return 'transient';
}

const CONFIG_STATUSES: readonly number[] = [401, 403, 404, 410, 413, 501, 505];
