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
 */
export function normalizeProperties(input: unknown): NormalizedProperties {
  const problems: PropertyProblem[] = [];
  const values: Record<string, PropertyValue> = {};
  if (input === undefined) return { values, problems };
  const entries = safely(() => entriesOf(input), null);
  if (entries === null) {
    problems.push({ kind: 'unreadable', path: '' });
  } else if (entries === undefined) {
    problems.push({ kind: 'unsupported-type', path: '', type: typeName(input) });
  } else {
    let count = 0;
    let extra = 0;
    for (const [key, read] of entries) {
      const name = checkKey(key, '', problems);
      if (name === undefined) continue;
      const replacing = hasOwn(values, name);
      if (!replacing && count === MAX_PROPERTIES) {
        extra += 1;
        continue;
      }
      const value = normalizeEntry(read, name, 1, problems);
      if (value === undefined) continue;
      define(values, name, value);
      if (!replacing) count += 1;
    }
    if (extra > 0) problems.push({ kind: 'too-many', path: '', count: extra });
  }
  return { values, problems };
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
): NormalizedProperties {
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
type Entry = readonly [key: unknown, read: Read];

// Returned by a row that does not apply, so the next row is tried.
const NOT_THIS: unique symbol = /*#__PURE__*/ Symbol('not this row');
// No value: dropped, with its problem recorded, or absent (`undefined` in an object).
const NONE: unique symbol = /*#__PURE__*/ Symbol('no value');
type Converted = PropertyValue | typeof NONE;
type Row = Converted | typeof NOT_THIS;

// The entries of a plain object or a Map, `undefined` for any other value. Reading the keys may run
// a `Proxy` trap; the caller catches.
function entriesOf(value: unknown): Entry[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const map = mapEntries(value, tagOf(value));
  if (map !== undefined) return map;
  if (!isPlainObject(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).map((key): Entry => [key, () => record[key]]);
}

// A value read for the key or position `path` at `level` (a top-level property is at 1). `undefined`
// when it is dropped, with its problem recorded, or absent.
function normalizeEntry(
  read: Read,
  path: string,
  level: number,
  problems: PropertyProblem[],
): PropertyValue | undefined {
  const value = safely(read, NOT_THIS);
  if (value === NOT_THIS) {
    problems.push({ kind: 'unreadable', path });
    return undefined;
  }
  return normalizeValue(value, path, level, problems);
}

function normalizeValue(
  value: unknown,
  path: string,
  level: number,
  problems: PropertyProblem[],
): PropertyValue | undefined {
  // A `Proxy` trap or a `Symbol.toStringTag` getter may throw anywhere below; the value is then
  // dropped as unreadable, never the event (Web Serialization 2).
  const at = problems.length;
  const converted = safely(() => convert(value, path, level, problems), NOT_THIS);
  if (converted === NONE) return undefined;
  if (converted !== NOT_THIS) return converted;
  problems.length = at;
  problems.push({ kind: 'unreadable', path });
  return undefined;
}

// The rows of the Web Serialization 2 table, in its order. Rows 3 and 4 (`undefined` in an object
// and in a list) are decided by the containers, which know which one applies.
function convert(value: unknown, path: string, level: number, problems: PropertyProblem[]): Converted {
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
  const row = boxed(value, tag, path, level, problems); // 8. Boxed primitives.
  if (row !== NOT_THIS) return row;
  if (tag === 'Date') return formatIsoDate(value as Date) ?? drop('out-of-range', 'Date'); // 9 and 10.
  const dateLibrary = dateLibraryName(value, tag); // 11. Temporal and date libraries, with the hint.
  if (dateLibrary !== undefined) return drop('date-library', dateLibrary);
  if (level > MAX_DEPTH && isContainer(value, tag)) return drop('too-deep'); // 22. Depth, which stops cycles.
  if (Array.isArray(value)) return list(arrayElements(value), path, level, problems); // 12.
  const set = setElements(value, tag); // 13.
  if (set !== undefined) return list(set, path, level, problems);
  const map = mapEntries(value, tag); // 14.
  if (map !== undefined) return object(map, path, level, problems);
  const typed = typedArrayElements(value); // 15.
  if (typed !== undefined) return list(typed, path, level, problems);
  if (BINARY_TAGS.indexOf(tag) >= 0) return drop('unsupported-type'); // 16.
  if (isPlainObject(value)) {
    // 17 and 18. Own enumerable string keys; a getter or a trap that throws drops only its key.
    const record = value as Record<string, unknown>;
    return object(
      Object.keys(record).map((key): Entry => [key, () => record[key]]),
      path,
      level,
      problems,
    );
  }
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
function boxed(value: object, tag: string, path: string, level: number, problems: PropertyProblem[]): Row {
  const primitive = safely(() => unbox(value, tag), NOT_THIS);
  return primitive === NOT_THIS ? NOT_THIS : convert(primitive, path, level, problems);
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

function hasSlot(value: object, tag: 'Set' | 'Map'): boolean {
  return (tag === 'Set' ? setElements(value, tag) : mapEntries(value, tag)) !== undefined;
}

// Row 4: `undefined` and holes become `null`, so positions are kept; each element read on its own.
function arrayElements(array: readonly unknown[]): Read[] {
  const reads: Read[] = [];
  const length = array.length;
  for (let i = 0; i < length; i += 1) reads.push(() => array[i]);
  return reads;
}

// Row 13, through this realm's `forEach`, which reads the internal slot (any frame) and never a
// method of the value.
function setElements(value: object, tag: string): Read[] | undefined {
  if (tag !== 'Set') return undefined;
  const reads: Read[] = [];
  const read = safely(() => {
    Set.prototype.forEach.call(value, (element: unknown) => reads.push(() => element));
    return true;
  }, false);
  return read ? reads : undefined;
}

// Row 14, as row 13.
function mapEntries(value: object, tag: string): Entry[] | undefined {
  if (tag !== 'Map') return undefined;
  const entries: Entry[] = [];
  const read = safely(() => {
    Map.prototype.forEach.call(value, (element: unknown, key: unknown) => entries.push([key, () => element]));
    return true;
  }, false);
  return read ? entries : undefined;
}

// Row 15. The `%TypedArray%` prototype's tag and length getters read the internal slots, so a typed
// array from any frame qualifies and an impostor, a `Proxy` included, does not.
function typedArrayElements(value: object): Read[] | undefined {
  if (typedArrayTag(value) === undefined) return undefined;
  const length = safely(() => readTypedArray(value, 'length'), undefined);
  if (typeof length !== 'number') return undefined;
  const elements = value as ArrayLike<unknown>;
  const reads: Read[] = [];
  for (let i = 0; i < length; i += 1) reads.push(() => elements[i]);
  return reads;
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

function list(reads: readonly Read[], path: string, level: number, problems: PropertyProblem[]): PropertyValue[] {
  const copy: PropertyValue[] = [];
  reads.forEach((read, index) => {
    const at = `${path}[${String(index)}]`;
    const element = safely(read, NOT_THIS);
    if (element === NOT_THIS) {
      problems.push({ kind: 'unreadable', path: at });
      return;
    }
    // Row 4: `undefined` in a list is `null`, as `JSON.stringify` writes it.
    const normalized = element === undefined ? null : normalizeValue(element, at, level + 1, problems);
    if (normalized !== undefined) copy.push(normalized);
  });
  return copy;
}

function object(
  entries: readonly Entry[],
  path: string,
  level: number,
  problems: PropertyProblem[],
): { [key: string]: PropertyValue } {
  const copy: { [key: string]: PropertyValue } = {};
  for (const [key, read] of entries) {
    const name = checkKey(key, path, problems);
    if (name === undefined) continue;
    // Row 3: `undefined` is an absent key, without a problem (normalizeEntry gives `undefined`).
    const value = normalizeEntry(read, `${path}.${name}`, level + 1, problems);
    if (value !== undefined) define(copy, name, value);
  }
  return copy;
}

// Row 22: a key is a string of 1 to 255 code units that is not blank, never trimmed; a lone
// surrogate in it becomes U+FFFD, so none reaches the writer (Web Serialization 1).
function checkKey(key: unknown, parent: string, problems: PropertyProblem[]): string | undefined {
  let problem: string;
  if (typeof key !== 'string') problem = typeName(key);
  else if (isBlank(key)) problem = 'blank';
  else if (key.length > MAX_KEY_LENGTH) problem = `${String(key.length)} characters`;
  else return replaceLoneSurrogates(key);
  problems.push({ kind: 'invalid-key', path: parent, type: problem });
  return undefined;
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
