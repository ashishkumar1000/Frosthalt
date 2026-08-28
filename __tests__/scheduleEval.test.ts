/**
 * Story 5.3 — `isScheduleActive` unit tests.
 *
 * Pure domain logic — no native modules, no mocks, no real clock: every test
 * pins an injected fixed `Date` (the evaluator never calls `new Date()`).
 * Covers the spec's full I/O & Edge-Case Matrix: in-window, out-of-window,
 * wrong weekday, the half-open boundary edges, a disabled schedule, a legacy
 * unpadded `'9:00'` time, a degenerate window, junk/missing fields, and the
 * weekday mapping (`jsDay 0` Sunday -> 6, `jsDay 1` Monday -> 0).
 */

import { isScheduleActive } from '../src/domain/scheduleEval';
import type { Schedule, Weekday } from '../src/config/types';

/** A well-formed in-window schedule for WEDNESDAY (weekday 2), 09:00-17:00. */
const BASE: Schedule = {
  id: 'focus',
  name: 'Focus',
  weekdays: [2],
  startTime: '09:00',
  endTime: '17:00',
  enabled: true,
  domains: ['example.com'],
};

/**
 * A fixed `Date` for the given JS day-of-week (0 = Sun), hour and minute.
 * 2026-08-05 is a Wednesday (jsDay 3 -> weekday 2) — an arbitrary, stable
 * anchor; the helper derives the weekday from the same mapping the evaluator
 * uses, so a wrong mapping would be caught by the dedicated mapping tests
 * below, not silently hidden here.
 */
function dateAt(
  jsDay: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  // 2026-08-02 is a Sunday; +jsDay walks forward.
  return new Date(2026, 7, 2 + jsDay, hour, minute, second, 0);
}

const WED = 3; // jsDay for Wednesday -> config weekday 2

// ---------------------------------------------------------------------------
// In-window / out-of-window / wrong weekday
// ---------------------------------------------------------------------------

test('in-window: enabled schedule, weekday matches, start <= now < end -> active', () => {
  expect(isScheduleActive(BASE, dateAt(WED, 9, 0))).toBe(true);
  expect(isScheduleActive(BASE, dateAt(WED, 12, 30))).toBe(true);
  expect(isScheduleActive(BASE, dateAt(WED, 16, 59))).toBe(true);
});

test('out-of-window: same config, now after end (or before start) -> inactive', () => {
  expect(isScheduleActive(BASE, dateAt(WED, 17, 0))).toBe(false);
  expect(isScheduleActive(BASE, dateAt(WED, 18, 30))).toBe(false);
  expect(isScheduleActive(BASE, dateAt(WED, 23, 59))).toBe(false);
  expect(isScheduleActive(BASE, dateAt(WED, 8, 59))).toBe(false);
  expect(isScheduleActive(BASE, dateAt(WED, 0, 0))).toBe(false);
});

test('wrong weekday: time matches but the day does not -> inactive', () => {
  // Thursday (jsDay 4 -> weekday 3) at noon: same time, wrong day.
  expect(isScheduleActive(BASE, dateAt(4, 12, 0))).toBe(false);
  // Tuesday (jsDay 2 -> weekday 1) at noon.
  expect(isScheduleActive(BASE, dateAt(2, 12, 0))).toBe(false);
  // Sunday (jsDay 0 -> weekday 6) at noon.
  expect(isScheduleActive(BASE, dateAt(0, 12, 0))).toBe(false);
});

// ---------------------------------------------------------------------------
// Half-open boundary edges (both pinned per the spec)
// ---------------------------------------------------------------------------

test('half-open boundary: now == startTime is ACTIVE', () => {
  expect(isScheduleActive(BASE, dateAt(WED, 9, 0))).toBe(true);
});

test('half-open boundary: now == endTime is INACTIVE', () => {
  expect(isScheduleActive(BASE, dateAt(WED, 17, 0))).toBe(false);
});

test('half-open boundary: the seconds field does not extend the window', () => {
  // 17:00:30 truncates to 17:00 -> end-exclusive -> inactive.
  expect(isScheduleActive(BASE, dateAt(WED, 17, 0, 30))).toBe(false);
  // 16:59:59 truncates to 16:59 -> still inside.
  expect(isScheduleActive(BASE, dateAt(WED, 16, 59, 59))).toBe(true);
});

// ---------------------------------------------------------------------------
// Disabled schedule
// ---------------------------------------------------------------------------

test('disabled schedule: enabled:false contributes nothing even inside the window', () => {
  const disabled: Schedule = { ...BASE, enabled: false };
  expect(isScheduleActive(disabled, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive(disabled, dateAt(WED, 9, 0))).toBe(false);
});

// ---------------------------------------------------------------------------
// Weekday mapping: JS getDay() 0=Sun -> config 6, jsDay 1 (Mon) -> config 0
// ---------------------------------------------------------------------------

test('weekday mapping: a Sunday schedule (config weekday 6) is active on jsDay 0', () => {
  const sunday: Schedule = { ...BASE, weekdays: [6] };
  expect(isScheduleActive(sunday, dateAt(0, 12, 0))).toBe(true);
  // And NOT on Monday (jsDay 1 -> weekday 0).
  expect(isScheduleActive(sunday, dateAt(1, 12, 0))).toBe(false);
});

test('weekday mapping: a Monday schedule (config weekday 0) is active on jsDay 1', () => {
  const monday: Schedule = { ...BASE, weekdays: [0] };
  expect(isScheduleActive(monday, dateAt(1, 12, 0))).toBe(true);
  expect(isScheduleActive(monday, dateAt(0, 12, 0))).toBe(false);
});

test('weekday mapping: the full 0..6 range maps one-to-one against getDay()', () => {
  for (let weekday = 0; weekday <= 6; weekday++) {
    const cfg: Schedule = { ...BASE, weekdays: [weekday as Weekday] };
    const jsDay = (weekday + 1) % 7; // inverse of (jsDay + 6) % 7
    expect(isScheduleActive(cfg, dateAt(jsDay, 12, 0))).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Legacy unpadded time (committed by hand: '9:00')
// ---------------------------------------------------------------------------

test('legacy unpadded time: a committed startTime "9:00" evaluates as 09:00', () => {
  const unpadded = { ...BASE, startTime: '9:00' };
  expect(isScheduleActive(unpadded, dateAt(WED, 9, 0))).toBe(true);
  expect(isScheduleActive(unpadded, dateAt(WED, 8, 59))).toBe(false);
  expect(isScheduleActive(unpadded, dateAt(WED, 12, 0))).toBe(true);
});

test('legacy unpadded time: an unpadded endTime "17:00" / "9:5" evaluates correctly', () => {
  const unpaddedEnd = { ...BASE, endTime: '17:00', startTime: '9:5' };
  // '9:5' -> 09:05, so 09:00 is BEFORE the window.
  expect(isScheduleActive(unpaddedEnd, dateAt(WED, 9, 0))).toBe(false);
  expect(isScheduleActive(unpaddedEnd, dateAt(WED, 9, 5))).toBe(true);
  expect(isScheduleActive(unpaddedEnd, dateAt(WED, 17, 0))).toBe(false);
});

// ---------------------------------------------------------------------------
// Degenerate window (endTime <= startTime, hand-editable)
// ---------------------------------------------------------------------------

test('degenerate window: endTime == startTime is never active', () => {
  const degenerate: Schedule = { ...BASE, startTime: '09:00', endTime: '09:00' };
  expect(isScheduleActive(degenerate, dateAt(WED, 9, 0))).toBe(false);
  expect(isScheduleActive(degenerate, dateAt(WED, 12, 0))).toBe(false);
});

test('degenerate window: endTime < startTime (inverted) is never active', () => {
  const inverted: Schedule = { ...BASE, startTime: '17:00', endTime: '09:00' };
  expect(isScheduleActive(inverted, dateAt(WED, 9, 0))).toBe(false);
  expect(isScheduleActive(inverted, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive(inverted, dateAt(WED, 17, 0))).toBe(false);
});

// ---------------------------------------------------------------------------
// Junk / missing fields — never throws, never crashes the pipeline
// ---------------------------------------------------------------------------

test('junk weekdays: [7, 2] drops the 7 and matches on the valid one', () => {
  const junk: Schedule = { ...BASE, weekdays: [7, 2] as unknown as Weekday[] };
  expect(isScheduleActive(junk, dateAt(WED, 12, 0))).toBe(true);
  // With only junk weekday values the schedule matches no day.
  const allJunk: Schedule = { ...BASE, weekdays: [7, -1] as unknown as Weekday[] };
  expect(isScheduleActive(allJunk, dateAt(WED, 12, 0))).toBe(false);
  // Non-integer and non-number junk (strings, floats) is dropped too — only
  // the valid `2` survives, so the in-window Wednesday still matches.
  const mixedJunk: Schedule = {
    ...BASE,
    weekdays: ['2', 2.5, 2] as unknown as Weekday[],
  };
  expect(isScheduleActive(mixedJunk, dateAt(WED, 12, 0))).toBe(true);
});

test('missing / non-array weekdays -> inactive (bad data shrinks blocking)', () => {
  expect(isScheduleActive({ ...BASE, weekdays: undefined }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, weekdays: 'Monday' }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, weekdays: null }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, weekdays: [] }, dateAt(WED, 12, 0))).toBe(false);
});

test('missing enabled coerces to true (the schedule is ON)', () => {
  const noEnabled = { ...BASE } as Partial<Schedule>;
  delete noEnabled.enabled;
  expect(isScheduleActive(noEnabled, dateAt(WED, 12, 0))).toBe(true);
  // A non-boolean enabled (e.g. a hand-edited string) also coerces to true.
  expect(isScheduleActive({ ...BASE, enabled: 'yes' as unknown as boolean }, dateAt(WED, 12, 0))).toBe(true);
});

test('unparseable times -> inactive, never thrown', () => {
  expect(isScheduleActive({ ...BASE, startTime: '9' }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, endTime: '24:00' }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, startTime: null as unknown as string }, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive({ ...BASE, endTime: 1234 as unknown as string }, dateAt(WED, 12, 0))).toBe(false);
  // Junk domains do NOT make an in-window schedule inactive (they are dropped
  // later, in effectiveBlocklist) — the evaluator only judges the window.
  const junkDomains: Schedule = { ...BASE, domains: ['not a domain', 'ok.com'] };
  expect(isScheduleActive(junkDomains, dateAt(WED, 12, 0))).toBe(true);
});

test('a malformed schedule (null / non-object) is inactive, never thrown', () => {
  expect(isScheduleActive(null, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive(undefined, dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive('focus', dateAt(WED, 12, 0))).toBe(false);
  expect(isScheduleActive(42, dateAt(WED, 12, 0))).toBe(false);
});

test('an invalid now Date is inactive, never thrown', () => {
  expect(isScheduleActive(BASE, new Date(NaN))).toBe(false);
  expect(isScheduleActive(BASE, new Date('not a date'))).toBe(false);
});

test('a non-Date now (null / undefined / number) is inactive, never thrown', () => {
  expect(isScheduleActive(BASE, null as unknown as Date)).toBe(false);
  expect(isScheduleActive(BASE, undefined as unknown as Date)).toBe(false);
  expect(isScheduleActive(BASE, 1234 as unknown as Date)).toBe(false);
});

// ---------------------------------------------------------------------------
// Midnight windows (both edges of the day)
// ---------------------------------------------------------------------------

test('a window starting at 00:00 is active at midnight and inactive at its end', () => {
  const early: Schedule = { ...BASE, startTime: '00:00', endTime: '06:00' };
  expect(isScheduleActive(early, dateAt(WED, 0, 0))).toBe(true);
  expect(isScheduleActive(early, dateAt(WED, 5, 59))).toBe(true);
  expect(isScheduleActive(early, dateAt(WED, 6, 0))).toBe(false);
});

test('a window ending at 23:59 excludes the final minute', () => {
  const late: Schedule = { ...BASE, startTime: '20:00', endTime: '23:59' };
  expect(isScheduleActive(late, dateAt(WED, 23, 58))).toBe(true);
  expect(isScheduleActive(late, dateAt(WED, 23, 59))).toBe(false);
});

// ---------------------------------------------------------------------------
// Purity pins
// ---------------------------------------------------------------------------

test('pure: the schedule object is not mutated and the same inputs replay', () => {
  const schedule: Schedule = { ...BASE, weekdays: [2, 7] as unknown as Weekday[] };
  const snapshot = JSON.stringify(schedule);
  const now = dateAt(WED, 12, 0);
  expect(isScheduleActive(schedule, now)).toBe(true);
  expect(isScheduleActive(schedule, now)).toBe(true);
  expect(JSON.stringify(schedule)).toStrictEqual(snapshot);
});

// Compile-time pin on the signature: schedule is unknown, now is a Date.
const _acceptsUnknownAndDateReturnsBoolean: (
  schedule: unknown,
  now: Date,
) => boolean = isScheduleActive;
void _acceptsUnknownAndDateReturnsBoolean;