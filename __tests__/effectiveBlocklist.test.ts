/**
 * Story 1.6 / Story 4.2 — `effectiveBlocklist` unit tests.
 *
 * Pure domain logic — no native modules, no mocks. Covers:
 *   - Epic 1 contribution: `domains.filter(alwaysOn)`, normalised + deduped.
 *   - Epic 4 (Story 4.2) contribution: `activeTimer?.selectedDomains` is
 *     walked AFTER the always-on loop with the same `normaliseDomain` +
 *     apex dedupe discipline so an apex that's both always-on AND timer-
 *     selected lands ONCE. When `activeTimer` is null (no session) the
 *     contribution is empty.
 *   - Defensive: a non-hostname in `activeTimer.selectedDomains` is skipped
 *     rather than crashing the pipeline (mirrors the always-on loop's
 *     posture).
 */

import { effectiveBlocklist } from '../src/domain/effectiveBlocklist';
import type { ActiveTimer, Config, Domain } from '../src/config/types';
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