import type { HttpOutcome } from 'rubicon-analytics-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NodeFetchTransport, realTimePlatform, SystemClock, TestPlatform, TimerScheduler } from '../src';
import { DROPPED, TestServer } from '../src/server';

// Real sockets and timers: every wait is a condition the transport or the scheduler resolves, with
// Vitest's timeout as the bound, never a fixed sleep.

let server: TestServer;

beforeAll(async () => {
  server = await TestServer.start();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.reset();
});

function send(transport: NodeFetchTransport, url: string, body?: string): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    transport.send(
      {
        method: body === undefined ? 'GET' : 'POST',
        url,
        headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json' },
        body,
        keepalive: false,
        compress: false,
      },
      resolve,
    );
  });
}

describe('SystemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('TimerScheduler', () => {
  it('runs tasks in the order they become due, never inside the call', async () => {
    const scheduler = new TimerScheduler();
    const ran: string[] = [];
    const done = new Promise<void>((resolve) => {
      scheduler.after(20, () => {
        ran.push('later');
        resolve();
      });
    });
    scheduler.yield(() => ran.push('yield'));
    expect(ran).toEqual([]);
    await done;
    expect(ran).toEqual(['yield', 'later']);
  });

  it('a cancelled task and every task after cancelAll never run', async () => {
    const scheduler = new TimerScheduler();
    const ran: string[] = [];
    scheduler.after(0, () => ran.push('cancelled')).cancel();
    scheduler.after(0, () => ran.push('cleared'));
    scheduler.cancelAll();
    // Timers of the same delay fire in order: this one runs after the two would have.
    await new Promise<void>((resolve) => {
      new TimerScheduler().after(0, resolve);
    });
    expect(ran).toEqual([]);
  });
});

describe('NodeFetchTransport', () => {
  it('sends the request as built and reports the response with its headers and body', async () => {
    server.enqueue({ status: 503, headers: { 'Retry-After': '7' }, body: 'busy' });

    const outcome = await send(new NodeFetchTransport(), server.url('/v1/batch'), '{"batch":[]}');

    expect(outcome).toMatchObject({ kind: 'response', status: 503, body: 'busy' });
    expect(outcome.kind === 'response' ? outcome.headers?.['retry-after'] : undefined).toBe('7');
    const request = server.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers['authorization']).toBe('Bearer key');
    expect(request?.body).toBe('{"batch":[]}');
  });

  it('reports a dropped connection as a rejection', async () => {
    server.enqueue(DROPPED);

    const outcome = await send(new NodeFetchTransport(), server.url('/v1/batch'), '{}');

    expect(outcome.kind).toBe('rejected');
  });

  it('reports an abort as a rejection', async () => {
    server.enqueue({ delayMs: 5_000 });
    const transport = new NodeFetchTransport();

    const outcome = await new Promise<HttpOutcome>((resolve) => {
      const call = transport.send(
        { method: 'GET', url: server.url('/v1/config'), headers: {}, keepalive: false, compress: false },
        resolve,
      );
      call.abort();
    });

    expect(outcome).toMatchObject({ kind: 'rejected' });
  });
});

describe('realTimePlatform', () => {
  it('keeps the fakes of the page and replaces the clock, the scheduler and the transport', () => {
    const test = new TestPlatform();
    const scheduler = new TimerScheduler();

    const platform = realTimePlatform(test, { scheduler });

    expect(platform.storage).toBe(test.storage);
    expect(platform.cookies).toBe(test.cookies);
    expect(platform.scheduler).toBe(scheduler);
    expect(platform.clock).toBeInstanceOf(SystemClock);
    expect(platform.transport).toBeInstanceOf(NodeFetchTransport);
  });
});
