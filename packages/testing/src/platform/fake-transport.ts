import type { HttpCall, HttpOutcome, HttpRequest, HttpTransport, Scheduler } from 'rubicon-analytics-core';
import { abortError } from './dom-exception';

/**
 * A scripted outcome with the time it takes: `delayMs` on the scheduler, `Infinity` for an answer
 * that never comes (until the request is aborted).
 */
export interface DelayedOutcome {
  readonly outcome: HttpOutcome;
  readonly delayMs: number;
}

/** One `send`, as the transport received it. */
export interface SentRequest {
  readonly request: HttpRequest;
  /** Whether the core aborted it before its outcome was reported. */
  readonly aborted: boolean;
}

/** What a scripted response carries besides its status. */
export interface ResponseOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly sentBytes?: number;
}

/** A response with `status`, as `fetch` resolves. */
export function responseOutcome(status: number, options: ResponseOptions = {}): HttpOutcome {
  return { kind: 'response', status, ...options };
}

/** A redirect under `redirect: "manual"`: `type: "opaqueredirect"`, status 0, no headers or body. */
export function opaqueRedirectOutcome(): HttpOutcome {
  return { kind: 'response', status: 0, opaqueRedirect: true };
}

/** A rejection with `error`, as `fetch` rejects. */
export function rejectedOutcome(error: unknown): HttpOutcome {
  return { kind: 'rejected', error };
}

/** The `TypeError` `fetch` rejects with for every network, CORS, CSP or blocker failure (Web HTTP 3). */
export function fetchTypeError(): TypeError {
  return new TypeError('Failed to fetch');
}

/** The answer when the script is empty: a 200 without a body. */
export const SUCCESS: HttpOutcome = { kind: 'response', status: 200 };

/**
 * Returns scripted outcomes in order and records every request, the counterpart of the Android and
 * iOS `FakeTransport`, one level lower: it scripts what `fetch` gives, and the core classifies it.
 * Outcomes arrive on the scheduler, never inside `send`, as `fetch` settles later; once the script is
 * used up every request gets `whenEmpty`. An abort drops the scripted answer and rejects with an
 * `AbortError` on the next turn, as `fetch` does when its `AbortController` aborts.
 */
export class FakeTransport implements HttpTransport {
  /** Requests whose outcome has not been reported yet. */
  inFlight = 0;

  private readonly script: DelayedOutcome[] = [];
  private readonly sent: { request: HttpRequest; aborted: boolean }[] = [];

  constructor(
    private readonly scheduler: Scheduler,
    private readonly whenEmpty: HttpOutcome = SUCCESS,
  ) {}

  /** Every request received, oldest first. */
  get requests(): readonly HttpRequest[] {
    return this.sent.map((entry) => entry.request);
  }

  /** Every request with whether it was aborted, oldest first. */
  get calls(): readonly SentRequest[] {
    return this.sent.map((entry) => ({ request: entry.request, aborted: entry.aborted }));
  }

  /** Appends answers to the script; a bare outcome arrives on the next turn. */
  enqueue(...answers: readonly (HttpOutcome | DelayedOutcome)[]): void {
    for (const answer of answers) this.script.push('outcome' in answer ? answer : { outcome: answer, delayMs: 0 });
  }

  send(request: HttpRequest, onOutcome: (outcome: HttpOutcome) => void): HttpCall {
    const entry = { request, aborted: false };
    this.sent.push(entry);
    this.inFlight += 1;
    const answer = this.script.shift() ?? { outcome: this.whenEmpty, delayMs: 0 };
    let reported = false;
    const report = (outcome: HttpOutcome): void => {
      if (reported) return;
      reported = true;
      this.inFlight -= 1;
      onOutcome(outcome);
    };
    const pending =
      answer.delayMs === Infinity
        ? undefined
        : this.scheduler.after(answer.delayMs, () => {
            report(answer.outcome);
          });
    return {
      abort: () => {
        if (reported || entry.aborted) return;
        entry.aborted = true;
        pending?.cancel();
        this.scheduler.yield(() => {
          report({ kind: 'rejected', error: abortError() });
        });
      },
    };
  }
}
