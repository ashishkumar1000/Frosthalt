/**
 * Story 1.6 / Story 4.2 / Story 5.3 — `effectiveBlocklist` unit tests.
 *
 * Pure domain logic — no native modules, no mocks. Covers:
 *   - Epic 1 contribution: `domains.filter(alwaysOn)`, normalised + deduped.
 *   - Epic 4 (Story 4.2) contribution: `activeTimer?.selectedDomains` is
 *     walked AFTER the always-on loop with the same `normaliseDomain` +
 *     apex dedupe discipline so an apex that's both always-on AND timer-
 *     selected lands ONCE. When `activeTimer` is null (no session) the
 *     contribution is empty.
 *   - Epic 5 (Story 5.3) contribution: an ENABLED schedule whose weekly
 *     window contains `now` contributes its domains, walked LAST (after the
 *     timer walk) with the same normalise + apex dedupe, so an apex that is
 *     always-on AND timer-selected AND scheduled writes ONCE. Disabled or
 *     out-of-window schedules contribute nothing.
 *   - Defensive: a non-hostname in `activeTimer.selectedDomains` or in an
 *     active schedule's `domains` is skipped rather than crashing the
 *     pipeline (mirrors the always-on loop's posture).
 */

import { effectiveBlocklist } from '../src/domain/effectiveBlocklist';
import type { ActiveTimer, Config, Domain, Schedule, Weekday } from '../src/config/types';
import { DEFAULT_CONFIG } from '../src/config/types';

function configWith(domains: Domain[]): Config {
  return {
    ...DEFAULT_CONFIG,
    domains,
  };
}

test('an empty config yields an empty effective blocklist', () => {
  expect(effectiveBlocklist(DEFAULT_CONFIG)).toStrictEqual([]);
});

test('only alwaysOn domains are included; alwaysOn:false is excluded', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'news.site', alwaysOn: false },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual([
    'example.com',
    'social.com',
  ]);
});

test('all domains with alwaysOn:false yields an empty effective blocklist', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: false },
    { hostname: 'news.site', alwaysOn: false },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual([]);
});

test('duplicate apexes (by hostname) are deduped, preserving first-seen order', () => {
  // A corrupt config with a duplicate hostname PK is deduped.
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a www.-prefixed or upper-case stored hostname is normalised to the apex', () => {
  // A hand-edited config.json could store a non-normalised hostname. The
  // computation normalises defensively so the hosts payload stays clean.
  const cfg = configWith([
    { hostname: 'www.example.com', alwaysOn: true },
    { hostname: 'EXAMPLE.COM', alwaysOn: true },
    { hostname: 'https://social.com/', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a corrupt (non-hostname) entry is skipped, not thrown', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'not a domain', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com', 'social.com']);
});

test('a single alwaysOn domain yields a single apex', () => {
  const cfg = configWith([{ hostname: 'example.com', alwaysOn: true }]);
  expect(effectiveBlocklist(cfg)).toStrictEqual(['example.com']);
});

// ===========================================================================
// Story 4.2 — Epic 4 contribution: `activeTimer?.selectedDomains` walked
// after the always-on loop with normalise + dedupe.
// ===========================================================================

test('Epic 4 (activeTimer) union: alwaysOn + selectedDomains is appended after the always-on loop', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['b.com'],
    },
  };
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com', 'b.com']);
});

test('Epic 4: a null activeTimer contributes nothing (alwaysOn-only)', () => {
  const cfg = configWith([{ hostname: 'a.com', alwaysOn: true }]);
  // activeTimer is null on a fresh config — the union adds nothing.
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com']);
});

test('Epic 4: overlap between alwaysOn and selectedDomains is deduped by apex', () => {
  // `a.com` is BOTH alwaysOn AND timer-selected. The dedupe must collapse
  // to a single entry (the spec's "the apex is written ONCE" acceptance
  // criterion). The always-on loop wins ordering (alwaysOn first, then
  // activeTimer), so `a.com` lands at index 0 and `b.com` at index 1.
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [
      { hostname: 'a.com', alwaysOn: true },
      { hostname: 'b.com', alwaysOn: false },
    ],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['a.com', 'b.com'],
    },
  };
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com', 'b.com']);
});

test('Epic 4: a corrupt (non-hostname) selectedDomain is skipped, not thrown', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['b.com', 'not a domain', 'c.com'],
    },
  };
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com', 'b.com', 'c.com']);
});

test('Epic 4: a www.-prefixed or upper-case selectedDomain is normalised to the apex', () => {
  // The union walks `normaliseDomain` defensively, so a hand-edited or
  // corrupt config holding `www.b.com` is normalised to `b.com` for the
  // hosts payload (mirrors the always-on loop).
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['WWW.b.com'],
    },
  };
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com', 'b.com']);
});

test('Epic 4: timer-only domain (no alwaysOn overlap) lands in the union', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['a.com', 'b.com'],
    },
  };
  expect(effectiveBlocklist(cfg)).toStrictEqual(['a.com', 'b.com']);
});

// ===========================================================================
// Story 5.3 — Epic 5 contribution: active-schedule domains, walked after the
// timer, gated by the pure window evaluator with an explicitly injected `now`.
// ===========================================================================

// 2026-08-05 is a Wednesday (jsDay 3 -> config weekday 2), 10:30 local —
// inside the 09:00-17:00 window the schedule fixtures use.
const NOW = new Date(2026, 7, 5, 10, 30, 0);
// The same Wednesday, 18:30 — after the window.
const AFTER = new Date(2026, 7, 5, 18, 30, 0);
// 2026-08-06 is a Thursday (jsDay 4 -> config weekday 3) — wrong weekday,
// same clock time.
const WRONG_DAY = new Date(2026, 7, 6, 10, 30, 0);

/** A well-formed in-window schedule for WEDNESDAY, 09:00-17:00. */
function scheduleWith(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'focus',
    name: 'Focus',
    weekdays: [2],
    startTime: '09:00',
    endTime: '17:00',
    enabled: true,
    domains: ['example.com'],
    ...overrides,
  };
}

test('Epic 5: an in-window schedule contributes its domains after the always-on walk', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    schedules: [scheduleWith({ domains: ['b.com'] })],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['a.com', 'b.com']);
});

test('Epic 5: a schedule-only blocklist (no alwaysOn, no timer) still blocks', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [],
    schedules: [scheduleWith({ domains: ['social.com', 'news.site'] })],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['social.com', 'news.site']);
});

test('Epic 5: an out-of-window schedule contributes nothing', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    schedules: [scheduleWith({ domains: ['b.com'] })],
  };
  expect(effectiveBlocklist(cfg, AFTER)).toStrictEqual(['a.com']);
});

test('Epic 5: the wrong weekday (same clock time) contributes nothing', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [scheduleWith({ domains: ['b.com'] })],
  };
  expect(effectiveBlocklist(cfg, WRONG_DAY)).toStrictEqual([]);
});

test('Epic 5: a disabled schedule contributes nothing even inside its window', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [scheduleWith({ enabled: false, domains: ['b.com'] })],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual([]);
});

test('Epic 5: an apex that is alwaysOn AND timer-selected AND scheduled writes ONCE', () => {
  // `a.com` is all three contributions. First-seen order wins (always-on
  // walk first), the dedupe collapses the later two, and `b.com` rides in
  // via the timer, `c.com` via the schedule.
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    schedules: [scheduleWith({ domains: ['a.com', 'c.com'] })],
    activeTimer: {
      endEpochMs: NOW.getTime() + 60_000,
      selectedDomains: ['a.com', 'b.com'],
    },
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['a.com', 'b.com', 'c.com']);
});

test('Epic 5: schedule contribution lands AFTER the timer walk (timer wins ordering ties)', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [],
    schedules: [scheduleWith({ domains: ['sched.com'] })],
    activeTimer: {
      endEpochMs: NOW.getTime() + 60_000,
      selectedDomains: ['timer.com'],
    },
  };
  // The timer walk runs before the schedule walk, so `timer.com` precedes
  // `sched.com` in the effective-blocklist order.
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['timer.com', 'sched.com']);
});

test('Epic 5: an out-of-window schedule does not disturb the always-on ∪ timer union', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    schedules: [scheduleWith({ domains: ['b.com'] })],
    activeTimer: {
      endEpochMs: AFTER.getTime() + 60_000,
      selectedDomains: ['c.com'],
    },
  };
  expect(effectiveBlocklist(cfg, AFTER)).toStrictEqual(['a.com', 'c.com']);
});

test('Epic 5: schedule domains are normalised and apex-deduped against the walk', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    schedules: [
      scheduleWith({
        domains: ['WWW.example.com', 'https://social.com/', 'EXAMPLE.COM'],
      }),
    ],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['example.com', 'social.com']);
});

test('Epic 5: a junk (non-hostname) domain in an active schedule is skipped, not thrown', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [
      scheduleWith({ domains: ['b.com', 'not a domain', 'c.com', 42] as unknown as string[] }),
    ],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['b.com', 'c.com']);
});

test('Epic 5: a schedule with missing/non-array domains contributes nothing but stays safe', () => {
  const missing = scheduleWith({});
  delete (missing as Partial<Schedule>).domains;
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [
      missing,
      scheduleWith({ id: 'junk-domains', domains: 'b.com' as unknown as string[] }),
    ],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual([]);
});

test('Epic 5: a malformed schedule element (null / junk fields) contributes nothing', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [
      null,
      scheduleWith({ id: 'degenerate', startTime: '17:00', endTime: '09:00', domains: ['b.com'] }),
      scheduleWith({ id: 'unparseable', startTime: '9' as string, domains: ['c.com'] }),
      scheduleWith({ id: 'good', domains: ['good.com'] }),
    ],
  } as unknown as Config;
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['good.com']);
});

test('Epic 5: multiple active schedules contribute in config order (deduped across schedules)', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [
      scheduleWith({ id: 'one', domains: ['b.com', 'c.com'] }),
      scheduleWith({ id: 'two', domains: ['c.com', 'd.com'] }),
    ],
  };
  expect(effectiveBlocklist(cfg, NOW)).toStrictEqual(['b.com', 'c.com', 'd.com']);
});

test('Epic 5: the default now (no injection) keeps the Epic 1/4 call shape working', () => {
  // A schedule whose window covers the entire day on ALL weekdays is active
  // at any wall-clock time, so the default `new Date()` path is exercised
  // without a fixed injection. Fake timers pin the system clock so the
  // function's internal `new Date()` is deterministic (no midnight race
  // between the test's and the function's own clock reads).
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    schedules: [
      scheduleWith({
        weekdays: [0, 1, 2, 3, 4, 5, 6] as Weekday[],
        startTime: '00:00',
        endTime: '23:59',
        domains: ['b.com'],
      }),
    ],
  };
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date(2026, 7, 5, 10, 0, 0));
    expect(effectiveBlocklist(cfg)).toStrictEqual(['b.com']);
  } finally {
    jest.useRealTimers();
  }
});

// Compile-time pin on the signature.
const _effectiveBlocklistAcceptsConfigReturnsStringArray: (
  config: Config,
) => string[] = effectiveBlocklist;
void _effectiveBlocklistAcceptsConfigReturnsStringArray;

// Pin the activeTimer shape the spec relies on (defensive).
const _activeTimerShape: ActiveTimer = {
  endEpochMs: 0,
  selectedDomains: [],
};
void _activeTimerShape;