/**
 * @format
 *
 * Story 5.1 — `formatScheduleSummary` tests (the pure schedule formatter).
 *
 * Pins the spec's frozen grammar golden examples + the TOTAL contract (the
 * formatter never throws on a malformed schedule element — `readConfig`
 * shape-gates the `schedules` ARRAY only, so a hand-edited config can carry
 * elements with missing/wrong-typed fields).
 */

import { formatScheduleSummary } from '../src/domain/scheduleSummary';
import type { Schedule } from '../src/config/types';

/** A valid baseline schedule; tests override the fields they exercise. */
function makeSchedule(overrides?: Partial<Schedule>): Schedule {
  return {
    id: 'focus',
    name: 'Focus',
    weekdays: [0, 1, 2, 3, 4],
    startTime: '09:00',
    endTime: '17:00',
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The frozen grammar golden examples
// ---------------------------------------------------------------------------

test('all 7 weekdays -> "Every day, 09:00–17:00"', () => {
  expect(
    formatScheduleSummary(makeSchedule({ weekdays: [0, 1, 2, 3, 4, 5, 6] })),
  ).toBe('Every day, 09:00–17:00');
});

test('a contiguous run -> "Every Mon–Fri, 09:00–17:00"', () => {
  expect(formatScheduleSummary(makeSchedule({ weekdays: [0, 1, 2, 3, 4] }))).toBe(
    'Every Mon–Fri, 09:00–17:00',
  );
});

test('a single day -> the FULL name: "Every Monday, 09:00–17:00"', () => {
  expect(formatScheduleSummary(makeSchedule({ weekdays: [0] }))).toBe(
    'Every Monday, 09:00–17:00',
  );
  expect(formatScheduleSummary(makeSchedule({ weekdays: [6] }))).toBe(
    'Every Sunday, 09:00–17:00',
  );
});

test('a mixed list -> "Every Mon, Wed–Thu, Sat, 09:00–17:00"', () => {
  // [0, 2, 3, 5]: Mon isolated, Wed–Thu run, Sat isolated.
  expect(formatScheduleSummary(makeSchedule({ weekdays: [0, 2, 3, 5] }))).toBe(
    'Every Mon, Wed–Thu, Sat, 09:00–17:00',
  );
});

test('empty weekdays -> time only: "09:00–17:00"', () => {
  expect(formatScheduleSummary(makeSchedule({ weekdays: [] }))).toBe(
    '09:00–17:00',
  );
});

test('times pass through verbatim, joined by the en dash', () => {
  expect(
    formatScheduleSummary(makeSchedule({ startTime: '22:30', endTime: '06:15' })),
  ).toBe('Every Mon–Fri, 22:30–06:15');
});

// ---------------------------------------------------------------------------
// Canonical order + de-duplication
// ---------------------------------------------------------------------------

test('weekdays render in canonical Mon→Sun order regardless of stored order', () => {
  // Stored [4, 0, 2] -> canonical Mon, Wed, Fri.
  expect(formatScheduleSummary(makeSchedule({ weekdays: [4, 0, 2] }))).toBe(
    'Every Mon, Wed, Fri, 09:00–17:00',
  );
});

test('duplicate weekdays are de-duplicated', () => {
  expect(formatScheduleSummary(makeSchedule({ weekdays: [0, 0, 1, 1] }))).toBe(
    'Every Mon–Tue, 09:00–17:00',
  );
});

test('a two-day contiguous pair renders as a run: "Every Sat–Sun, …"', () => {
  expect(formatScheduleSummary(makeSchedule({ weekdays: [5, 6] }))).toBe(
    'Every Sat–Sun, 09:00–17:00',
  );
});

// ---------------------------------------------------------------------------
// TOTAL: malformed schedules never throw (hand-edited config elements)
// ---------------------------------------------------------------------------

test('a null schedule renders "" (total — never throws)', () => {
  // Cast: the runtime reality of an unvalidated config element.
  expect(formatScheduleSummary(null as unknown as Schedule)).toBe('');
  expect(formatScheduleSummary(undefined as unknown as Schedule)).toBe('');
});

test('missing fields render fail-safe: no weekdays -> time only, missing times -> empty strings', () => {
  // An element missing every optional detail (cast: unvalidated config).
  expect(formatScheduleSummary({} as unknown as Schedule)).toBe('–');
  // Missing times with valid weekdays -> the weekday grammar with empty times.
  expect(
    formatScheduleSummary(makeSchedule({ startTime: undefined as unknown as string })),
  ).toBe('Every Mon–Fri, –17:00');
  expect(
    formatScheduleSummary(makeSchedule({ endTime: undefined as unknown as string })),
  ).toBe('Every Mon–Fri, 09:00–');
});

test('non-string times render raw (no throw, no reformat)', () => {
  expect(
    formatScheduleSummary(
      makeSchedule({
        startTime: 9 as unknown as string,
        endTime: true as unknown as string,
      }),
    ),
  ).toBe('Every Mon–Fri, –');
});

test('non-array weekdays are dropped -> time only', () => {
  expect(
    formatScheduleSummary(
      makeSchedule({ weekdays: 'mon-fri' as unknown as Schedule['weekdays'] }),
    ),
  ).toBe('09:00–17:00');
  expect(
    formatScheduleSummary(makeSchedule({ weekdays: null as unknown as Schedule['weekdays'] })),
  ).toBe('09:00–17:00');
});

test('unknown weekday indices are dropped (never crash, never invent a day)', () => {
  // 7, -1, 2.5, and '1' are all invalid -> only 0 survives.
  expect(
    formatScheduleSummary(
      makeSchedule({ weekdays: [7, -1, 2.5, '1', 0] as unknown as Schedule['weekdays'] }),
    ),
  ).toBe('Every Monday, 09:00–17:00');
});