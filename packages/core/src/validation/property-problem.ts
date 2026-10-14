import type { IssueCodeAt } from '../log/issue-code';
import type { Log } from '../log/log';

/**
 * Every {@link PropertyProblemKind}, so tests can iterate them.
 */
export const PROPERTY_PROBLEM_KINDS = [
  'unsupported-type',
  'date-library',
  'not-finite',
  'out-of-range',
  'unreadable',
  'invalid-key',
  'too-deep',
  'truncated',
  'too-many',
  'invalid-name',
] as const;

/**
 * What the normalizer dropped or changed, the port of the Android `PropertyProblem.Kind` with the
 * web's rows of Web Serialization 2:
 *
 * - `unsupported-type`: a value of a type the SDK does not send (a function, a `Symbol`, an `Error`,
 *   a class instance, an object with a `toJSON` of its own, a DOM node, ...); with an empty path,
 *   properties that are not an object at all;
 * - `date-library`: a `Temporal` value or a date-library object; the message says how to convert it
 *   (the counterpart of Android's `java.time` hint);
 * - `not-finite`: `NaN` or `Infinity`;
 * - `out-of-range`: a `BigInt` outside the safe integer range, an invalid `Date` or one outside the
 *   years 0000 to 9999;
 * - `unreadable`: a getter or a `Proxy` trap threw while the value was read;
 * - `invalid-key`: a key that is not a string, is blank, or is longer than 255 code units;
 * - `too-deep`: a list or object nested deeper than 3 levels, which also stops cycles;
 * - `truncated`: a string longer than 1024 code units, cut to 1024; logged once per key and never a
 *   developer error (Serialization 3);
 * - `too-many`: more than 256 properties; the extra ones were dropped, super properties first;
 * - `invalid-name`: an event or screen name that is blank or longer than 255 code units.
 *
 * Android's `JSON_TYPE` (`org.json` values) has no web counterpart.
 */
export type PropertyProblemKind = (typeof PROPERTY_PROBLEM_KINDS)[number];

/**
 * Something the normalizer dropped or changed. It names the property's path and the value's type,
 * never the value itself (Logging 4a, Web Public API 4).
 */
export interface PropertyProblem {
  readonly kind: PropertyProblemKind;
  /**
   * The key, with nested keys after dots and list positions in brackets: `cart.items[2]`. Empty for
   * the event name and for a problem about the whole properties object.
   */
  readonly path: string;
  /**
   * The type of the offending value or key (`typeof`, the `Object.prototype.toString` tag or a
   * class name), or for an invalid key what is wrong with it (`blank`, `300 characters`).
   */
  readonly type?: string;
  /** For `too-many`: how many properties were dropped. */
  readonly count?: number;
}

const CODES: Readonly<Record<PropertyProblemKind, IssueCodeAt<'warn'>>> = {
  'unsupported-type': 'PROPERTY_DROPPED',
  'date-library': 'PROPERTY_DROPPED',
  'not-finite': 'PROPERTY_DROPPED',
  'out-of-range': 'PROPERTY_DROPPED',
  unreadable: 'PROPERTY_DROPPED',
  'invalid-key': 'PROPERTY_DROPPED',
  'too-deep': 'PROPERTY_DROPPED',
  truncated: 'PROPERTY_TRUNCATED',
  'too-many': 'TOO_MANY_PROPERTIES',
  'invalid-name': 'INVALID_EVENT_NAME',
};

/** The issue code a problem of `kind` is logged with. */
export function propertyProblemCode(kind: PropertyProblemKind): IssueCodeAt<'warn'> {
  return CODES[kind];
}

/**
 * Whether a problem of `kind` is a developer error (Web Public API 4), the web form of Android's
 * `throwsInDebug`: every kind except a truncation, which is not an error (Serialization 3).
 */
export function isDeveloperError(kind: PropertyProblemKind): boolean {
  return kind !== 'truncated';
}

/**
 * The log line of `problem`, without its code: keys and types only, never a value or anything from
 * a caught error (Logging 4a, Web Logging 1).
 */
export function propertyProblemMessage(problem: PropertyProblem): string {
  const { path } = problem;
  const type = problem.type ?? 'value';
  const subject = path === '' ? 'Properties' : `Property "${path}"`;
  switch (problem.kind) {
    case 'unsupported-type':
      return path === ''
        ? `Properties dropped: ${type} is not an object or a Map.`
        : `${subject} dropped: ${type} is not supported.`;
    case 'date-library':
      // The web form of the hint of Serialization 2 (Web Serialization 2).
      return `${subject} dropped: ${type} is not supported. Pass a Date, epoch milliseconds or an ISO string instead.`;
    case 'not-finite':
      return `${subject} dropped: NaN and Infinity are not supported.`;
    case 'out-of-range':
      return `${subject} dropped: this ${type} cannot be sent without losing its value.`;
    case 'unreadable':
      return `${subject} dropped: reading the value threw.`;
    case 'invalid-key':
      return `Property key${path === '' ? '' : ` in "${path}"`} dropped: keys are non-blank strings of at most 255 characters (${type}).`;
    case 'too-deep':
      return `${subject} dropped: values nest at most 3 levels deep.`;
    case 'truncated':
      return `${subject} truncated to 1024 characters.`;
    case 'too-many':
      return `${String(problem.count ?? 0)} properties dropped: an event has at most 256, super properties are dropped first.`;
    case 'invalid-name':
      return 'Event dropped: its name is blank or longer than 255 characters.';
  }
}

/**
 * Logs `problems` as WARN lines with their codes, in order (Serialization 2, 3, Web Public API 4).
 * Every kind but a truncation is a developer error, which `debug` turns into the error form of the
 * default sink; nothing is ever thrown (Web Public API 4, Web Logging 1). A truncation is logged once
 * per key; the other codes at their frequency, `per_page`.
 */
export function reportPropertyProblems(problems: readonly PropertyProblem[], log: Log): void {
  for (const problem of problems) {
    log.warn(propertyProblemCode(problem.kind), () => propertyProblemMessage(problem), {
      developerError: isDeveloperError(problem.kind),
      repeatKey: problem.kind === 'truncated' ? problem.path : undefined,
    });
  }
}
