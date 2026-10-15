// The round constants of FIPS 180-4, section 4.2.2: the first 32 bits of the fractional parts of the
// cube roots of the first 64 primes.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];

// The initial hash value of FIPS 180-4, section 5.3.3.
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/**
 * The SHA-256 of `text` in UTF-8, as 64 lowercase hex characters; the port of the Android
 * `Hashing.sha256Hex`.
 *
 * Our own synchronous implementation of FIPS 180-4 (Web Identity 4): `crypto.subtle.digest` returns
 * a Promise and exists only in secure contexts, and the SDK has no dependency. Its uses are the key
 * hash of the store names and the salted sampling buckets of the remote configuration (step 5.3),
 * a few short strings per page, so it is written for clarity, over 32-bit words only.
 */
export function sha256Hex(text: string): string {
  const message = utf8(text);
  // The message, the bit 1, zeros, and the bit length as 64 bits: a multiple of 64 bytes.
  const blocks = Math.ceil((message.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const bits = message.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits % 0x1_0000_0000);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block += 1) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] ?? 0;
      const w2 = w[t - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t += 1) {
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * The key hash of the store and cookie names, `rubicon.<keyHash>.device`, `rubicon_<keyHash>`: the
 * first 16 hex characters of the SHA-256 of the API key, as Android (`FileEventStore.kt:79`) and iOS
 * (Web Identity 4).
 */
export function keyHash(apiKey: string): string {
  return sha256Hex(apiKey).slice(0, 16);
}

/** A 32-bit word rotated right by `n` bits. */
function rotr(word: number, n: number): number {
  return (word >>> n) | (word << (32 - n));
}

/**
 * The UTF-8 bytes of `text`. A lone surrogate becomes U+FFFD, as `TextEncoder` writes it (the core
 * has no DOM types); the normalizer has already replaced them in event data (Web Serialization 1).
 */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + (code - 0xd800) * 0x400 + (next - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}
