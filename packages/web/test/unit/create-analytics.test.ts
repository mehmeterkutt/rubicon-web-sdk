import { coreOf, createNoOpAnalytics, SDK_VERSION } from 'rubicon-analytics-core';
import type { Analytics } from 'rubicon-analytics-core';
import { RecordingLogger } from 'rubicon-analytics-testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalytics } from '../../src';
import type { AnalyticsConfig } from '../../src';
import { resetForTests } from '../../src/testing';
import { recordConsole, restoreConsole } from './console-support';

// The factory of step 7.1 (Web Public API 1, 7; Web Configuration 2, 3; Web Logging 1): a working
// instance in a browser, one instance per page across copies of the SDK, the no-op outside a browser
// and for an unusable configuration, never a throw into the host.

const MARKER = Symbol.for('rubicon.analytics');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const replaced = new Map<PropertyKey, PropertyDescriptor | undefined>();
const replacedPrototype: (() => void)[] = [];

function replaceGlobal(name: PropertyKey, value: unknown): void {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function marker(): unknown {
  return Reflect.get(globalThis, MARKER);
}

function config(extra: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return { apiKey: 'rk_test', host: 'https://api.example.com', ...extra };
}

function withLogger(logger: RecordingLogger, extra: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return config({ logging: { logger: logger.logger, level: 'debug' }, ...extra });
}

// Every instance reaches the network through `fetch` since step 7.3: a recording `fetch` that never
// answers keeps the tests off the network.
let fetched: { readonly url: string; readonly method: string | undefined }[] = [];

beforeEach(() => {
  fetched = [];
  replaceGlobal('fetch', (url: string, init: RequestInit | undefined) => {
    fetched.push({ url, method: init?.method });
    return new Promise(() => undefined);
  });
});

afterEach(() => {
  resetForTests();
  restoreConsole();
  for (const [name, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  replaced.clear();
  for (const restore of replacedPrototype.splice(0)) restore();
  // The instances write the page's real storage and cookies since step 7.2.
  localStorage.clear();
  for (const pair of document.cookie.split('; ')) {
    const name = pair.split('=')[0] ?? '';
    if (name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
});

describe('storage and cookies (step 7.2)', () => {
  it('reads and writes nothing at creation, and writes the identity to the page at first use', () => {
    const analytics = createAnalytics(config());
    expect(document.cookie).toBe('');
    expect(localStorage.length).toBe(0);

    const deviceId = analytics.deviceId;

    // jsdom's page is http://localhost: host-only cookies, no Secure, no probe (Web Identity 2). The
    // load's Page Viewed waits in its window (step 8.1), so no session has started yet.
    expect(document.cookie.split('; ')).toEqual([
      expect.stringMatching(new RegExp(`^rubicon_[0-9a-f]{16}=1\\.${deviceId}\\.[0-9a-f]{16}\\.$`)),
    ]);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys).toEqual([expect.stringMatching(/^rubicon\.[0-9a-f]{16}\.device$/) as unknown]);
  });

  describe('the write half of the start probe (step 7.2, answer 3)', () => {
    const PROBE = /^rubicon\.[0-9a-f]{16}\.probe$/;

    /** Makes `localStorage.setItem` throw a `QuotaExceededError`, as a zero quota does, recording the keys. */
    function zeroQuota(): string[] {
      const keys: string[] = [];
      const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem');
      Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true,
        writable: true,
        value(key: string) {
          keys.push(key);
          throw new DOMException('quota', 'QuotaExceededError');
        },
      });
      replacedPrototype.push(() => {
        if (original) Object.defineProperty(Storage.prototype, 'setItem', original);
      });
      return keys;
    }

    it('a zero quota on a granted page gives the memory-only mode with one STORAGE_UNAVAILABLE', () => {
      const keys = zeroQuota();
      const logger = new RecordingLogger();
      const analytics = createAnalytics(withLogger(logger));
      analytics.track('In memory');

      expect(keys).toEqual([expect.stringMatching(PROBE) as unknown]);
      expect(logger.lines.filter((line) => line.level === 'warn').map((line) => line.message)).toEqual([
        'STORAGE_UNAVAILABLE: Storage cannot be used; the SDK runs from memory on this page',
      ]);
      expect(document.cookie).toBe('');
    });

    it('a page whose consent is pending tries no write', () => {
      const keys = zeroQuota();
      const logger = new RecordingLogger();
      const analytics = createAnalytics(withLogger(logger, { privacy: { defaultConsent: 'pending' } }));
      analytics.track('Waiting');

      expect(keys).toEqual([]);
      expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([]);
    });

    it('a granted page that can write leaves no probe key', () => {
      const analytics = createAnalytics(config());
      analytics.track('Stored');
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
      expect(keys.some((key) => key !== null && PROBE.test(key))).toBe(false);
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  it('runs from memory with one STORAGE_UNAVAILABLE where localStorage throws (Web Disk 4)', () => {
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      const logger = new RecordingLogger();
      const analytics = createAnalytics(withLogger(logger));
      analytics.track('In memory');
      expect(analytics.deviceId).toMatch(UUID);
      expect(logger.lines.filter((line) => line.level === 'warn').map((line) => line.message)).toEqual([
        'STORAGE_UNAVAILABLE: Storage cannot be used; the SDK runs from memory on this page',
      ]);
      expect(document.cookie).toBe('');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });
});

describe('createAnalytics in a browser', () => {
  it('returns a working instance, not the no-op', () => {
    const analytics = createAnalytics(config());
    expect(coreOf(analytics)).toBeDefined();
    expect(analytics.isOptedOut).toBe(false);
    expect(analytics.deviceId).toMatch(UUID);
  });

  it('logs the effective host once at INFO through the developer logger', () => {
    const logger = new RecordingLogger();
    createAnalytics(withLogger(logger));
    expect(logger.lines).toEqual([{ level: 'info', message: 'Sending to https://api.example.com', error: undefined }]);
  });

  it('fills the page marker with the instance and this version, not enumerable', () => {
    const analytics = createAnalytics(config());
    expect(marker()).toEqual({ version: SDK_VERSION, analytics });
    expect(Object.prototype.propertyIsEnumerable.call(globalThis, MARKER)).toBe(false);
  });

  it('returns the no-op for an unusable configuration, with its error, and never fills the marker', () => {
    const logger = new RecordingLogger();
    const noOp = createAnalytics(withLogger(logger, { apiKey: ' ' }));
    expect(coreOf(noOp)).toBeUndefined();
    expect(noOp.isOptedOut).toBe(true);
    expect(logger.messages.filter((message) => message.startsWith('INVALID_API_KEY:'))).toHaveLength(1);
    expect(marker()).toBeUndefined();

    const second = new RecordingLogger();
    const analytics = createAnalytics(withLogger(second));
    expect(coreOf(analytics)).toBeDefined();
    expect(second.messages.some((message) => message.includes('SECOND_INSTANCE'))).toBe(false);
  });

  it('never fills the marker for createNoOpAnalytics', () => {
    createNoOpAnalytics();
    expect(marker()).toBeUndefined();
  });
});

describe('the network (step 7.3)', () => {
  it('sends through the page fetch: the configuration request when the instance starts', () => {
    const analytics = createAnalytics(config());
    expect(fetched).toEqual([]);

    expect(analytics.deviceId).toMatch(UUID);

    expect(fetched).toEqual([{ url: 'https://api.example.com/v1/config', method: 'GET' }]);
  });

  it('a Content Security Policy violation of the host logs CSP_BLOCKED once; another host is ignored', () => {
    const logger = new RecordingLogger();
    const analytics = createAnalytics(withLogger(logger));
    const violation = (blockedURI: string): void => {
      const event = new Event('securitypolicyviolation');
      for (const [name, value] of Object.entries({
        disposition: 'enforce',
        effectiveDirective: 'connect-src',
        blockedURI,
      }))
        Object.defineProperty(event, name, { value });
      document.dispatchEvent(event);
    };

    violation('https://api.example.com/v1/batch');
    expect(logger.messages.filter((message) => message.startsWith('CSP_BLOCKED'))).toEqual([]);

    expect(analytics.deviceId).toMatch(UUID);
    violation('https://cdn.example.com/v1/batch');
    violation('https://api.example.com/v1/batch');
    violation('https://api.example.com/v1/batch');

    expect(logger.lines.filter((line) => line.message.startsWith('CSP_BLOCKED')).map((line) => line.level)).toEqual([
      'error',
      'debug',
    ]);
  });

  it('stops watching when the instance is shut down', () => {
    const logger = new RecordingLogger();
    const analytics = createAnalytics(withLogger(logger));
    expect(analytics.deviceId).toMatch(UUID);
    resetForTests();

    const event = new Event('securitypolicyviolation');
    for (const [name, value] of Object.entries({
      disposition: 'enforce',
      effectiveDirective: 'connect-src',
      blockedURI: 'https://api.example.com/v1/batch',
    }))
      Object.defineProperty(event, name, { value });
    document.dispatchEvent(event);

    expect(logger.messages.filter((message) => message.startsWith('CSP_BLOCKED'))).toEqual([]);
  });
});

describe('the second instance (Web Configuration 3)', () => {
  it('returns the first instance and logs SECOND_INSTANCE once, naming both versions', () => {
    const firstLogger = new RecordingLogger();
    const first = createAnalytics(withLogger(firstLogger));
    const logger = new RecordingLogger();
    const second = createAnalytics(withLogger(logger, { host: 'https://other.example.com' }));
    expect(second).toBe(first);
    expect(logger.lines).toEqual([
      {
        level: 'error',
        message:
          `SECOND_INSTANCE: createAnalytics was called again on this page (SDK ${SDK_VERSION}); the first ` +
          `instance, made by SDK ${SDK_VERSION}, is returned and its configuration stays in force`,
        error: undefined,
      },
    ]);
    expect(firstLogger.messages.some((message) => message.includes('SECOND_INSTANCE'))).toBe(false);
  });

  it('keeps the first configuration: the second one is not validated beyond its logging', () => {
    const first = createAnalytics(config());
    const logger = new RecordingLogger();
    const second = createAnalytics(withLogger(logger, { apiKey: '', flush: { at: 1000 } }));
    expect(second).toBe(first);
    expect(logger.messages.map((message) => message.split(':')[0])).toEqual(['SECOND_INSTANCE']);
  });

  it('logs later second calls at DEBUG only (per_page, Web Logging 2)', () => {
    const first = createAnalytics(config());
    createAnalytics(config({ logging: { level: 'debug', logger: new RecordingLogger().logger } }));
    const logger = new RecordingLogger();
    expect(createAnalytics(withLogger(logger))).toBe(first);
    expect(logger.lines.map((line) => [line.level, line.message.split(':')[0]])).toEqual([
      ['debug', 'SECOND_INSTANCE'],
    ]);
  });

  it('a second call whose level wrote nothing leaves the next one at its level', () => {
    createAnalytics(config());
    createAnalytics(config({ logging: { level: 'off' } }));
    const logger = new RecordingLogger();
    createAnalytics(withLogger(logger));
    expect(logger.lines.map((line) => line.level)).toEqual(['error']);
  });

  it('returns the instance another copy of the SDK registered, naming both versions', () => {
    const other: Analytics = { ...createNoOpAnalytics(), isOptedOut: false, deviceId: 'other-copy' };
    replaceGlobal(MARKER, { version: '0.0.9', analytics: other });
    const logger = new RecordingLogger();
    expect(createAnalytics(withLogger(logger))).toBe(other);
    expect(logger.messages).toEqual([
      `SECOND_INSTANCE: createAnalytics was called again on this page (SDK ${SDK_VERSION}); the first ` +
        'instance, made by SDK 0.0.9, is returned and its configuration stays in force',
    ]);
  });

  it('ignores a value under the marker key that is not an instance', () => {
    for (const value of ['x', null, { version: 1, analytics: {} }, { version: '0.1.0' }]) {
      resetForTests();
      replaceGlobal(MARKER, value);
      const analytics = createAnalytics(config());
      expect(coreOf(analytics)).toBeDefined();
      expect(marker()).toEqual({ version: SDK_VERSION, analytics });
    }
  });

  it('a marker whose reading throws counts as absent', () => {
    replaceGlobal(
      MARKER,
      new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
        },
      ),
    );
    expect(coreOf(createAnalytics(config()))).toBeDefined();
  });

  it('the module registry guards this copy when the marker was removed', () => {
    const first = createAnalytics(config());
    Reflect.deleteProperty(globalThis, MARKER);
    expect(createAnalytics(config())).toBe(first);
  });

  it('the test reset clears the registry and the marker and stops the instance', () => {
    const first = createAnalytics(config());
    resetForTests();
    expect(marker()).toBeUndefined();
    const next = createAnalytics(config());
    expect(next).not.toBe(first);
    expect(coreOf(next)).toBeDefined();
  });
});

describe('SECOND_INSTANCE as a developer error (Web Public API 4, Web Logging 1)', () => {
  it('with debug: true the default sink writes console.error(new Error(message)), and nothing throws', () => {
    createAnalytics(config());
    const calls = recordConsole();
    expect(() => createAnalytics(config({ debug: true }))).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('error');
    const error = calls[0]?.args[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^\[Rubicon\] SECOND_INSTANCE: createAnalytics was called again/);
  });

  it('with debug: false the default sink writes the ERROR line as a string', () => {
    createAnalytics(config());
    const calls = recordConsole();
    createAnalytics(config({ debug: false }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('error');
    expect(calls[0]?.args[0]).toMatch(/^\[Rubicon\] SECOND_INSTANCE: createAnalytics was called again/);
  });

  it('logging.level "off" silences it, with and without debug', () => {
    createAnalytics(config());
    const calls = recordConsole();
    createAnalytics(config({ debug: true, logging: { level: 'off' } }));
    createAnalytics(config({ debug: false, logging: { level: 'off' } }));
    expect(calls).toEqual([]);
  });

  it('a developer logger receives it with its level and message, whatever debug says', () => {
    createAnalytics(config());
    const logger = new RecordingLogger();
    createAnalytics(withLogger(logger, { debug: true }));
    expect(logger.lines.map((line) => line.level)).toEqual(['error']);
  });
});

describe('outside a browser (Web Public API 7)', () => {
  it('without crypto.getRandomValues it returns the no-op with one INFO line and fills no marker', () => {
    replaceGlobal('crypto', undefined);
    const logger = new RecordingLogger();
    const analytics = createAnalytics(withLogger(logger));
    expect(coreOf(analytics)).toBeUndefined();
    expect(analytics.isOptedOut).toBe(true);
    expect(analytics.deviceId).toBe('');
    expect(logger.lines).toEqual([
      { level: 'info', message: 'Not running in a browser; analytics does nothing here', error: undefined },
    ]);
    expect(marker()).toBeUndefined();
  });

  it('writes the INFO line to the console only when the level allows it', () => {
    replaceGlobal('crypto', {});
    const calls = recordConsole();
    createAnalytics(config());
    expect(calls).toEqual([]);
    createAnalytics(config({ logging: { level: 'info' } }));
    expect(calls).toEqual([
      { method: 'info', args: ['[Rubicon] Not running in a browser; analytics does nothing here'] },
    ]);
  });
});

describe('never crashes the host', () => {
  it('a platform that fails while the instance is built gives the no-op with WORKER_FAILED', () => {
    replaceGlobal('setTimeout', () => {
      throw new Error('timers broke');
    });
    const logger = new RecordingLogger();
    let analytics: Analytics | undefined;
    expect(() => {
      analytics = createAnalytics(withLogger(logger));
    }).not.toThrow();
    expect(analytics?.isOptedOut).toBe(true);
    expect(logger.messages.filter((message) => message.startsWith('WORKER_FAILED:'))).toHaveLength(1);
    expect(marker()).toBeUndefined();
  });

  it('a configuration whose every read throws returns the no-op', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    ) as AnalyticsConfig;
    const calls = recordConsole();
    let analytics: Analytics | undefined;
    expect(() => {
      analytics = createAnalytics(hostile);
    }).not.toThrow();
    expect(analytics?.isOptedOut).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['error']);
  });

  it('a logger that throws on the SECOND_INSTANCE line still gets the first instance back', () => {
    const first = createAnalytics(config());
    const calls = recordConsole();
    const throwing = config({
      logging: {
        logger: () => {
          throw new Error('logger broke');
        },
      },
    });
    expect(createAnalytics(throwing)).toBe(first);
    expect(calls.map((call) => String(call.args[0]).split(':')[0])).toEqual([
      '[Rubicon] LOGGER_THREW',
      '[Rubicon] SECOND_INSTANCE',
    ]);
  });
});
