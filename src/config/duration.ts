/**
 * Duration helpers — pure, unit-tested boundary between the Timer custom input
 * and the Start `disabled` gate (Story 4.1).
 *
 * Two helpers, intentionally narrow:
 *   - `parseDurationMinutes(input)` accepts a minute string in `[1, 1440]`
 *     (inclusive) and returns `{ ok: true, minutes }`; rejects empty, zero,
 *     negative, non-integer, oversized, and whitespace-only inputs with
 *     `{ ok: false, reason }`. The shape mirrors the store's other
 *     `{ ok, ... }` envelopes so the UI can switch on `result.ok` uniformly.
 *   - `formatDurationLabel(minutes)` formats a positive integer minute count
 *     as `"<n> min"` for display in the Start hint + preset chip text.
 *
 * Both helpers are PURE (no I/O, no module state) so they can be unit-tested
 * without a native runtime. The boundary matrix (`''`, `'0'`, `'-1'`,
 * `'30.5'`, `'1441'`, `'1440'`, `'1'`, `'30'`) is locked in
 * `__tests__/duration.test.ts` ahead of UI consumers.
 *
 * The 24-hour ceiling (1440 minutes) matches the spec's upper bound — the
 * Timer never silently truncates an oversized value; the input becomes invalid
 * and Start is gated off until the user fixes it.
 */

export type ParseDurationResult =
  | { ok: true; minutes: number }
  | { ok: false; reason: string };

/** Inclusive upper bound on a valid Timer duration. */
export const DURATION_MIN_MINUTES = 1;
export const DURATION_MAX_MINUTES = 1440;

/**
 * Parse a user-typed duration string. Accepts positive integers in
 * `[DURATION_MIN_MINUTES, DURATION_MAX_MINUTES]`; rejects everything else
 * with a short, user-readable `reason`. The `reason` strings are the
 * canonical user-facing copy for the Timer's inline error message.
 *
 * Leading/trailing whitespace is trimmed before validating so `"  30  "` is
 * accepted as 30 — matches the AddDomain field's `raw.trim()` convention.
 *
 * Returns:
 *   - `{ ok: false, reason: 'empty' }` for empty / whitespace-only input.
 *   - `{ ok: false, reason: 'not-a-number' }` for non-numeric strings
 *     (including `'30.5'`, `'abc'`, `'1e2'`).
 *   - `{ ok: false, reason: 'not-integer' }` for positive floats that survive
 *     the `Number()` parse — defensive; `'30.5'` already fails the parse
 *     path above, but anything that slips through (e.g. `'30.0'`) is caught
 *     by the integer check.
 *   - `{ ok: false, reason: 'out-of-range' }` for values outside
 *     `[DURATION_MIN_MINUTES, DURATION_MAX_MINUTES]`.
 */
export function parseDurationMinutes(input: string): ParseDurationResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }
  // Accept ONLY plain decimal digits (0-9). Reject:
  //   - signs (`+30`, `-1`),
  //   - exponent form (`1e2` -> 100),
  //   - whitespace inside the string (`3 0`),
  //   - decimals (`30.5`).
  // A plain-digit regex is the cleanest gate: `parseInt` is too permissive
  // (`parseInt('30.5')` is 30), `Number()` is too permissive (it accepts
  // exponents and signs). The regex pins the contract to "exactly N digits"
  // so a future caller cannot silently relax it.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: 'not-a-number' };
  }
  const n = Number(trimmed);
  if (n < DURATION_MIN_MINUTES || n > DURATION_MAX_MINUTES) {
    return { ok: false, reason: 'out-of-range' };
  }
  return { ok: true, minutes: n };
}

/**
 * Format a minute count as a label for chips + the inline hint. For
 * `minutes >= 60`, formats as `"<h>h <m>m"` when there are remaining minutes,
 * else `"<h>h"`. For `minutes < 60`, formats as `"<m> min"`. Non-integer /
 * out-of-range values fall back to the input verbatim so a future caller that
 * bypasses `parseDurationMinutes` never gets a misleading label. Pure
 * presentational — does NOT gate Start (that's `parseDurationMinutes`'s job).
 */
export function formatDurationLabel(minutes: number): string {
  if (!Number.isInteger(minutes)) {
    return `${minutes} min`;
  }
  if (minutes < DURATION_MIN_MINUTES || minutes > DURATION_MAX_MINUTES) {
    return `${minutes} min`;
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) {
    return `${h}h`;
  }
  return `${h}h ${m}m`;
}