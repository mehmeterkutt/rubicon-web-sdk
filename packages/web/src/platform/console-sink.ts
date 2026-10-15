import type { DefaultSink, LogLevel } from 'rubicon-analytics-core';

// The default sink of the browser (Web Logging 1, Web Configuration 2): the only code of the SDK that
// calls `console` (rule `console`). It writes when the developer gives no `logging.logger` and after
// theirs failed; the level was already checked by the core's `Log`, which alone decides whether a
// line is written.
//
// - Each line is one string, prefixed `[Rubicon]`; no object is passed, since a logged object stays
//   live and inspectable in the developer tools, and the caught error never reaches this sink.
// - `error` -> `console.error`, `warn` -> `console.warn`, `info` -> `console.info`, `debug` ->
//   `console.log`, because Chrome hides `console.debug` by default (Amplitude's reason).
// - A developer error with `debug: true` is written as `console.error(new Error(message))`, red and
//   with a stack (Web Public API 4); the `Error` is the one object this sink passes, as decided.
// - `console` is read at every call, never captured: a page that wraps or replaces it decides where
//   its console goes. A page that removed it, or a method that throws, costs the line only: nothing
//   reaches the host (root `CLAUDE.md`, non-negotiable 1).

const PREFIX = '[Rubicon] ';

type ConsoleMethod = 'error' | 'warn' | 'info' | 'log';

const METHODS: Readonly<Record<Exclude<LogLevel, 'off'>, ConsoleMethod>> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'log',
};

/** The browser's default sink, over `console`; one per instance and per factory log. */
export function createConsoleSink(): DefaultSink {
  return {
    write(level: LogLevel, message: string): void {
      if (level === 'off') return;
      call(METHODS[level], PREFIX + message);
    },
    writeDeveloperError(message: string): void {
      // Built inside the guard: a page that replaced `Error` must not break the call either.
      call('error', undefined, PREFIX + message);
    },
  };
}

function call(method: ConsoleMethod, line: string | undefined, errorMessage?: string): void {
  try {
    if (typeof console === 'undefined') return;
    const target: unknown = Reflect.get(console, method);
    if (typeof target !== 'function') return;
    const argument = errorMessage === undefined ? line : new Error(errorMessage);
    (target as (value: unknown) => unknown).call(console, argument);
  } catch {
    // A host that removed, replaced or broke `console` loses the line, never the page.
  }
}
