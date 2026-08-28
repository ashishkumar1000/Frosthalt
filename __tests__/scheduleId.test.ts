/**
 * @format
 *
 * Story 5.2 — `nextScheduleId` unit tests (pure schedule-id generation).
 *
 * Pins the spec's golden examples: "Focus mornings" slugifies to
 * `focus-mornings`; a collision uniquifies to `focus-mornings-2` (then -3, …).
 * Pure domain logic — no native modules, no mocks.
 */

import { nextScheduleId } from '../src/domain/scheduleId';

// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

test('a plain name slugifies to lowercase kebab-case', () => {
  expect(nextScheduleId('Focus mornings', [])).toBe('focus-mornings');
});

test('mixed case is lowercased', () => {
  expect(nextScheduleId('Focus Mornings', [])).toBe('focus-mornings');
});

test('punctuation and whitespace collapse into single dashes', () => {
  expect(nextScheduleId('Deep  work / focus!!', [])).toBe('deep-work-focus');
});

test('leading and trailing separators are trimmed', () => {
  expect(nextScheduleId('  --Evenings--  ', [])).toBe('evenings');
});

test('a name that slugifies to nothing falls back to `schedule`', () => {
  expect(nextScheduleId('', [])).toBe('schedule');
  expect(nextScheduleId('   ', [])).toBe('schedule');
  expect(nextScheduleId('!!!', [])).toBe('schedule');
});

// ---------------------------------------------------------------------------
// Uniquification
// ---------------------------------------------------------------------------

test('an unused slug is returned verbatim (no suffix)', () => {
  expect(nextScheduleId('Focus mornings', ['evenings'])).toBe(
    'focus-mornings',
  );
});

test('a collision gets the -2 suffix (the spec golden example)', () => {
  expect(nextScheduleId('Focus mornings', ['focus-mornings'])).toBe(
    'focus-mornings-2',
  );
});

test('the suffix ladder walks -2, -3, ... until free', () => {
  expect(
    nextScheduleId('Focus', ['focus', 'focus-2', 'focus-3']),
  ).toBe('focus-4');
});

test('an unrelated id containing the slug as a substring does NOT collide', () => {
  expect(nextScheduleId('Focus', ['focus-mornings'])).toBe('focus');
});

test('existingIds is order-irrelevant (membership only)', () => {
  expect(nextScheduleId('Evenings', ['focus', 'evenings', 'other'])).toBe(
    'evenings-2',
  );
});

// Compile-time pin: the export keeps its contract.
const _nextScheduleIdAcceptsNameAndIdsReturnsString: (
  name: string,
  existingIds: readonly string[],
) => string = nextScheduleId;
void _nextScheduleIdAcceptsNameAndIdsReturnsString;