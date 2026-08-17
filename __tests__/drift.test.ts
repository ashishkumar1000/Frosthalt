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
import type { ReadSectionResult } from '../src/hosts/shellRunner';
import type { Config, Domain } from '../src/config/types';
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

// Compile-time pin on the signature.
const _computeDriftAcceptsConfigAndReadReturnsDriftResult: (
  committed: Config,
  read: ReadSectionResult,
) => DriftResult = computeDrift;
void _computeDriftAcceptsConfigAndReadReturnsDriftResult;