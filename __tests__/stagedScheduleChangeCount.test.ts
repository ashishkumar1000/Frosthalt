/**
 * @format
 *
 * Story 5.1 — `stagedScheduleChangeCount` tests (the Schedule Apply counter).
 *
 * Mirrors the `stagedChangeCount` contract from Epic 2, applied to the
 * schedule buffer: count = added + field-changed + removed, order-agnostic,
 * with weekday SETS compared as sets (a reordered weekday list is not a
 * change).
 */

import { stagedScheduleChangeCount } from '../src/domain/stagedScheduleChangeCount';
import type { Schedule } from '../src/config/types';

function makeSchedule(overrides?: Partial<Schedule>): Schedule {
  return {
    id: 'focus',
    name: 'Focus',
    weekdays: [0, 1, 2, 3, 4],
    startTime: '09:00',
    endTime: '17:00',
    enabled: true,
    domains: ['example.com'],
    ...overrides,
  };
}

test('identical staged and committed -> 0', () => {
  const schedules = [makeSchedule()];
  expect(stagedScheduleChangeCount(schedules, schedules)).toBe(0);
});

test('an enabled toggle (the only field Schedule 5.1 can stage) counts as 1', () => {
  const committed = [makeSchedule()];
  const staged = [makeSchedule({ enabled: false })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a name change counts as 1', () => {
  const committed = [makeSchedule()];
  const staged = [makeSchedule({ name: 'Deep focus' })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a time change counts as 1', () => {
  const committed = [makeSchedule()];
  const staged = [makeSchedule({ startTime: '10:00' })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a weekday-set change counts as 1', () => {
  const committed = [makeSchedule()];
  const staged = [makeSchedule({ weekdays: [0, 1, 2, 3] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a reordered-but-equal weekday set is NOT a change', () => {
  const committed = [makeSchedule({ weekdays: [0, 1, 2] })];
  const staged = [makeSchedule({ weekdays: [2, 0, 1] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

test('a duplicated-but-equal weekday set is NOT a change', () => {
  const committed = [makeSchedule({ weekdays: [0, 1] })];
  const staged = [makeSchedule({ weekdays: [1, 0, 0] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

test('a reordered-but-equal schedule list is NOT a change (order-agnostic)', () => {
  const committed = [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b', name: 'Evenings' })];
  const staged = [makeSchedule({ id: 'b', name: 'Evenings' }), makeSchedule({ id: 'a' })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

test('an added schedule counts as 1', () => {
  const committed = [makeSchedule({ id: 'a' })];
  const staged = [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b', name: 'Evenings' })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a removed schedule counts as 1', () => {
  const committed = [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b', name: 'Evenings' })];
  const staged = [makeSchedule({ id: 'a' })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('multiple simultaneous changes count individually (added + changed + removed)', () => {
  const committed = [
    makeSchedule({ id: 'a' }),
    makeSchedule({ id: 'b', name: 'Evenings', enabled: false }),
  ];
  const staged = [
    makeSchedule({ id: 'a', enabled: false }), // changed
    makeSchedule({ id: 'c', name: 'Nights' }), // added
    // 'b' removed
  ];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(3);
});

test('empty staged over non-empty committed counts every removal', () => {
  const committed = [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b' })];
  expect(stagedScheduleChangeCount([], committed)).toBe(2);
});

test('an empty committed with staged additions counts every addition', () => {
  const staged = [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b' })];
  expect(stagedScheduleChangeCount(staged, [])).toBe(2);
});
// ---------------------------------------------------------------------------
// 5-1 review EC-4/BH-9: the value key is JSON-encoded, not a `|`/`,` join
// ---------------------------------------------------------------------------

test('names containing the old separator characters are never conflated (EC-4/BH-9)', () => {
  // The JSON-encoded key is injective on the field VALUES: a name that
  // itself contains `|` or `,` cannot shift across the field boundaries the
  // old join-based key had. Under a `|`/`,` join, hand-edited separator-
  // bearing values could alias a different schedule's key and make this diff
  // report 0 for a real change; the JSON key sees the differing fields.
  const committed = [
    makeSchedule({ id: 'a', name: 'a|1,2' }),
    makeSchedule({ id: 'b', name: 'plain', weekdays: [1, 2] }),
  ];
  const staged = [
    makeSchedule({ id: 'a', name: 'a|1,2', enabled: false }), // changed
    makeSchedule({ id: 'b', name: 'plain', weekdays: [2, 1] }), // same set, reordered -> equal
  ];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a weekday set and its reordered twin compare equal inside the JSON key', () => {
  const committed = [makeSchedule({ id: 'a', weekdays: [4, 0, 2] })];
  const staged = [makeSchedule({ id: 'a', weekdays: [0, 2, 4] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

// ---------------------------------------------------------------------------
// Story 5.2 — domains are part of the value key
// ---------------------------------------------------------------------------

test('a domains-only change counts as 1 (scheduleValueKey includes domains)', () => {
  const committed = [makeSchedule()];
  const staged = [makeSchedule({ domains: ['news.site'] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(1);
});

test('a reordered-but-equal domain set is NOT a change (order-agnostic)', () => {
  const committed = [makeSchedule({ domains: ['a.com', 'b.com'] })];
  const staged = [makeSchedule({ domains: ['b.com', 'a.com'] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

test('a duplicated-but-equal domain set is NOT a change', () => {
  const committed = [makeSchedule({ domains: ['a.com'] })];
  const staged = [makeSchedule({ domains: ['a.com', 'a.com'] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

// 5-2 review patch: a MISSING array canonicalises to [] — the same key as an
// explicit empty one — so an enable-toggle copy of a schedule with no domains
// (empty or absent field) is NOT a change and the clean-revert holds.
test('a toggle-copy with the domains field MISSING vs committed domains: [] is NOT a change', () => {
  const committed = [
    makeSchedule({ domains: [] }),
  ];
  // Same enabled value — ONLY the array's presence differs (the enabled
  // delta is covered by its own test above).
  const staged = [
    { ...makeSchedule(), domains: undefined } as unknown as Schedule,
  ];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});

test('a toggle-copy with domains: [] vs committed domains MISSING entirely is NOT a change', () => {
  const committed = [
    { ...makeSchedule(), domains: undefined } as unknown as Schedule,
  ];
  // Same enabled value — ONLY the array's presence differs.
  const staged = [makeSchedule({ domains: [] })];
  expect(stagedScheduleChangeCount(staged, committed)).toBe(0);
});
