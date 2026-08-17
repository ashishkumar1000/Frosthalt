/**
 * Pure-JS SHA-256 (FIPS 180-4), salt-free — the hash mechanism for
 * `passwordHash` (AD-9, Story 3.1).
 *
 * No runtime dependency, no native module — the Epic-3 context requires "no
 * new native module", so the hash lives entirely in the JS layer. The
 * ConfigStore native adapter stays a dumb string-file writer; it never sees
 * hashing or `passwordHash` validation.
 *
 * Operates on a byte array. The input string is UTF-8 encoded first: SHA-256
 * hashes bytes, and a JS string is UTF-16 internally, so hashing the char
 * codes directly would diverge from every reference implementation (and from
 * `node crypto` / `openssl`, which the manual config.json inspection is
 * compared against). Hermes may not expose `TextEncoder`; a minimal in-file
 * UTF-8 encoder is included as a fallback so the byte encoding is correct on
 * every runtime, and the non-ASCII NIST-style test vector
 * (`__tests__/sha256.test.ts`) locks that path.
 *
 * The implementation follows FIPS 180-4 precisely: 32-bit words, the six
 * functions (Ch, Maj, Σ0, Σ1, σ0, σ1), the 64 round constants, and the
 * standard message schedule + compression. Pads per the spec (append 0x80,
 * zero bits, then the 64-bit big-endian bit length) so the empty string and
 * multi-block inputs both produce the published digests.
 */

/** SHA-256 output: a 64-character lowercase hex string. */
export type Sha256Hex = string;

/**
 * Compute the SHA-256 hash of `input` (UTF-8 encoded) and return a 64-char
 * lowercase hex digest. Pure: no globals mutated, no I/O.
 */
export function sha256(input: string): Sha256Hex {
  const bytes = utf8Encode(input);
  return hashBytes(bytes);
}

// ---------------------------------------------------------------------------
// UTF-8 encoding
// ---------------------------------------------------------------------------

/**
 * UTF-8-encode a JS string to a `Uint8Array`. Uses the global `TextEncoder`
 * when present (Node, modern browsers, newer Hermes); otherwise falls back to
 * the in-file minimal encoder. The fallback is ~30 lines and handles the full
 * UTF-8 range (1-4 byte sequences incl. astral planes via surrogate pairs) —
 * kept in-file so Hermes (which historically lacks `TextEncoder`) still
 * produces correct bytes, and the non-ASCII test vector locks it.
 */
function utf8Encode(input: string): Uint8Array {
  // Cast through `unknown` to a permissive shape — `TextEncoder` is not in the
  // RN TypeScript lib defs, and Hermes may not expose it at runtime either.
  // The `typeof ... !== 'undefined'` guard is what makes this safe: we only
  // call the constructor when it actually exists.
  const g = globalThis as unknown as {
    TextEncoder?: { new (): { encode(s: string): Uint8Array } };
  };
  if (typeof g.TextEncoder !== 'undefined') {
    return new g.TextEncoder!().encode(input);
  }
  return utf8EncodeFallback(input);
}

/**
 * Minimal UTF-8 encoder (RFC 3629). Handles BMP code points directly and
 * decodes surrogate pairs for astral code points (U+10000..U+10FFFF) so the
 * non-ASCII test vector and emoji inputs both hash correctly. Used only when
 * the global `TextEncoder` is absent (older Hermes).
 */
function utf8EncodeFallback(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6));
      out.push(0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: pair with the next char (low surrogate) to reassemble
      // an astral code point. If the next char is missing or not a low
      // surrogate, emit the replacement byte (U+FFFD = 0xEF 0xBF 0xBD) — the
      // same behaviour as TextEncoder for a lone surrogate.
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp =
          0x10000 +
          ((code - 0xd800) << 10) +
          (next - 0xdc00);
        out.push(0xf0 | (cp >> 18));
        out.push(0x80 | ((cp >> 12) & 0x3f));
        out.push(0x80 | ((cp >> 6) & 0x3f));
        out.push(0x80 | (cp & 0x3f));
        i += 1; // consume the low surrogate
      } else {
        // Lone high surrogate — emit U+FFFD.
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate — emit U+FFFD.
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (code >> 12));
      out.push(0x80 | ((code >> 6) & 0x3f));
      out.push(0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// SHA-256 core (FIPS 180-4)
// ---------------------------------------------------------------------------

// Round constants (first 32 bits of the fractional parts of the cube roots of
// the first 64 primes), per FIPS 180-4 §4.2.2.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Right-rotate a 32-bit word.
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of a byte array — the core, separated so UTF-8 encoding is testable. */
function hashBytes(bytes: Uint8Array): Sha256Hex {
  // Initial hash values (first 32 bits of the fractional parts of the square
  // roots of the first 8 primes), FIPS 180-4 §5.3.3.
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  // Pre-processing: padding. The message is padded with 0x80, then zero bits,
  // then a 64-bit big-endian bit length, so the total is a multiple of 512
  // bits (64 bytes). The 64-bit length is split into two 32-bit halves so this
  // works for inputs up to ~500 MB without floating-point precision loss
  // (JS bitwise ops are 32-bit; the high length word would otherwise be lost
  // on inputs longer than 512 MB, far beyond any password).
  const bitLen = bytes.length * 8;
  const bitLenHi = Math.floor(bytes.length / 0x20000000) & 0xffffffff;
  const bitLenLo = bitLen >>> 0;

  // The padded message length: original + 1 (0x80) + padding zeros + 8 (length).
  // Append 1 byte of 0x80 first, then pad with zeros until length ≡ 56 (mod 64),
  // then append the 8-byte length.
  const paddedLen =
    Math.floor((bytes.length + 8) / 64) * 64 + 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // The bytes between `bytes.length + 1` and `paddedLen - 8` are already 0.
  // Append the 64-bit big-endian bit length (high word first).
  padded[paddedLen - 8] = (bitLenHi >>> 24) & 0xff;
  padded[paddedLen - 7] = (bitLenHi >>> 16) & 0xff;
  padded[paddedLen - 6] = (bitLenHi >>> 8) & 0xff;
  padded[paddedLen - 5] = bitLenHi & 0xff;
  padded[paddedLen - 4] = (bitLenLo >>> 24) & 0xff;
  padded[paddedLen - 3] = (bitLenLo >>> 16) & 0xff;
  padded[paddedLen - 2] = (bitLenLo >>> 8) & 0xff;
  padded[paddedLen - 1] = bitLenLo & 0xff;

  // Process each 512-bit (64-byte) block.
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    // Message schedule, words 0..15 from the block (big-endian).
    for (let t = 0; t < 16; t++) {
      w[t] =
        (padded[off + t * 4] << 24) |
        (padded[off + t * 4 + 1] << 16) |
        (padded[off + t * 4 + 2] << 8) |
        padded[off + t * 4 + 3];
    }
    // Extend the schedule to 64 words.
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    // Initialize the working variables from the current hash state.
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;

    // 64 rounds of compression.
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    // Add the compressed block to the current hash value.
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }

  // Produce the final big-endian hex digest.
  return (
    hex32(h0) +
    hex32(h1) +
    hex32(h2) +
    hex32(h3) +
    hex32(h4) +
    hex32(h5) +
    hex32(h6) +
    hex32(h7)
  );
}

/** Format a 32-bit word as 8 lowercase hex digits (big-endian). */
function hex32(x: number): string {
  return (x >>> 0).toString(16).padStart(8, '0');
}