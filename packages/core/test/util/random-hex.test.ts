import { ScriptedRandom, SeededRandom } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { newPersonEpoch, randomHex } from '../../src';

describe('newPersonEpoch', () => {
  it('is 64 bits from two draws, as 16 lowercase hex characters in draw order', () => {
    const random = new ScriptedRandom([0xdead_beef, 0x0000_00ff]);

    expect(newPersonEpoch(random)).toBe('deadbeef000000ff');
    expect(random.drawn).toBe(2);
  });

  it('keeps leading zeros and the largest word', () => {
    expect(newPersonEpoch(new ScriptedRandom([0, 0]))).toBe('0000000000000000');
    expect(newPersonEpoch(new ScriptedRandom([0xffff_ffff, 0xffff_ffff]))).toBe('ffffffffffffffff');
  });

  it('differs between draws', () => {
    const random = new SeededRandom(3);
    const epochs = Array.from({ length: 1_000 }, () => newPersonEpoch(random));

    expect(new Set(epochs).size).toBe(1_000);
    expect(epochs.every((epoch) => /^[0-9a-f]{16}$/.test(epoch))).toBe(true);
  });
});

describe('randomHex', () => {
  it('writes 8 hex characters per word', () => {
    expect(randomHex(new ScriptedRandom([1, 2, 3]), 3)).toBe('000000010000000200000003');
    expect(randomHex(new ScriptedRandom([]), 0)).toBe('');
  });
});
