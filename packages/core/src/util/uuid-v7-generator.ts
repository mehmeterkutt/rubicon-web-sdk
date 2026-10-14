import type { Clock } from '../platform/clock';
import type { RandomSource } from '../platform/random';

const TWO_POW_32 = 0x1_0000_0000;
const TWO_POW_30 = 0x4000_0000;
const TWO_POW_48 = 0x1_0000_0000_0000;
/** The largest 42-bit counter, 2^42 - 1. */
const COUNTER_MAX = 0x3ff_ffff_ffff;

/**
 * Makes UUIDv7 strings that sort in creation order within the page (Event Model 4, Web Event Model
 * 3), for `message_id`, `device_id` and the session id. One generator per `Analytics` instance; a
 * port of the Android `UuidV7Generator` with the same layout and rules (Android log 2.3).
 *
 * Layout (RFC 9562, section 5.7): 48 bits of Unix time in milliseconds, the version `7`, then 74
 * bits that hold a 42-bit counter (the 12 bits of `rand_a` and the top 30 bits of `rand_b`, RFC 9562
 * section 6.2, method 1) followed by 32 random bits, with the variant `10` in between.
 *
 * - The counter starts at a random value with its top bit clear in each new millisecond and grows
 *   by one per id, so ids of the same millisecond are ordered and about 2^41 of them fit.
 * - If the clock moves back, the last timestamp is kept and the counter keeps growing, so order holds.
 * - If the counter runs out, the timestamp moves one millisecond ahead (RFC 9562, section 6.2).
 *
 * Plain `Number` arithmetic (Web Event Model 3): the millisecond and the counter are integers below
 * 2^53, split into words by division and modulo; bitwise operators only ever see 32-bit words, and
 * there is no `BigInt` (ES2020). The page has one thread, so there is no lock.
 *
 * Random draws, in the Android order: two words for the counter seed (the high word first, as
 * Kotlin's `nextLong()` draws them), then one word for the tail. A scripted `RandomSource` that
 * replays the words of Android's draws therefore gives Android's ids.
 */
export class UuidV7Generator {
  // A fresh counter uses the lower half of the range, leaving at least half for increments; the
  // mask is split into the words a seed is drawn as.
  private readonly seedMaskHigh: number;
  private readonly seedMaskLow: number;
  private lastMillis = -Infinity;
  private counter = 0;

  /**
   * @param counterMax - tests lower it to reach the overflow path; it is `2^k - 1`, and ids keep the
   *   42-bit layout.
   */
  constructor(
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly counterMax: number = COUNTER_MAX,
  ) {
    const seedMask = Math.floor(counterMax / 2);
    this.seedMaskHigh = Math.floor(seedMask / TWO_POW_32);
    this.seedMaskLow = seedMask % TWO_POW_32;
  }

  /** A new id: 36 lowercase characters. */
  next(): string {
    const now = this.clock.now();
    if (now > this.lastMillis) {
      this.lastMillis = now;
      this.counter = this.seed();
    } else if (this.counter === this.counterMax) {
      this.lastMillis += 1;
      this.counter = this.seed();
    } else {
      this.counter += 1;
    }
    const tail = this.random.nextUint32() >>> 0;
    // The two's complement of Android's `millis and 0xFFFF_FFFF_FFFF`, for a clock before 1970 too.
    const millis = ((this.lastMillis % TWO_POW_48) + TWO_POW_48) % TWO_POW_48;
    const counter = this.counter;
    // unix_ts_ms (48) | ver (4) | counter high 12 bits
    const timeHigh = hex(Math.floor(millis / TWO_POW_32), 4) + hex(millis % TWO_POW_32, 8);
    const versionAndCounter = hex(0x7000 + Math.floor(counter / TWO_POW_30), 4);
    // var (2) | counter low 30 bits | 32 random bits
    const variantAndCounter = hex(0x8000_0000 + (counter % TWO_POW_30), 8);
    return (
      `${timeHigh.slice(0, 8)}-${timeHigh.slice(8)}-${versionAndCounter}-` +
      `${variantAndCounter.slice(0, 4)}-${variantAndCounter.slice(4)}${hex(tail, 8)}`
    );
  }

  private seed(): number {
    const high = this.random.nextUint32() & this.seedMaskHigh;
    const low = this.random.nextUint32() & this.seedMaskLow;
    return (high >>> 0) * TWO_POW_32 + (low >>> 0);
  }
}

/** `value`, an integer in `[0, 2^32)`, as `width` lowercase hex digits. */
function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}
