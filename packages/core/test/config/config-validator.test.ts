import { RecordingLogger, RecordingSink, SeededRandom, WhatwgUrlParser } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  AUTOCAPTURE_TYPES,
  CONSENTS,
  CONTEXT_FIELDS,
  DEFAULT_HOST,
  ISSUE_CODES,
  Log,
  reportConfig,
  validateConfig,
} from '../../src';
import type {
  BeforeSend,
  ConfigSnapshot,
  ConfigValidation,
  EventObserver,
  IssueCode,
  LogLevel,
  PageScheme,
  RubiconLogger,
} from '../../src';

// The port of the Android ConfigValidatorTest (Configuration 2 to 5, Android log 3.1) with the web
// rows of Web Configuration 1, 4 and 6: the wrong-type row, the closed sets of Web Lifecycle 8 and
// Web Context 5, `session.inactivityTimeoutMs` (Web Session 3), the browser-only groups, and the
// mixed-content reading of CLEARTEXT_HOST (Web Logging 3). Android's "frozen config" tests have no
// counterpart: the web keeps nothing of the caller's object instead of freezing it, which the
// "config snapshot" tests prove.

const urls = new WhatwgUrlParser();

function validate(input: unknown, pageScheme: PageScheme = 'https'): ConfigValidation {
  return validateConfig(input, { urls, pageScheme });
}

function snapshotOf(input: unknown): ConfigSnapshot {
  const { snapshot } = validate(input);
  if (snapshot === undefined) throw new Error('no snapshot');
  return snapshot;
}

const codes = (validation: ConfigValidation): IssueCode[] => validation.issues.map((issue) => issue.code);
const texts = (validation: ConfigValidation): string[] => validation.issues.map((issue) => issue.text);

/** Reports as the factory will: a `Log` made of the validated logging settings over a recording sink. */
function report(validation: ConfigValidation, level?: LogLevel) {
  const sink = new RecordingSink();
  const counted: IssueCode[] = [];
  const { logSettings } = validation;
  const log = new Log({
    level: level ?? logSettings.level,
    debug: logSettings.debug,
    logger: logSettings.logger,
    sink,
    issues: { increment: (code) => counted.push(code) },
  });
  reportConfig(validation, log);
  return { sink, counted };
}

const KEY = 'rk_test';

describe('validateConfig', () => {
  describe('default values', () => {
    it('every setting has its decided default', () => {
      const snapshot = snapshotOf({ apiKey: KEY });

      expect(snapshot.apiKey).toBe(KEY);
      expect(snapshot.host).toBe('https://api.rubicon.example');
      expect(snapshot.host).toBe(DEFAULT_HOST);
      expect(snapshot.hostSecurity).toBe('encrypted');
      expect(snapshot.debug).toBe(false);
      expect(snapshot.beforeSend).toEqual([]);
      expect(snapshot.flushAt).toBe(30);
      expect(snapshot.flushIntervalMs).toBe(5_000);
      expect([...snapshot.immediateEvents]).toEqual([]);
      expect(snapshot.inactivityTimeoutMs).toBe(1_800_000);
      expect([...snapshot.autocapture]).toEqual(['sessions', 'page_views', 'network_requests']);
      expect([...snapshot.disabledFields]).toEqual([]);
      expect(snapshot.app).toEqual({});
      expect(snapshot.pageQueryParams).toEqual([]);
      expect(snapshot.pageTitle).toBe(false);
      expect(snapshot.crossSubdomain).toBe(true);
      expect(snapshot.cookieDomain).toBeUndefined();
      expect(snapshot.defaultConsent).toBe('granted');
      expect(snapshot.persistConsent).toBe(true);
      expect(snapshot.logging).toEqual({ level: 'warn', debug: false });
      expect(snapshot.sendDiagnostics).toBe(true);
      expect({ ...snapshot.headers }).toEqual({});
    });

    it('the default configuration validates without issues', () => {
      const validation = validate({ apiKey: KEY });
      const snapshot = validation.snapshot!;

      expect(validation.issues).toEqual([]);
      expect(snapshot.batchUrl).toBe('https://api.rubicon.example/v1/batch');
      expect(snapshot.configUrl).toBe('https://api.rubicon.example/v1/config');
    });

    it('the closed sets hold the decided values', () => {
      expect(AUTOCAPTURE_TYPES).toEqual(['sessions', 'page_views', 'network_requests']);
      expect(CONSENTS).toEqual(['granted', 'pending']);
      expect(CONTEXT_FIELDS).toHaveLength(17);
      for (const absent of ['library.name', 'page.title', 'app.build', 'os.version', 'network.type']) {
        expect(CONTEXT_FIELDS).not.toContain(absent);
      }
    });

    it('a group given in part keeps the defaults of its other settings', () => {
      const snapshot = snapshotOf({ apiKey: KEY, flush: { at: 20 }, logging: { sendDiagnostics: false } });

      expect(snapshot.flushAt).toBe(20);
      expect(snapshot.flushIntervalMs).toBe(5_000);
      expect(snapshot.logging.level).toBe('warn');
      expect(snapshot.sendDiagnostics).toBe(false);
    });
  });

  describe('numeric bounds', () => {
    function expectClamped(input: object, read: (snapshot: ConfigSnapshot) => number, expected: number) {
      const validation = validate({ apiKey: KEY, ...input });
      expect(read(validation.snapshot!)).toBe(expected);
      expect(codes(validation)).toEqual(['SETTING_OUT_OF_BOUNDS']);
      const { sink } = report(validation, 'debug');
      expect(sink.lines.map((line) => line.level)).toEqual(['warn', 'info']);
    }

    function expectAccepted(input: object, read: (snapshot: ConfigSnapshot) => number, expected: number) {
      const validation = validate({ apiKey: KEY, ...input });
      expect(read(validation.snapshot!)).toBe(expected);
      expect(validation.issues).toEqual([]);
    }

    it('flush at accepts 1 to 100', () => {
      expectAccepted({ flush: { at: 1 } }, (s) => s.flushAt, 1);
      expectAccepted({ flush: { at: 100 } }, (s) => s.flushAt, 100);
    });

    it('flush at is clamped', () => {
      expectClamped({ flush: { at: 0 } }, (s) => s.flushAt, 1);
      expectClamped({ flush: { at: 101 } }, (s) => s.flushAt, 100);
      expectClamped({ flush: { at: -2_147_483_648 } }, (s) => s.flushAt, 1);
      expectClamped({ flush: { at: 1e21 } }, (s) => s.flushAt, 100);
    });

    it('flush interval accepts one second to ten minutes', () => {
      expectAccepted({ flush: { intervalMs: 1_000 } }, (s) => s.flushIntervalMs, 1_000);
      expectAccepted({ flush: { intervalMs: 600_000 } }, (s) => s.flushIntervalMs, 600_000);
    });

    it('flush interval is clamped', () => {
      expectClamped({ flush: { intervalMs: 999 } }, (s) => s.flushIntervalMs, 1_000);
      expectClamped({ flush: { intervalMs: 600_001 } }, (s) => s.flushIntervalMs, 600_000);
    });

    it('the inactivity timeout accepts one minute to two hours (Web Session 3)', () => {
      expectAccepted({ session: { inactivityTimeoutMs: 60_000 } }, (s) => s.inactivityTimeoutMs, 60_000);
      expectAccepted({ session: { inactivityTimeoutMs: 7_200_000 } }, (s) => s.inactivityTimeoutMs, 7_200_000);
    });

    it('the inactivity timeout is clamped', () => {
      expectClamped({ session: { inactivityTimeoutMs: 59_999 } }, (s) => s.inactivityTimeoutMs, 60_000);
      expectClamped({ session: { inactivityTimeoutMs: 7_200_001 } }, (s) => s.inactivityTimeoutMs, 7_200_000);
    });

    it('an out-of-bounds number names the setting and its bounds, a developer error', () => {
      const validation = validate({ apiKey: KEY, flush: { at: 0 } });

      expect(validation.issues).toEqual([
        {
          level: 'warn',
          code: 'SETTING_OUT_OF_BOUNDS',
          text: 'flush.at is 0, outside 1 to 100; 1 is used.',
          developerError: true,
        },
      ]);
    });
  });

  describe('api key', () => {
    it.each(['', ' ', '\t\n'])('a blank key %j stops the SDK with an ERROR', (apiKey) => {
      const validation = validate({ apiKey });

      expect(validation.snapshot).toBeUndefined();
      expect(codes(validation)).toEqual(['INVALID_API_KEY']);
      const { sink } = report(validation);
      expect(sink.lines).toEqual([
        {
          level: 'error',
          message: 'INVALID_API_KEY: The API key is blank; the SDK does nothing.',
          developerErrorForm: false,
        },
      ]);
    });

    it.each([undefined, null, 42, ['rk'], { key: 'rk' }])('a key %j that is not a string stops the SDK', (apiKey) => {
      const validation = validate({ apiKey });

      expect(validation.snapshot).toBeUndefined();
      expect(texts(validation)).toEqual(['The API key is missing or not a string; the SDK does nothing.']);
    });

    it.each([undefined, null, 'rk_test', 42, [KEY]])(
      'a configuration %j that is not an object stops the SDK',
      (input) => {
        const validation = validate(input);

        expect(validation.snapshot).toBeUndefined();
        expect(codes(validation)).toEqual(['INVALID_API_KEY']);
      },
    );

    it('the key is used as given, never trimmed', () => {
      expect(snapshotOf({ apiKey: ' rk_test ' }).apiKey).toBe(' rk_test ');
    });

    it('the key never appears in a log line or a string form', () => {
      const validation = validate({ apiKey: 'rk_live_secret', flush: { at: 0 }, host: 'http://10.0.2.2' }, 'http');
      const { sink } = report(validation, 'debug');

      expect(String(validation.snapshot)).toBe('ConfigSnapshot(host=http://10.0.2.2, debug=false)');
      expect(sink.messages.join('\n')).not.toContain('rk_live_secret');
      expect(sink.messages).toContain('Sending to http://10.0.2.2');
    });
  });

  describe('host url', () => {
    it.each([
      ['https://api.example.com', 'https://api.example.com'],
      ['https://api.example.com/', 'https://api.example.com'],
      ['https://intranet.example.com/analytics', 'https://intranet.example.com/analytics'],
      ['https://intranet.example.com/analytics/', 'https://intranet.example.com/analytics'],
      ['https://api.example.com:8443', 'https://api.example.com:8443'],
      ['HTTPS://api.example.com', 'HTTPS://api.example.com'],
      ['https://10.0.0.5', 'https://10.0.0.5'],
    ])('a base URL %j is accepted as %j and its endpoints appended', (host, expected) => {
      const validation = validate({ apiKey: KEY, host });

      expect(validation.issues).toEqual([]);
      expect(validation.snapshot!.host).toBe(expected);
      expect(validation.snapshot!.batchUrl).toBe(`${expected}/v1/batch`);
      expect(validation.snapshot!.configUrl).toBe(`${expected}/v1/config`);
    });

    it.each([
      '',
      'api.example.com',
      'ftp://api.example.com',
      'https://',
      'https:///path',
      'https://api.example.com?key=1',
      'https://api.example.com/#part',
      'https://user:pass@api.example.com',
      ' https://api.example.com',
      'https://api.example.com ',
      'not a url',
      'https://exa mple.com',
    ])('an invalid host %j stops the SDK with an ERROR that never repeats the text', (host) => {
      const validation = validate({ apiKey: KEY, host });

      expect(validation.snapshot).toBeUndefined();
      expect(codes(validation)).toEqual(['INVALID_HOST']);
      expect(validation.issues[0]!.level).toBe('error');
      expect(validation.issues[0]!.developerError).toBe(true);
      if (host.trim() !== '') expect(validation.issues[0]!.text).not.toContain(host.trim());
    });

    it('the message says what is wrong', () => {
      expect(texts(validate({ apiKey: KEY, host: 'https://user:pass@api.example.com' }))).toEqual([
        'host has user info; the SDK does nothing.',
      ]);
      expect(texts(validate({ apiKey: KEY, host: 'https://api.example.com?token=1' }))).toEqual([
        'host has a query; the SDK does nothing.',
      ]);
    });

    it.each([null, 42, true, ['https://api.example.com'], { href: 'https://api.example.com' }])(
      'a host %j that is not a string stops the SDK rather than sending to the default host',
      (host) => {
        const validation = validate({ apiKey: KEY, host });

        expect(validation.snapshot).toBeUndefined();
        expect(codes(validation)).toEqual(['INVALID_HOST']);
        expect(validation.issues[0]!.text).toMatch(/^host is .+, not a string; the SDK does nothing\.$/);
      },
    );

    it('an invalid key and an invalid host are both reported', () => {
      expect(codes(validate({ apiKey: '', host: 'ftp://x' }))).toEqual(['INVALID_API_KEY', 'INVALID_HOST']);
    });

    it('http works with a WARN on an http page, the text of Web Logging 3', () => {
      const validation = validate({ apiKey: KEY, host: 'http://10.0.2.2:8080' }, 'http');

      expect(validation.snapshot!.host).toBe('http://10.0.2.2:8080');
      expect(validation.snapshot!.hostSecurity).toBe('cleartext');
      expect(validation.issues).toEqual([
        {
          level: 'warn',
          code: 'CLEARTEXT_HOST',
          text: 'The host uses http://; events travel unencrypted.',
          developerError: false,
        },
      ]);
    });

    it('http to localhost or 127.0.0.1 from an https page is a WARN, since the browser allows it', () => {
      for (const host of ['http://localhost:8080/', 'http://127.0.0.1:8080']) {
        const validation = validate({ apiKey: KEY, host }, 'https');
        expect(validation.snapshot!.hostSecurity).toBe('cleartext');
        expect(validation.issues.map((issue) => [issue.code, issue.level])).toEqual([['CLEARTEXT_HOST', 'warn']]);
      }
    });

    it('http to any other host from an https page is an ERROR: mixed content, nothing will be sent', () => {
      const validation = validate({ apiKey: KEY, host: 'http://api.example.com' }, 'https');

      expect(validation.snapshot!.hostSecurity).toBe('blocked');
      expect(validation.issues).toEqual([
        {
          level: 'error',
          code: 'CLEARTEXT_HOST',
          text:
            'The host uses http://, which the browser blocks from an https page as mixed content; ' +
            'nothing is sent until host uses https://.',
          developerError: false,
        },
      ]);
    });

    it('the effective host is logged once at INFO, after the issues', () => {
      const validation = validate({ apiKey: KEY, host: 'https://intranet.example.com/analytics/', flush: { at: 0 } });
      const { sink } = report(validation, 'debug');

      expect(sink.messages).toEqual([
        'SETTING_OUT_OF_BOUNDS: flush.at is 0, outside 1 to 100; 1 is used.',
        'Sending to https://intranet.example.com/analytics',
      ]);
    });

    it('a configuration that does not start the SDK logs no host', () => {
      const { sink } = report(validate({ apiKey: '' }), 'debug');
      expect(sink.messages.some((message) => message.startsWith('Sending to'))).toBe(false);
    });
  });

  describe('custom headers', () => {
    it.each([
      'Authorization',
      'authorization',
      'AUTHORIZATION',
      'Content-Type',
      'Content-Encoding',
      'Content-Length',
      'User-Agent',
      'Host',
      'If-None-Match',
      'X-Rubicon-Version',
      'x-rubicon-anything',
    ])('a reserved header %j is ignored with a WARN, a developer error', (name) => {
      const validation = validate({ apiKey: KEY, network: { headers: { [name]: 'v', 'X-Gateway-Token': 't' } } });

      expect({ ...validation.snapshot!.headers }).toEqual({ 'X-Gateway-Token': 't' });
      expect(validation.issues).toEqual([
        {
          level: 'warn',
          code: 'RESERVED_HEADER',
          text: `network.headers: "${name}" is set by the SDK and cannot be replaced; it is ignored.`,
          developerError: true,
        },
      ]);
    });

    it('other headers are kept, and their values are never logged', () => {
      const validation = validate({
        apiKey: KEY,
        network: { headers: { 'X-Gateway-Token': 'token-123', Authorization: 'secret-456', 'X-Bad': 7 } },
      });
      const { sink } = report(validation, 'debug');

      expect({ ...validation.snapshot!.headers }).toEqual({ 'X-Gateway-Token': 'token-123' });
      expect(codes(validation)).toEqual(['RESERVED_HEADER', 'SETTING_WRONG_TYPE']);
      expect(texts(validation)[1]).toBe('network.headers["X-Bad"] is a number, not a string; it is dropped.');
      for (const message of sink.messages) {
        expect(message).not.toContain('token-123');
        expect(message).not.toContain('secret-456');
      }
    });

    it('a header named __proto__ stays a header and changes no prototype', () => {
      const headers = Object.defineProperty({}, '__proto__', { value: 'x', enumerable: true });
      const snapshot = snapshotOf({ apiKey: KEY, network: { headers } });

      expect(Object.keys(snapshot.headers)).toEqual(['__proto__']);
      expect(Object.getPrototypeOf(snapshot.headers)).toBeNull();
    });
  });

  describe('wrong types (Web Configuration 1)', () => {
    // Every setting with a value of the wrong type: the default is used, SETTING_WRONG_TYPE.
    const rows: [string, object, (snapshot: ConfigSnapshot) => unknown, unknown, string][] = [
      [
        'debug',
        { debug: 'true' },
        (s) => s.debug,
        false,
        'debug is a string, not a boolean; the default false is used.',
      ],
      [
        'beforeSend',
        { beforeSend: () => null },
        (s) => s.beforeSend,
        [],
        'beforeSend is a function, not an array; the default is used.',
      ],
      ['flush', { flush: 20 }, (s) => s.flushAt, 30, 'flush is a number, not an object; its defaults are used.'],
      [
        'flush.at',
        { flush: { at: '20' } },
        (s) => s.flushAt,
        30,
        'flush.at is a string, not a whole number; the default 30 is used.',
      ],
      [
        'flush.at (fraction)',
        { flush: { at: 20.5 } },
        (s) => s.flushAt,
        30,
        'flush.at is a fractional number, not a whole number; the default 30 is used.',
      ],
      [
        'flush.at (NaN)',
        { flush: { at: Number.NaN } },
        (s) => s.flushAt,
        30,
        'flush.at is NaN, not a whole number; the default 30 is used.',
      ],
      [
        'flush.intervalMs',
        { flush: { intervalMs: Infinity } },
        (s) => s.flushIntervalMs,
        5_000,
        'flush.intervalMs is not finite, not a whole number; the default 5000 is used.',
      ],
      [
        'flush.immediateEvents',
        { flush: { immediateEvents: 'Purchase' } },
        (s) => [...s.immediateEvents],
        [],
        'flush.immediateEvents is a string, not an array; the default is used.',
      ],
      [
        'session.inactivityTimeoutMs',
        { session: { inactivityTimeoutMs: null } },
        (s) => s.inactivityTimeoutMs,
        1_800_000,
        'session.inactivityTimeoutMs is null, not a whole number; the default 1800000 is used.',
      ],
      [
        'autocapture.enabled',
        { autocapture: { enabled: 'sessions' } },
        (s) => [...s.autocapture],
        ['sessions', 'page_views', 'network_requests'],
        'autocapture.enabled is a string, not an array; the default is used.',
      ],
      [
        'context',
        { context: [] },
        (s) => [...s.disabledFields],
        [],
        'context is an array, not an object; its defaults are used.',
      ],
      [
        'context.disabledFields',
        { context: { disabledFields: new Set(['locale']) } },
        (s) => [...s.disabledFields],
        [],
        'context.disabledFields is an object, not an array; the default is used.',
      ],
      [
        'context.app.name',
        { context: { app: { name: 1 } } },
        (s) => s.app,
        { name: undefined, version: undefined, namespace: undefined },
        'context.app.name is a number, not a string; it is not used.',
      ],
      [
        'context.page',
        { context: { page: true } },
        (s) => s.pageTitle,
        false,
        'context.page is a boolean, not an object; its defaults are used.',
      ],
      [
        'context.page.queryParams',
        { context: { page: { queryParams: 'page' } } },
        (s) => s.pageQueryParams,
        [],
        'context.page.queryParams is a string, not an array; the default is used.',
      ],
      [
        'context.page.title',
        { context: { page: { title: 1 } } },
        (s) => s.pageTitle,
        false,
        'context.page.title is a number, not a boolean; the default false is used.',
      ],
      [
        'identity.crossSubdomain',
        { identity: { crossSubdomain: 'no' } },
        (s) => s.crossSubdomain,
        true,
        'identity.crossSubdomain is a string, not a boolean; the default true is used.',
      ],
      [
        'identity.cookieDomain',
        { identity: { cookieDomain: ['example.com'] } },
        (s) => s.cookieDomain,
        undefined,
        'identity.cookieDomain is an array, not a string; it is not used.',
      ],
      [
        'privacy.defaultConsent',
        { privacy: { defaultConsent: 'PENDING' } },
        (s) => s.defaultConsent,
        'granted',
        'privacy.defaultConsent is not one of "granted", "pending"; the default "granted" is used.',
      ],
      [
        'privacy.persistConsent',
        { privacy: { persistConsent: 0 } },
        (s) => s.persistConsent,
        true,
        'privacy.persistConsent is a number, not a boolean; the default true is used.',
      ],
      [
        'logging.level',
        { logging: { level: 'verbose' } },
        (s) => s.logging.level,
        'warn',
        'logging.level is not one of "debug", "info", "warn", "error", "off"; the default "warn" is used.',
      ],
      [
        'logging.logger',
        { logging: { logger: console } },
        (s) => s.logging.logger,
        undefined,
        'logging.logger is an object, not a function; it is not used.',
      ],
      [
        'logging.eventObserver',
        { logging: { eventObserver: 'x' } },
        (s) => s.logging.eventObserver,
        undefined,
        'logging.eventObserver is a string, not a function; it is not used.',
      ],
      [
        'logging.sendDiagnostics',
        { logging: { sendDiagnostics: 'false' } },
        (s) => s.sendDiagnostics,
        true,
        'logging.sendDiagnostics is a string, not a boolean; the default true is used.',
      ],
      [
        'network.headers',
        { network: { headers: new Map([['X-A', '1']]) } },
        (s) => ({ ...s.headers }),
        {},
        'network.headers is an object, not an object of strings; no header is added.',
      ],
    ];

    it.each(rows)('%s of the wrong type takes its default with SETTING_WRONG_TYPE', (_, input, read, value, text) => {
      const validation = validate({ apiKey: KEY, ...input });

      expect(read(validation.snapshot!)).toEqual(value);
      expect(validation.issues).toEqual([{ level: 'warn', code: 'SETTING_WRONG_TYPE', text, developerError: true }]);
    });

    it('covers every group and setting of the configuration', () => {
      const paths = rows.map(([path]) => path.replace(/ \(.*\)$/, ''));
      for (const path of [
        'debug',
        'beforeSend',
        'flush.at',
        'flush.intervalMs',
        'flush.immediateEvents',
        'session.inactivityTimeoutMs',
        'autocapture.enabled',
        'context.disabledFields',
        'context.app.name',
        'context.page.queryParams',
        'context.page.title',
        'identity.crossSubdomain',
        'identity.cookieDomain',
        'privacy.defaultConsent',
        'privacy.persistConsent',
        'logging.level',
        'logging.logger',
        'logging.eventObserver',
        'logging.sendDiagnostics',
        'network.headers',
      ]) {
        expect(paths).toContain(path);
      }
    });

    it('every group that is not an object takes its defaults', () => {
      for (const group of ['flush', 'session', 'autocapture', 'context', 'identity', 'privacy', 'logging', 'network']) {
        const validation = validate({ apiKey: KEY, [group]: 'x' });
        expect(texts(validation)).toEqual([`${group} is a string, not an object; its defaults are used.`]);
        expect({ ...validation.snapshot, toString: undefined }).toEqual({
          ...snapshotOf({ apiKey: KEY }),
          toString: undefined,
        });
      }
    });

    it('undefined is "not given" for every setting, null is a wrong type', () => {
      expect(
        validate({ apiKey: KEY, host: undefined, flush: undefined, logging: { level: undefined } }).issues,
      ).toEqual([]);
      expect(codes(validate({ apiKey: KEY, flush: null }))).toEqual(['SETTING_WRONG_TYPE']);
    });

    it('a bad array element drops only itself', () => {
      const hook: BeforeSend = (event) => event;
      const validation = validate({
        apiKey: KEY,
        beforeSend: [hook, 'not a hook'],
        flush: { immediateEvents: ['Purchase', 7, 'Purchase', null] },
        context: { page: { queryParams: ['page', {}, 'sort', 'page'] } },
      });
      const snapshot = validation.snapshot!;

      expect(snapshot.beforeSend).toEqual([hook]);
      expect([...snapshot.immediateEvents]).toEqual(['Purchase']);
      expect(snapshot.pageQueryParams).toEqual(['page', 'sort']);
      expect(texts(validation)).toEqual([
        'beforeSend[1] is a string, not a function; it is dropped.',
        'flush.immediateEvents[1] is a number, not a string; it is dropped.',
        'flush.immediateEvents[3] is null, not a string; it is dropped.',
        'context.page.queryParams[1] is an object, not a string; it is dropped.',
      ]);
    });

    it('a hole in an array is a dropped element', () => {
      // eslint-disable-next-line no-sparse-arrays
      const validation = validate({ apiKey: KEY, flush: { immediateEvents: ['A', , 'B'] } });

      expect([...validation.snapshot!.immediateEvents]).toEqual(['A', 'B']);
      expect(texts(validation)).toEqual(['flush.immediateEvents[1] is undefined, not a string; it is dropped.']);
    });
  });

  describe('closed sets (Web Lifecycle 8, Web Context 5)', () => {
    it('an autocapture member the web lacks is dropped with SETTING_WRONG_TYPE, the others kept', () => {
      const validation = validate({
        apiKey: KEY,
        autocapture: { enabled: ['sessions', 'app_lifecycle', 'screen_views', 'SESSIONS', 'deep_links', 3] },
      });

      expect([...validation.snapshot!.autocapture]).toEqual(['sessions']);
      expect(validation.issues.map((issue) => [issue.code, issue.level, issue.developerError])).toEqual(
        Array.from({ length: 5 }, () => ['SETTING_WRONG_TYPE', 'warn', true]),
      );
      expect(texts(validation)[0]).toBe(
        'autocapture.enabled[1] is not one of "sessions", "page_views", "network_requests"; it is dropped.',
      );
    });

    it('the message never repeats the unknown value', () => {
      const validation = validate({ apiKey: KEY, autocapture: { enabled: ['secret-member'] } });
      expect(texts(validation).join()).not.toContain('secret-member');
    });

    it('an empty list switches every type off', () => {
      const validation = validate({ apiKey: KEY, autocapture: { enabled: [] } });
      expect([...validation.snapshot!.autocapture]).toEqual([]);
      expect(validation.issues).toEqual([]);
    });

    it('duplicates are ignored and the snapshot holds a Set', () => {
      const snapshot = snapshotOf({
        apiKey: KEY,
        autocapture: { enabled: ['page_views', 'page_views'] },
        context: { disabledFields: ['locale', 'page.url', 'locale'] },
      });

      expect(snapshot.autocapture).toBeInstanceOf(Set);
      expect([...snapshot.autocapture]).toEqual(['page_views']);
      expect([...snapshot.disabledFields]).toEqual(['locale', 'page.url']);
    });

    it('a context field the web never produces, or page.title, is dropped with SETTING_WRONG_TYPE', () => {
      const validation = validate({
        apiKey: KEY,
        context: { disabledFields: ['os.version', 'page.title', 'network.carrier', 'timezone'] },
      });

      expect([...validation.snapshot!.disabledFields]).toEqual(['timezone']);
      expect(codes(validation)).toEqual(['SETTING_WRONG_TYPE', 'SETTING_WRONG_TYPE', 'SETTING_WRONG_TYPE']);
    });

    it('every member of each closed set is accepted', () => {
      const snapshot = snapshotOf({
        apiKey: KEY,
        autocapture: { enabled: AUTOCAPTURE_TYPES },
        context: { disabledFields: CONTEXT_FIELDS },
      });
      expect([...snapshot.autocapture]).toEqual([...AUTOCAPTURE_TYPES]);
      expect([...snapshot.disabledFields]).toEqual([...CONTEXT_FIELDS]);
      for (const consent of CONSENTS) {
        expect(snapshotOf({ apiKey: KEY, privacy: { defaultConsent: consent } }).defaultConsent).toBe(consent);
      }
    });
  });

  describe("another platform's setting (Web Session 3)", () => {
    it('session.backgroundTimeoutMs is not applied, and the WARN names the web key', () => {
      const validation = validate({ apiKey: KEY, session: { backgroundTimeoutMs: 300_000 } });

      expect(validation.snapshot!.inactivityTimeoutMs).toBe(1_800_000);
      expect(validation.issues).toEqual([
        {
          level: 'warn',
          code: 'SETTING_NOT_SUPPORTED',
          text: 'session.backgroundTimeoutMs is not a web setting and is not applied; use session.inactivityTimeoutMs.',
          developerError: true,
        },
      ]);
    });

    it('next to the web key, only the web key counts', () => {
      const validation = validate({
        apiKey: KEY,
        session: { backgroundTimeoutMs: 10_000, inactivityTimeoutMs: 120_000 },
      });

      expect(validation.snapshot!.inactivityTimeoutMs).toBe(120_000);
      expect(codes(validation)).toEqual(['SETTING_NOT_SUPPORTED']);
    });
  });

  describe('config snapshot', () => {
    it('later changes to the config, its groups, arrays and headers never reach the snapshot', () => {
      const hook: BeforeSend = (event) => event;
      const immediate = ['Purchase'];
      const enabled: string[] = ['sessions'];
      const disabled: string[] = ['locale'];
      const queryParams = ['page'];
      const hooks = [hook];
      const headers: Record<string, string> = { 'X-A': '1' };
      const app = { name: 'Shop' };
      const config = {
        apiKey: KEY,
        host: 'https://api.example.com',
        beforeSend: hooks,
        flush: { at: 20, immediateEvents: immediate },
        session: { inactivityTimeoutMs: 120_000 },
        autocapture: { enabled },
        context: { disabledFields: disabled, app, page: { queryParams, title: true } },
        identity: { crossSubdomain: false, cookieDomain: 'example.com' },
        privacy: { defaultConsent: 'pending', persistConsent: false },
        logging: { level: 'debug', sendDiagnostics: false },
        network: { headers },
      };
      const snapshot = snapshotOf(config);

      config.apiKey = 'other';
      config.host = 'https://other.example.com';
      config.flush.at = 5;
      config.flush = { at: 6, immediateEvents: [] };
      config.session.inactivityTimeoutMs = 60_000;
      config.context.page.title = false;
      config.identity.cookieDomain = 'other.example.com';
      config.privacy.defaultConsent = 'granted';
      config.logging.level = 'off';
      immediate.push('Signup');
      enabled.push('page_views');
      disabled.push('page.url');
      queryParams.push('token');
      hooks.push(() => null);
      headers['X-B'] = '2';
      app.name = 'Other';

      expect(snapshot.apiKey).toBe(KEY);
      expect(snapshot.host).toBe('https://api.example.com');
      expect(snapshot.flushAt).toBe(20);
      expect([...snapshot.immediateEvents]).toEqual(['Purchase']);
      expect(snapshot.inactivityTimeoutMs).toBe(120_000);
      expect([...snapshot.autocapture]).toEqual(['sessions']);
      expect([...snapshot.disabledFields]).toEqual(['locale']);
      expect(snapshot.pageQueryParams).toEqual(['page']);
      expect(snapshot.pageTitle).toBe(true);
      expect(snapshot.cookieDomain).toBe('example.com');
      expect(snapshot.defaultConsent).toBe('pending');
      expect(snapshot.logging.level).toBe('debug');
      expect(snapshot.beforeSend).toEqual([hook]);
      expect({ ...snapshot.headers }).toEqual({ 'X-A': '1' });
      expect(snapshot.app).toEqual({ name: 'Shop', version: undefined, namespace: undefined });
    });

    it('every value reaches the snapshot, functions by reference', () => {
      const logger: RubiconLogger = () => undefined;
      const observer: EventObserver = () => undefined;
      const hook: BeforeSend = (event) => event;
      const hooks = [hook];
      const snapshot = snapshotOf({
        apiKey: KEY,
        host: 'https://api.example.com/analytics/',
        debug: true,
        beforeSend: hooks,
        flush: { at: 50, intervalMs: 60_000, immediateEvents: ['Purchase'] },
        session: { inactivityTimeoutMs: 600_000 },
        autocapture: { enabled: ['network_requests'] },
        context: {
          disabledFields: ['locale'],
          app: { name: 'Shop', version: '4.2.0', namespace: 'com.example.shop' },
          page: { queryParams: ['page'], title: true },
        },
        identity: { crossSubdomain: false, cookieDomain: 'shop.example.com' },
        privacy: { defaultConsent: 'pending', persistConsent: false },
        logging: { level: 'debug', logger, eventObserver: observer, sendDiagnostics: false },
        network: { headers: { 'X-Gateway-Token': 't' } },
      });

      expect(snapshot.host).toBe('https://api.example.com/analytics');
      expect(snapshot.debug).toBe(true);
      expect(snapshot.beforeSend).not.toBe(hooks);
      expect(snapshot.beforeSend[0]).toBe(hook);
      expect(snapshot.flushAt).toBe(50);
      expect(snapshot.flushIntervalMs).toBe(60_000);
      expect([...snapshot.immediateEvents]).toEqual(['Purchase']);
      expect(snapshot.inactivityTimeoutMs).toBe(600_000);
      expect([...snapshot.autocapture]).toEqual(['network_requests']);
      expect([...snapshot.disabledFields]).toEqual(['locale']);
      expect(snapshot.app).toEqual({ name: 'Shop', version: '4.2.0', namespace: 'com.example.shop' });
      expect(snapshot.pageQueryParams).toEqual(['page']);
      expect(snapshot.pageTitle).toBe(true);
      expect(snapshot.crossSubdomain).toBe(false);
      expect(snapshot.cookieDomain).toBe('shop.example.com');
      expect(snapshot.defaultConsent).toBe('pending');
      expect(snapshot.persistConsent).toBe(false);
      expect(snapshot.logging).toEqual({ level: 'debug', debug: true, logger, eventObserver: observer });
      expect(snapshot.logging.logger).toBe(logger);
      expect(snapshot.logging.eventObserver).toBe(observer);
      expect(snapshot.sendDiagnostics).toBe(false);
      expect({ ...snapshot.headers }).toEqual({ 'X-Gateway-Token': 't' });
    });

    it('the string form shows the host only', () => {
      const snapshot = snapshotOf({ apiKey: 'rk_live_secret', network: { headers: { 'X-Token': 'secret-1' } } });

      expect(String(snapshot)).toBe('ConfigSnapshot(host=https://api.rubicon.example, debug=false)');
      expect(String(snapshot)).not.toContain('secret');
    });

    it('settings it does not know are ignored', () => {
      const validation = validate({ apiKey: KEY, flsh: { at: 1 }, flush: { att: 2 }, remote: { enabled: false } });
      expect(validation.issues).toEqual([]);
      expect(validation.snapshot!.flushAt).toBe(30);
    });
  });

  describe('robustness', () => {
    it('a throwing getter makes its setting unreadable, never an exception', () => {
      const flush = Object.defineProperty({}, 'at', {
        enumerable: true,
        get(): number {
          throw new Error('boom');
        },
      });
      const validation = validate({ apiKey: KEY, flush });

      expect(validation.snapshot!.flushAt).toBe(30);
      expect(texts(validation)).toEqual(['flush.at is unreadable, not a whole number; the default 30 is used.']);
    });

    it('a throwing key getter stops the SDK with INVALID_API_KEY', () => {
      const config = Object.defineProperty({}, 'apiKey', {
        get(): string {
          throw new Error('boom');
        },
      });
      expect(codes(validate(config))).toEqual(['INVALID_API_KEY']);
    });

    it('a Proxy whose traps throw, and a revoked Proxy, are wrong types', () => {
      const throwing = new Proxy(
        {},
        {
          get() {
            throw new Error('get');
          },
          ownKeys() {
            throw new Error('ownKeys');
          },
        },
      );
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();

      for (const value of [throwing, revoked.proxy]) {
        const validation = validate({
          apiKey: KEY,
          flush: value,
          autocapture: { enabled: value },
          network: { headers: value },
          logging: value,
        });
        expect(validation.snapshot).toBeDefined();
        expect(validation.snapshot!.flushAt).toBe(30);
        expect(codes(validation).every((code) => code === 'SETTING_WRONG_TYPE')).toBe(true);
      }
    });

    it('headers whose keys cannot be listed add no header', () => {
      const headers = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys');
          },
        },
      );
      const validation = validate({ apiKey: KEY, network: { headers } });

      expect({ ...validation.snapshot!.headers }).toEqual({});
      expect(texts(validation)).toEqual([
        'network.headers is unreadable, not an object of strings; no header is added.',
      ]);
    });

    it('an array whose element getter throws drops that element only', () => {
      const enabled = ['sessions', 'page_views'];
      Object.defineProperty(enabled, 0, {
        get(): string {
          throw new Error('boom');
        },
      });
      const validation = validate({ apiKey: KEY, autocapture: { enabled } });

      expect([...validation.snapshot!.autocapture]).toEqual(['page_views']);
      expect(codes(validation)).toEqual(['SETTING_WRONG_TYPE']);
    });

    it('seeded random configurations never throw and always give a snapshot or an ERROR', () => {
      const random = new SeededRandom(31);
      const pick = <T>(values: readonly T[]): T => values[random.nextUint32() % values.length]!;
      const leaves: unknown[] = [
        undefined,
        null,
        0,
        -1,
        1.5,
        Number.NaN,
        Infinity,
        1e21,
        '',
        ' ',
        'x',
        'sessions',
        'https://api.example.com',
        true,
        false,
        [],
        ['sessions', 7],
        {},
        () => null,
        Symbol('s'),
        new Map(),
        new Date(0),
      ];
      const keys = [
        'apiKey',
        'host',
        'debug',
        'beforeSend',
        'flush',
        'session',
        'autocapture',
        'context',
        'identity',
        'privacy',
        'logging',
        'network',
        'at',
        'intervalMs',
        'immediateEvents',
        'inactivityTimeoutMs',
        'backgroundTimeoutMs',
        'enabled',
        'disabledFields',
        'app',
        'page',
        'name',
        'queryParams',
        'title',
        'level',
        'logger',
        'headers',
        '__proto__',
      ];
      const tree = (depth: number): unknown => {
        if (depth === 0 || random.nextUint32() % 3 === 0) return pick(leaves);
        const out: Record<string, unknown> = {};
        const count = random.nextUint32() % 5;
        for (let i = 0; i < count; i++) {
          Object.defineProperty(out, pick(keys), { value: tree(depth - 1), enumerable: true, configurable: true });
        }
        return out;
      };

      for (let i = 0; i < 3_000; i++) {
        const input = random.nextUint32() % 2 === 0 ? tree(3) : { apiKey: KEY, ...(tree(3) as object) };
        const validation = validate(input, pick(['https', 'http', 'other'] as const));
        if (validation.snapshot === undefined) {
          expect(validation.issues.some((issue) => issue.level === 'error')).toBe(true);
        }
        for (const issue of validation.issues) {
          expect(ISSUE_CODES[issue.code].levels).toContain(issue.level);
          expect(issue.text.length).toBeGreaterThan(0);
        }
        expect(() => {
          report(validation, 'debug');
        }).not.toThrow();
      }
    });
  });

  describe('debug and developer errors (Web Public API 4, Web Logging 1)', () => {
    const mistakes = { apiKey: KEY, flush: { at: '20' }, network: { headers: { Host: 'x' } } };

    it('with debug the default sink writes developer errors in the error form, and nothing throws', () => {
      const validation = validate({ ...mistakes, debug: true });
      const { sink } = report(validation);

      expect(sink.lines).toEqual([
        {
          level: 'error',
          message: 'SETTING_WRONG_TYPE: flush.at is a string, not a whole number; the default 30 is used.',
          developerErrorForm: true,
        },
        {
          level: 'error',
          message: 'RESERVED_HEADER: network.headers: "Host" is set by the SDK and cannot be replaced; it is ignored.',
          developerErrorForm: true,
        },
      ]);
    });

    it('without debug the same mistakes are WARN lines with their codes', () => {
      const { sink, counted } = report(validate(mistakes));

      expect(counted).toEqual(['SETTING_WRONG_TYPE', 'RESERVED_HEADER']);
      expect(sink.lines.map((line) => [line.level, line.developerErrorForm])).toEqual([
        ['warn', false],
        ['warn', false],
      ]);
    });

    it('CLEARTEXT_HOST is never a developer error, also with debug', () => {
      const validation = validate({ apiKey: KEY, debug: true, host: 'http://api.example.com' }, 'http');
      const { sink } = report(validation);
      expect(sink.lines[0]).toEqual({
        level: 'warn',
        message: 'CLEARTEXT_HOST: The host uses http://; events travel unencrypted.',
        developerErrorForm: false,
      });
    });

    it.each([true, false])('logging.level "off" silences every line, debug %s', (debug) => {
      const validation = validate({ ...mistakes, apiKey: '', debug, logging: { level: 'off' } });
      const { sink, counted } = report(validation);

      expect(sink.lines).toEqual([]);
      expect(counted).toEqual(['INVALID_API_KEY', 'SETTING_WRONG_TYPE', 'RESERVED_HEADER']);
    });

    it("the developer's logger receives the lines at their normal level, even when the SDK does not start", () => {
      const recording = new RecordingLogger();
      const validation = validate({ apiKey: ' ', debug: true, logging: { logger: recording.logger, level: 'warn' } });
      const { sink } = report(validation);

      expect(sink.lines).toEqual([]);
      expect(recording.lines).toEqual([
        { level: 'error', message: 'INVALID_API_KEY: The API key is blank; the SDK does nothing.', error: undefined },
      ]);
    });
  });
});
