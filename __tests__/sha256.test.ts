/**
 * Story 3.1 — SHA-256 known-answer tests (FIPS 180-4).
 *
 * The pure-JS SHA-256 in `src/config/sha256.ts` is the password hash
 * mechanism (AD-9). These tests prove the implementation is CORRECT against
 * NIST FIPS 180-4 published digests (not merely self-consistent) and that the
 * UTF-8 encoding path works for non-ASCII input — the path Hermes would break
 * if the byte encoding regressed (Hermes may lack `TextEncoder`, so a minimal
 * in-file UTF-8 encoder is the fallback).
 *
 * Vectors:
 *   - empty string      (the canonical zero-length input)
 *   - "abc"             (FIPS 180-4 B.1, single-block)
 *   - "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
 *                        (FIPS 180-4 B.2, multi-block — 448 bits crosses a
 *                        padding boundary so this exercises the padding/
 *                        schedule across blocks)
 *   - "héllo"           (non-ASCII, U+00E9 = 2-byte UTF-8 — locks the UTF-8
 *                        path; expected digest computed against Node
 *                        `crypto` in a scratch script, not shipped)
 *   - "日本語"          (non-ASCII BMP, 3-byte UTF-8 — locks astral-less
 *                        multi-byte UTF-8; expected from Node `crypto`)
 *
 * The expected digests are the published NIST values for the first three and
 * Node-`crypto`-derived values for the two non-ASCII cases (computed in a
 * throwaway scratch script — not shipped, per the spec).
 */

import { sha256 } from '../src/config/sha256';

// NIST FIPS 180-4 known-answer vectors (B.1 single-block, B.2 multi-block),
// plus the empty-string digest (FIPS 180-4 §B). These are the canonical
// reference values; if the implementation produces these, it is correct.
const NIST_EMPTY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const NIST_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const NIST_LONG =
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';

// Non-ASCII vectors (computed against Node `crypto` in a scratch script — not
// shipped). These lock the UTF-8 byte-encoding path so a regression in the
// in-file UTF-8 encoder (the Hermes fallback) surfaces as a test failure
// rather than a silently-wrong `passwordHash`.
const NONASCII_HELLO =
  '3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179'; // "héllo"
const NONASCII_JAPANESE =
  '77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5'; // "日本語"
// Astral-plane vector (U+1F600 = "😀"), a 4-byte UTF-8 sequence assembled
// from a surrogate pair. This is the ONLY path that exercises the fallback's
// surrogate-pair branch (sha256.ts lines 79-94); the BMP vectors above do
// not. Expected from Node `crypto` (scratch script, not shipped).
const NONASCII_ASTRAL =
  'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9'; // "😀"

test('SHA-256 of the empty string matches the NIST FIPS 180-4 digest', () => {
  expect(sha256('')).toBe(NIST_EMPTY);
});

test('SHA-256 of "abc" matches the NIST FIPS 180-4 B.1 single-block digest', () => {
  expect(sha256('abc')).toBe(NIST_ABC);
});

test('SHA-256 of the 448-bit FIPS 180-4 B.2 multi-block input matches the published digest', () => {
  expect(
    sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  ).toBe(NIST_LONG);
});

test('SHA-256 of non-ASCII input ("héllo") uses UTF-8 byte encoding (locks the Hermes fallback path)', () => {
  expect(sha256('héllo')).toBe(NONASCII_HELLO);
});

test('SHA-256 of multi-byte UTF-8 ("日本語") matches the Node-crypto digest', () => {
  expect(sha256('日本語')).toBe(NONASCII_JAPANESE);
});

test('SHA-256 of an astral-plane emoji ("😀") exercises the fallback surrogate-pair branch', () => {
  // 😀 = U+1F600, which in JS is the surrogate pair 0xD83D 0xDE00. Only the
  // fallback's surrogate-pair branch (4-byte UTF-8) handles this; the BMP
  // vectors above never reach it. Locks that branch against Node `crypto`.
  expect(sha256('😀')).toBe(NONASCII_ASTRAL);
});

test('SHA-256 always returns a 64-char lowercase hex digest', () => {
  for (const input of ['', 'a', 'abc', 'héllo', '日本語']) {
    const digest = sha256(input);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }
});

test('SHA-256 is deterministic: the same input produces the same digest across calls', () => {
  expect(sha256('abc')).toBe(sha256('abc'));
});

test('SHA-256 is sensitive to a single byte (avalanche sanity)', () => {
  // A one-bit change in the input must produce a different digest (SHA-256 is
  // a cryptographic hash; this is a cheap sanity check, not a full avalanche
  // proof).
  expect(sha256('abc')).not.toBe(sha256('abd'));
  expect(sha256('hello')).not.toBe(sha256('héllo'));
});