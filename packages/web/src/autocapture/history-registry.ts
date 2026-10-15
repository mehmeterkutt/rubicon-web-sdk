// The history registry of Web Lifecycle 2: the only code that touches the `history` methods (source
// rule `history-wrap`). `history.pushState` and `history.replaceState` are wrapped once per page, by
// the first instance that starts with `page_views` on; every copy of the SDK on the page, of any
// version, finds the same registry at `window[Symbol.for("rubicon.history")]` (reached through
// `window`, not `globalThis`, which is ES2020: Changed on note of 2026-10-15) and never wraps again,
// so two copies or two bundles never double a page view, and a library that wraps after us hides
// nothing. The wrapper calls the original first, with its arguments and `this`, returns what it
// returned and lets what it throws reach the caller unchanged; then it tells the registry's current
// listener, inside `try/catch`. The wrapping is never undone; only the tests undo it.

const REGISTRY = 'rubicon.history';

/** Which history method was called; the listener reads the new URL from `location`. */
export type HistoryMethod = 'pushState' | 'replaceState';

/** Told after every `pushState` and `replaceState` of the page, once the original has returned. */
export type HistoryListener = (method: HistoryMethod) => void;

/**
 * What every copy of the SDK finds under the key, a contract between versions like the page marker
 * (Web Configuration 3): only `current` is read, so it never changes. The instance that captures page
 * views sets it when it starts and clears it when it stops.
 */
export interface HistoryRegistry {
  current: HistoryListener | undefined;
}

/** How to put `history` back as it was; tests only. */
interface Installed {
  readonly registry: HistoryRegistry;
  readonly undo: () => void;
}

// The registry this copy installed, for `resetHistoryForTests`.
let installed: Installed | undefined;

/**
 * The page's registry, installed with the two wrappers when no copy has done it yet; `undefined`
 * when the key holds something else or cannot be defined, which costs the single-page navigations
 * only. A throw (a page whose `history` cannot be replaced) is the caller's to catch.
 */
export function historyRegistry(): HistoryRegistry | undefined {
  // Anything else under the key is no registry, and then nothing is wrapped: the key is taken, and
  // wrapping again could double the page views.
  if (Reflect.has(window, Symbol.for(REGISTRY))) return readRegistry();
  const registry: HistoryRegistry = { current: undefined };
  if (!Reflect.defineProperty(window, Symbol.for(REGISTRY), { value: registry, configurable: true })) return undefined;
  const undoPush = wrap(registry, 'pushState');
  const undoReplace = wrap(registry, 'replaceState');
  installed = {
    registry,
    undo: () => {
      undoPush();
      undoReplace();
      Reflect.deleteProperty(window, Symbol.for(REGISTRY));
    },
  };
  return registry;
}

/**
 * Puts back the `history` methods this copy wrapped and removes the registry, so the next test starts
 * from an unwrapped page (`packages/web/CLAUDE.md`, Tests). Never called by the SDK itself.
 */
export function resetHistoryForTests(): void {
  const current = installed;
  installed = undefined;
  current?.undo();
}

// Another copy's registry, checked before it is trusted.
function readRegistry(): HistoryRegistry | undefined {
  const value: unknown = Reflect.get(window, Symbol.for(REGISTRY));
  return typeof value === 'object' && value !== null && 'current' in value ? (value as HistoryRegistry) : undefined;
}

// Replaces `history[method]` with a wrapper; returns how to put the original back.
function wrap(registry: HistoryRegistry, method: HistoryMethod): () => void {
  const own = Object.getOwnPropertyDescriptor(history, method);
  const original: unknown = Reflect.get(history, method);
  if (typeof original !== 'function') return () => undefined;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const result: unknown = Reflect.apply(original, this, args);
    notify(registry, method);
    return result;
  };
  if (method === 'pushState') history.pushState = wrapper;
  else history.replaceState = wrapper;
  return () => {
    if (own === undefined) Reflect.deleteProperty(history, method);
    else Object.defineProperty(history, method, own);
  };
}

// The SDK's part never reaches the page's call (root `CLAUDE.md`, non-negotiable 1).
function notify(registry: HistoryRegistry, method: HistoryMethod): void {
  try {
    const listener = registry.current;
    if (typeof listener === 'function') listener(method);
  } catch {
    // The listener logs its own failures; nothing may reach the page's `pushState`.
  }
}
