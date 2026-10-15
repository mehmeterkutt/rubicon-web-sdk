import { afterEach, describe, expect, it } from 'vitest';
import { createConsoleSink } from '../../src/platform/console-sink';
import { recordConsole, replaceConsole, restoreConsole } from './console-support';

// The default sink of Web Logging 1 and Web Configuration 2: `[Rubicon]`, the level mapping, debug
// through console.log, one string and no object, the developer-error form, console read per call and
// every call guarded.

afterEach(() => {
  restoreConsole();
});

describe('the console sink', () => {
  it('maps error, warn, info and debug to console.error, warn, info and log with the prefix', () => {
    const calls = recordConsole();
    const sink = createConsoleSink();
    sink.write('error', 'QUEUE_FULL: e');
    sink.write('warn', 'PROPERTY_DROPPED: w');
    sink.write('info', 'i');
    sink.write('debug', 'd');
    expect(calls).toEqual([
      { method: 'error', args: ['[Rubicon] QUEUE_FULL: e'] },
      { method: 'warn', args: ['[Rubicon] PROPERTY_DROPPED: w'] },
      { method: 'info', args: ['[Rubicon] i'] },
      { method: 'log', args: ['[Rubicon] d'] },
    ]);
  });

  it('never uses console.debug, which Chrome hides by default', () => {
    const calls = recordConsole();
    createConsoleSink().write('debug', 'd');
    expect(calls.map((call) => call.method)).toEqual(['log']);
  });

  it('writes nothing for the level off', () => {
    const calls = recordConsole();
    createConsoleSink().write('off', 'x');
    expect(calls).toEqual([]);
  });

  it('passes one string per line and no object', () => {
    const calls = recordConsole();
    const sink = createConsoleSink();
    for (const level of ['error', 'warn', 'info', 'debug'] as const) sink.write(level, 'line');
    for (const call of calls) {
      expect(call.args).toHaveLength(1);
      expect(call.args[0]).toBeTypeOf('string');
    }
  });

  it('writes a developer error as console.error(new Error(message)) with the prefix', () => {
    const calls = recordConsole();
    createConsoleSink().writeDeveloperError('SECOND_INSTANCE: twice');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('error');
    const error = calls[0]?.args[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('[Rubicon] SECOND_INSTANCE: twice');
    expect(calls[0]?.args).toHaveLength(1);
  });

  it('reads console at every call, so a console the page replaced later receives the line', () => {
    const sink = createConsoleSink();
    const first = recordConsole();
    sink.write('warn', 'one');
    const second = recordConsole();
    sink.write('warn', 'two');
    expect(first.map((call) => call.args[0])).toEqual(['[Rubicon] one']);
    expect(second.map((call) => call.args[0])).toEqual(['[Rubicon] two']);
  });

  it('calls the method with console as this', () => {
    const receivers: unknown[] = [];
    const page = {
      warn(this: unknown) {
        receivers.push(this);
      },
    };
    replaceConsole(page);
    createConsoleSink().write('warn', 'x');
    expect(receivers).toEqual([page]);
  });

  describe('a console the page removed or broke costs the line, never the page', () => {
    const cases: [string, () => void][] = [
      [
        'console removed',
        () => {
          replaceConsole(undefined);
        },
      ],
      [
        'console null',
        () => {
          replaceConsole(null);
        },
      ],
      [
        'a method missing',
        () => {
          replaceConsole({});
        },
      ],
      [
        'a method that is not a function',
        () => {
          replaceConsole({ error: 1, warn: 'x', info: null, log: {} });
        },
      ],
      [
        'methods that throw',
        () => {
          const thrower = () => {
            throw new Error('page console broke');
          };
          replaceConsole({ error: thrower, warn: thrower, info: thrower, log: thrower });
        },
      ],
      [
        'a console whose every read throws',
        () => {
          replaceConsole(
            new Proxy(
              {},
              {
                get() {
                  throw new Error('trap');
                },
              },
            ),
          );
        },
      ],
    ];
    for (const [name, install] of cases) {
      it(name, () => {
        install();
        const sink = createConsoleSink();
        expect(() => {
          for (const level of ['error', 'warn', 'info', 'debug'] as const) sink.write(level, 'line');
          sink.writeDeveloperError('SECOND_INSTANCE: x');
        }).not.toThrow();
      });
    }
  });
});
