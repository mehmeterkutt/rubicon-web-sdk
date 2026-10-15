// A recording `console` for the unit tests, installed on `globalThis` for one test and restored after
// it (packages/web/CLAUDE.md, Tests: every browser global is stubbed or provided per test).

/** One call the recording console received. */
export interface ConsoleCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

let saved: PropertyDescriptor | undefined;

/** Replaces `globalThis.console` with `value` until {@link restoreConsole}. */
export function replaceConsole(value: unknown): void {
  saved ??= Object.getOwnPropertyDescriptor(globalThis, 'console');
  Object.defineProperty(globalThis, 'console', { configurable: true, writable: true, value });
}

/** Installs a console whose five methods record their calls, and returns the record. */
export function recordConsole(): ConsoleCall[] {
  const calls: ConsoleCall[] = [];
  const method =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ method: name, args });
    };
  replaceConsole({
    error: method('error'),
    warn: method('warn'),
    info: method('info'),
    log: method('log'),
    debug: method('debug'),
  });
  return calls;
}

/** Puts the real console back; does nothing when none was replaced. */
export function restoreConsole(): void {
  if (saved === undefined) return;
  Object.defineProperty(globalThis, 'console', saved);
  saved = undefined;
}
