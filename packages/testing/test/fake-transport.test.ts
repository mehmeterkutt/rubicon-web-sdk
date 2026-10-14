import type { HttpRequest, HttpResult } from 'rubicon-analytics-core';
import { describe, expect, it } from 'vitest';
import { FakeTransport, TestScheduler } from '../src';

const batch: HttpRequest = {
  method: 'POST',
  url: 'https://api.rubicon.example/v1/batch',
  headers: { 'Content-Type': 'application/json' },
  body: '{"sent_at":0,"batch":[]}',
  keepalive: true,
};

function setup(): { scheduler: TestScheduler; transport: FakeTransport; results: HttpResult[] } {
  const scheduler = new TestScheduler();
  return { scheduler, transport: new FakeTransport(scheduler), results: [] };
}

describe('FakeTransport', () => {
  it('records every request in order', () => {
    const { transport, results } = setup();
    transport.send(batch, (result) => results.push(result));
    transport.send({ ...batch, method: 'GET', body: undefined, keepalive: false }, (result) => results.push(result));
    expect(transport.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
    expect(transport.requests[0]).toBe(batch);
  });

  it('answers on a later turn of the scheduler, never inside send', () => {
    const { scheduler, transport, results } = setup();
    transport.send(batch, (result) => results.push(result));
    expect(results).toEqual([]);
    expect(transport.inFlight).toBe(1);
    scheduler.runUntilIdle();
    expect(results).toEqual([{ kind: 'success', status: 200 }]);
    expect(transport.inFlight).toBe(0);
  });

  it('returns scripted results in order, then the answer for an empty script', () => {
    const scheduler = new TestScheduler();
    const transport = new FakeTransport(scheduler, { kind: 'success', status: 204 });
    const results: HttpResult[] = [];
    transport.enqueue(
      { kind: 'http-error', status: 503, retryAfterMs: 2_000 },
      { kind: 'network-failure', failure: 'io' },
    );
    for (let i = 0; i < 3; i += 1) transport.send(batch, (result) => results.push(result));
    scheduler.runUntilIdle();
    expect(results).toEqual([
      { kind: 'http-error', status: 503, retryAfterMs: 2_000 },
      { kind: 'network-failure', failure: 'io' },
      { kind: 'success', status: 204 },
    ]);
  });

  it('delays a scripted answer on virtual time', () => {
    const { scheduler, transport, results } = setup();
    transport.enqueue({ result: { kind: 'success', status: 200 }, delayMs: 45_000 });
    transport.send(batch, (result) => results.push(result));
    scheduler.advanceBy(44_999);
    expect(results).toEqual([]);
    scheduler.advanceBy(1);
    expect(results).toHaveLength(1);
  });

  it('reports an aborted request once, as a timeout on the next turn, and drops its late answer', () => {
    const { scheduler, transport, results } = setup();
    transport.enqueue({ result: { kind: 'success', status: 200 }, delayMs: 60_000 });
    const call = transport.send(batch, (result) => results.push(result));
    scheduler.advanceBy(45_000);
    call.abort();
    call.abort();
    expect(results).toEqual([]);
    scheduler.runAll();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
    expect(transport.calls).toEqual([{ request: batch, aborted: true }]);
    expect(transport.inFlight).toBe(0);
  });

  it('never answers a request scripted with an infinite delay unless it is aborted', () => {
    const { scheduler, transport, results } = setup();
    transport.enqueue({ result: { kind: 'success', status: 200 }, delayMs: Infinity });
    const call = transport.send(batch, (result) => results.push(result));
    scheduler.runAll();
    expect(results).toEqual([]);
    expect(transport.inFlight).toBe(1);
    call.abort();
    scheduler.runUntilIdle();
    expect(results).toEqual([{ kind: 'network-failure', failure: 'timeout' }]);
  });

  it('ignores an abort after the result was reported', () => {
    const { scheduler, transport, results } = setup();
    const call = transport.send(batch, (result) => results.push(result));
    scheduler.runUntilIdle();
    call.abort();
    scheduler.runAll();
    expect(results).toEqual([{ kind: 'success', status: 200 }]);
    expect(transport.calls[0]?.aborted).toBe(false);
  });
});
