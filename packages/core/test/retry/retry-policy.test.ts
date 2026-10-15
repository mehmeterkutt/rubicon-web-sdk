import { MemoryStorage, SeededRandom, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  keyHash,
  LONGEST_WAIT_MS,
  MAX_WAIT_MS,
  PAUSE_FIELDS,
  PROBE_WINDOW_MS,
  RETRY_FIELDS,
  RetryPolicy,
  SUSPECT_FIELDS,
} from '../../src';
import type {
  FailureKind,
  HostSecurity,
  HttpResult,
  IssueCode,
  RandomSource,
  RetryAttempt,
  RetryDecision,
  StoreAccess,
} from '../../src';
import { KEY_HASH, openPage, plant } from '../storage/store-test-support';
import type { TestPage } from '../storage/store-test-support';

const HOST = 'https://api.rubicon.example';
const NOW = TestClock.DEFAULT_START;

const OK: HttpResult = { kind: 'success', status: 200 };

function http(status: number, retryAfterMs?: number, body?: string): HttpResult {
  return {
    kind: 'http-error',
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(body === undefined ? {} : { body }),
  };
}

function network(failure: FailureKind): HttpResult {
  return { kind: 'network-failure', failure };
}

/** One simulated page: its stores, its log and its policy, over a storage area other pages may share. */
interface RetryPage extends TestPage {
  readonly policy: RetryPolicy;
  readonly clock: TestClock;
  /** Milliseconds until the next attempt may start; 0 when it may start now (the Android `waitMs`). */
  waitMs(): number;
  /** The gate's attempt, failing the test when it does not allow one. */
  attempt(): RetryAttempt;
  /** `onResult` for an attempt the gate allowed now. */
  send(chunkIds: readonly string[], result: HttpResult): RetryDecision;
  /** The stored `.device` `retry` object. */
  retry(): Record<string, unknown>;
  /** Lines of `code` written at their own level. */
  count(code: IssueCode): number;
}

interface PageOptions {
  readonly storage?: MemoryStorage;
  readonly clock?: TestClock;
  readonly random?: RandomSource;
  readonly host?: string;
  readonly hostSecurity?: HostSecurity;
  readonly access?: StoreAccess['level'];
}

function retryPage(options: PageOptions = {}): RetryPage {
  const clock = options.clock ?? new TestClock();
  const page = openPage(options.storage ?? new MemoryStorage(), clock, { access: options.access });
  const policy = new RetryPolicy({
    device: page.stores.device,
    pause: page.stores.pause,
    clock,
    random: options.random ?? new SeededRandom(7),
    log: page.log,
    config: { host: options.host ?? HOST, hostSecurity: options.hostSecurity ?? 'encrypted' },
  });
  const attempt = (): RetryAttempt => {
    const gate = policy.gate();
    if (gate.kind !== 'go') throw new Error(`the gate said ${gate.kind}`);
    return gate.attempt;
  };
  return {
    ...page,
    policy,
    clock,
    waitMs() {
      const gate = policy.gate();
      return gate.kind === 'wait' ? gate.until - clock.now() : 0;
    },
    attempt,
    send(chunkIds, result) {
      return policy.onResult(attempt(), chunkIds, result);
    },
    retry() {
      return (page.stored('device')?.retry ?? {}) as Record<string, unknown>;
    },
    count(code) {
      return page.sink.lines.filter((line) => line.level !== 'debug' && line.message.startsWith(`${code}:`)).length;
    },
  };
}

/** Moves the clock to the end of every wait in force, as the uploader's timer would. */
function waitOut(page: RetryPage): RetryAttempt {
  for (let i = 0; i < 10; i += 1) {
    const gate = page.policy.gate();
    if (gate.kind === 'go') return gate.attempt;
    if (gate.kind === 'blocked') throw new Error('blocked');
    page.clock.set(gate.until);
  }
  throw new Error('the wait never ended');
}

/**
 * A scripted uploader, the web form of the Android test's: waits out every wait, lets the policy
 * choose the batch from the pending chunks in their order, and deletes what it is told to.
 */
function run(
  page: RetryPage,
  chunks: string[],
  attempts: number,
  answer: (batch: readonly string[]) => HttpResult,
): { readonly batch: string; readonly decision: RetryDecision }[] {
  const log: { batch: string; decision: RetryDecision }[] = [];
  for (let i = 0; i < attempts && chunks.length > 0; i += 1) {
    const attempt = waitOut(page);
    const batch = page.policy.selectChunks(chunks.map((id) => ({ id }))).map((chunk) => chunk.id);
    const decision = page.policy.onResult(attempt, batch, answer(batch));
    log.push({ batch: batch.join('+'), decision });
    if (decision !== 'keep') batch.forEach((id) => chunks.splice(chunks.indexOf(id), 1));
  }
  return log;
}

function suspectsOf(page: RetryPage): Record<string, Record<string, number>> {
  return (page.retry().suspects ?? {}) as Record<string, Record<string, number>>;
}

function repeat<T>(times: number, value: T): T[] {
  return Array.from({ length: times }, () => value);
}

describe('RetryPolicy', () => {
  describe('backoff (Retry 2)', () => {
    it('transient failures walk the table with jitter between 0.5 and 1.5', () => {
      const page = retryPage();
      const table = [2_000, 10_000, 30_000, 120_000, 300_000, 600_000, 600_000, 600_000];

      const waits = table.map(() => {
        waitOut(page);
        expect(page.send(['p.1'], http(500))).toBe('keep');
        return page.waitMs();
      });

      waits.forEach((wait, i) => {
        expect(wait).toBeGreaterThanOrEqual(table[i]! / 2);
        expect(wait).toBeLessThan((table[i]! * 3) / 2);
      });
      expect(page.retry()).toMatchObject({ step: 8, last_failure: 'http_500', rev: 8 });
      expect(page.stored('pause')).toBeUndefined();
    });

    it('jitter spreads devices that failed together', () => {
      const waits = Array.from({ length: 20 }, (_, seed) => {
        const page = retryPage({ random: new SeededRandom(seed + 1) });
        page.send(['s.0'], network('timeout'));
        return page.waitMs();
      });

      expect(new Set(waits).size).toBeGreaterThan(15);
      waits.forEach((wait) => {
        expect(wait).toBeGreaterThanOrEqual(1_000);
        expect(wait).toBeLessThan(3_000);
      });
    });

    it('a success resets the table and clears the wait', () => {
      const page = retryPage();
      for (let i = 0; i < 4; i += 1) {
        waitOut(page);
        page.send(['a.0'], http(502));
      }

      expect(page.policy.onResult(waitOut(page), ['a.0'], OK)).toBe('delete-sent');

      expect(page.waitMs()).toBe(0);
      expect(page.retry()).toEqual({ step: 0, rev: 4, probe_at: page.retry().probe_at, suspects: {} });
      page.send(['b.0'], http(502));
      expect(page.waitMs()).toBeLessThanOrEqual(3_000);
    });

    it('a wait is a wall-clock deadline in the shared record (Web Retry 3)', () => {
      const page = retryPage();

      page.send(['a.0'], network('io'));

      const until = page.retry().paused_until as number;
      expect(until - NOW).toBe(page.waitMs());
      page.clock.advanceBy(until - NOW - 1);
      expect(page.waitMs()).toBe(1);
      page.clock.advanceBy(1);
      expect(page.waitMs()).toBe(0);
    });

    it('the stored retry object has only the decided keys (Web Retry 1)', () => {
      const page = retryPage();
      page.send(['a.0'], http(500));
      waitOut(page);

      expect(Object.keys(page.retry()).every((key) => (RETRY_FIELDS as readonly string[]).includes(key))).toBe(true);
      expect(Object.keys(page.retry()).sort()).toEqual([...RETRY_FIELDS].sort());
      expect(Object.keys(suspectsOf(page)['a.0']!).sort()).toEqual([...SUSPECT_FIELDS].sort());
    });
  });

  describe('Retry-After (Retry 3)', () => {
    it('is never shortened and gets forward jitter of at most 10 percent', () => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const page = retryPage({ random: new SeededRandom(seed) });
        page.send(['a.0'], http(429, 120_000));

        expect(page.waitMs()).toBeGreaterThanOrEqual(120_000);
        expect(page.waitMs()).toBeLessThanOrEqual(132_000);
        expect(page.stored('pause')).toMatchObject({ kind: 'throttle' });
      }
    });

    it('is capped at one hour, jitter included', () => {
      const first = retryPage();
      first.send(['a.0'], http(503, 7_200_000));
      expect(first.waitMs()).toBe(MAX_WAIT_MS);

      const second = retryPage();
      second.send(['a.0'], http(429, 3_590_000));
      expect(second.waitMs()).toBeGreaterThanOrEqual(3_590_000);
      expect(second.waitMs()).toBeLessThanOrEqual(3_600_000);
    });

    it('zero or less counts as one second', () => {
      for (const retryAfter of [0, -60_000]) {
        const page = retryPage();
        page.send(['a.0'], http(429, retryAfter));

        expect(page.waitMs()).toBeGreaterThanOrEqual(1_000);
        expect(page.waitMs()).toBeLessThanOrEqual(1_100);
      }
    });

    it('429 without the header uses the table', () => {
      const page = retryPage();

      page.send(['a.0'], http(429));

      expect(page.waitMs()).toBeGreaterThanOrEqual(1_000);
      expect(page.waitMs()).toBeLessThan(3_000);
      expect(page.retry()).toMatchObject({ step: 1, rev: 1, last_failure: 'http_429' });
      expect(page.stored('pause')).toMatchObject({ kind: 'throttle' });
      expect(page.retry().paused_until).toBeUndefined();
    });

    it('does not advance the table or count against the chunk', () => {
      const page = retryPage();

      page.send(['a.0'], http(429, 5_000));

      expect(page.stored('device')).toBeUndefined();
      expect(page.stored('pause')).toEqual({ v: 1, until: NOW + page.waitMs(), kind: 'throttle', host: keyHash(HOST) });
    });

    it('the pause record has exactly the decided keys, the host as keyHash(host) (plan section 15, step 4.1)', () => {
      const page = retryPage({ host: 'https://api.rubicon.example/collect' });

      page.send(['a.0'], http(429, 5_000));

      expect(Object.keys(page.stored('pause')!).sort()).toEqual(['v', ...PAUSE_FIELDS].sort());
      expect(page.stored('pause')!.host).toBe(keyHash('https://api.rubicon.example/collect'));
      expect(page.policy.pauseHost).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('configuration problems (Retry 1, 2, 4)', () => {
    it('pause one hour plus or minus 20 percent and log one error per code', () => {
      const page = retryPage();
      for (let i = 0; i < 3; i += 1) {
        expect(page.policy.onResult(waitOut(page), ['a.0'], http(401))).toBe('keep');
        expect(page.waitMs()).toBeGreaterThanOrEqual(2_880_000);
        expect(page.waitMs()).toBeLessThanOrEqual(4_320_000);
      }
      for (const status of [403, 404, 410, 413, 501, 505, 300, 304])
        page.policy.onResult(waitOut(page), ['a.0'], http(status));

      expect(page.count('UPLOAD_UNAUTHORIZED')).toBe(1);
      expect(page.count('UPLOAD_ENDPOINT_MISSING')).toBe(1);
      expect(page.count('UPLOAD_TOO_LARGE')).toBe(1);
      expect(page.count('UPLOAD_NOT_SUPPORTED')).toBe(1);
      expect(page.count('HTTP_REDIRECT')).toBe(1);
      expect(page.stored('pause')).toMatchObject({ kind: 'config', host: keyHash(HOST) });
      expect(page.retry()).toMatchObject({ step: 0, rev: 0, suspects: {} });
    });

    it('a plain 3xx is logged as HTTP_REDIRECT at ERROR, naming only its status (plan section 15, step 5.2)', () => {
      const page = retryPage();

      page.send(['a.0'], http(300, undefined, 'body text'));

      const line = page.sink.lines.find((recorded) => recorded.message.startsWith('HTTP_REDIRECT:'));
      expect(line?.level).toBe('error');
      expect(line?.message).toContain('300');
      expect(line?.message).not.toContain('body text');
    });

    it('a 304 to an upload pauses for an hour and logs nothing, as Android and iOS (plan section 15, step 5.2)', () => {
      const page = retryPage();

      expect(page.send(['a.0'], http(304))).toBe('keep');

      expect(page.sink.lines.filter((line) => line.level !== 'debug')).toEqual([]);
      expect(page.stored('pause')).toMatchObject({ kind: 'config' });
      expect(page.waitMs()).toBeGreaterThanOrEqual(2_880_000);
    });

    it('an opaque redirect pauses without a line of its own, since the HTTP client logged it', () => {
      const page = retryPage();

      page.send(['a.0'], { kind: 'http-error', status: 0, redirect: true });

      expect(page.count('HTTP_REDIRECT')).toBe(0);
      expect(page.stored('pause')).toMatchObject({ kind: 'config' });
      expect(page.waitMs()).toBeGreaterThanOrEqual(2_880_000);
    });

    it('a bad batch is deleted at once, with a warning', () => {
      const page = retryPage();

      expect(page.send(['a.0'], http(400, undefined, 'the server said why'))).toBe('delete-rejected');
      expect(page.send(['b.0'], http(422))).toBe('delete-rejected');

      expect(page.waitMs()).toBe(0);
      expect(page.count('BATCH_REJECTED')).toBe(1);
      expect(page.sink.messages.some((message) => message.includes('the server said why'))).toBe(false);
      expect(page.stored('device')).toBeUndefined();
    });

    it('a bad batch forgets the counters of its chunks', () => {
      const page = retryPage();
      page.send(['a.0'], http(500));
      waitOut(page);

      page.send(['a.0'], http(400));

      expect(suspectsOf(page)).toEqual({});
    });
  });

  describe('the network returning (Retry 2, Web Retry 2)', () => {
    it('makes one early attempt after a network failure and keeps the table position', () => {
      const page = retryPage();
      for (let i = 0; i < 3; i += 1) {
        waitOut(page);
        page.send(['a.0'], network('connect'));
      }
      const before = page.retry();

      const attempt = page.policy.onlineAttempt(page.policy.noteOnline());

      expect(attempt).toEqual({ rev: 3, probe: true });
      expect(page.retry()).toEqual({ ...before, probe_at: NOW + (page.clock.now() - NOW) });
      expect(page.policy.onResult(attempt!, ['a.0'], network('io'))).toBe('keep');
      expect(page.retry().step).toBe(4);
      expect(page.waitMs()).toBeGreaterThanOrEqual(60_000);
    });

    it('a success of the early attempt resets the table', () => {
      const page = retryPage();
      page.send(['a.0'], network('io'));

      const attempt = page.policy.onlineAttempt(page.policy.noteOnline());
      page.policy.onResult(attempt!, ['a.0'], OK);

      expect(page.waitMs()).toBe(0);
      expect(page.retry()).toMatchObject({ step: 0 });
    });

    it('never ends a server wait', () => {
      for (const result of [http(500), http(429, 60_000), http(429), http(401), http(503, 30_000)]) {
        const page = retryPage();
        page.send(['a.0'], result);
        const wait = page.waitMs();
        const stored = [page.raw('device'), page.raw('pause')];

        expect(page.policy.onlineAttempt(page.policy.noteOnline())).toBeUndefined();

        expect(page.waitMs()).toBe(wait);
        expect([page.raw('device'), page.raw('pause')]).toEqual(stored);
      }
    });

    it('never ends the local pause of an unexpected failure', () => {
      const page = retryPage();
      page.send(['a.0'], network('unexpected'));

      expect(page.policy.onlineAttempt(page.policy.noteOnline())).toBeUndefined();
    });

    it('does nothing when no wait is in force', () => {
      const page = retryPage();
      page.send(['a.0'], network('io'));
      waitOut(page);

      expect(page.policy.onlineAttempt(page.policy.noteOnline())).toBeUndefined();
    });

    it('a failure another page wrote after the event holds its wait', () => {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      const page = retryPage({ storage, clock });
      const other = retryPage({ storage: storage.otherPage(), clock, random: new SeededRandom(8) });
      page.send(['a.0'], network('io'));
      const noted = page.policy.noteOnline();

      other.policy.onResult({ rev: 0, probe: false }, ['b.0'], network('io'));

      expect(page.policy.onlineAttempt(noted)).toBeUndefined();
    });

    it('another page probing within 30 seconds is waited for', () => {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      const page = retryPage({ storage, clock });
      const other = retryPage({ storage: storage.otherPage(), clock });
      page.send(['a.0'], network('io'));

      expect(other.policy.onlineAttempt(other.policy.noteOnline())).toBeDefined();
      clock.advanceBy(500);

      expect(page.policy.onlineAttempt(page.policy.noteOnline())).toBeUndefined();
    });

    it('is never made in a page that may not upload', () => {
      const page = retryPage({ hostSecurity: 'blocked' });

      expect(page.policy.onlineAttempt(page.policy.noteOnline())).toBeUndefined();
    });
  });

  describe('poison chunks (Web Retry 1, point 6; Web Retry 4b)', () => {
    it('a chunk that keeps failing while others succeed is deleted after f 10, cleared_by 1 and alone 5', () => {
      const page = retryPage();
      const chunks = ['41.0', '42.0'];

      const outage = run(page, chunks, 5, () => http(500));
      expect(outage).toEqual(repeat(5, { batch: '41.0+42.0', decision: 'keep' }));
      expect(suspectsOf(page)).toEqual({
        '41.0': { f: 5, alone: 0, cleared_by: 0 },
        '42.0': { f: 5, alone: 0, cleared_by: 0 },
      });

      chunks.push('43.0');
      const log = run(page, chunks, 30, (batch) => (batch.includes('41.0') ? http(500) : OK));

      expect(log).toEqual([
        { batch: '43.0', decision: 'delete-sent' },
        { batch: '41.0', decision: 'keep' },
        { batch: '42.0', decision: 'delete-sent' },
        ...repeat(3, { batch: '41.0', decision: 'keep' }),
        { batch: '41.0', decision: 'delete-exhausted' },
      ]);
      expect(suspectsOf(page)).toEqual({});
      expect(page.count('RETRY_EXHAUSTED')).toBe(1);
    });

    it('is not deleted before alone reaches 5, however high f is', () => {
      const page = retryPage();
      const chunks = ['41.0'];
      run(page, chunks, 20, () => http(500));
      chunks.push('42.0');
      run(page, chunks, 1, () => OK);

      const log = run(page, chunks, 5, () => http(500));

      expect(log.map((entry) => entry.decision)).toEqual([...repeat(4, 'keep'), 'delete-exhausted']);
      expect(chunks).toEqual([]);
    });

    it('newer chunks written later go before the suspects', () => {
      const page = retryPage();
      const chunks = ['41.0', '42.0'];
      run(page, chunks, 7, () => http(503));
      chunks.push('44.0');

      expect(run(page, chunks, 1, () => OK)).toEqual([{ batch: '44.0', decision: 'delete-sent' }]);
    });

    it('a suspect is left out of the next attempt, and suspects go as before when nothing else is left', () => {
      const page = retryPage();
      page.policy.onResult(waitOut(page), ['41.0'], http(500));
      for (let i = 0; i < 4; i += 1) page.policy.onResult(waitOut(page), ['41.0'], http(500));
      const chunks = [{ id: '41.0' }, { id: '42.0' }, { id: '43.0' }];

      expect(page.policy.selectChunks(chunks)).toEqual([{ id: '42.0' }, { id: '43.0' }]);
      expect(page.policy.selectChunks([{ id: '41.0' }])).toEqual([{ id: '41.0' }]);
      expect(page.policy.selectChunks([])).toEqual([]);
    });

    it('the cleared chunk with the fewest lone attempts goes alone first', () => {
      const page = retryPage();
      plant(
        page.storage,
        'device',
        '{"v":1,"retry":{"step":0,"rev":0,"suspects":{"a.0":{"f":7,"alone":2,"cleared_by":1},"b.0":{"f":5,"alone":0,"cleared_by":1},"c.0":{"f":5,"alone":0,"cleared_by":0}}}}',
      );

      expect(page.policy.selectChunks([{ id: 'a.0' }, { id: 'b.0' }, { id: 'c.0' }])).toEqual([{ id: 'b.0' }]);
      expect(page.policy.selectChunks([{ id: 'a.0' }, { id: 'c.0' }])).toEqual([{ id: 'a.0' }]);
      expect(page.policy.selectChunks([{ id: 'c.0' }, { id: 'd.0' }])).toEqual([{ id: 'd.0' }]);
    });

    it('a success of a batch that held suspects clears no other suspect', () => {
      const page = retryPage();
      run(page, ['41.0', '42.0'], 5, () => http(500));
      run(page, ['43.0'], 5, () => http(500));

      page.policy.onResult(waitOut(page), ['41.0', '42.0'], OK);

      expect(suspectsOf(page)).toEqual({ '43.0': { f: 5, alone: 0, cleared_by: 0 } });
    });

    it('in a general outage nothing is deleted', () => {
      const page = retryPage();
      const chunks = ['41.0', '42.0', '43.0'];

      const log = run(page, chunks, 60, () => http(500));

      expect(log.every((entry) => entry.decision === 'keep')).toBe(true);
      expect(chunks).toEqual(['41.0', '42.0', '43.0']);
      expect(suspectsOf(page)['41.0']).toEqual({ f: 60, alone: 0, cleared_by: 0 });
    });

    it('a lone failing chunk is never deleted, since nothing proves the server works', () => {
      const page = retryPage();
      const chunks = ['41.0'];

      run(page, chunks, 25, () => http(500));

      expect(chunks).toEqual(['41.0']);
      expect(suspectsOf(page)['41.0']).toEqual({ f: 25, alone: 0, cleared_by: 0 });
    });

    it('timeouts, io and connect never grow f; 408, 5xx and non-standard codes do (Web Retry 4b)', () => {
      const page = retryPage();
      for (const failure of ['timeout', 'io', 'connect'] as const) {
        for (let i = 0; i < 4; i += 1) page.policy.onResult(waitOut(page), ['a.0'], network(failure));
      }
      expect(suspectsOf(page)).toEqual({});
      expect(page.retry().step).toBe(12);

      for (const status of [408, 500, 502, 504, 599, 600, 0])
        page.policy.onResult(waitOut(page), ['a.0'], http(status));

      expect(suspectsOf(page)['a.0']).toEqual({ f: 7, alone: 0, cleared_by: 0 });
    });

    it('groups C and E never count against a chunk', () => {
      const page = retryPage();
      for (const result of [http(429), http(429, 1_000), http(503, 1_000), http(401), network('unexpected')]) {
        page.policy.onResult(waitOut(page), ['a.0'], result);
      }

      expect(suspectsOf(page)).toEqual({});
    });

    it('a chunk deleted for another reason is forgotten, and a vanished one at the walk', () => {
      const page = retryPage();
      page.send(['41.0', '42.0', '43.0'], http(500));

      page.policy.forget(['41.0']);
      expect(Object.keys(suspectsOf(page)).sort()).toEqual(['42.0', '43.0']);

      page.policy.prune(['43.0', '44.0']);
      expect(Object.keys(suspectsOf(page))).toEqual(['43.0']);

      const writes = page.storage.writeCount;
      page.policy.forget(['99.0']);
      page.policy.prune(['43.0']);
      expect(page.storage.writeCount).toBe(writes);
    });
  });

  describe('two pages share the state (Web Retry 1)', () => {
    function twoPages(): { readonly a: RetryPage; readonly b: RetryPage } {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      return {
        a: retryPage({ storage, clock, random: new SeededRandom(1) }),
        b: retryPage({ storage: storage.otherPage(), clock, random: new SeededRandom(2) }),
      };
    }

    it('a 429 seen by one pauses the other', () => {
      const { a, b } = twoPages();

      a.send(['a.0'], http(429, 600_000));

      const gate = b.policy.gate();
      expect(gate).toMatchObject({ kind: 'wait', reason: 'throttle' });
      expect(b.waitMs()).toBe(a.waitMs());
    });

    it('a transient wait written by one holds the other, also on a new page load', () => {
      const { a, b } = twoPages();

      a.send(['a.0'], network('io'));

      expect(b.policy.gate()).toMatchObject({ kind: 'wait', reason: 'transient' });
      const reloaded = retryPage({ storage: a.storage.otherPage(), clock: a.clock });
      expect(reloaded.waitMs()).toBe(a.waitMs());
    });

    it('a pause is never shortened by another page, and the later end wins', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], http(429, 600_000));
      const until = a.stored('pause')!.until as number;

      b.policy.onResult({ rev: 0, probe: false }, ['b.0'], http(429, 60_000));
      expect(a.stored('pause')!.until).toBe(until);

      b.policy.onResult({ rev: 0, probe: false }, ['b.0'], http(401));
      expect(a.stored('pause')!.until).toBeGreaterThan(until);
      expect(a.stored('pause')!.kind).toBe('config');
    });

    it('success, transient and counter writes never touch the pause', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], http(429, 600_000));
      const pause = a.raw('pause');

      b.policy.onResult({ rev: 0, probe: false }, ['b.0'], OK);
      b.policy.onResult({ rev: 0, probe: false }, ['b.0'], http(500));
      b.stores.device.countDropped('expired');
      b.stores.persist();

      expect(a.raw('pause')).toBe(pause);
    });

    it('a pause written between the write and the read back is answered with one more write', () => {
      const { a } = twoPages();
      const pauseKey = `rubicon.${KEY_HASH}.pause`;
      const earlier = `{"v":1,"until":${String(NOW + 1_000)},"kind":"throttle","host":"${keyHash(HOST)}"}`;
      let planted = false;
      const storage = a.storage;
      const setItem = storage.setItem.bind(storage);
      storage.setItem = (key: string, value: string) => {
        setItem(key, value);
        if (key === pauseKey && !planted) {
          planted = true;
          storage.area.entries.set(pauseKey, earlier);
        }
      };

      a.policy.onResult({ rev: 0, probe: false }, ['a.0'], http(429, 600_000));

      expect(a.stored('pause')!.until).toBeGreaterThanOrEqual(NOW + 600_000);
    });

    it('a pause of another host is ignored, and replaced by a pause of this one', () => {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      const other = retryPage({ storage, clock, host: 'https://other.example' });
      const page = retryPage({ storage: storage.otherPage(), clock });

      other.send(['a.0'], http(401));
      expect(page.policy.gate()).toMatchObject({ kind: 'go' });

      page.send(['b.0'], http(429, 1_000));
      expect(page.stored('pause')!.host).toBe(keyHash(HOST));
    });

    it('a success in one never erases a newer failure written by the other', () => {
      const { a, b } = twoPages();
      const attempt = a.attempt();
      b.policy.onResult(b.attempt(), ['b.0'], network('io'));
      const failure = a.retry();

      a.policy.onResult(attempt, ['a.0'], OK);

      expect(a.retry()).toMatchObject({
        step: failure.step,
        paused_until: failure.paused_until,
        rev: failure.rev,
        last_failure: 'io',
      });
      expect(a.policy.gate()).toMatchObject({ kind: 'wait', reason: 'transient' });
    });

    it('a success with the revision it read resets the state for every page', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], network('io'));
      const attempt = waitOut(b);

      b.policy.onResult(attempt, ['b.0'], OK);

      expect(a.retry()).toMatchObject({ step: 0 });
      expect(a.retry().paused_until).toBeUndefined();
    });

    it('only one page probes when a wait ends', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], network('io'));
      a.clock.set(a.retry().paused_until as number);

      const first = a.policy.gate();
      const second = b.policy.gate();

      expect(first).toEqual({ kind: 'go', attempt: { rev: 1, probe: true } });
      expect(second).toEqual({ kind: 'wait', until: a.clock.now() + PROBE_WINDOW_MS, reason: 'probe' });
      expect(a.retry().probe_at).toBe(a.clock.now());
      // The probing page goes on without writing another probe.
      const writes = a.storage.writeCount;
      expect(a.policy.gate()).toEqual({ kind: 'go', attempt: { rev: 1, probe: false } });
      expect(a.storage.writeCount).toBe(writes);
    });

    it("the probe's success frees the other page at once", () => {
      const { a, b } = twoPages();
      a.send(['a.0'], network('io'));
      const probe = waitOut(a);

      a.policy.onResult(probe, ['a.0'], OK);

      expect(b.policy.gate()).toEqual({ kind: 'go', attempt: { rev: 1, probe: false } });
    });

    it("the probe's failure is the other page's next wait", () => {
      const { a, b } = twoPages();
      a.send(['a.0'], network('io'));
      const probe = waitOut(a);

      a.policy.onResult(probe, ['a.0'], network('io'));

      const gate = b.policy.gate();
      expect(gate).toMatchObject({ kind: 'wait', reason: 'transient', until: a.retry().paused_until });
    });

    it('a probe that never reports holds the other page for 30 seconds only', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], http(429, 10_000));
      waitOut(a);

      b.clock.advanceBy(PROBE_WINDOW_MS - 1);
      expect(b.policy.gate()).toMatchObject({ kind: 'wait', reason: 'probe' });
      b.clock.advanceBy(1);
      expect(b.policy.gate()).toEqual({ kind: 'go', attempt: { rev: 0, probe: false } });
    });

    it('after an expired pause was probed, later attempts write no probe', () => {
      const { a, b } = twoPages();
      a.send(['a.0'], http(429, 10_000));
      a.policy.onResult(waitOut(a), ['a.0'], OK);
      b.clock.advanceBy(PROBE_WINDOW_MS);
      const writes = b.storage.writeCount;

      expect(b.policy.gate()).toMatchObject({ kind: 'go', attempt: { probe: false } });
      expect(b.storage.writeCount).toBe(writes);
    });

    it('a suspect chunk is cleared by another page whose batch succeeds, and only then deleted', () => {
      const { a, b } = twoPages();
      const chunks = ['41.0'];
      run(a, chunks, 15, () => http(500));
      expect(suspectsOf(a)['41.0']).toEqual({ f: 15, alone: 0, cleared_by: 0 });

      b.policy.onResult(waitOut(b), ['b7.0'], OK);
      expect(suspectsOf(a)['41.0']).toEqual({ f: 15, alone: 0, cleared_by: 1 });

      const log = run(a, chunks, 10, () => http(500));
      expect(log.map((entry) => entry.decision)).toEqual([...repeat(4, 'keep'), 'delete-exhausted']);
    });

    it('two pages counting failures of one chunk in turn both count', () => {
      const { a, b } = twoPages();

      a.policy.onResult({ rev: 0, probe: false }, ['41.0'], http(500));
      b.policy.onResult({ rev: 0, probe: false }, ['41.0'], http(500));

      expect(suspectsOf(a)['41.0']).toEqual({ f: 2, alone: 0, cleared_by: 0 });
      expect(a.retry()).toMatchObject({ step: 2, rev: 2 });
    });
  });

  describe('the clock guard (Web Retry 3)', () => {
    it('a transient deadline beyond 15 minutes is read as 15 minutes from now, and written back', () => {
      const page = retryPage();
      page.send(['a.0'], network('io'));
      page.clock.advanceBy(-86_400_000);

      expect(page.waitMs()).toBe(LONGEST_WAIT_MS.transient);
      expect(page.retry().paused_until).toBe(page.clock.now() + LONGEST_WAIT_MS.transient);
      expect(page.retry().rev).toBe(1);
      // A new page load reads the end that was written, not another 15 minutes from its own start.
      page.clock.advanceBy(60_000);
      expect(retryPage({ storage: page.storage.otherPage(), clock: page.clock }).waitMs()).toBe(
        LONGEST_WAIT_MS.transient - 60_000,
      );
    });

    it('a pause beyond the longest of its kind is read as that from now, kind and host kept', () => {
      for (const [result, kind] of [
        [http(401), 'config'],
        [http(429, 3_600_000), 'throttle'],
      ] as const) {
        const page = retryPage();
        page.send(['a.0'], result);
        page.clock.advanceBy(-86_400_000);

        expect(page.waitMs()).toBe(LONGEST_WAIT_MS[kind]);
        expect(page.stored('pause')).toEqual({
          v: 1,
          until: page.clock.now() + LONGEST_WAIT_MS[kind],
          kind,
          host: keyHash(HOST),
        });
      }
    });

    it('the longest waits are the table times the largest jitter', () => {
      expect(LONGEST_WAIT_MS).toEqual({
        transient: 600_000 * 1.5,
        throttle: Math.round(3_600_000 * 1.1),
        config: 3_600_000 * 1.2,
      });
    });

    it('an end beyond the longest wait never wins the later-end comparison', () => {
      const page = retryPage();
      plant(
        page.storage,
        'pause',
        `{"v":1,"until":${String(NOW + 86_400_000)},"kind":"throttle","host":"${keyHash(HOST)}"}`,
      );
      plant(page.storage, 'device', `{"v":1,"retry":{"paused_until":${String(NOW + 86_400_000)},"step":2,"rev":5}}`);

      page.policy.onResult({ rev: 5, probe: false }, ['a.0'], http(429, 60_000));
      page.policy.onResult({ rev: 5, probe: false }, ['a.0'], network('io'));

      expect(page.stored('pause')!.until).toBeLessThanOrEqual(NOW + 66_000);
      expect(page.retry().paused_until).toBeLessThan(NOW + 60_000);
    });

    it('a probe_at in the future is ignored', () => {
      const page = retryPage();
      page.send(['a.0'], network('io'));
      const end = page.retry().paused_until as number;
      plant(
        page.storage,
        'device',
        `{"v":1,"retry":{"paused_until":${String(end)},"step":1,"rev":1,"probe_at":${String(end + 10_000)}}}`,
      );
      page.clock.set(end);

      expect(page.policy.gate()).toEqual({ kind: 'go', attempt: { rev: 1, probe: true } });
    });

    it("the local pause of an unexpected failure is guarded in this page's memory", () => {
      const page = retryPage();
      page.send(['a.0'], network('unexpected'));
      page.clock.advanceBy(-86_400_000);

      expect(page.waitMs()).toBe(LONGEST_WAIT_MS.config);
    });

    it('a clock set forward ends a wait early, as accepted on Android', () => {
      const page = retryPage();
      page.send(['a.0'], http(401));
      page.clock.advanceBy(86_400_000);

      expect(page.policy.gate()).toMatchObject({ kind: 'go' });
    });
  });

  describe('persistence across page loads (Retry 5)', () => {
    function reload(page: RetryPage): RetryPage {
      return retryPage({ storage: page.storage.otherPage(), clock: page.clock });
    }

    it('a wait survives a reload', () => {
      const page = retryPage();
      page.send(['41.0'], http(429, 600_000));
      const wait = page.waitMs();
      page.clock.advanceBy(100_000);

      expect(reload(page).waitMs()).toBe(wait - 100_000);
    });

    it('counters per chunk and the table position survive a reload', () => {
      const page = retryPage();
      for (let i = 0; i < 3; i += 1) page.policy.onResult(waitOut(page), ['41.0'], http(500));

      const restored = reload(page);

      expect(restored.retry()).toMatchObject({ step: 3, last_failure: 'http_500', suspects: { '41.0': { f: 3 } } });
      expect(restored.policy.selectChunks([{ id: '41.0' }])).toEqual([{ id: '41.0' }]);
    });

    it('a wait that ended before the reload is not restored, and its end is probed', () => {
      const page = retryPage();
      page.send(['41.0'], http(500));
      page.clock.advanceBy(60_000);

      expect(reload(page).policy.gate()).toEqual({ kind: 'go', attempt: { rev: 1, probe: true } });
    });

    it('clearing the stored retry state ends the wait in this page too (Android log 9.3)', () => {
      const page = retryPage();
      page.send(['41.0'], http(500));
      expect(page.waitMs()).toBeGreaterThan(0);

      page.stores.device.write((state) => ({ ...state, retry: { ...state.retry, pausedUntil: undefined, step: 0 } }));

      expect(page.waitMs()).toBe(0);
    });

    it('a deleted pause ends the wait in this page too', () => {
      const page = retryPage();
      page.send(['41.0'], http(401));

      page.stores.pause.remove();

      expect(page.waitMs()).toBe(0);
    });
  });

  describe('page-local outcomes (Web Retry 4)', () => {
    it('an unknown outcome writes nothing and keeps the chunks', () => {
      const page = retryPage();
      page.send(['a.0'], http(500));
      const attempt = waitOut(page);
      const stored = [page.raw('device'), page.raw('pause')];

      expect(page.policy.onResult(attempt, ['a.0'], { kind: 'keepalive-refused' })).toBe('keep');
      expect(page.policy.onResult(attempt, ['a.0'], network('io'), { closing: true })).toBe('keep');
      expect(page.policy.onResult(attempt, ['a.0'], network('connect'), { closing: true })).toBe('keep');

      expect([page.raw('device'), page.raw('pause')]).toEqual(stored);
    });

    it('a real response processed while the page goes away is classified normally', () => {
      const page = retryPage();

      page.policy.onResult({ rev: 0, probe: false }, ['a.0'], http(500), { closing: true });
      page.policy.onResult({ rev: 0, probe: false }, ['a.0'], http(429, 5_000), { closing: true });

      expect(page.retry()).toMatchObject({ step: 1, suspects: { 'a.0': { f: 1 } } });
      expect(page.stored('pause')).toMatchObject({ kind: 'throttle' });
    });

    it('unexpected pauses this page only, in memory, for an hour plus or minus 20 percent', () => {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      const page = retryPage({ storage, clock });
      const other = retryPage({ storage: storage.otherPage(), clock });

      expect(page.send(['a.0'], network('unexpected'))).toBe('keep');

      expect(page.policy.gate()).toMatchObject({ kind: 'wait', reason: 'local' });
      expect(page.waitMs()).toBeGreaterThanOrEqual(2_880_000);
      expect(page.waitMs()).toBeLessThanOrEqual(4_320_000);
      expect(other.policy.gate()).toMatchObject({ kind: 'go', attempt: { probe: false } });
      expect(page.raw('device')).toBeNull();
      expect(page.raw('pause')).toBeNull();
      clock.advanceBy(page.waitMs());
      expect(page.policy.gate()).toEqual({ kind: 'go', attempt: { rev: 0, probe: false } });
    });

    it('mixed content stops this page only, whatever the shared state', () => {
      const storage = new MemoryStorage();
      const page = retryPage({ storage, hostSecurity: 'blocked' });
      const httpPage = retryPage({ storage: storage.otherPage(), hostSecurity: 'cleartext' });

      expect(page.policy.gate()).toEqual({ kind: 'blocked' });
      expect(httpPage.policy.gate()).toMatchObject({ kind: 'go' });
      expect(page.raw('device')).toBeNull();
    });
  });

  describe('storage access (Web Retry 1, point 7; Web Logging 4)', () => {
    it('in the memory-only mode the same state lives in this page alone', () => {
      const storage = new MemoryStorage();
      const clock = new TestClock();
      const page = retryPage({ storage, clock, access: 'none' });
      const other = retryPage({ storage: storage.otherPage(), clock });

      page.send(['a.0'], http(500));
      page.policy.onResult(waitOut(page), ['b.0'], http(429, 60_000));

      expect(page.policy.gate()).toMatchObject({ kind: 'wait' });
      expect(storage.area.entries.size).toBe(0);
      expect(other.policy.gate()).toMatchObject({ kind: 'go' });
      expect(page.policy.selectChunks([{ id: 'a.0' }])).toEqual([{ id: 'a.0' }]);
    });

    it('while consent is pending or refused the retry state and the pause stay in memory', () => {
      const page = retryPage({ access: 'consent' });

      page.send(['a.0'], http(401));

      expect(page.policy.gate()).toMatchObject({ kind: 'wait', reason: 'config' });
      expect(page.storage.area.entries.size).toBe(0);
    });

    it('a pause that cannot be written still holds this page', () => {
      const page = retryPage();
      page.storage.failWrites = true;

      expect(page.send(['a.0'], http(429, 600_000))).toBe('keep');

      expect(page.waitMs()).toBeGreaterThanOrEqual(600_000);
      expect(page.count('STORAGE_WRITE_FAILED')).toBe(1);
      expect(page.raw('pause')).toBeNull();
    });

    it('a transient failure that cannot be written is kept in memory and written later', () => {
      const page = retryPage();
      page.storage.failWrites = true;

      page.send(['a.0'], http(500));
      expect(page.waitMs()).toBeGreaterThan(0);
      page.storage.failWrites = false;
      page.stores.persist();

      expect(page.retry()).toMatchObject({ step: 1, suspects: { 'a.0': { f: 1 } } });
    });

    it('storage that throws on every access never throws into the caller', () => {
      const page = retryPage();
      page.storage.failAccess = true;

      expect(() => {
        page.send(['a.0'], http(500));
        page.policy.onResult({ rev: 0, probe: false }, ['a.0'], http(429, 1_000));
        page.policy.selectChunks([{ id: 'a.0' }]);
        page.policy.prune([]);
        page.policy.onlineAttempt(page.policy.noteOnline());
      }).not.toThrow();
      expect(page.policy.gate()).toMatchObject({ kind: 'wait' });
    });
  });

  describe('log lines (Logging 4, Web Logging 1)', () => {
    it('name codes, statuses, counts and durations, never a body or the host', () => {
      const page = retryPage({ host: 'https://secret-host.example' });
      for (const result of [http(400, undefined, 'BODY'), http(401, undefined, 'BODY'), http(500, undefined, 'BODY')]) {
        page.policy.onResult({ rev: 0, probe: false }, ['a.0'], result);
      }

      expect(page.sink.messages.length).toBeGreaterThan(0);
      for (const message of page.sink.messages) {
        expect(message).not.toContain('BODY');
        expect(message).not.toContain('secret-host');
        expect(message).not.toContain('a.0');
      }
    });
  });
});
