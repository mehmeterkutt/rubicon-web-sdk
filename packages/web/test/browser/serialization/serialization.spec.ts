import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { TestServer } from 'rubicon-analytics-testing/server';
import { parseWithPython } from 'rubicon-analytics-testing/python';
import { SeededRandom } from 'rubicon-analytics-testing/random';
import { TEST_HOST_A, expect, test } from '../fixtures';
import { SERIALIZATION_BUNDLE } from '../global-setup';
import type { SerializationApi } from './serialization-entry';
import { buildCases } from './cases';
import type { Realm } from './cases';

// Web Serialization 3 in the three engines (step 8.1): the conversion table of Web Serialization 2
// and its limits, the Android `IsoDates` vectors and the UTF-8 size scan run in Chromium, Firefox and
// WebKit, with values from the page's realm and from an iframe's, through the core's own code (a
// test-only bundle of it, built by global-setup.ts). Each engine must give exactly what Node gives
// for the same inputs; Node's answers are the core's unit tests' (step 2.5). Every line an engine
// writes is parsed by that engine's `JSON.parse` and by Python with strict UTF-8 (D9).

interface CaseResult {
  readonly name: string;
  readonly line: string;
  readonly problems: readonly unknown[];
  readonly oversize: boolean;
}

/** The Android `IsoDatesTest` table (packages/core/test/util/iso-dates.test.ts). */
const ISO_VECTORS: readonly (readonly [number, string])[] = [
  [0, '1970-01-01T00:00:00.000Z'],
  [999, '1970-01-01T00:00:00.999Z'],
  [-1, '1969-12-31T23:59:59.999Z'],
  [-2208988800000, '1900-01-01T00:00:00.000Z'],
  [946684799999, '1999-12-31T23:59:59.999Z'],
  [946684800000, '2000-01-01T00:00:00.000Z'],
  [951782400000, '2000-02-29T00:00:00.000Z'],
  [1709210096789, '2024-02-29T12:34:56.789Z'],
  [4107542400000, '2100-03-01T00:00:00.000Z'],
  [1759147200123, '2025-09-29T12:00:00.123Z'],
  [-62167219200000, '0000-01-01T00:00:00.000Z'],
  [253402300799999, '9999-12-31T23:59:59.999Z'],
];
/** Instants outside the years 0000 to 9999, and the ECMAScript limits. */
const ISO_OUT_OF_RANGE = [-62167219200001, 253402300800000, -8.64e15, 8.64e15];
const ISO_MIN_MILLIS = -62167219200000;
const ISO_MAX_MILLIS = 253402300799999;

/** The core's answers in Node: the same bundle, run with a stand-in window. */
function nodeApi(): SerializationApi {
  const window: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test bundle, run as the page runs it.
  (new Function('window', readFileSync(SERIALIZATION_BUNDLE, 'utf8')) as (target: unknown) => void)(window);
  return window.__serialization as SerializationApi;
}

/** Runs one realm's cases through `api`; the same body runs in the engines. */
function runCases(api: SerializationApi, realm: Realm): CaseResult[] {
  return buildCases(realm).map(({ name, input }) => {
    const result = api.normalizeProperties(input);
    return { name, line: api.writeJson(result.values), problems: result.problems, oversize: result.oversize };
  });
}

/** Opens a page with the bundle; an iframe of the same origin gives the second realm. */
async function openPage(page: Page, server: TestServer): Promise<void> {
  await page.goto(server.url('/pages/blank.html', TEST_HOST_A));
  await page.addScriptTag({ path: SERIALIZATION_BUNDLE });
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'realm';
    document.body.appendChild(frame);
  });
}

/** The cases run in the engine, with the page's constructors or the iframe's. */
function engineCases(page: Page, inFrame: boolean): Promise<CaseResult[]> {
  return page.evaluate(
    ({ source, frame }) => {
      const api = Reflect.get(window, '__serialization') as SerializationApi;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the case builder's own source, sent from the spec.
      const build = (new Function(`return (${source})`) as () => typeof buildCases)();
      const realm = frame
        ? ((document.getElementById('realm') as HTMLIFrameElement).contentWindow as unknown as Realm)
        : (window as unknown as Realm);
      return build(realm).map(({ name, input }) => {
        const result = api.normalizeProperties(input);
        const line = api.writeJson(result.values);
        // The engine's own parser reads every line it wrote back to the same value.
        if (JSON.stringify(JSON.parse(line)) !== line) throw new Error(`${name}: JSON.parse does not round-trip`);
        return { name, line, problems: result.problems, oversize: result.oversize };
      });
    },
    { source: buildCases.toString(), frame: inFrame },
  );
}

let nodeResults: CaseResult[] | undefined;

/** Node's answers, computed once per worker (the bundle exists only after the global setup). */
function expectedResults(): CaseResult[] {
  nodeResults ??= runCases(nodeApi(), globalThis);
  return nodeResults;
}

test.describe('the conversion table of Web Serialization 2', () => {
  test('gives in the engine what it gives in Node, row by row', async ({ page, server }) => {
    await openPage(page, server);

    const results = await engineCases(page, false);
    const expected = expectedResults();

    expect(results.map((result) => result.name)).toEqual(expected.map((result) => result.name));
    results.forEach((result, i) => {
      expect(result, result.name).toEqual(expected[i]);
    });
    // The rows that hold the engine's own behaviour, pinned as well as compared.
    const line = (name: string) => JSON.parse(results.find((result) => result.name === name)?.line ?? '{}') as unknown;
    expect(line('5 finite numbers')).toEqual({
      half: 1.5,
      big: 1e21,
      unsafe: 2 ** 53 + 2,
      tiny: 1e-7,
      cents: 49.9,
      whole: 50,
      negativeZero: 0,
    });
    expect(line('9 valid dates')).toEqual({
      now: '2026-10-14T08:00:00.000Z',
      epoch: '1970-01-01T00:00:00.000Z',
      first: '0000-01-01T00:00:00.000Z',
      last: '9999-12-31T23:59:59.999Z',
    });
    expect(line('1 strings')).toEqual({ plain: 'a', empty: '', unicode: '😀 ğ 日', lone: 'a�b�c' });
  });

  test('values from an iframe are converted by the same rows (Object.prototype.toString, never instanceof)', async ({
    page,
    server,
  }) => {
    await openPage(page, server);
    expect(
      await page.evaluate(() => {
        const frame = (document.getElementById('realm') as HTMLIFrameElement).contentWindow as unknown as Realm;
        return new frame.Date(0) instanceof Date || new frame.Map() instanceof Map;
      }),
    ).toBe(false);

    const results = await engineCases(page, true);
    const expected = expectedResults();

    results.forEach((result, i) => {
      expect(result, result.name).toEqual(expected[i]);
    });
  });

  test('every line the engine wrote is standard JSON in valid UTF-8 for Python', async ({ page, server }) => {
    await openPage(page, server);
    const lines = [...(await engineCases(page, false)), ...(await engineCases(page, true))].map((r) => r.line);

    parseWithPython(lines).forEach((answer, i) => {
      expect(answer, lines[i]).toEqual({ ok: true, value: JSON.parse(lines[i] ?? '') as unknown });
    });
  });
});

test.describe('the Android IsoDates vectors (Web Serialization 3)', () => {
  test('toISOString writes the Android text in the engine, for this realm and an iframe', async ({ page, server }) => {
    await openPage(page, server);
    const random = new SeededRandom(81);
    const span = ISO_MAX_MILLIS - ISO_MIN_MILLIS + 1;
    const instants: number[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const fraction = ((random.nextUint32() >>> 5) * 2 ** 26 + (random.nextUint32() >>> 6)) / 2 ** 53;
      instants.push(ISO_MIN_MILLIS + Math.floor(fraction * span));
    }

    const answers = await page.evaluate(
      ({ vectors, outside, randomInstants }) => {
        const api = Reflect.get(window, '__serialization') as SerializationApi;
        const frame = (document.getElementById('realm') as HTMLIFrameElement).contentWindow as unknown as Realm;
        return {
          vectors: vectors.map((millis) => api.formatIsoDate(new Date(millis))),
          framed: vectors.map((millis) => api.formatIsoDate(new frame.Date(millis))),
          outside: outside.map((millis) => api.formatIsoDate(new Date(millis)) ?? null),
          invalid: api.formatIsoDate(new Date(NaN)) ?? null,
          random: randomInstants.map((millis) => api.formatIsoDate(new Date(millis))),
        };
      },
      { vectors: ISO_VECTORS.map(([millis]) => millis), outside: ISO_OUT_OF_RANGE, randomInstants: instants },
    );

    expect(answers.vectors).toEqual(ISO_VECTORS.map(([, text]) => text));
    expect(answers.framed).toEqual(ISO_VECTORS.map(([, text]) => text));
    expect(answers.outside).toEqual(ISO_OUT_OF_RANGE.map(() => null));
    expect(answers.invalid).toBeNull();
    expect(answers.random).toEqual(instants.map((millis) => new Date(millis).toISOString()));
  });
});

test.describe('the UTF-8 size scan (Web Serialization 1)', () => {
  test('agrees with the engine’s TextEncoder on random strings of any code unit', async ({ page, server }) => {
    await openPage(page, server);

    const mismatches = await page.evaluate(() => {
      const api = Reflect.get(window, '__serialization') as SerializationApi;
      // mulberry32, generated in the page so that lone surrogates never cross the protocol.
      let state = 2026;
      const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
      };
      const encoder = new TextEncoder();
      const found: number[] = [];
      for (let i = 0; i < 2000; i += 1) {
        const units: number[] = [];
        const length = next() % 64;
        for (let j = 0; j < length; j += 1) {
          // Mostly ASCII, Latin-1 and BMP, with surrogates (paired or not) often enough.
          const pick = next() % 4;
          units.push(pick === 0 ? next() % 0x80 : pick === 1 ? 0xd800 + (next() % 0x800) : next() % 0x10000);
        }
        const text = String.fromCharCode(...units);
        if (api.utf8ByteLength(text) !== encoder.encode(text).length) found.push(i);
      }
      return found;
    });

    expect(mismatches).toEqual([]);
  });

  test('a line of exactly 32 KB is kept and one byte more is over', async ({ page, server }) => {
    await openPage(page, server);

    const answers = await page.evaluate(() => {
      const api = Reflect.get(window, '__serialization') as SerializationApi;
      const at = 'x'.repeat(api.MAX_EVENT_BYTES - 2) + 'ğ';
      return [api.isOversizeLine(at), api.isOversizeLine(`${at}x`), api.utf8ByteLength(at)];
    });

    expect(answers).toEqual([false, true, 32 * 1024]);
  });
});
