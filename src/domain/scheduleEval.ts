/**
 * Schedule-window evaluation (Story 5.3 / Epic 5).
 *
 * The PURE evaluator that decides whether a schedule is active RIGHT NOW: it
 * answers "is this schedule's weekly block window covering this moment?" and
 * is the gate behind which a schedule's domains enter `effectiveBlocklist`.
 * It owns NO state and performs NO I/O — `now` is an injected `Date`
 * parameter, never `new Date()` internally (call sites default it, tests pin
 * it), so the evaluation is deterministic and Jest-testable.
 *
 * Defensive posture (mirrors the store's readConfig shape-gating): a
 * hand-edited `config.json` schedule may have missing/junk fields — the
 * evaluator NEVER throws, it only ever returns `true`/`false`:
 *   - `enabled`      coerces to `true` when missing/non-boolean (the store's
 *                    "missing toggle = on" convention); `false` disables.
 *   - `weekdays`     missing or not an array -> empty -> matches no weekday ->
 *                    inactive (bad data shrinks blocking, never grows it).
 *                    Junk elements (non-integer, out of 0..6, strings) are
 *                    dropped; the remaining valid ones are matched.
 *   - times          parsed via `normaliseTime` (Story 5.2) so an UNPADDED
 *                    committed `'9:00'` evaluates as 09:00. Unparseable start
 *                    or end -> inactive.
 *   - degenerate     `endTime <= startTime` (hand-editable) -> never active.
 *   - `now`          a non-Date or NaN-time `now` -> inactive (never throws).
 *
 * Window semantics: HALF-OPEN `[start, end)` — `start` inclusive, `end`
 * exclusive, so `now == startTime` is active and `now == endTime` is not.
 *
 * Weekday mapping: config uses 0 = Mon .. 6 = Sun while JS `Date.getDay()`
 * returns 0 = Sun .. 6 = Sat; the conversion is `(jsDay + 6) % 7`. An empty
 * weekday list (or a weekday not in the list) is inactive regardless of time.
 */

import { normaliseTime } from './normalise';

/**
 * True when `schedule` is an enabled schedule whose weekly window contains
 * `now`. TOTAL and PURE: never throws, never reads the clock itself, never
 * mutates its inputs. A malformed `schedule` (null, non-object, junk fields)
 * evaluates to `false` — never crashes the hosts pipeline.
 */
export function isScheduleActive(schedule: unknown, now: Date): boolean {
  if (schedule == null || typeof schedule !== 'object') {
    return false;
  }
  // A non-Date or NaN-time `now` is never active — never throws (a hand-edited
  // caller or a corrupt clock read must not crash the hosts pipeline). Checked
  // STRUCTURALLY (a callable `getTime`) rather than with `instanceof`, which
  // would misjudge a Date built in another JS realm — or under a mocked global
  // `Date` in tests — as a non-Date.
  if (
    now == null ||
    typeof (now as { getTime?: unknown }).getTime !== 'function' ||
    Number.isNaN((now as Date).getTime())
  ) {
    return false;
  }
  const s = schedule as Record<string, unknown>;

  // Missing / non-boolean `enabled` means ON (the hand-edit convention: only
  // an explicit `false` turns a schedule off).
  const enabled = typeof s.enabled === 'boolean' ? s.enabled : true;
  if (!enabled) {
    return false;
  }

  // Weekday gate: the config's 0=Mon..6=Sun index of `now` must be a member
  // of the (defensively filtered) weekday list. A missing/non-array list
  // yields an empty set -> no weekday matches -> inactive.
  if (!Array.isArray(s.weekdays)) {
    return false;
  }
  const weekday = (now.getDay() + 6) % 7;
  const weekdays = new Set<number>();
  for (const raw of s.weekdays) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) {
      weekdays.add(raw);
    }
  }
  if (!weekdays.has(weekday)) {
    return false;
  }

  // Time gate. `normaliseTime` accepts unpadded `H:mm` (a committed
  // `'9:00'` evaluates as 09:00) and returns `null` for anything unusable.
  const start = normaliseTime(s.startTime);
  const end = normaliseTime(s.endTime);
  if (start == null || end == null) {
    return false;
  }
  const startMinutes =
    Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
  const endMinutes = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
  // Degenerate window (hand-editable: `endTime <= startTime`) is never
  // active — blocking only ever shrinks on bad data.
  if (endMinutes <= startMinutes) {
    return false;
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  // Half-open [start, end): `now == startTime` active, `now == endTime` not.
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}