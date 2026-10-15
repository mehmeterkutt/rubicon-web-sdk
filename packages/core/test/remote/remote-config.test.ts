import { createHash } from 'node:crypto';
import { RecordingLogger, WhatwgUrlParser } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import {
  isSampledIn,
  Log,
  NO_OP_SINK,
  NO_REMOTE_CONFIG,
  parseRemoteBody,
  readRemoteConfig,
  restrictConfig,
  samplingBucket,
  validateConfig,
} from '../../src';
import type { ConfigSnapshot, RemoteConfig } from '../../src';

// The port of the Android RemoteConfigTest's "validation" and "sampling" groups (Configuration 1,
// Android log 5.3), with the web's autocapture members (Web Lifecycle 8, Web Configuration 6). The
// client is in remote-config-client.test.ts.

const urls = new WhatwgUrlParser();

function code(input: Record<string, unknown> = {}): ConfigSnapshot {
  const { snapshot } = validateConfig({ apiKey: 'rk_test', ...input }, { urls, pageScheme: 'https' });
  if (snapshot === undefined) throw new Error('no snapshot');
  return snapshot;
}

function setup() {
  const logger = new RecordingLogger();
  const log = new Log({ level: 'debug', debug: false, logger: logger.logger, sink: NO_OP_SINK });
  const remote = (json: string, config: ConfigSnapshot = code()): RemoteConfig => {
    const values = parseRemoteBody(json);
    if (values === undefined) throw new Error('not an object');
    return readRemoteConfig(values, config, log);
  };
  const warnings = (): string[] =>
    logger.lines
      .filter((line) => line.level === 'warn' && line.message.startsWith('REMOTE_CONFIG_INVALID_VALUE'))
      .map((line) => line.message);
  return { logger, remote, warnings };
}

describe('validation', () => {
  it('a full valid body restricts the code', () => {
    const { remote, warnings } = setup();
    const config = code();

    const values = remote(
      '{"enabled":false,"autocapture_off":["network_requests","sessions"],"flush_at":50,' +
        '"flush_interval_ms":120000,"sample_rate":0.5,"diagnostics_sample_rate":0}',
      config,
    );
    const restricted = restrictConfig(config, values);

    expect(values.enabled).toBe(false);
    expect([...values.autocaptureOff]).toEqual(['network_requests', 'sessions']);
    expect([...restricted.autocapture]).toEqual(['page_views']);
    expect(restricted.flushAt).toBe(50);
    expect(restricted.flushIntervalMs).toBe(120_000);
    expect(values.sampleRate).toBe(0.5);
    expect(values.diagnosticsSampleRate).toBe(0);
    expect(warnings()).toEqual([]);
  });

  it('an empty body changes nothing', () => {
    const { remote } = setup();
    const config = code();

    const restricted = restrictConfig(config, remote('{}', config));

    expect(remote('{}', config)).toEqual(NO_REMOTE_CONFIG);
    expect({ ...restricted, toString: undefined }).toEqual({ ...config, toString: undefined });
    expect(String(restricted)).toBe(String(config));
  });

  it('restricting copies the snapshot and leaves the code as it was', () => {
    const { remote } = setup();
    const config = code();

    const restricted = restrictConfig(config, remote('{"autocapture_off":["sessions"],"flush_at":60}', config));

    expect(restricted).not.toBe(config);
    expect([...config.autocapture]).toEqual(['sessions', 'page_views', 'network_requests']);
    expect(config.flushAt).toBe(30);
    expect(restricted.apiKey).toBe(config.apiKey);
  });

  it('remote cannot switch on an autocapture the code switched off', () => {
    const { remote } = setup();
    const config = code({ autocapture: { enabled: ['sessions'] } });

    const restricted = restrictConfig(config, remote('{"autocapture_off":[]}', config));

    expect([...restricted.autocapture]).toEqual(['sessions']);
  });

  it('flushing can only become less frequent', () => {
    const { remote, warnings } = setup();
    const config = code({ flush: { at: 40, intervalMs: 90_000 } });

    const lower = restrictConfig(config, remote('{"flush_at":20,"flush_interval_ms":30000}', config));
    const higher = restrictConfig(config, remote('{"flush_at":40,"flush_interval_ms":600000}', config));

    expect(lower.flushAt).toBe(40);
    expect(lower.flushIntervalMs).toBe(90_000);
    expect(higher.flushAt).toBe(40);
    expect(higher.flushIntervalMs).toBe(600_000);
    expect(warnings()).toHaveLength(2);
  });

  it('values outside the bounds are ignored', () => {
    const { remote, warnings } = setup();

    const values = remote(
      '{"flush_at":101,"flush_interval_ms":600001,"sample_rate":1.5,"diagnostics_sample_rate":-0.1}',
    );

    expect(values).toEqual(NO_REMOTE_CONFIG);
    expect(warnings()).toHaveLength(4);
  });

  it('diagnostics cannot be switched on when the code switched them off', () => {
    const { remote } = setup();
    const config = code({ logging: { sendDiagnostics: false } });

    expect(remote('{"diagnostics_sample_rate":0.5}', config).diagnosticsSampleRate).toBeUndefined();
    expect(remote('{"diagnostics_sample_rate":0}', config).diagnosticsSampleRate).toBe(0);
  });

  it('values of the wrong type are ignored with a warning, the rest still applies', () => {
    const { remote, warnings } = setup();

    const values = remote(
      '{"enabled":"false","autocapture_off":"sessions","flush_at":50.5,"flush_interval_ms":"60000",' +
        '"sample_rate":true,"diagnostics_sample_rate":0.25}',
    );

    expect(values.enabled).toBe(true);
    expect([...values.autocaptureOff]).toEqual([]);
    expect(values.flushAt).toBeUndefined();
    expect(values.flushIntervalMs).toBeUndefined();
    expect(values.sampleRate).toBeUndefined();
    expect(values.diagnosticsSampleRate).toBe(0.25);
    expect(warnings()).toHaveLength(5);
  });

  it('null and huge numbers are of the wrong type as well', () => {
    const { remote, warnings } = setup();

    const values = remote('{"enabled":null,"flush_at":1e400,"flush_interval_ms":9007199254740993,"sample_rate":null}');

    expect(values).toEqual(NO_REMOTE_CONFIG);
    expect(warnings()).toHaveLength(4);
  });

  it('a whole number written with a fraction reads as that number (one JSON number type)', () => {
    const { remote, warnings } = setup();

    expect(remote('{"flush_at":50.0}').flushAt).toBe(50);
    expect(warnings()).toEqual([]);
  });

  it('a list with a non-string entry is invalid as a whole', () => {
    const { remote, warnings } = setup();

    expect([...remote('{"autocapture_off":["sessions",3]}').autocaptureOff]).toEqual([]);
    expect(warnings()).toHaveLength(1);
  });

  it('unknown keys and autocapture types are ignored quietly', () => {
    const { remote, warnings, logger } = setup();

    const values = remote('{"replay_rate":0.1,"autocapture_off":["taps","deep_links","page_views"]}');

    expect([...values.autocaptureOff]).toEqual(['page_views']);
    expect(warnings()).toEqual([]);
    expect(logger.lines.some((line) => line.level === 'debug' && line.message.includes('"replay_rate"'))).toBe(true);
    expect(logger.lines.some((line) => line.level === 'debug' && line.message.includes('"taps"'))).toBe(true);
  });

  it('the Android members the web lacks are unknown types, ignored at DEBUG (Web Configuration 6)', () => {
    const { remote, warnings, logger } = setup();

    const values = remote(
      '{"autocapture_off":["app_lifecycle","install_update","screen_views","deep_links","Sessions"]}',
    );

    expect([...values.autocaptureOff]).toEqual([]);
    expect(warnings()).toEqual([]);
    expect(logger.lines.filter((line) => line.level === 'debug')).toHaveLength(5);
  });

  it('a key named __proto__ is an unknown key and changes nothing', () => {
    const { remote, warnings } = setup();

    expect(remote('{"__proto__":{"enabled":false},"flush_at":60}')).toEqual({ ...NO_REMOTE_CONFIG, flushAt: 60 });
    expect(warnings()).toEqual([]);
  });

  it('an invalid key is a WARN once per key and page, its repeats DEBUG lines', () => {
    const { remote, warnings, logger } = setup();

    remote('{"flush_at":0}');
    remote('{"flush_at":0}');
    remote('{"sample_rate":2}');

    expect(warnings()).toHaveLength(2);
    expect(logger.lines.filter((line) => line.message.startsWith('REMOTE_CONFIG_INVALID_VALUE'))).toHaveLength(3);
  });

  it('whole-number rates are accepted', () => {
    const { remote } = setup();

    expect(remote('{"sample_rate":1}').sampleRate).toBe(1);
    expect(remote('{"sample_rate":0}').sampleRate).toBe(0);
  });

  it('a body that is not one JSON object is not parsed', () => {
    expect(parseRemoteBody('[1,2]')).toBeUndefined();
    expect(parseRemoteBody('{"enabled":')).toBeUndefined();
    expect(parseRemoteBody('<html>')).toBeUndefined();
    expect(parseRemoteBody('{} trailing')).toBeUndefined();
    expect(parseRemoteBody('null')).toBeUndefined();
    expect(parseRemoteBody('"{}"')).toBeUndefined();
  });
});

describe('sampling', () => {
  it('is stable for a device id', () => {
    for (let i = 0; i < 100; i += 1) {
      const id = `device-${String(i)}`;
      const first = isSampledIn(id, 0.5, 'events');
      for (let j = 0; j < 3; j += 1) expect(isSampledIn(id, 0.5, 'events')).toBe(first);
    }
  });

  it('splits a population close to the rate', () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `0192e4a1-7c3f-7a2b-8d4e-${String(i).padStart(12, '0')}`);

    for (const rate of [0.01, 0.1, 0.5, 0.9]) {
      const share = ids.filter((id) => isSampledIn(id, rate, 'events')).length / ids.length;
      expect(Math.abs(share - rate), `rate ${String(rate)}`).toBeLessThanOrEqual(0.015);
    }
  });

  it('rates of 0 and 1 are exact', () => {
    expect(isSampledIn('any', 1, 'events')).toBe(true);
    expect(isSampledIn('any', 0, 'events')).toBe(false);
  });

  it('a device inside a lower rate is inside every higher rate', () => {
    for (let i = 0; i < 1_000; i += 1) {
      const id = `d${String(i)}`;
      if (isSampledIn(id, 0.2, 'events')) expect(isSampledIn(id, 0.6, 'events')).toBe(true);
    }
  });

  it('events and diagnostics draw independently', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `d${String(i)}`);
    const both = ids.filter((id) => isSampledIn(id, 0.5, 'events') && isSampledIn(id, 0.5, 'diagnostics')).length;

    expect(Math.abs(both / ids.length - 0.25)).toBeLessThanOrEqual(0.02);
  });

  it("the bucket is Android's: the first 52 bits of the SHA-256 of the salted id", () => {
    for (const purpose of ['events', 'diagnostics'] as const) {
      for (const id of ['0192e4a1-7c3f-7a2b-8d4e-000000000001', 'd42', 'ğüşıöç']) {
        const hex = createHash('sha256').update(`${purpose}:${id}`, 'utf8').digest('hex').slice(0, 13);
        const expected = Number(BigInt(`0x${hex}`)) / 2 ** 52;
        expect(samplingBucket(id, purpose)).toBe(expected);
        expect(samplingBucket(id, purpose)).toBeGreaterThanOrEqual(0);
        expect(samplingBucket(id, purpose)).toBeLessThan(1);
      }
    }
  });
});
