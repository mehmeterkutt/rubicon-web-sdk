import { RecordingLogger, RecordingSink } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import type { IssueCode, LogOptions, PropertyProblem } from '../../src';
import {
  checkName,
  ISSUE_CODES,
  isDeveloperError,
  Log,
  mergeSuperProperties,
  normalizeProperties,
  PROPERTY_PROBLEM_KINDS,
  propertyProblemCode,
  propertyProblemMessage,
  reportPropertyProblems,
} from '../../src';

// The "problem reporting" half of the Android PropertyNormalizerTest (Serialization 2, 3) for Web
// Public API 4 and Web Logging 1: every problem is a WARN line with its code under the log level;
// `debug` only turns a developer error into the error form of the default sink, and nothing throws.

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

class Order {
  constructor(readonly secret: string) {}
}

class Instant {
  get [Symbol.toStringTag](): string {
    return 'Temporal.Instant';
  }
}

describe('reportPropertyProblems', () => {
  it('without debug every problem is a WARN line with its code, and nothing is thrown', () => {
    const { log, sink, counted } = setup();
    const result = normalizeProperties({ t: new Instant(), long: 'x'.repeat(2000), '': 1 });

    reportPropertyProblems(result.problems, log);

    expect(counted).toEqual(['PROPERTY_DROPPED', 'PROPERTY_TRUNCATED', 'PROPERTY_DROPPED']);
    expect(sink.lines[0]).toEqual({
      level: 'warn',
      message:
        'PROPERTY_DROPPED: Property "t" dropped: Temporal.Instant is not supported. ' +
        'Pass a Date, epoch milliseconds or an ISO string instead.',
      developerErrorForm: false,
    });
    expect(sink.lines[1]).toEqual({
      level: 'warn',
      message: 'PROPERTY_TRUNCATED: Property "long" truncated to 1024 characters.',
      developerErrorForm: false,
    });
    // A second PROPERTY_DROPPED in the page is a debug line (per_page, Web Logging 2).
    expect(sink.lines[2]?.level).toBe('debug');
  });

  it('with debug a developer error takes the error form of the default sink, and nothing is thrown', () => {
    const { log, sink } = setup({ level: 'warn', debug: true });
    const result = normalizeProperties({ long: 'x'.repeat(2000), bad: new Order('secret') });

    expect(() => {
      reportPropertyProblems(result.problems, log);
    }).not.toThrow();

    expect(sink.lines).toEqual([
      {
        level: 'warn',
        message: 'PROPERTY_TRUNCATED: Property "long" truncated to 1024 characters.',
        developerErrorForm: false,
      },
      {
        level: 'error',
        message: 'PROPERTY_DROPPED: Property "bad" dropped: Order is not supported.',
        developerErrorForm: true,
      },
    ]);
  });

  it('a developer logger receives the WARN line with its normal level and message, debug or not', () => {
    const developer = new RecordingLogger();
    const { log } = setup({ level: 'warn', debug: true, logger: developer.logger });

    reportPropertyProblems(normalizeProperties({ bad: NaN }).problems, log);

    expect(developer.lines).toEqual([
      {
        level: 'warn',
        message: 'PROPERTY_DROPPED: Property "bad" dropped: NaN and Infinity are not supported.',
        error: undefined,
      },
    ]);
  });

  it.each([true, false])('logging.level "off" silences every problem with debug %s, still counted', (debug) => {
    const developer = new RecordingLogger();
    const withSink = setup({ level: 'off', debug });
    const withLogger = setup({ level: 'off', debug, logger: developer.logger });
    const result = normalizeProperties({ bad: () => 1, long: 'x'.repeat(2000) });

    for (const { log } of [withSink, withLogger]) reportPropertyProblems(result.problems, log);

    expect(withSink.sink.lines).toEqual([]);
    expect(developer.lines).toEqual([]);
    expect(withSink.counted).toEqual(['PROPERTY_DROPPED', 'PROPERTY_TRUNCATED']);
  });

  it('a truncation is never a developer error, even with debug, and is logged once per key', () => {
    const { log, sink, counted } = setup({ level: 'warn', debug: true });

    for (let i = 0; i < 2; i += 1) {
      reportPropertyProblems(normalizeProperties({ bio: 'x'.repeat(2000), note: 'y'.repeat(2000) }).problems, log);
    }

    expect(sink.lines).toEqual([
      { level: 'warn', message: 'PROPERTY_TRUNCATED: Property "bio" truncated to 1024 characters.', developerErrorForm: false },
      { level: 'warn', message: 'PROPERTY_TRUNCATED: Property "note" truncated to 1024 characters.', developerErrorForm: false },
    ]); // prettier-ignore
    expect(counted).toHaveLength(4);
  });

  it('a blank event name and too many properties are developer errors with their codes', () => {
    const { log, sink } = setup({ level: 'warn', debug: true });
    const name = checkName(' ');
    const many: Record<string, number> = {};
    for (let i = 0; i < 257; i += 1) many[`p${String(i)}`] = i;
    const problems: PropertyProblem[] = [...normalizeProperties(many).problems];
    if (!name.valid) problems.push(name.problem);

    reportPropertyProblems(problems, log);

    expect(sink.lines).toEqual([
      {
        level: 'error',
        message:
          'TOO_MANY_PROPERTIES: 1 properties dropped: an event has at most 256, super properties are dropped first.',
        developerErrorForm: true,
      },
      {
        level: 'error',
        message: 'INVALID_EVENT_NAME: Event dropped: its name is blank or longer than 255 characters.',
        developerErrorForm: true,
      },
    ]);
  });
});

describe('messages', () => {
  it("name keys and types, never values or a caught error's text", () => {
    const secret = 's3cr3t-value';
    const result = normalizeProperties({
      custom: new Order(secret),
      error: new Error(secret),
      big: BigInt('18446744073709551616'),
      date: new Date(NaN),
      fn: () => secret,
      getter: {
        get g(): unknown {
          throw new Error(secret);
        },
      },
      long: secret.repeat(200),
      [`k${'x'.repeat(300)}`]: secret,
      map: new Map<unknown, unknown>([[secret.length, secret]]),
    });
    const { log, sink } = setup();

    reportPropertyProblems(result.problems, log);

    expect(result.problems.map((problem) => problem.type)).toEqual([
      'Order',
      'Error',
      'bigint',
      'Date',
      'function',
      undefined,
      'string',
      '301 characters',
      'number',
    ]);
    for (const message of sink.messages) expect(message).not.toContain(secret);
  });

  it('a problem about the whole properties argument has its own wording', () => {
    expect(propertyProblemMessage(normalizeProperties(null).problems[0] ?? { kind: 'too-many', path: '' })).toBe(
      'Properties dropped: null is not an object or a Map.',
    );
    expect(propertyProblemMessage({ kind: 'unreadable', path: '' })).toBe(
      'Properties dropped: reading the value threw.',
    );
    expect(propertyProblemMessage({ kind: 'invalid-key', path: 'm', type: 'number' })).toBe(
      'Property key in "m" dropped: keys are non-blank strings of at most 255 characters (number).',
    );
  });

  it('each kind has a message and a WARN code of the catalogue; only a truncation is no developer error', () => {
    for (const kind of PROPERTY_PROBLEM_KINDS) {
      expect(propertyProblemMessage({ kind, path: 'p', type: 'Type', count: 3 })).not.toBe('');
      expect(ISSUE_CODES[propertyProblemCode(kind)].levels).toContain('warn');
    }
    expect(propertyProblemCode('invalid-name')).toBe('INVALID_EVENT_NAME');
    expect(propertyProblemCode('too-many')).toBe('TOO_MANY_PROPERTIES');
    expect(propertyProblemCode('truncated')).toBe('PROPERTY_TRUNCATED');
    expect(PROPERTY_PROBLEM_KINDS.filter((kind) => !isDeveloperError(kind))).toEqual(['truncated']);
  });

  it('super properties dropped by the merge are reported like any too-many problem', () => {
    const own: Record<string, number> = {};
    for (let i = 0; i < 256; i += 1) own[`p${String(i)}`] = i;
    const { log, counted } = setup();

    reportPropertyProblems(mergeSuperProperties(own, { s: 1 }).problems, log);

    expect(counted).toEqual(['TOO_MANY_PROPERTIES']);
  });
});
