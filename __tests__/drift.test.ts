/**
 * Story 1.7 — `computeDrift` comparator unit tests.
 *
 * Pure domain logic — no native modules, no mocks. The comparator takes the
 * committed `Config` and the opaque `ReadSectionResult` (from the
 * `readHostsSection` port) and returns a `DriftResult`. Covers the spec's I/O &
 * Edge-Case Matrix rows: in-sync, missing, corrupt, mismatch, empty-committed +
 * absent = in-sync, and order-sensitivity.
 *
 * The body lines are treated OPAQUELY (array equality) — `computeDrift` never
 * parses markers. The `ReadSectionResult` is constructed directly (no port
 * mock needed) since the comparator is a pure function of its two inputs.
 */

import { computeDrift } from '../src/domain/drift';
import type { DriftResult } from '../src/domain/drift';
import { toHostsLines } from '../src/domain/normalise';
import type { ReadSectionResult } from '../src/hosts/shellRunner';
import type { Config, Domain, Schedule } from '../src/config/types';
import { DEFAULT_CONFIG } from '../src/config/types';

const GOLDEN_LINES = [
  '0.0.0.0 example.com',
  ':: example.com',
  '0.0.0.0 www.example.com',
  ':: www.example.com',
];

function configWith(domains: Domain[]): Config {
  return { ...DEFAULT_CONFIG, domains };
}

/** A committed config with one alwaysOn domain -> expected = GOLDEN_LINES. */
const ONE_DOMAIN = configWith([{ hostname: 'example.com', alwaysOn: true }]);

// ---------------------------------------------------------------------------
// Happy in-sync: section body == effectiveHostsLines(committed)
// ---------------------------------------------------------------------------

test('in-sync: body == effectiveHostsLines(committed) -> { drift:false, reason:"in-sync" }', () => {
  const read: ReadSectionResult = { ok: true, section: GOLDEN_LINES };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

test('in-sync: empty committed + absent section (null) -> in-sync (nothing to enforce)', () => {
  // The spec's "Empty committed + absent = in-sync" row. A fresh install with
  // no domains and no managed section is NOT drift.
  const read: ReadSectionResult = { ok: true, section: null };
  expect(computeDrift(DEFAULT_CONFIG, read)).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

test('in-sync: empty committed + present-but-empty section (markers, no lines) -> in-sync', () => {
  // expected = [] and body = [] -> equal -> in-sync. An empty managed section
  // with empty intent is in-sync (not a mismatch).
  const read: ReadSectionResult = { ok: true, section: [] };
  expect(computeDrift(DEFAULT_CONFIG, read)).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

// ---------------------------------------------------------------------------
// Missing: absent section + committed has alwaysOn domains
// ---------------------------------------------------------------------------

test('missing: absent section (null) + committed has alwaysOn domains -> { drift:true, reason:"missing" }', () => {
  const read: ReadSectionResult = { ok: true, section: null };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'missing',
  });
});

// ---------------------------------------------------------------------------
// Corrupt: ok:false (hosts-unreadable / markers-mismatch)
// ---------------------------------------------------------------------------

test('corrupt: ok:false, error:"hosts-unreadable" -> { drift:true, reason:"corrupt" }', () => {
  const read: ReadSectionResult = { ok: false, error: 'hosts-unreadable' };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'corrupt',
  });
});

test('corrupt: ok:false, error:"markers-mismatch" -> { drift:true, reason:"corrupt" }', () => {
  const read: ReadSectionResult = { ok: false, error: 'markers-mismatch' };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'corrupt',
  });
});

test('corrupt takes precedence over missing: ok:false + null section -> corrupt, not missing', () => {
  // A corrupt read (ok:false) is never silently treated as an in-sync empty
  // body, even if `section` is absent. Corrupt is checked first.
  const read: ReadSectionResult = { ok: false, error: 'markers-mismatch', section: null };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'corrupt',
  });
});

// ---------------------------------------------------------------------------
// Mismatch: present (markers found) but body != expected
// ---------------------------------------------------------------------------

test('mismatch: someone deleted the www lines (fewer lines) -> { drift:true, reason:"mismatch" }', () => {
  // The spec's golden example: read returns only the apex lines (the www lines
  // were hand-deleted) -> mismatch, NOT in-sync.
  const read: ReadSectionResult = {
    ok: true,
    section: ['0.0.0.0 example.com', ':: example.com'],
  };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

test('mismatch: extra lines added -> { drift:true, reason:"mismatch" }', () => {
  const read: ReadSectionResult = {
    ok: true,
    section: [...GOLDEN_LINES, '0.0.0.0 extra.com'],
  };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

test('mismatch: a line was hand-edited (wrong host) -> { drift:true, reason:"mismatch" }', () => {
  const read: ReadSectionResult = {
    ok: true,
    section: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.other.com',
      ':: www.other.com',
    ],
  };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

test('mismatch: present non-empty body but empty committed -> { drift:true, reason:"mismatch" }', () => {
  // Committed has no domains (expected = []) but the section has stray lines ->
  // those lines should not be there -> mismatch (NOT in-sync).
  const read: ReadSectionResult = {
    ok: true,
    section: ['0.0.0.0 stray.com'],
  };
  expect(computeDrift(DEFAULT_CONFIG, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

test('mismatch: present-but-empty section (markers, no lines) with non-empty committed -> { drift:true, reason:"mismatch" }', () => {
  // All body lines hand-deleted but the markers remain: section is [] while
  // committed has an alwaysOn domain -> length 0 vs 4 -> mismatch (NOT missing:
  // the markers are present, so it is not "absent").
  const read: ReadSectionResult = { ok: true, section: [] };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

// ---------------------------------------------------------------------------
// Order-sensitivity: a reordering is a real drift
// ---------------------------------------------------------------------------

test('order-sensitive: the same lines in a different order -> mismatch', () => {
  // The managed section is written in effective-blocklist order (apex lines
  // before www lines). A reordering is a real drift, not in-sync.
  const reordered = [
    '0.0.0.0 www.example.com',
    ':: www.example.com',
    '0.0.0.0 example.com',
    ':: example.com',
  ];
  const read: ReadSectionResult = { ok: true, section: reordered };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

test('order-sensitive: lines swapped within the same set -> mismatch', () => {
  // Swap the IPv4/IPv6 pair for the apex only.
  const swapped = [
    ':: example.com',
    '0.0.0.0 example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ];
  const read: ReadSectionResult = { ok: true, section: swapped };
  expect(computeDrift(ONE_DOMAIN, read)).toStrictEqual({
    drift: true,
    reason: 'mismatch',
  });
});

// ---------------------------------------------------------------------------
// Multiple domains: effective-blocklist order is preserved
// ---------------------------------------------------------------------------

test('multiple alwaysOn domains: in-sync when body matches effective-blocklist order', () => {
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  const read: ReadSectionResult = {
    ok: true,
    section: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.example.com',
      ':: www.example.com',
      '0.0.0.0 social.com',
      ':: social.com',
      '0.0.0.0 www.social.com',
      ':: www.social.com',
    ],
  };
  expect(computeDrift(cfg, read)).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

test('multiple domains with one alwaysOn:false: only the alwaysOn domain contributes', () => {
  // news.site is alwaysOn:false -> not in the effective blocklist -> not
  // expected in the section. A section with only example.com lines is in-sync.
  const cfg = configWith([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'news.site', alwaysOn: false },
  ]);
  const read: ReadSectionResult = { ok: true, section: GOLDEN_LINES };
  expect(computeDrift(cfg, read)).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

// ===========================================================================
// Story 5.3 — active schedules are part of the recomputed expectation.
//
// `computeDrift` calls `effectiveHostsLines(committed)` with the DEFAULT
// `now` (call-time `new Date()`), so these tests pin the global Date
// constructor for the duration of the comparison (other arities delegate to
// the real one) and build the schedule fixtures against that same fixed
// instant — deterministic regardless of when the suite runs.
// ===========================================================================

/** 2026-08-05 is a Wednesday (jsDay 3 -> config weekday 2). */
const WEDNESDAY_IN_WINDOW = new Date(2026, 7, 5, 10, 30, 0);
// The same Wednesday, 18:30 — after the 09:00-17:00 window.
const WEDNESDAY_AFTER_WINDOW = new Date(2026, 7, 5, 18, 30, 0);

/**
 * Pin the global `Date` constructor so the no-arg `new Date()` inside
 * `effectiveHostsLines` (the default `now`) observes `fixed`. The spy is
 * restored in `finally`; `computeDrift` is synchronous, so the pinned
 * instant is exactly what it sees.
 *
 * Twin of `withFixedNow` in `__tests__/apply.test.ts` — kept per-file: the
 * react-native jest preset collects every file under `__tests__` as a suite,
 * so a shared helper file would need testMatch config changes.
 */
function withFixedNow<T>(fixed: Date, fn: () => T): T {
  const RealDate = globalThis.Date as unknown as new (...args: unknown[]) => Date;
  const spy = jest.spyOn(globalThis, 'Date') as unknown as jest.SpyInstance;
  spy.mockImplementation(((...args: unknown[]) =>
    args.length === 0
      ? fixed
      : new RealDate(...args)) as unknown as (...a: unknown[]) => Date);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/** A committed config with the always-on golden domain plus an in-window schedule. */
function configWithSchedule(overrides: Partial<Schedule> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    schedules: [
      {
        id: 'focus',
        name: 'Focus',
        weekdays: [2],
        startTime: '09:00',
        endTime: '17:00',
        enabled: true,
        domains: ['social.com'],
        ...overrides,
      },
    ],
  };
}

// The section body the payload SHOULD have while the schedule is in-window.
const IN_WINDOW_BODY = [...GOLDEN_LINES, ...linesFor('social.com')];

/**
 * The 4 managed hosts lines for one apex — delegates to `toHostsLines` so the
 * expected body can never silently drift from the real line producer.
 */
function linesFor(apex: string): string[] {
  return toHostsLines(apex);
}

test('Story 5.3: in-window schedule + section missing its lines -> mismatch (drift)', () => {
  const result = withFixedNow(WEDNESDAY_IN_WINDOW, () => {
    const read: ReadSectionResult = { ok: true, section: GOLDEN_LINES };
    return computeDrift(configWithSchedule(), read);
  });
  // The committed schedule is inside its window, so its social.com lines are
  // part of the expectation; a section without them is drift (mismatch).
  expect(result).toStrictEqual({ drift: true, reason: 'mismatch' });
});

test('Story 5.3: in-window schedule + section carrying the recomputed lines -> in-sync', () => {
  const result = withFixedNow(WEDNESDAY_IN_WINDOW, () => {
    const read: ReadSectionResult = { ok: true, section: IN_WINDOW_BODY };
    return computeDrift(configWithSchedule(), read);
  });
  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
});

test('Story 5.3: out-of-window schedule + section without its lines -> in-sync', () => {
  const result = withFixedNow(WEDNESDAY_AFTER_WINDOW, () => {
    const read: ReadSectionResult = { ok: true, section: GOLDEN_LINES };
    return computeDrift(configWithSchedule(), read);
  });
  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
});

test('Story 5.3: out-of-window schedule + section still carrying its lines -> mismatch', () => {
  const result = withFixedNow(WEDNESDAY_AFTER_WINDOW, () => {
    const read: ReadSectionResult = { ok: true, section: IN_WINDOW_BODY };
    return computeDrift(configWithSchedule(), read);
  });
  // The window has closed, so the schedule's lines are now EXTRA on disk —
  // an honest drift report (5.4's ticker closes the live gap).
  expect(result).toStrictEqual({ drift: true, reason: 'mismatch' });
});

test('Story 5.3: a disabled schedule is never part of the expectation', () => {
  const result = withFixedNow(WEDNESDAY_IN_WINDOW, () => {
    const read: ReadSectionResult = { ok: true, section: GOLDEN_LINES };
    return computeDrift(configWithSchedule({ enabled: false }), read);
  });
  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
});

// Compile-time pin on the signature.
const _computeDriftAcceptsConfigAndReadReturnsDriftResult: (
  committed: Config,
  read: ReadSectionResult,
) => DriftResult = computeDrift;
void _computeDriftAcceptsConfigAndReadReturnsDriftResult;