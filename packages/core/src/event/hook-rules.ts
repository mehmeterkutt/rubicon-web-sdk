import type { Log } from '../log/log';
import { checkName, normalizeProperties, propertyKeys } from '../validation/property-normalizer';
import { reportPropertyProblems } from '../validation/property-problem';
import type { PropertyValue } from '../validation/property-value';
import type { BeforeSend } from './before-send';
import type { Event } from './event';

// The `beforeSend` chain and the rules a hook's result must meet (Public API 4, Web Public API 5,
// Android log 3.2 and 6.3, iOS log 3.2). `readonly` is compile-time only and a JavaScript hook can
// write anywhere, so the protection is here: each hook gets its own deep copy, its result is read
// once and checked against the SDK's event, and the event that goes on is rebuilt by the SDK from
// its own fixed fields and the result's name and values, normalized again (Event Model 3). Nothing
// of the hook's objects is kept. The pipeline (step 6.3a) calls `runHooks`.

/** Every {@link HookViolation}, so tests can iterate them. */
export const HOOK_VIOLATIONS = [
  'undefined',
  'promise',
  'unreadable',
  'null-for-automatic-event',
  'other-kind',
  'changed-fixed-fields',
  'invalid-name',
  'renamed-automatic-event',
  'changed-automatic-keys',
] as const;

/**
 * Why a hook's result is not accepted (`HOOK_VIOLATION`):
 *
 * - `undefined`: nothing was returned, a forgotten `return` (Web Public API 5);
 * - `promise`: a Promise or another thenable, an `async` hook (Web Public API 5);
 * - `unreadable`: reading the result threw, a throwing getter or `Proxy` trap;
 * - `null-for-automatic-event`: `null` for an automatic event, which only `autocapture` switches off;
 * - `other-kind`: not an object of the input's `type`;
 * - `changed-fixed-fields`: `source`, `messageId`, `timestamp`, `userId`, `deviceId` or `context`
 *   differ from the input's;
 * - `invalid-name`: a track or screen name that is not a string of 1 to 255 code units, or blank;
 * - `renamed-automatic-event`, `changed-automatic-keys`: an automatic event may change property
 *   values only.
 */
export type HookViolation = (typeof HOOK_VIOLATIONS)[number];

/** What {@link checkHookResult} found. */
export type HookCheck =
  | {
      readonly kind: 'accepted';
      /** The track or screen name to go on with, lone surrogates replaced; absent for identify. */
      readonly name: string | undefined;
      /** The result's properties or traits as returned, for the second pass of the normalizer. */
      readonly values: unknown;
    }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'violation'; readonly violation: HookViolation };

/**
 * Checks what a hook returned for `input`, the event the SDK gave it a copy of. `null` drops an
 * app event; anything else must be an object of the input's kind with the input's fixed fields and
 * `context` (compared by value, so a copy changed in place is caught), a valid name, and on an
 * automatic event the same name and the same top-level keys (Android log 3.2, 6.3). Every field is
 * read once; a read that throws makes the result `unreadable`. Never throws.
 */
export function checkHookResult(result: unknown, input: Event): HookCheck {
  if (result === undefined) return violation('undefined');
  if (result === null) return input.source === 'auto' ? violation('null-for-automatic-event') : DROPPED;
  try {
    return checkObject(result, input);
  } catch {
    return violation('unreadable');
  }
}

/** The outcome of the chain: the event to go on with, or a drop as `before_send`, already logged. */
export type HookOutcome =
  | {
      readonly kept: true;
      readonly event: Event;
      /**
       * The second pass over some hook's values stopped above the event size limit (section 15,
       * step 2.5, 2026-10-15); what the writer does with it is decided in step 6.3b.
       */
      readonly oversize: boolean;
    }
  | { readonly kept: false };

/**
 * Runs the hooks in order, synchronously, each on its own deep copy of the event (Web Public API
 * 5). `null` drops the event quietly (a DEBUG line with its `message_id`, Android log 6.3a); a throw
 * drops it with `HOOK_THREW`, the error going only to the developer's logger; `undefined`, a
 * Promise or a breach of the rules drops it with `HOOK_VIOLATION`, a developer error (Web Public
 * API 4). A returned Promise is never awaited and its rejection is caught, so it never becomes an
 * unhandled rejection of the page. Later hooks do not run after a drop. Never throws.
 */
export function runHooks(hooks: readonly BeforeSend[], event: Event, log: Log): HookOutcome {
  let current = event;
  let oversize = false;
  for (const hook of hooks) {
    let result: unknown;
    try {
      // Typed to return `unknown`: a function typed to return an event may still return anything.
      result = (hook as (event: Event) => unknown)(copyEvent(current));
    } catch (error) {
      log.error('HOOK_THREW', () => 'A beforeSend hook threw; the event was dropped', { error });
      return { kept: false };
    }
    const check = checkHookResult(result, current);
    if (check.kind === 'dropped') {
      const messageId = current.messageId;
      log.debug(() => `A beforeSend hook dropped ${messageId}`);
      return { kept: false };
    }
    if (check.kind === 'violation') {
      if (check.violation === 'promise') ignoreRejection(result);
      const text = VIOLATION_TEXT[check.violation];
      log.error('HOOK_VIOLATION', () => `A beforeSend hook ${text}; the event was dropped`, { developerError: true });
      return { kept: false };
    }
    const normalized = normalizeProperties(check.values);
    reportPropertyProblems(normalized.problems, log);
    oversize = oversize || normalized.oversize;
    current = withData(current, check.name, normalized.values);
  }
  return { kept: true, event: current, oversize };
}

/**
 * A deep copy of an event the SDK made, for a hook to change as it likes (Web Public API 5): every
 * object and list of the properties, traits and context is new. Keys are defined, not assigned, so a
 * `__proto__` property stays a property.
 */
export function copyEvent(event: Event): Event {
  const context = copyData(event.context);
  switch (event.type) {
    case 'track':
    case 'screen':
      return { ...event, properties: copyData(event.properties), context };
    case 'identify':
      return { ...event, traits: copyData(event.traits), context };
  }
}

const VIOLATION_TEXT: Readonly<Record<HookViolation, string>> = {
  undefined: 'returned undefined instead of the event or null',
  promise: 'returned a Promise; hooks must be synchronous',
  unreadable: 'returned an event that could not be read',
  'null-for-automatic-event': 'returned null for an automatic event',
  'other-kind': 'returned something that is not an event of its input type',
  'changed-fixed-fields': 'changed the source, ids, timestamp or context of an event',
  'invalid-name': 'returned an invalid event name',
  'renamed-automatic-event': 'renamed an automatic event',
  'changed-automatic-keys': 'added or removed top-level keys of an automatic event',
};

const DROPPED: HookCheck = { kind: 'dropped' };

function violation(kind: HookViolation): HookCheck {
  return { kind: 'violation', violation: kind };
}

// Reads every field once, in a fixed order; may throw (a getter or a `Proxy` trap), which the caller
// turns into `unreadable`.
function checkObject(result: unknown, input: Event): HookCheck {
  if (typeof result !== 'object' && typeof result !== 'function') return violation('other-kind');
  const fields = result as Readonly<Record<string, unknown>>;
  if (typeof fields.then === 'function') return violation('promise');
  if (typeof result !== 'object' || fields.type !== input.type) return violation('other-kind');
  const same =
    fields.source === input.source &&
    fields.messageId === input.messageId &&
    fields.timestamp === input.timestamp &&
    fields.userId === input.userId &&
    fields.deviceId === input.deviceId &&
    sameData(input.context, fields.context);
  if (!same) return violation('changed-fixed-fields');
  if (input.type === 'identify') {
    const traits = fields.traits;
    return checkKeys(input, input.traits, traits) ?? { kind: 'accepted', name: undefined, values: traits };
  }
  const name = checkName(fields.name);
  if (!name.valid) return violation('invalid-name');
  const properties = fields.properties;
  if (input.source === 'auto' && name.name !== input.name) return violation('renamed-automatic-event');
  return checkKeys(input, input.properties, properties) ?? { kind: 'accepted', name: name.name, values: properties };
}

// An automatic event keeps its top-level keys, in any order; values are free (Android log 3.2).
function checkKeys(
  input: Event,
  before: Readonly<Record<string, PropertyValue>>,
  after: unknown,
): HookCheck | undefined {
  if (input.source !== 'auto') return undefined;
  const keys = Object.keys(before);
  const returned = propertyKeys(after);
  if (returned?.length !== keys.length) return violation('changed-automatic-keys');
  const known = new Set<unknown>(keys);
  return returned.every((key) => known.has(key)) ? undefined : violation('changed-automatic-keys');
}

// Equal as data: the same primitives, and objects with the same keys holding a defined value, so
// a key the hook left out and one it kept as `undefined` read the same (Web Public API 4). Walks
// `expected`, the SDK's own context, so a cyclic or deep result costs no more than it.
function sameData(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) return expected === actual;
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual) !== Array.isArray(expected)) {
    return false;
  }
  const want = expected as Readonly<Record<string, unknown>>;
  const got = actual as Readonly<Record<string, unknown>>;
  const keys = definedKeys(want);
  if (definedKeys(got).length !== keys.length) return false;
  return keys.every((key) => sameData(want[key], got[key]));
}

function definedKeys(value: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

function withData(event: Event, name: string | undefined, values: Record<string, PropertyValue>): Event {
  switch (event.type) {
    case 'track':
    case 'screen':
      return { ...event, name: name ?? event.name, properties: values };
    case 'identify':
      return { ...event, traits: values };
  }
}

// A deep copy of the SDK's own data: plain objects, lists and primitives, nothing else.
function copyData<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((element: unknown) => copyData(element)) as T;
  const source = value as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: copyData(source[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}

// The hook's Promise is not awaited; a handler keeps its rejection from reaching the page as an
// unhandled rejection (Web Public API 5, root CLAUDE.md non-negotiable 1). A `then` that throws
// changes nothing: the event is dropped either way.
function ignoreRejection(thenable: unknown): void {
  try {
    (thenable as { then(onFulfilled: undefined, onRejected: () => void): unknown }).then(undefined, () => undefined);
  } catch {
    // Nothing to do: the event is already dropped.
  }
}
