/**
 * Duration helpers — boundary matrix (Story 4.1).
 *
 * Locks `parseDurationMinutes` + `formatDurationLabel` against the spec's
 * boundary cases: every I/O matrix row for `parseDurationMinutes` (the
 * `'30'`, `''`, `'0'`, `'-1'`, `'30.5'`, `'1441'`, `'1440'`, `'1'` boundary)
 * plus `formatDurationLabel` for each preset and a couple of custom cases.
 *
 * Pure helpers (no I/O, no module state, no native runtime required) — the
 * test file owns no mocks, just direct calls + assertions.
 */

import {
  parseDurationMinutes,
  formatDurationLabel,
  DURATION_MIN_MINUTES,
  DURATION_MAX_MINUTES,
} from '../src/config/duration';

describe('parseDurationMinutes — boundary matrix', () => {
  test("accepts a positive integer minute string in [1, 1440] and returns its numeric value", () => {
    expect(parseDurationMinutes('30')).toEqual({ ok: true, minutes: 30 });
    expect(parseDurationMinutes('1')).toEqual({ ok: true, minutes: 1 });
    expect(parseDurationMinutes('1440')).toEqual({ ok: true, minutes: 1440 });
    // 25 / 45 / 60 — the three preset chips.
    expect(parseDurationMinutes('25')).toEqual({ ok: true, minutes: 25 });
    expect(parseDurationMinutes('45')).toEqual({ ok: true, minutes: 45 });
    expect(parseDurationMinutes('60')).toEqual({ ok: true, minutes: 60 });
  });

  test('trims leading/trailing whitespace before validating', () => {
    expect(parseDurationMinutes('  30  ')).toEqual({ ok: true, minutes: 30 });
    expect(parseDurationMinutes('\t60\n')).toEqual({ ok: true, minutes: 60 });
  });

  test('rejects empty / whitespace-only input with reason "empty"', () => {
    expect(parseDurationMinutes('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseDurationMinutes('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseDurationMinutes('\t')).toEqual({ ok: false, reason: 'empty' });
  });

  test('rejects zero with reason "out-of-range"', () => {
    expect(parseDurationMinutes('0')).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
  });

  test('rejects negative integers (rejected by the digit-only gate, not the range gate)', () => {
    // The plain-digit regex fires BEFORE the range check, so a signed input
    // is `not-a-number` rather than `out-of-range`. The spec's I/O matrix
    // only requires rejection — the reason text is implementation detail.
    // Pin the actual reason here so a future regex relaxation can't silently
    // shift `-1` to `out-of-range` and break the user-facing error copy.
    expect(parseDurationMinutes('-1')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
    expect(parseDurationMinutes('-30')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
  });

  test('rejects non-integer numeric input with reason "not-a-number"', () => {
    // The plain-digit regex rejects any non-digit character, so decimals and
    // exponents all land in `not-a-number` — not `not-integer`. (The
    // `not-integer` branch is unreachable in practice: a plain-digit regex
    // permits only integers, but the branch is kept as a defensive fallback
    // if a future caller relaxes the regex.)
    expect(parseDurationMinutes('30.5')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
    expect(parseDurationMinutes('30.0')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
  });

  test('rejects non-numeric input with reason "not-a-number"', () => {
    expect(parseDurationMinutes('abc')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
    // Exponent form (`1e2` -> 100): not a plain minute count — reject.
    expect(parseDurationMinutes('1e2')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
    // Signed input (`+30`): the spec wants positive integers — reject.
    expect(parseDurationMinutes('+30')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
    // Internal whitespace (`3 0`): not a single integer — reject.
    expect(parseDurationMinutes('3 0')).toEqual({
      ok: false,
      reason: 'not-a-number',
    });
  });

  test('rejects values above the 1440-minute (24-hour) ceiling', () => {
    expect(parseDurationMinutes('1441')).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    expect(parseDurationMinutes('9999')).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
  });

  test('exposes the [1, 1440] bounds as named constants', () => {
    expect(DURATION_MIN_MINUTES).toBe(1);
    expect(DURATION_MAX_MINUTES).toBe(1440);
  });
});

describe('formatDurationLabel', () => {
  test('formats sub-hour minute counts as "<m> min"', () => {
    expect(formatDurationLabel(25)).toBe('25 min');
    expect(formatDurationLabel(45)).toBe('45 min');
    expect(formatDurationLabel(30)).toBe('30 min');
    expect(formatDurationLabel(1)).toBe('1 min');
  });

  test('formats exact-hour minute counts as "<h>h" (no trailing "0m")', () => {
    expect(formatDurationLabel(60)).toBe('1h');
    expect(formatDurationLabel(120)).toBe('2h');
    expect(formatDurationLabel(1440)).toBe('24h');
  });

  test('formats hour-plus-minute counts as "<h>h <m>m"', () => {
    expect(formatDurationLabel(90)).toBe('1h 30m');
    expect(formatDurationLabel(75)).toBe('1h 15m');
  });

  test('falls back to verbatim "<n> min" for non-integer / out-of-range / zero inputs', () => {
    // The function is permissive on the rendering side (it does not gate
    // Start — that's `parseDurationMinutes`'s job). Non-integer and out-of-
    // range values are not silently re-mapped. Zero is rendered defensively
    // as "0 min" — the caller is supposed to gate Start on validity, but the
    // render path must not crash if it slips through.
    expect(formatDurationLabel(0)).toBe('0 min');
    expect(formatDurationLabel(30.5)).toBe('30.5 min');
    expect(formatDurationLabel(-1)).toBe('-1 min');
    expect(formatDurationLabel(9999)).toBe('9999 min');
  });
});