import type { HttpOutcome, HttpRequest } from 'rubicon-analytics-core';
import { describe, expect, it } from 'vitest';
import {
  FakeTransport,
  fetchTypeError,
  opaqueRedirectOutcome,
  rejectedOutcome,
  responseOutcome,
  TestScheduler,
} from '../src';

const batch: HttpRequest = {
  method: 'POST',
  url: 'https://api.rubicon.example/v1/batch',
  headers: { 'Content-Type': 'application/json' },
  body: '{"sent_at":0,"batch":[]}',
  keepalive: true,
  compress: true,
};

function setup(): { scheduler: TestScheduler; transport: FakeTransport; outcomes: HttpOutcome[] } {
  const scheduler = new TestScheduler();
  return { scheduler, transport: new FakeTransport(scheduler), outcomes: [] };
}

describe('FakeTransport', () => {
  it('records every request in order', () => {
    const { transport, outcomes } = setup();
    transport.send(batch, (outcome) => outcomes.push(outcome));
    transport.send({ ...batch, method: 'GET', body: undefined, keepalive: false }, (outcome) => outcomes.push(outcome));
    expect(transport.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
    expect(transport.requests[0]).toBe(batch);
  });

  it('answers on a later turn of the scheduler, never inside send', () => {
    const { scheduler, transport, outcomes } = setup();
    transport.send(batch, (outcome) => outcomes.push(outcome));
    expect(outcomes).toEqual([]);
    expect(transport.inFlight).toBe(1);
    scheduler.runUntilIdle();
    expect(outcomes).toEqual([{ kind: 'response', status: 200 }]);
    expect(transport.inFlight).toBe(0);
  });

  it('returns scripted outcomes in order, then the answer for an empty script', () => {
    const scheduler = new TestScheduler();
    const transport = new FakeTransport(scheduler, responseOutcome(204));
    const outcomes: HttpOutcome[] = [];
    const error = fetchTypeError();
    transport.enqueue(
      responseOutcome(503, { headers: { 'Retry-After': '2' }, body: 'busy' }),
      rejectedOutcome(error),
      opaqueRedirectOutcome(),
    );
    for (let i = 0; i < 4; i += 1) transport.send(batch, (outcome) => outcomes.push(outcome));
    scheduler.runUntilIdle();
    expect(outcomes).toEqual([
      { kind: 'response', status: 503, headers: { 'Retry-After': '2' }, body: 'busy' },
      { kind: 'rejected', error },
      { kind: 'response', status: 0, opaqueRedirect: true },
      { kind: 'response', status: 204 },
    ]);
  });

  it('delays a scripted answer on virtual time', () => {
    const { scheduler, transport, outcomes } = setup();
    transport.enqueue({ outcome: responseOutcome(200), delayMs: 45_000 });
    transport.send(batch, (outcome) => outcomes.push(outcome));
    scheduler.advanceBy(44_999);
    expect(outcomes).toEqual([]);
    scheduler.advanceBy(1);
    expect(outcomes).toHaveLength(1);
  });

  it('rejects an aborted request once with an AbortError on the next turn, and drops its late answer', () => {
    const { scheduler, transport, outcomes } = setup();
    transport.enqueue({ outcome: responseOutcome(200), delayMs: 60_000 });
    const call = transport.send(batch, (outcome) => outcomes.push(outcome));
    scheduler.advanceBy(45_000);
    call.abort();
    call.abort();
    expect(outcomes).toEqual([]);
    scheduler.runAll();
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.kind === 'rejected' && outcome.error instanceof DOMException && outcome.error.name).toBe(
      'AbortError',
    );
    expect(transport.calls).toEqual([{ request: batch, aborted: true }]);
    expect(transport.inFlight).toBe(0);
  });

  it('never answers a request scripted with an infinite delay unless it is aborted', () => {
    const { scheduler, transport, outcomes } = setup();
    transport.enqueue({ outcome: responseOutcome(200), delayMs: Infinity });
    const call = transport.send(batch, (outcome) => outcomes.push(outcome));
    scheduler.runAll();
    expect(outcomes).toEqual([]);
    expect(transport.inFlight).toBe(1);
    call.abort();
    scheduler.runUntilIdle();
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['rejected']);
  });

  it('ignores an abort after the outcome was reported', () => {
    const { scheduler, transport, outcomes } = setup();
    const call = transport.send(batch, (outcome) => outcomes.push(outcome));
    scheduler.runUntilIdle();
    call.abort();
    scheduler.runAll();
    expect(outcomes).toEqual([{ kind: 'response', status: 200 }]);
    expect(transport.calls[0]?.aborted).toBe(false);
  });
});
