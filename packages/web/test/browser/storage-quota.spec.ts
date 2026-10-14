import { expect, test } from './fixtures';

// Web Disk 2: the SDK keeps 2 × Σ(key.length + value.length) of its chunk and marker keys at or
// below 1 MiB, "the conservative reading of how browsers count" the 5 MiB `localStorage` quota of
// an origin (Web Queue 6, Web Disk 1). These tests fill an empty `localStorage` with keys of known
// length until the engine throws, and check that the rule holds: in every engine and for every kind
// of character, the quota is at least 5 MiB when counted as two bytes per UTF-16 code unit of key and
// value. The measured capacities are recorded in plan section 15 (step 1.4).

const MIB = 1024 * 1024;
/** The quota every engine documents for one origin's `localStorage`. */
const DOCUMENTED_QUOTA_BYTES = 5 * MIB;
/** The SDK's budget of Web Disk 2, in the rule's units (2 × code units). */
const SDK_BUDGET = MIB;

interface Fill {
  /** UTF-16 code units of keys and values stored when the engine refused one more. */
  readonly units: number;
  readonly keys: number;
  /** The `name` of what `setItem` threw. */
  readonly errorName: string;
}

interface Case {
  readonly name: string;
  /** One character of the class, repeated in the values; keys are ASCII, as the SDK's are. */
  readonly char: string;
  readonly keyLength: number;
  readonly valueLength: number;
}

const CASES: readonly Case[] = [
  { name: 'ASCII values, 80-character keys', char: 'a', keyLength: 80, valueLength: 48 * 1024 },
  { name: 'Latin-1 values (U+00E9), 80-character keys', char: 'é', keyLength: 80, valueLength: 48 * 1024 },
  { name: 'non-Latin-1 values (U+0100), 80-character keys', char: 'Ā', keyLength: 80, valueLength: 48 * 1024 },
  { name: 'CJK values (U+6587), 80-character keys', char: '文', keyLength: 80, valueLength: 48 * 1024 },
  { name: 'surrogate pairs (U+1F600), 80-character keys', char: '\u{1f600}', keyLength: 80, valueLength: 48 * 1024 },
  { name: 'ASCII values, 1024-character keys', char: 'a', keyLength: 1024, valueLength: 1024 },
];

for (const c of CASES) {
  test(`localStorage is filled until QuotaExceededError: ${c.name}`, async ({ page, server }) => {
    await page.goto(server.url('/pages/blank.html'));

    const fill = await page.evaluate(
      ([char, keyLength, valueLength]): Fill => {
        localStorage.clear();
        const key = (index: number): string => {
          const id = `k${String(index)}.`;
          return id + 'x'.repeat(keyLength - id.length);
        };
        const value = char.repeat(valueLength / char.length);
        /** `undefined` when stored, else the `name` of what `setItem` threw. */
        const attempt = (name: string, text: string): string | undefined => {
          try {
            localStorage.setItem(name, text);
            return undefined;
          } catch (error) {
            return error instanceof DOMException ? error.name : String(error);
          }
        };
        let keys = 0;
        let units = 0;
        let errorName = attempt(key(keys), value);
        while (errorName === undefined) {
          keys += 1;
          units += keyLength + value.length;
          errorName = attempt(key(keys), value);
        }
        // The remainder: the longest value of whole characters that still fits under one more key.
        let low = -1;
        let high = value.length / char.length - 1;
        while (low < high) {
          const mid = Math.floor((low + high + 1) / 2);
          if (attempt(key(keys), char.repeat(mid)) === undefined) {
            localStorage.removeItem(key(keys));
            low = mid;
          } else {
            high = mid - 1;
          }
        }
        if (low >= 0) units += keyLength + low * char.length;
        localStorage.clear();
        return { units, keys, errorName };
      },
      [c.char, c.keyLength, c.valueLength] as const,
    );

    test.info().annotations.push({
      type: 'measurement',
      description: `units=${String(fill.units)} keys=${String(fill.keys)} error=${fill.errorName} 2xunits=${String(2 * fill.units)}`,
    });
    expect(fill.errorName).toBe('QuotaExceededError');
    // The rule's reading: two bytes per code unit never exceed what the engine accepts.
    expect(2 * fill.units).toBeGreaterThanOrEqual(DOCUMENTED_QUOTA_BYTES);
    // And the SDK's budget stays a fifth of the origin's quota in the rule's units.
    expect(SDK_BUDGET * 5).toBeLessThanOrEqual(2 * fill.units);
  });
}
