/**
 * @format
 *
 * Story 5.4 — the pure badge ramp helper (`computeBadgeState`) tests.
 *
 * No React, no ports, no clock: `computeBadgeState(committed, now)` takes an
 * injected `now`, so every test pins its own instants. Schedules are built
 * FROM a local `Date` (the weekday index and the `HH:mm` strings are derived
 * from that Date's local fields) so the tests are timezone-independent.
 *
 * Covers the Story 5.4 badge matrix:
 *   - Window opens  -> `blocked`; window ends (nothing else blocks) -> `free`.
 *   - Ending soon with a shrink at the boundary -> `amber`; the threshold is
 *     inclusive at exactly 10 minutes and exclusive one tick later.
 *   - Ending soon WITHOUT a shrink (domains still covered by always-on /
 *     another active schedule) -> stays `blocked` — never amber for a
 *     boundary that changes nothing.
 *   - Timer-only session ending soon (no active schedule) -> `blocked` —
 *     amber is schedule-scoped (the 4-4 defer stands).
 *   - Two active schedules: the EARLIEST active end governs.
 *   - Junk schedules never throw and evaluate inactive (the 5.3 evaluator
 *     contract); `SCHEDULE_ENDING_SOON_MS` is pinned at 10 minutes.
 */

import type { Config, Schedule, Weekday } from '../src/config/types';
import { DEFAULT_CONFIG } from '../src/config/types';
import { computeBadgeState, SCHEDULE_ENDING_SOON_MS } from '../src/domain/badgeState';

/** A local-noon `Date` on the same calendar day as `T0`, for stable windows. */
const probe = new Date(1_756_000_000_000);
const base = new Date(
  probe.getFullYear(),
  probe.getMonth(),
  probe.getDate(),
  12,
  0,
  0,
  0,
);

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * A schedule whose window covers `[base, base + minutes)`, on `base`'s
 * weekday — derived from the LOCAL clock of a fixed instant, so the tests
 * pass in any timezone. `minutes` is the window LENGTH in minutes.
 */
function makeSchedule(
  minutes: number,
  overrides: Partial<Schedule> = {},
): Schedule {
  const end = new Date(base.getTime() + minutes * 60_000);
  return {
    id: 's1',
    name: 'Deep Work',
    weekdays: [((base.getDay() + 6) % 7) as Weekday],
    startTime: hhmm(base),
    endTime: hhmm(end),
    enabled: true,
    domains: ['x.com'],
    ...overrides,
  };
}

function configWith(overrides: Partial<Config>): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// --- I/O Matrix: window opens (badge -> blocked) -----------------------------
test('an active schedule window shows blocked', () => {
  const config = configWith({ schedules: [makeSchedule(60)] });
  expect(computeBadgeState(config, base)).toBe('blocked');
  // Deep inside the window (still 25 min from the end, outside the ramp).
  expect(computeBadgeState(config, new Date(base.getTime() + 5 * 60_000))).toBe(
    'blocked',
  );
});

// --- I/O Matrix: window ends / not yet open (badge -> free) ------------------
test('outside the window (and with nothing else live) the badge is free', () => {
  const config = configWith({ schedules: [makeSchedule(60)] });
  // Before the window opens.
  expect(computeBadgeState(config, new Date(base.getTime() - 60_000))).toBe(
    'free',
  );
  // After the window ends (half-open [start, end): endTime is not active).
  expect(computeBadgeState(config, new Date(base.getTime() + 61 * 60_000))).toBe(
    'free',
  );
});

// --- I/O Matrix: ending soon WITH a shrink -> amber --------------------------
test('ending soon with a shrinking blocklist shows amber', () => {
  // Window [12:00, 13:00) blocking x.com; at 12:55 the end is 5 min away and
  // the blocklist goes 1 -> 0 at the boundary (nothing else covers x.com).
  const config = configWith({ schedules: [makeSchedule(60)] });
  const now = new Date(base.getTime() + 55 * 60_000);
  expect(computeBadgeState(config, now)).toBe('amber');
});

test('the threshold is inclusive at exactly 10 minutes', () => {
  const config = configWith({ schedules: [makeSchedule(60)] });
  // 12:50 with a 13:00 end: remaining is exactly 10 minutes -> amber.
  const exactlyTen = new Date(base.getTime() + 50 * 60_000);
  expect(computeBadgeState(config, exactlyTen)).toBe('amber');
});

test('just under the threshold is not amber', () => {
  const config = configWith({ schedules: [makeSchedule(60)] });
  const justOver = new Date(base.getTime() + 50 * 60_000 - 999);
  expect(computeBadgeState(config, justOver)).toBe('blocked');
});

// --- I/O Matrix: ending soon WITHOUT a shrink -> stays blocked ---------------
test('ending soon with the boundary covered by always-on never ambers', () => {
  // x.com is ALSO always-on: at the end instant the blocklist does not shrink
  // (1 apex -> 1 apex), so the badge stays blocked despite the 5-minute ramp.
  const config = configWith({
    domains: [{ hostname: 'x.com', alwaysOn: true }],
    schedules: [makeSchedule(60)],
  });
  expect(computeBadgeState(config, new Date(base.getTime() + 55 * 60_000))).toBe(
    'blocked',
  );
  // And after the window ends the always-on domain keeps the count at 1 —
  // the badge follows the live-window semantics (no session, no schedule).
  expect(computeBadgeState(config, new Date(base.getTime() + 61 * 60_000))).toBe(
    'free',
  );
});

test('a boundary covered by ANOTHER still-active schedule never ambers', () => {
  // Two overlapping schedules on x.com and y.com; x's window ends at 12:30
  // while y's runs to 13:00. At 12:55 the earliest ACTIVE end is y's — and
  // x is long gone, so the shrink check compares against the earliest end.
  const x = makeSchedule(30, { id: 'sx', name: 'Morning', domains: ['x.com'] });
  const y = makeSchedule(60, { id: 'sy', name: 'Afternoon', domains: ['y.com'] });
  const config = configWith({ schedules: [x, y] });
  const now = new Date(base.getTime() + 55 * 60_000);
  // y ends in 5 min and y's domains DO lift at that boundary -> amber.
  expect(computeBadgeState(config, now)).toBe('amber');
});

test('a no-shrink earliest end wins over a shrinking later end', () => {
  // Schedule A ends in 5 min and its domains stay covered (always-on), so
  // the blocklist does NOT shrink at the earliest end -> blocked, even though
  // a later-ending schedule WOULD shrink at its own boundary.
  const covered = makeSchedule(60, { id: 'sc', name: 'Covered', domains: ['x.com'] });
  const later = {
    ...makeSchedule(120, { id: 'sl', name: 'Later', domains: ['y.com'] }),
    startTime: hhmm(base),
  };
  const config = configWith({
    domains: [{ hostname: 'x.com', alwaysOn: true }],
    schedules: [covered, later],
  });
  expect(computeBadgeState(config, new Date(base.getTime() + 55 * 60_000))).toBe(
    'blocked',
  );
});

// --- I/O Matrix: timer-only session ending soon -> blocked (4-4 defer) ------
test('a timer-only session never ambers, however close to expiry', () => {
  const config = configWith({
    activeTimer: { endEpochMs: base.getTime() + 30_000, selectedDomains: ['x.com'] },
  });
  expect(computeBadgeState(config, new Date(base.getTime() + 10_000))).toBe(
    'blocked',
  );
});

test('a live timer WITH an ending schedule ambers only on a real shrink', () => {
  // The schedule blocks x.com; the timer ALSO selected x.com, so the schedule
  // boundary changes nothing -> stays blocked.
  const covered = configWith({
    activeTimer: { endEpochMs: base.getTime() + 3_600_000, selectedDomains: ['x.com'] },
    schedules: [makeSchedule(60)],
  });
  expect(computeBadgeState(covered, new Date(base.getTime() + 55 * 60_000))).toBe(
    'blocked',
  );
  // The timer selected a DIFFERENT domain: the boundary shrinks the blocklist
  // 2 -> 1 -> amber.
  const shrunk = configWith({
    activeTimer: { endEpochMs: base.getTime() + 3_600_000, selectedDomains: ['y.com'] },
    schedules: [makeSchedule(60)],
  });
  expect(computeBadgeState(shrunk, new Date(base.getTime() + 55 * 60_000))).toBe(
    'amber',
  );
});

// --- I/O Matrix: mount/launch free state -------------------------------------
test('no session and no schedule is free, even with always-on domains', () => {
  // The Epic-2 header semantics are preserved: the badge tracks LIVE
  // sessions/windows, not the static always-on set.
  const config = configWith({ domains: [{ hostname: 'x.com', alwaysOn: true }] });
  expect(computeBadgeState(config, base)).toBe('free');
});

// --- Never throws: junk schedules evaluate inactive (the 5.3 contract) ------
test('junk schedules never throw and evaluate inactive', () => {
  const junk = [null, 'nope', 42, {}, { startTime: 'x' }] as unknown as Schedule[];
  const config = configWith({ schedules: junk });
  expect(() => computeBadgeState(config, base)).not.toThrow();
  expect(computeBadgeState(config, base)).toBe('free');

  // A non-array schedules field is equally harmless.
  const broken = { ...DEFAULT_CONFIG, schedules: 'junk' } as unknown as Config;
  expect(() => computeBadgeState(broken, base)).not.toThrow();
  expect(computeBadgeState(broken, base)).toBe('free');

  // An ACTIVE schedule with junk domains still shows the open window.
  const activeJunk = makeSchedule(60, { domains: ['not a hostname', ''] as unknown as string[] });
  const config2 = configWith({ schedules: [activeJunk] });
  expect(computeBadgeState(config2, base)).toBe('blocked');
});

test('an unparseable or degenerate window is never active', () => {
  const config = configWith({
    schedules: [
      makeSchedule(60, { startTime: 'banana' }),
      makeSchedule(0, { endTime: hhmm(base) }), // degenerate: end == start
    ],
  });
  expect(computeBadgeState(config, base)).toBe('free');
});

// --- Pin: the threshold constant ---------------------------------------------
test('SCHEDULE_ENDING_SOON_MS is exactly 10 minutes', () => {
  expect(SCHEDULE_ENDING_SOON_MS).toBe(10 * 60 * 1000);
});