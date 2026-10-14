import type { HttpCall, HttpRequest, HttpResult, HttpTransport, Scheduler } from 'rubicon-analytics-core';

/**
 * A scripted answer with the time it takes: `delayMs` on the scheduler, `Infinity` for an answer that
 * never comes (until the request is aborted).
 */
export interface DelayedResult {
  readonly result: HttpResult;
  readonly delayMs: number;
}

/** One `send`, as the transport received it. */
export interface SentRequest {
  readonly request: HttpRequest;
  /** Whether the core aborted it before its result was reported. */
  readonly aborted: boolean;
}

/** The answer when the script is empty: a 2xx without a body. */
export const SUCCESS: HttpResult = { kind: 'success', status: 200 };

/**
 * Returns scripted results in order and records every request, the counterpart of the Android and
 * iOS `FakeTransport`. Results arrive on the scheduler, never inside `send`, as `fetch` settles
 * later; once the script is used up every request gets `whenEmpty`. An abort reports a `timeout`
 * failure on the next turn and drops the scripted answer, as the `HttpTransport` contract says.
 */
export class FakeTransport implements HttpTransport {
  /** Requests whose result has not been reported yet. */
  inFlight = 0;

  private readonly script: DelayedResult[] = [];
  private readonly sent: { request: HttpRequest; aborted: boolean }[] = [];

  constructor(
    private readonly scheduler: Scheduler,
    private readonly whenEmpty: HttpResult = SUCCESS,
  ) {}

  /** Every request received, oldest first. */
  get requests(): readonly HttpRequest[] {
    return this.sent.map((entry) => entry.request);
  }

  /** Every request with whether it was aborted, oldest first. */
  get calls(): readonly SentRequest[] {
    return this.sent.map((entry) => ({ request: entry.request, aborted: entry.aborted }));
  }

  /** Appends answers to the script; a bare result arrives on the next turn. */
  enqueue(...answers: readonly (HttpResult | DelayedResult)[]): void {
    for (const answer of answers) this.script.push('result' in answer ? answer : { result: answer, delayMs: 0 });
  }

  send(request: HttpRequest, onResult: (result: HttpResult) => void): HttpCall {
    const entry = { request, aborted: false };
    this.sent.push(entry);
    this.inFlight += 1;
    const answer = this.script.shift() ?? { result: this.whenEmpty, delayMs: 0 };
    let reported = false;
    const report = (result: HttpResult): void => {
      if (reported) return;
      reported = true;
      this.inFlight -= 1;
      onResult(result);
    };
    const pending =
      answer.delayMs === Infinity
        ? undefined
        : this.scheduler.after(answer.delayMs, () => {
            report(answer.result);
          });
    return {
      abort: () => {
        if (reported || entry.aborted) return;
        entry.aborted = true;
        pending?.cancel();
        this.scheduler.yield(() => {
          report({ kind: 'network-failure', failure: 'timeout' });
        });
      },
    };
  }
}
