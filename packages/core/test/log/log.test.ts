import { RecordingLogger, RecordingSink } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { isInCallback, Log, LOG_LEVELS, NO_OP_SINK } from '../../src';
import type {
  DailyLogLimit,
  EventObserver,
  EventUpdate,
  IssueCode,
  LogLevel,
  LogOptions,
  RubiconLogger,
} from '../../src';

const SENT: EventUpdate = { type: 'sent', messageIds: ['m1'] };

// Resolves after every microtask queued so far, so a rejected Promise's handler has run.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(options: Partial<LogOptions> = {}) {
  const sink = new RecordingSink();
  const counted: IssueCode[] = [];
  const log = new Log({
    level: 'debug',
    debug: false,
    sink,
    issues: { increment: (code) => counted.push(code) },
    ...options,
  });
  return { log, sink, counted };
}

const levelsAtOrAbove = (level: LogLevel): number =>
  (['debug', 'info', 'warn', 'error'] as const).filter((l) => LOG_LEVELS.indexOf(l) >= LOG_LEVELS.indexOf(level))
    .length;

describe('Log', () => {
  describe('level gating', () => {
    it.each(LOG_LEVELS)('a disabled line never runs its message function, at level %s', (level) => {
      const { log, sink } = setup({ level });
      let built = 0;

      log.debug(() => `d${String((built += 1))}`);
      log.info(() => `i${String((built += 1))}`);
      log.warn('QUEUE_FULL', () => `w${String((built += 1))}`);
      log.error('HTTP_REDIRECT', () => `e${String((built += 1))}`);

      expect(built).toBe(levelsAtOrAbove(level));
      expect(sink.lines).toHaveLength(levelsAtOrAbove(level));
    });

    it('off logs nothing but still counts issues', () => {
      const { log, sink, counted } = setup({ level: 'off' });

      log.debug(() => 'd');
      log.info(() => 'i');
      log.warn('QUEUE_FULL', () => 'w');
      log.error('HTTP_REDIRECT', () => 'e');

      expect(sink.lines).toEqual([]);
      expect(counted).toEqual(['QUEUE_FULL', 'HTTP_REDIRECT']);
    });

    it('isEnabled follows the order of the levels', () => {
      const { log } = setup({ level: 'warn' });

      expect(LOG_LEVELS.map((level) => log.isEnabled(level))).toEqual([false, false, true, true, false]);
    });
  });

  describe('log lines', () => {
    it('warnings and errors start with their code; the error reaches only the developer logger', () => {
      const developer = new RecordingLogger();
      const { log } = setup({ logger: developer.logger });
      const cause = new Error('disk full');

      log.debug(() => 'queued');
      log.info(() => 'host in use');
      log.warn('CLEARTEXT_HOST', () => 'host uses http');
      log.error('STORAGE_WRITE_FAILED', () => 'write failed', { error: cause });

      expect(developer.lines.map((l) => `${l.level} ${l.message}`)).toEqual([
        'debug queued',
        'info host in use',
        'warn CLEARTEXT_HOST: host uses http',
        'error STORAGE_WRITE_FAILED: write failed',
      ]);
      expect(developer.lines[3]?.error).toBe(cause);
    });

    it('the default sink never receives the error', () => {
      const { log, sink } = setup();

      log.error('STORAGE_WRITE_FAILED', () => 'write failed', { error: new Error('disk full') });

      expect(sink.lines).toEqual([
        { level: 'error', message: 'STORAGE_WRITE_FAILED: write failed', developerErrorForm: false },
      ]);
    });

    it("the developer's logger replaces the default sink", () => {
      const developer = new RecordingLogger();
      const { log, sink } = setup({ logger: developer.logger });

      log.info(() => 'hello');

      expect(developer.messages).toEqual(['hello']);
      expect(sink.lines).toEqual([]);
    });

    it('a code that may be logged at both levels is written at the level of the call', () => {
      const { log, sink } = setup();

      log.error('CLEARTEXT_HOST', () => 'mixed content', { repeatKey: 'https' });
      log.warn('CLEARTEXT_HOST', () => 'unencrypted', { repeatKey: 'http' });

      expect(sink.lines.map((l) => l.level)).toEqual(['error', 'warn']);
    });
  });

  describe('repeat limit', () => {
    it('per_page logs a code at its level once, then at debug, and always counts it', () => {
      const { log, sink, counted } = setup({ level: 'debug' });

      for (const n of [1, 2, 3]) log.warn('PROPERTY_DROPPED', () => `dropped ${String(n)}`);

      expect(sink.lines.map((l) => l.level)).toEqual(['warn', 'debug', 'debug']);
      expect(counted).toEqual(['PROPERTY_DROPPED', 'PROPERTY_DROPPED', 'PROPERTY_DROPPED']);
    });

    it('at the default level only the first occurrence is visible and later messages are never built', () => {
      const { log, sink, counted } = setup({ level: 'warn' });
      let built = 0;

      for (let i = 0; i < 3; i += 1) log.error('HTTP_REDIRECT', () => `redirect ${String((built += 1))}`);

      expect(sink.messages).toEqual(['HTTP_REDIRECT: redirect 1']);
      expect(built).toBe(1);
      expect(counted).toHaveLength(3);
    });

    it('each code has its own limit', () => {
      const { log, sink } = setup({ level: 'warn' });

      log.warn('QUEUE_FULL', () => 'a');
      log.warn('CLEARTEXT_HOST', () => 'b');
      log.warn('QUEUE_FULL', () => 'c');

      expect(sink.messages).toEqual(['QUEUE_FULL: a', 'CLEARTEXT_HOST: b']);
    });

    it('a repeat key limits per key instead of per code', () => {
      const { log, sink, counted } = setup({ level: 'warn' });

      log.warn('PROPERTY_TRUNCATED', () => 'bio', { repeatKey: 'bio' });
      log.warn('PROPERTY_TRUNCATED', () => 'note', { repeatKey: 'note' });
      log.warn('PROPERTY_TRUNCATED', () => 'bio again', { repeatKey: 'bio' });
      log.warn('PROPERTY_TRUNCATED', () => 'without key');

      expect(sink.messages).toEqual([
        'PROPERTY_TRUNCATED: bio',
        'PROPERTY_TRUNCATED: note',
        'PROPERTY_TRUNCATED: without key',
      ]);
      expect(counted).toHaveLength(4);
    });

    it('separate instances keep separate limits, as two page loads do', () => {
      const sink = new RecordingSink();
      new Log({ level: 'warn', debug: false, sink }).warn('QUEUE_FULL', () => 'first');
      new Log({ level: 'warn', debug: false, sink }).warn('QUEUE_FULL', () => 'second');

      expect(sink.messages).toEqual(['QUEUE_FULL: first', 'QUEUE_FULL: second']);
    });
  });

  describe('per_24h', () => {
    // A device-wide record standing in for the `.device` field of step 4.1.
    function deviceRecord(): DailyLogLimit & { claims: IssueCode[]; taken: Set<IssueCode> } {
      const taken = new Set<IssueCode>();
      const claims: IssueCode[] = [];
      return {
        taken,
        claims,
        claim(code) {
          claims.push(code);
          if (taken.has(code)) return false;
          taken.add(code);
          return true;
        },
      };
    }

    it('without the daily limit a per_24h code is limited per page', () => {
      const { log, sink } = setup({ level: 'warn' });

      log.warn('UPLOAD_FAILED_OPAQUE', () => 'first');
      log.warn('UPLOAD_FAILED_OPAQUE', () => 'second');

      expect(sink.messages).toEqual(['UPLOAD_FAILED_OPAQUE: first']);
    });

    it('a second page load of the device within the limit logs the code at debug, and counts it', () => {
      const record = deviceRecord();
      const first = setup({ level: 'debug' });
      first.log.dailyLimit = record;
      const second = setup({ level: 'debug' });
      second.log.dailyLimit = record;

      first.log.warn('QUEUE_FULL', () => 'dropped');
      second.log.warn('QUEUE_FULL', () => 'dropped');

      expect(first.sink.lines.map((l) => l.level)).toEqual(['warn']);
      expect(second.sink.lines.map((l) => l.level)).toEqual(['debug']);
      expect(second.counted).toEqual(['QUEUE_FULL']);
    });

    it('asks the daily limit once per page, only for per_24h codes and only when the level is enabled', () => {
      const record = deviceRecord();
      const { log } = setup({ level: 'warn' });
      log.dailyLimit = record;
      const quiet = setup({ level: 'error' });
      quiet.log.dailyLimit = record;

      log.warn('EVENTS_EXPIRED', () => 'expired');
      log.warn('EVENTS_EXPIRED', () => 'expired');
      log.warn('PROPERTY_DROPPED', () => 'dropped');
      quiet.log.warn('QUEUE_FULL', () => 'dropped');

      expect(record.claims).toEqual(['EVENTS_EXPIRED']);
    });

    it('a daily limit that throws lets the line through', () => {
      const { log, sink } = setup({ level: 'warn' });
      log.dailyLimit = {
        claim: () => {
          throw new Error('storage');
        },
      };

      log.warn('QUEUE_FULL', () => 'dropped');

      expect(sink.messages).toEqual(['QUEUE_FULL: dropped']);
    });
  });

  describe('debug and developer errors (Web Logging 1)', () => {
    it('debug writes a developer error at its level in the error form of the default sink', () => {
      const { log, sink } = setup({ level: 'warn', debug: true });

      log.warn('PROPERTY_DROPPED', () => 'Dropped property "a": unsupported type Symbol', { developerError: true });
      log.warn('QUEUE_FULL', () => 'not a developer error');

      expect(sink.lines).toEqual([
        {
          level: 'error',
          message: 'PROPERTY_DROPPED: Dropped property "a": unsupported type Symbol',
          developerErrorForm: true,
        },
        { level: 'warn', message: 'QUEUE_FULL: not a developer error', developerErrorForm: false },
      ]);
    });

    it('without debug a developer error is a normal line', () => {
      const { log, sink } = setup({ level: 'warn', debug: false });

      log.warn('INVALID_EVENT_NAME', () => 'blank name', { developerError: true });

      expect(sink.lines).toEqual([
        { level: 'warn', message: 'INVALID_EVENT_NAME: blank name', developerErrorForm: false },
      ]);
    });

    it('a developer logger receives the line with its normal level and message, debug or not', () => {
      const developer = new RecordingLogger();
      const { log } = setup({ level: 'warn', debug: true, logger: developer.logger });

      log.error('HOOK_VIOLATION', () => 'a hook returned undefined', { developerError: true });

      expect(developer.lines).toEqual([
        { level: 'error', message: 'HOOK_VIOLATION: a hook returned undefined', error: undefined },
      ]);
    });

    it.each([true, false])('off silences a developer error with debug %s', (debug) => {
      const developer = new RecordingLogger();
      const withSink = setup({ level: 'off', debug });
      const withLogger = setup({ level: 'off', debug, logger: developer.logger });
      let built = 0;

      for (const { log } of [withSink, withLogger]) {
        log.warn('PROPERTY_DROPPED', () => `dropped ${String((built += 1))}`, { developerError: true });
        log.error('SECOND_INSTANCE', () => `second ${String((built += 1))}`, { developerError: true });
      }

      expect(withSink.sink.lines).toEqual([]);
      expect(developer.lines).toEqual([]);
      expect(built).toBe(0);
      expect(withSink.counted).toEqual(['PROPERTY_DROPPED', 'SECOND_INSTANCE']);
    });

    it('debug adds no line: a level above the developer error silences it', () => {
      const { log, sink } = setup({ level: 'error', debug: true });

      log.warn('PROPERTY_DROPPED', () => 'dropped', { developerError: true });

      expect(sink.lines).toEqual([]);
    });

    it('a repeated developer error demoted to debug stays a debug line', () => {
      const { log, sink } = setup({ level: 'debug', debug: true });

      log.warn('PROPERTY_DROPPED', () => 'first', { developerError: true });
      log.warn('PROPERTY_DROPPED', () => 'second', { developerError: true });

      expect(sink.lines.map((l) => [l.level, l.developerErrorForm])).toEqual([
        ['error', true],
        ['debug', false],
      ]);
    });
  });

  describe('a failing logger', () => {
    it('a logger that throws is replaced by the default sink once, which says so once', () => {
      let calls = 0;
      const throwing: RubiconLogger = () => {
        calls += 1;
        throw new Error('broken logger');
      };
      const { log, sink, counted } = setup({ logger: throwing });

      log.info(() => 'first');
      log.info(() => 'second');

      expect(calls).toBe(1);
      expect(sink.messages).toEqual([
        'LOGGER_THREW: Custom logger threw; falling back to the default logger',
        'first',
        'second',
      ]);
      expect(log.callbacks.usesDeveloperLogger).toBe(false);
      expect(counted).toEqual(['LOGGER_THREW']);
    });

    it('a logger that returns a rejected Promise is replaced once, and the rejection is handled', async () => {
      let calls = 0;
      const rejecting = (() => {
        calls += 1;
        return Promise.reject(new Error('broken logger'));
      }) as RubiconLogger;
      const { log, sink, counted } = setup({ logger: rejecting });

      log.info(() => 'first');
      log.info(() => 'second');
      await settle();
      log.info(() => 'third');

      expect(calls).toBe(2);
      expect(sink.messages).toEqual([
        'LOGGER_THREW: Custom logger threw; falling back to the default logger',
        'first',
        'third',
      ]);
      expect(counted).toEqual(['LOGGER_THREW']);
    });

    it('a logger that resolves is kept', async () => {
      const developer = new RecordingLogger();
      const resolving = ((level: LogLevel, message: string) => {
        developer.logger(level, message);
        return Promise.resolve();
      }) as RubiconLogger;
      const { log, sink } = setup({ logger: resolving });

      log.info(() => 'one');
      await settle();
      log.info(() => 'two');

      expect(developer.messages).toEqual(['one', 'two']);
      expect(sink.lines).toEqual([]);
    });

    it('a thenable whose then throws counts as a throw', () => {
      const odd = (() => ({
        then() {
          throw new Error('broken then');
        },
      })) as RubiconLogger;
      const { log, sink } = setup({ logger: odd });

      log.info(() => 'first');

      expect(sink.messages).toEqual(['LOGGER_THREW: Custom logger threw; falling back to the default logger', 'first']);
    });

    it('a throwing default sink is swallowed', () => {
      const log = new Log({
        level: 'debug',
        debug: true,
        sink: {
          write: () => {
            throw new Error('no console');
          },
          writeDeveloperError: () => {
            throw new Error('no console');
          },
        },
      });

      expect(() => {
        log.info(() => 'one');
        log.error('SECOND_INSTANCE', () => 'two', { developerError: true });
      }).not.toThrow();
    });
  });

  describe('the event observer', () => {
    it('updates reach the observer', () => {
      const seen: EventUpdate[] = [];
      const { log } = setup({ eventObserver: (update) => seen.push(update) });
      const queued: EventUpdate = { type: 'queued', event: { type: 'track' } };

      log.callbacks.notify(queued);
      log.callbacks.notify(SENT);

      expect(seen).toEqual([queued, SENT]);
      expect(log.callbacks.isObserverEnabled).toBe(true);
    });

    it('without an observer nothing happens', () => {
      const { log, sink } = setup();

      log.callbacks.notify(SENT);

      expect(log.callbacks.isObserverEnabled).toBe(false);
      expect(sink.lines).toEqual([]);
    });

    it('a throwing observer is switched off after one ERROR', () => {
      let calls = 0;
      const throwing: EventObserver = () => {
        calls += 1;
        throw new Error('broken observer');
      };
      const developer = new RecordingLogger();
      const { log } = setup({ level: 'warn', eventObserver: throwing, logger: developer.logger });

      for (let i = 0; i < 3; i += 1) log.callbacks.notify(SENT);

      expect(calls).toBe(1);
      expect(log.callbacks.isObserverEnabled).toBe(false);
      expect(developer.messages).toEqual(['OBSERVER_THREW: Event observer threw; it is switched off']);
      expect((developer.lines[0]?.error as Error).message).toBe('broken observer');
    });

    it('an observer that returns a rejected Promise is switched off once', async () => {
      let calls = 0;
      const rejecting = (() => {
        calls += 1;
        return Promise.reject(new Error('broken observer'));
      }) as EventObserver;
      const { log, sink, counted } = setup({ level: 'warn', eventObserver: rejecting });

      log.callbacks.notify(SENT);
      log.callbacks.notify(SENT);
      await settle();
      log.callbacks.notify(SENT);

      expect(calls).toBe(2);
      expect(log.callbacks.isObserverEnabled).toBe(false);
      expect(sink.messages).toEqual(['OBSERVER_THREW: Event observer threw; it is switched off']);
      expect(counted).toEqual(['OBSERVER_THREW']);
    });
  });

  describe('the guard ignores lines caused inside a callback', () => {
    it('a logger that logs through the SDK is ignored, without recursion', () => {
      const developer = new RecordingLogger();
      let calls = 0;
      const holder: { log?: Log } = {};
      const reentrant: RubiconLogger = (level, message, error) => {
        calls += 1;
        developer.logger(level, message, error);
        holder.log?.warn('QUEUE_FULL', () => 'from inside the logger');
      };
      const { log, counted } = setup({ logger: reentrant });
      holder.log = log;

      log.info(() => 'outside');

      expect(calls).toBe(1);
      expect(developer.messages).toEqual(['outside']);
      // The ignored line still counts as an issue.
      expect(counted).toEqual(['QUEUE_FULL']);
    });

    it('an observer that logs or notifies again is ignored', () => {
      let calls = 0;
      const holder: { log?: Log } = {};
      const { log, sink } = setup({
        eventObserver: () => {
          calls += 1;
          holder.log?.info(() => 'from inside the observer');
          holder.log?.callbacks.notify(SENT);
        },
      });
      holder.log = log;

      log.callbacks.notify(SENT);

      expect(calls).toBe(1);
      expect(sink.lines).toEqual([]);
      expect(isInCallback()).toBe(false);
    });

    it('the flag is cleared after a callback throws, and is module-wide across instances', () => {
      const other = setup();
      const { log } = setup({
        eventObserver: () => {
          other.log.info(() => 'another instance, inside the callback');
          throw new Error('broken observer');
        },
      });

      log.callbacks.notify(SENT);
      other.log.info(() => 'after');

      expect(isInCallback()).toBe(false);
      expect(other.sink.messages).toEqual(['after']);
    });
  });

  it('the no-op sink accepts anything', () => {
    const log = new Log({ level: 'debug', debug: true, sink: NO_OP_SINK });

    expect(() => {
      log.info(() => 'ignored');
      log.error('SECOND_INSTANCE', () => 'ignored', { developerError: true });
    }).not.toThrow();
  });
});
