import { sha256Hex } from '../util/hashing';

/**
 * Why a device is sampled; each purpose has its own salt, so a device out of one sample is not more
 * likely to be out of the other (Android log 5.3).
 *
 * - `events`: `sample_rate`, whether the device collects at all;
 * - `diagnostics`: `diagnostics_sample_rate`, whether it sends `SDK Diagnostics` (Logging 5).
 */
export type SamplingPurpose = 'events' | 'diagnostics';

// 2^52: the first 13 hex characters of the hash are 52 bits, below `Number`'s 53-bit integers.
const BUCKET_SPAN = 4_503_599_627_370_496;

/**
 * Deterministic sampling by `device_id` (Configuration 1, Web Configuration 5), the port of the
 * Android `Sampling`: a device is always in or always out for a rate, so it does not flicker between
 * page loads. A new `device_id`, after `clearLocalData()`, draws again.
 */
export function isSampledIn(deviceId: string, rate: number, purpose: SamplingPurpose): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return samplingBucket(deviceId, purpose) < rate;
}

/**
 * A uniform position in `[0, 1)` from the first 52 bits of the SHA-256 of `<purpose>:<deviceId>`,
 * with the SHA-256 that makes the key hash (Web Identity 4, step 2.3), so the three SDKs give a
 * device the same position.
 */
export function samplingBucket(deviceId: string, purpose: SamplingPurpose): number {
  return parseInt(sha256Hex(`${purpose}:${deviceId}`).slice(0, 13), 16) / BUCKET_SPAN;
}
