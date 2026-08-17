/**
 * Story 2.3 — pure unit tests for the staged-change-count helper.
 *
 * `stagedChangeCount` is a PURE per-hostname diff (added + removed + toggled),
 * a sibling to the module-private `draftEqualsCommitted` (`store.ts:282`). No
 * React, no store, no mocking — just call the function with `Domain[]` arrays.
 *
 * Covers every case the spec's Tasks & Acceptance require:
 *   - added-only → +1 per added hostname
 *   - toggled-only → +1 per toggled `alwaysOn` (length unchanged!)
 *   - removed-only → +1 per removed hostname (remove lands in 2-4 but the
 *     helper must already count it)
 *   - added + toggled
 *   - mixed (added + toggled + removed)
 *   - value-equal staged-vs-committed → 0 (the off-then-on clean-revert
 *     analogue: the helper receives the resulting array, not the history)
 *
 * The naive length-diff (`staged.length - committed.length`) is WRONG for
 * toggles (0 length-change, 1 change) and for the value-equal case — these
 * tests pin the per-hostname discipline.
 */

import { stagedChangeCount } from '../src/domain/stagedChangeCount';
import type { Domain } from '../src/config/types';

test('value-equal staged vs committed yields 0 (clean-revert analogue)', () => {
  const committed: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ];
  // A staged array value-equal to committed (e.g. the result of an off-then-on
  // clean-revert that did NOT clear `staged` — the helper must still report 0
  // for the value-equal pair, since there is no net change).
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ];
  expect(stagedChangeCount(staged, committed)).toBe(0);
});

test('value-equal in a DIFFERENT order still yields 0 (order-agnostic)', () => {
  // The diff is by hostname via a Map, so reordering alone is not a change.
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
  ];
  const staged: Domain[] = [
    { hostname: 'b.com', alwaysOn: false },
    { hostname: 'a.com', alwaysOn: true },
  ];
  expect(stagedChangeCount(staged, committed)).toBe(0);
});

test('empty staged vs empty committed yields 0', () => {
  expect(stagedChangeCount([], [])).toBe(0);
});

// ---------------------------------------------------------------------------
// added-only
// ---------------------------------------------------------------------------

test('a single added domain yields 1', () => {
  const committed: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true }, // added
  ];
  expect(stagedChangeCount(staged, committed)).toBe(1);
});

test('multiple added domains yield one per added hostname', () => {
  const committed: Domain[] = [{ hostname: 'a.com', alwaysOn: true }];
  const staged: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: true }, // added
    { hostname: 'c.com', alwaysOn: false }, // added
    { hostname: 'd.com', alwaysOn: true }, // added
  ];
  expect(stagedChangeCount(staged, committed)).toBe(3);
});

test('adding a domain to an empty committed yields 1', () => {
  expect(
    stagedChangeCount([{ hostname: 'new.com', alwaysOn: true }], []),
  ).toBe(1);
});

// ---------------------------------------------------------------------------
// toggled-only (length unchanged — the naive length-diff failure case)
// ---------------------------------------------------------------------------

test('a single toggled alwaysOn yields 1 (length unchanged)', () => {
  const committed: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: false }];
  // A toggle changes no length — a naive length-diff would report 0 (WRONG).
  expect(stagedChangeCount(staged, committed)).toBe(1);
});

test('multiple toggled alwaysOn yield one per toggled hostname', () => {
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
    { hostname: 'c.com', alwaysOn: true },
  ];
  const staged: Domain[] = [
    { hostname: 'a.com', alwaysOn: false }, // toggled
    { hostname: 'b.com', alwaysOn: true }, // toggled
    { hostname: 'c.com', alwaysOn: true }, // unchanged
  ];
  expect(stagedChangeCount(staged, committed)).toBe(2);
});

test('a true->false and false->true pair each count as 1 (two toggles)', () => {
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
  ];
  const staged: Domain[] = [
    { hostname: 'a.com', alwaysOn: false },
    { hostname: 'b.com', alwaysOn: true },
  ];
  expect(stagedChangeCount(staged, committed)).toBe(2);
});

// ---------------------------------------------------------------------------
// removed-only (remove lands in 2-4 but the helper must already count it)
// ---------------------------------------------------------------------------

test('a single removed domain yields 1', () => {
  const committed: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ];
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  expect(stagedChangeCount(staged, committed)).toBe(1);
});

test('multiple removed domains yield one per removed hostname', () => {
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
    { hostname: 'c.com', alwaysOn: true },
  ];
  const staged: Domain[] = [{ hostname: 'b.com', alwaysOn: false }];
  expect(stagedChangeCount(staged, committed)).toBe(2);
});

test('removing all domains (staged empty) yields the committed length', () => {
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: true },
  ];
  expect(stagedChangeCount([], committed)).toBe(2);
});

// ---------------------------------------------------------------------------
// added + toggled
// ---------------------------------------------------------------------------

test('one added + one toggled yields 2', () => {
  const committed: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: false }, // toggled
    { hostname: 'social.com', alwaysOn: true }, // added
  ];
  expect(stagedChangeCount(staged, committed)).toBe(2);
});

// ---------------------------------------------------------------------------
// mixed: added + toggled + removed
// ---------------------------------------------------------------------------

test('mixed (added + toggled + removed) yields the sum', () => {
  const committed: Domain[] = [
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
    { hostname: 'c.com', alwaysOn: true },
  ];
  const staged: Domain[] = [
    { hostname: 'a.com', alwaysOn: false }, // toggled (a.com)
    { hostname: 'b.com', alwaysOn: false }, // unchanged (b.com)
    // c.com removed
    { hostname: 'd.com', alwaysOn: true }, // added
  ];
  // 1 toggled + 1 removed + 1 added = 3
  expect(stagedChangeCount(staged, committed)).toBe(3);
});

test('the golden example: add social.com to [example.com] then toggle example.com off = 2 changes', () => {
  // From the spec's golden example: add social.com -> "1 change staged";
  // toggle example.com off -> "2 changes staged" (1 added + 1 toggled).
  const committed: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
  ];
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: false }, // toggled off
    { hostname: 'social.com', alwaysOn: true }, // added
  ];
  expect(stagedChangeCount(staged, committed)).toBe(2);
});

test('the golden example clean-revert: toggle example.com back on = 1 change (just the add)', () => {
  // From the spec: toggle example.com back on -> "1 change staged" (the add
  // of social.com remains). This is the helper's view of the draft; the store's
  // clean-revert only fires when the WHOLE draft nets to committed (here it
  // does not — social.com is still added).
  const committed: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
  ];
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: true }, // back to committed value
    { hostname: 'social.com', alwaysOn: true }, // still added
  ];
  expect(stagedChangeCount(staged, committed)).toBe(1);
});