import type {
  Clock,
  HttpCall,
  HttpOutcome,
  HttpRequest,
  HttpTransport,
  Platform,
  ScheduledTask,
  Scheduler,
} from 'rubicon-analytics-core';
import type { TestPlatform } from './test-platform';

// The real-time parts of the component integration layer (plan section 5): the core over the
// in-memory storage and cookies of `TestPlatform`, with the wall clock, real timers and Node's own
// `fetch` against the `TestServer`. Unit tests never use them; they wait in real time.

/** `Date.now()`, the browser's `Clock`. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * `setTimeout` as the `Scheduler`, `yield` a zero-delay timer. Timers are unreferenced, so one left
 * behind by a test never keeps Node running; {@link cancelAll} clears what is still waiting.
 */
export class TimerScheduler implements Scheduler {
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();

  after(delayMs: number, task: () => void): ScheduledTask {
    const handle = setTimeout(
      () => {
        this.pending.delete(handle);
        task();
      },
      Math.max(0, delayMs),
    );
    handle.unref();
    this.pending.add(handle);
    return {
      cancel: () => {
        clearTimeout(handle);
        this.pending.delete(handle);
      },
    };
  }

  yield(task: () => void): ScheduledTask {
    return this.after(0, task);
  }

  /** Cancels every timer still waiting. */
  cancelAll(): void {
    this.pending.forEach((handle) => {
      clearTimeout(handle);
    });
    this.pending.clear();
  }
}

/**
 * Node's `fetch` as the `HttpTransport`: the request as the core built it, uncompressed, redirects
 * not followed, and the outcome reported once on a later turn. Not the browser transport of step
 * 7.3, which adds `keepalive`, gzip and the CORS options; enough to carry the core's requests to the
 * test server over a real socket.
 */
export class NodeFetchTransport implements HttpTransport {
  send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
    const controller = new AbortController();
    const answered = fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: controller.signal,
    }).then(async (response): Promise<HttpOutcome> => {
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const body = await response.text();
      return { kind: 'response', status: response.status, headers, body };
    });
    // One outcome, a failure while reading the body included; no rejection is left unhandled.
    answered.then(onOutcome, (error: unknown) => {
      onOutcome({ kind: 'rejected', error });
    });
    return {
      abort: () => {
        controller.abort();
      },
    };
  }
}

/** The platform of `test` with the wall clock, real timers and Node's `fetch`. */
export function realTimePlatform(
  test: TestPlatform,
  parts: { readonly scheduler: TimerScheduler; readonly transport?: HttpTransport },
): Platform {
  return {
    ...test.platform,
    clock: new SystemClock(),
    scheduler: parts.scheduler,
    transport: parts.transport ?? new NodeFetchTransport(),
  };
}
