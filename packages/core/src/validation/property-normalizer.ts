import { utf8ByteLength } from '../json/utf8-byte-length';
import { formatIsoDate } from '../util/iso-dates';
import type { PropertyProblem, PropertyProblemKind } from './property-problem';
import type { PropertyValue } from './property-value';

/** An event or screen name: 1 to 255 UTF-16 code units (Serialization 3). */
export const MAX_NAME_LENGTH = 255;
/** A property key: 1 to 255 UTF-16 code units (Serialization 3). */
export const MAX_KEY_LENGTH = 255;
/** A string value is cut to 1024 UTF-16 code units (Serialization 3). */
export const MAX_STRING_LENGTH = 1024;
/** Properties of one event, super properties included (Serialization 3). */
export const MAX_PROPERTIES = 256;
/** Lists and objects nest at most 3 levels (Serialization 3, Android log 2.5). */
export const MAX_DEPTH = 3;
/** An event line, in UTF-8 bytes; over it the writer drops the event as `oversize` (Serialization 3). */
export const MAX_EVENT_BYTES = 32 * 1024;

/** Properties, traits or super properties after the normalizer, with what it dropped or changed. */
export interface NormalizedProperties {
  /** A deep copy made only of {@link PropertyValue}s; the caller's objects are never kept. */
  readonly values: Record<string, PropertyValue>;
  readonly problems: readonly PropertyProblem[];
  /**
   * The properties alone are over {@link MAX_EVENT_BYTES} in JSON, so every event that holds them
   * is over the limit: the walk stopped as soon as that was certain (section 15, step 2.5,
   * 2026-10-15). `values` then holds what was copied before the stop, itself over the limit, and
   * `problems` what was found before it. The normalizer drops nothing for it; the writer drops the
   * event as `oversize` (step 6.3b). `false` does not mean the event fits: escapes and the rest of
   * the event line are measured by the writer's scan.
   */
  readonly oversize: boolean;
}

/** An event's properties after {@link mergeSuperProperties}. */
export interface MergedProperties {
  readonly values: Record<string, PropertyValue>;
  readonly problems: readonly PropertyProblem[];
}

/** An event or screen name after {@link checkName}. */
export type NameCheck =
  { readonly valid: true; readonly name: string } | { readonly valid: false; readonly problem: PropertyProblem };

/**
 * Turns whatever the developer passes as properties, traits or super properties into a deep copy
 * made only of {@link PropertyValue}s, in one pass (Web Public API 4, Web Serialization 2,
 * Serialization 2 and 3): the port of the Android `PropertyNormalizer.normalize`. The same function
 * is the second pass over the properties a `beforeSend` hook returned (Event Model 3), so a hook
 * that puts a `Map` or a `NaN` back in is cleaned like a call.
 *
 * It never throws, runs no method of the caller's values (no `toJSON`, `valueOf` or `toString` of
 * theirs; only getters and `Proxy` traps, whose throws are caught) and never keeps a reference to the
 * caller's objects. A bad value costs only its key, a bad element of a list only that element; what
 * was dropped or changed is returned as {@link PropertyProblem}s for the caller to log
 * (`reportPropertyProblems`).
 *
 * `undefined` gives no properties. Anything other than a plain object or a `Map` with string keys
 * gives no properties and one problem with an empty path; the event is kept.
 *
 * The walk stops once the JSON of what it copied is certainly over `stopAboveBytes`, so a list of a
 * billion elements costs a few thousand reads (section 15, step 2.5, 2026-10-15; a web difference
 * from Android, which walks it whole): see {@link NormalizedProperties.oversize}. Only tests pass
 * another limit, `Infinity` for the whole walk.
 */
export function normalizeProperties(input: unknown, stopAboveBytes: number = MAX_EVENT_BYTES): NormalizedProperties {
  const walk: Walk = { problems: [], stopAbove: stopAboveBytes, bytes: 0, uncounted: 0 };
  const values: Record<string, PropertyValue> = {};
  if (input === undefined) return { values, problems: walk.problems, oversize: false };
  const entries = safely(() => entriesOf(input), null);
  if (entries === null) {
    walk.problems.push({ kind: 'unreadable', path: '' });
  } else if (entries === undefined) {
    walk.problems.push({ kind: 'unsupported-type', path: '', type: typeName(input) });
  } else {
    const extra = copyEntries(entries, values, '', 1, MAX_PROPERTIES, walk);
    if (extra > 0) walk.problems.push({ kind: 'too-many', path: '', count: extra });
  }
  return { values, problems: walk.problems, oversize: isOver(walk) };
}

/**
 * Merges super properties into an event's normalized properties: the event's own key wins, and
 * above {@link MAX_PROPERTIES} the super properties are dropped first, in their own order (Event
 * Model 1, Serialization 3, Android log 2.5). Both inputs are normalized already; the result is a new
 * object holding their values.
 */
export function mergeSuperProperties(
  own: Readonly<Record<string, PropertyValue>>,
  superProperties: Readonly<Record<string, PropertyValue>>,
): MergedProperties {
  const merged: Record<string, PropertyValue> = {};
  const ownKeys = Object.keys(own);
  const room = MAX_PROPERTIES - ownKeys.length;
  let kept = 0;
  let dropped = 0;
  for (const key of Object.keys(superProperties)) {
    if (hasOwn(own, key)) continue;
    if (kept < room) {
      define(merged, key, superProperties[key] ?? null);
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  for (const key of ownKeys) define(merged, key, own[key] ?? null);
  return { values: merged, problems: dropped > 0 ? [{ kind: 'too-many', path: '', count: dropped }] : [] };
}

/**
 * An event or screen name: a string of 1 to 255 code units that is not blank; never trimmed
 * (Serialization 3). A lone surrogate becomes U+FFFD, so none reaches the writer (Web Serialization
 * 1); the length does not change.
 */
export function checkName(name: unknown): NameCheck {
  if (typeof name !== 'string' || isBlank(name) || name.length > MAX_NAME_LENGTH) {
    return { valid: false, problem: { kind: 'invalid-name', path: '' } };
  }
  return { valid: true, name: replaceLoneSurrogates(name) };
}

/**
 * The top-level keys {@link normalizeProperties} would walk in `input`, as given, before any key is
 * checked: none for `undefined`, the own enumerable string keys of a plain object, the keys of a
 * `Map`. `undefined` for anything else, or when reading throws. The hook rules compare an automatic
 * event's keys with it (Android log 3.2), so they read the result as the second pass will.
 */
export function propertyKeys(input: unknown): readonly unknown[] | undefined {
  if (input === undefined) return [];
  return safely(() => entriesOf(input)?.keys, undefined);
}

/** Whether an event line is over {@link MAX_EVENT_BYTES} in UTF-8, measured by the scan (Web Serialization 1). */
export function isOversizeLine(line: string): boolean {
  return utf8ByteLength(line) > MAX_EVENT_BYTES;
}

/**
 * Unpaired UTF-16 surrogates replaced with U+FFFD; pairs and every other code unit kept, so the
 * length does not change (Serialization 2, Web Serialization 1).
 */
export function replaceLoneSurrogates(value: string): string {
  let out: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) {
      if (out !== undefined) out += value.charAt(i);
      continue;
    }
    const next = value.charCodeAt(i + 1);
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      if (out !== undefined) out += value.substring(i, i + 2);
      i += 1;
      continue;
    }
    if (out === undefined) out = value.substring(0, i);
    out += '\uFFFD';
  }
  return out ?? value;
}

// One property read: a getter that throws is caught where it is called (Web Serialization 2).
type Read = () => unknown;

// The elements of a list. `element` reads one when the walk reaches it and may run a getter or a trap
// that throws.
interface Elements {
  readonly length: number;
  element(index: number): unknown;
}

// The keys of an object, read when the walk starts, and its values, read when the walk reaches them.
interface Entries {
  readonly keys: readonly unknown[];
  value(index: number): unknown;
}

// One call's walk. `bytes` counts the UTF-8 bytes of the copy's JSON that will stay in the copy:
// the exact length without escapes, a lower bound with them. Once it passes `stopAbove`, every event
// holding the copy is over the limit whatever the rest of the input holds, so the walk stops, and the
// writer's decision is the one the whole walk would give (section 15, step 2.5, 2026-10-15).
interface Walk {
  readonly problems: PropertyProblem[];
  readonly stopAbove: number;
  bytes: number;
  // Above 0 inside a value that a later key of the same object replaces: walked, so its getters run
  // and its problems count as before, but its bytes are not counted.
  uncounted: number;
}

function isOver(walk: Walk): boolean {
  return walk.bytes > walk.stopAbove;
}

function count(walk: Walk, bytes: number): void {
  if (walk.uncounted === 0) walk.bytes += bytes;
}

// Returned by a row that does not apply, so the next row is tried.
const NOT_THIS: unique symbol = /*#__PURE__*/ Symbol('not this row');
// No value: dropped, with its problem recorded, or absent (`undefined` in an object).
const NONE: unique symbol = /*#__PURE__*/ Symbol('no value');
type Converted = PropertyValue | typeof NONE;
type Row = Converted | typeof NOT_THIS;

// The entries of a plain object or a Map, `undefined` for any other value. Reading the keys may run
// a `Proxy` trap; the caller catches.
function entriesOf(value: unknown): Entries | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const map = mapEntries(value, tagOf(value));
  if (map !== undefined) return map;
  return isPlainObject(value) ? objectEntries(value) : undefined;
}

// Rows 17 and 18. Own enumerable string keys; a getter or a trap that throws drops only its key.
function objectEntries(value: object): Entries {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return { keys, value: (index) => record[keys[index] as string] };
}

// A value read for the key or position `path` at `level` (a top-level property is at 1). `undefined`
// when it is dropped, with its problem recorded, or absent.
function normalizeEntry(read: Read, path: string, level: number, walk: Walk): PropertyValue | undefined {
  const value = safely(read, NOT_THIS);
  if (value === NOT_THIS) {
    walk.problems.push({ kind: 'unreadable', path });
    return undefined;
  }
  return normalizeValue(value, path, level, walk);
}

function normalizeValue(value: unknown, path: string, level: number, walk: Walk): PropertyValue | undefined {
  // A `Proxy` trap or a `Symbol.toStringTag` getter may throw anywhere below; the value is then
  // dropped as unreadable, never the event (Web Serialization 2), and what it counted is undone.
  const { problems, bytes, uncounted } = walk;
  const at = problems.length;
  const converted = safely(() => convert(value, path, level, walk), NOT_THIS);
  if (converted === NONE) return undefined;
  if (converted !== NOT_THIS) return converted;
  problems.length = at;
  walk.bytes = bytes;
  walk.uncounted = uncounted;
  problems.push({ kind: 'unreadable', path });
  return undefined;
}

// The rows of the Web Serialization 2 table, in its order. Rows 3 and 4 (`undefined` in an object
// and in a list) are decided by the containers, which know which one applies.
function convert(value: unknown, path: string, level: number, walk: Walk): Converted {
  const { problems } = walk;
  const drop = (kind: PropertyProblemKind, type: string = typeName(value)): typeof NONE => {
    problems.push({ kind, path, type });
    return NONE;
  };
  switch (typeof value) {
    case 'string': // 1. As is, lone surrogates replaced (and the 1024 limit, row 22).
      return cleanString(value, path, problems);
    case 'boolean': // 2.
      return value;
    case 'number': // 5 and 6. Finite numbers as is, also beyond the safe range.
      return Number.isFinite(value) ? value : drop('not-finite');
    case 'bigint': // 7. A number within the safe range, never a silent loss of precision.
      return bigIntToNumber(value) ?? drop('out-of-range');
    case 'undefined': // 3 and 4 are the containers'; nothing else passes `undefined` here.
      return NONE;
    case 'object':
      break;
    default: // 21. Functions and symbols.
      return drop('unsupported-type');
  }
  if (value === null) return null; // 2.
  const tag = tagOf(value);
  const row = boxed(value, tag, path, level, walk); // 8. Boxed primitives.
  if (row !== NOT_THIS) return row;
  if (tag === 'Date') return formatIsoDate(value as Date) ?? drop('out-of-range', 'Date'); // 9 and 10.
  const dateLibrary = dateLibraryName(value, tag); // 11. Temporal and date libraries, with the hint.
  if (dateLibrary !== undefined) return drop('date-library', dateLibrary);
  if (level > MAX_DEPTH && isContainer(value, tag)) return drop('too-deep'); // 22. Depth, which stops cycles.
  if (Array.isArray(value)) return list(arrayElements(value), path, level, walk); // 12.
  const set = setElements(value, tag); // 13.
  if (set !== undefined) return list(set, path, level, walk);
  const map = mapEntries(value, tag); // 14.
  if (map !== undefined) return object(map, path, level, walk);
  const typed = typedArrayElements(value); // 15.
  if (typed !== undefined) return list(typed, path, level, walk);
  if (BINARY_TAGS.indexOf(tag) >= 0) return drop('unsupported-type'); // 16.
  if (isPlainObject(value)) return object(objectEntries(value), path, level, walk); // 17 and 18.
  if (tag === 'URL') {
    // 19. Its `href`, read through the URL's own getter.
    const href = (value as { readonly href?: unknown }).href;
    if (typeof href === 'string') return cleanString(href, path, problems);
  }
  // 20 and 21. Any other object, `toJSON` or not (a foreign `toJSON` is never run): class instances,
  // `Error`, `RegExp`, `Promise`, DOM nodes, `window`.
  return drop('unsupported-type');
}

// `ArrayBuffer`, `DataView`, `Blob` and `File` are rejected by name (row 16); the shared buffer too.
const BINARY_TAGS: readonly string[] = ['ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Blob', 'File'];

// Row 8. The value of a `Number`, `String`, `Boolean` or `BigInt` object, checked with this realm's
// `valueOf`, which reads the internal slot and works on objects from any frame; a value that only
// claims the tag is not boxed.
function boxed(value: object, tag: string, path: string, level: number, walk: Walk): Row {
  const primitive = safely(() => unbox(value, tag), NOT_THIS);
  return primitive === NOT_THIS ? NOT_THIS : convert(primitive, path, level, walk);
}

// ES2020; absent below Chrome 67, Firefox 68 and Safari 14, where no BigInt object exists either.
declare const BigInt: { readonly prototype: { valueOf(this: unknown): unknown } } | undefined;

// Throws for an object without the slot; `NOT_THIS` for a tag that names no boxed primitive.
function unbox(value: object, tag: string): unknown {
  switch (tag) {
    case 'Number':
      return Number.prototype.valueOf.call(value);
    case 'String':
      return String.prototype.valueOf.call(value);
    case 'Boolean':
      return Boolean.prototype.valueOf.call(value);
    case 'BigInt':
      return typeof BigInt === 'undefined' ? NOT_THIS : BigInt.prototype.valueOf.call(value);
    default:
      return NOT_THIS;
  }
}

function bigIntToNumber(value: bigint): number | undefined {
  const number = Number(value);
  // Every bigint beyond the safe range converts to a number beyond it, rounded or not.
  return Number.isSafeInteger(number) ? number : undefined;
}

// Row 11. `Temporal` objects by their tag; moment, Day.js and Luxon objects by the marker each sets
// on its instances, read as an own data property so no getter runs. Plain objects never qualify.
function dateLibraryName(value: object, tag: string): string | undefined {
  if (tag.indexOf('Temporal.') === 0) return tag;
  if (isPlainObject(value)) return undefined;
  if (ownData(value, '_isAMomentObject') === true) return 'moment';
  if (ownData(value, '$isDayjsObject') === true || tagOf(ownData(value, '$d')) === 'Date') return 'Dayjs';
  if (ownData(value, 'isLuxonDateTime') === true) return 'DateTime';
  return undefined;
}

function isContainer(value: object, tag: string): boolean {
  return (
    Array.isArray(value) ||
    ((tag === 'Set' || tag === 'Map') && hasSlot(value, tag)) ||
    typedArrayTag(value) !== undefined ||
    isPlainObject(value)
  );
}

// The `size` getter of this realm's prototype reads the internal slot (any frame) and throws
// without it; nothing is copied.
function hasSlot(value: object, tag: 'Set' | 'Map'): boolean {
  const prototype: object = tag === 'Set' ? Set.prototype : Map.prototype;
  return safely(() => typeof Reflect.get(prototype, 'size', value) === 'number', false);
}

// Row 4: `undefined` and holes become `null`, so positions are kept; each element read on its own,
// when the walk reaches it, so a sparse array of any length costs only what is walked.
function arrayElements(array: readonly unknown[]): Elements {
  return { length: array.length, element: (index) => array[index] };
}

// Row 13, through this realm's `forEach`, which reads the internal slot (any frame) and never a
// method of the value. The elements are collected first, as a list of values, so a getter that
// changes the set while it is walked changes nothing.
function setElements(value: object, tag: string): Elements | undefined {
  if (tag !== 'Set') return undefined;
  const elements: unknown[] = [];
  const read = safely(() => {
    Set.prototype.forEach.call(value, (element: unknown) => elements.push(element));
    return true;
  }, false);
  return read ? { length: elements.length, element: (index) => elements[index] } : undefined;
}

// Row 14, as row 13.
function mapEntries(value: object, tag: string): Entries | undefined {
  if (tag !== 'Map') return undefined;
  const keys: unknown[] = [];
  const values: unknown[] = [];
  const read = safely(() => {
    Map.prototype.forEach.call(value, (element: unknown, key: unknown) => {
      keys.push(key);
      values.push(element);
    });
    return true;
  }, false);
  return read ? { keys, value: (index) => values[index] } : undefined;
}

// Row 15. The `%TypedArray%` prototype's tag and length getters read the internal slots, so a typed
// array from any frame qualifies and an impostor, a `Proxy` included, does not.
function typedArrayElements(value: object): Elements | undefined {
  if (typedArrayTag(value) === undefined) return undefined;
  const length = safely(() => readTypedArray(value, 'length'), undefined);
  if (typeof length !== 'number') return undefined;
  const elements = value as ArrayLike<unknown>;
  return { length, element: (index) => elements[index] };
}

function typedArrayTag(value: object): string | undefined {
  const tag = safely(() => readTypedArray(value, Symbol.toStringTag), undefined);
  return typeof tag === 'string' ? tag : undefined;
}

// Runs the `%TypedArray%` prototype's getter for `key` with `value` as its receiver.
function readTypedArray(value: object, key: PropertyKey): unknown {
  return Reflect.get(Object.getPrototypeOf(Int8Array.prototype) as object, key, value);
}

// Row 17. A prototype of `null`, or an `Object.prototype` of any realm: a prototype whose own
// prototype is `null` and whose `constructor` is a native `Object`, compared by source text, which
// is the same in every frame of an engine.
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = ownData(prototype, 'constructor');
  return typeof constructor === 'function' && functionSource(constructor) === functionSource(Object);
}

function functionSource(fn: unknown): string {
  return Function.prototype.toString.call(fn);
}

function list(elements: Elements, path: string, level: number, walk: Walk): PropertyValue[] {
  const copy: PropertyValue[] = [];
  count(walk, 2); // `[]`
  for (let index = 0; index < elements.length && !isOver(walk); index += 1) {
    const at = `${path}[${String(index)}]`;
    const element = safely(() => elements.element(index), NOT_THIS);
    if (element === NOT_THIS) {
      walk.problems.push({ kind: 'unreadable', path: at });
      continue;
    }
    // Row 4: `undefined` in a list is `null`, as `JSON.stringify` writes it.
    const normalized = element === undefined ? null : normalizeValue(element, at, level + 1, walk);
    if (normalized === undefined) continue;
    count(walk, (copy.length > 0 ? 1 : 0) + primitiveBytes(normalized));
    copy.push(normalized);
  }
  return copy;
}

function object(entries: Entries, path: string, level: number, walk: Walk): { [key: string]: PropertyValue } {
  const copy: { [key: string]: PropertyValue } = {};
  copyEntries(entries, copy, path, level + 1, Infinity, walk);
  return copy;
}

// Copies `entries` into `copy`, the values at `level`, at most `max` keys; returns how many more
// were dropped. Row 3: `undefined` is an absent key, without a problem (normalizeEntry gives
// `undefined`). A later key that becomes equal to an earlier one replaces its value, in its place.
function copyEntries(
  entries: Entries,
  copy: Record<string, PropertyValue>,
  parent: string,
  level: number,
  max: number,
  walk: Walk,
): number {
  const { keys } = entries;
  const lastOf = lastIndexes(keys);
  let kept = 0;
  let extra = 0;
  let counted = 0;
  count(walk, 2); // `{}`
  for (let index = 0; index < keys.length && !isOver(walk); index += 1) {
    const name = checkKey(keys[index], parent, walk.problems);
    if (name === undefined) continue;
    const replacing = hasOwn(copy, name);
    if (!replacing && kept === max) {
      extra += 1;
      continue;
    }
    const last = lastOf === undefined || lastOf.get(name) === index;
    if (!last) walk.uncounted += 1;
    const value = normalizeEntry(() => entries.value(index), parent === '' ? name : `${parent}.${name}`, level, walk);
    if (!last) walk.uncounted -= 1;
    if (value === undefined) continue;
    define(copy, name, value);
    if (!replacing) kept += 1;
    if (last) {
      // `"name":` and the value, after a comma from the second key on.
      count(walk, (counted > 0 ? 1 : 0) + utf8ByteLength(name) + 3 + primitiveBytes(value));
      counted += 1;
    }
  }
  return extra;
}

// The index of the last entry of each name when two entries share one (a lone surrogate replaced in
// a key, or a `Proxy` that lists a key twice), `undefined` when every name is distinct: the value of
// an earlier entry may be replaced, so the walk does not count it.
function lastIndexes(keys: readonly unknown[]): Map<string, number> | undefined {
  if (keys.length < 2) return undefined;
  const lastOf = new Map<string, number>();
  let shared = false;
  for (let index = 0; index < keys.length; index += 1) {
    const name = validKey(keys[index]);
    if (name === undefined) continue;
    if (lastOf.has(name)) shared = true;
    lastOf.set(name, index);
  }
  return shared ? lastOf : undefined;
}

// The UTF-8 bytes of a primitive's JSON: exact for `null`, a boolean and a number (`JSON.stringify`
// writes a finite number as `String` does, `-0` as `0`), a lower bound for a string, whose escapes
// add bytes; 0 for a list or an object, whose parts were counted as they were copied.
function primitiveBytes(value: PropertyValue): number {
  if (value === null) return 4;
  switch (typeof value) {
    case 'boolean':
      return value ? 4 : 5;
    case 'number':
      return String(value).length;
    case 'string':
      return utf8ByteLength(value) + 2;
    default:
      return 0;
  }
}

// Row 22: a key is a string of 1 to 255 code units that is not blank, never trimmed; a lone
// surrogate in it becomes U+FFFD, so none reaches the writer (Web Serialization 1).
function checkKey(key: unknown, parent: string, problems: PropertyProblem[]): string | undefined {
  const name = validKey(key);
  if (name !== undefined) return name;
  let problem: string;
  if (typeof key !== 'string') problem = typeName(key);
  else if (isBlank(key)) problem = 'blank';
  else problem = `${String(key.length)} characters`;
  problems.push({ kind: 'invalid-key', path: parent, type: problem });
  return undefined;
}

function validKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || isBlank(key) || key.length > MAX_KEY_LENGTH) return undefined;
  return replaceLoneSurrogates(key);
}

// Unpaired surrogates become U+FFFD; then the string is cut to 1024 code units, never inside a
// surrogate pair, with no marker (Serialization 2, 3).
function cleanString(value: string, path: string, problems: PropertyProblem[]): string {
  const clean = replaceLoneSurrogates(value);
  if (clean.length <= MAX_STRING_LENGTH) return clean;
  problems.push({ kind: 'truncated', path, type: 'string' });
  const last = clean.charCodeAt(MAX_STRING_LENGTH - 1);
  return clean.substring(0, last >= 0xd800 && last <= 0xdbff ? MAX_STRING_LENGTH - 1 : MAX_STRING_LENGTH);
}

// JavaScript's white space, the set `trim` removes; Kotlin's `isBlank` differs only in characters no
// name or key holds by intent.
function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}

/**
 * The type a problem names: `typeof` for primitives and functions, the `Object.prototype.toString`
 * tag for objects (`Date`, `Error`, `HTMLDivElement`), and the class name for a class instance. Never
 * the value; a tag or name that is not an identifier is not written.
 */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const tag = safely(() => tagOf(value), 'Object');
  if (tag !== 'Object') return tag;
  return safely(() => className(value), undefined) ?? 'Object';
}

function className(value: object): string | undefined {
  const prototype = Object.getPrototypeOf(value) as object | null;
  const constructor = prototype === null ? undefined : ownData(prototype, 'constructor');
  if (typeof constructor !== 'function') return undefined;
  const name = ownData(constructor, 'name');
  return typeof name === 'string' && IDENTIFIER.test(name) ? name : undefined;
}

const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/;

// The `Object.prototype.toString` tag: `Date` for `[object Date]`. A `Symbol.toStringTag` getter may
// run and throw; the callers catch.
function tagOf(value: unknown): string {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return IDENTIFIER.test(tag) ? tag : 'Object';
}

// An own data property's value; a getter is never run (only a `Proxy` trap can be).
function ownData(target: object, key: string): unknown {
  const descriptor = safely(() => Object.getOwnPropertyDescriptor(target, key), undefined);
  return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

// Keys are defined rather than assigned, so a `__proto__` key stays a key of the copy.
function define(target: object, key: string, value: PropertyValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function safely<T, F>(run: () => T, fallback: F): T | F {
  try {
    return run();
  } catch {
    return fallback;
  }
}
