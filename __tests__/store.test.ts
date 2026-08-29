/**
 * Story 1.6 — the domain store (Zustand) tests.
 *
 * Mocks both native specs (factory pattern from `shellRunner.test.ts:27-35` /
 * `configStore.test.ts:21-30`) so the store logic is proven in JS. Covers:
 *   - `stageDomainAdd` rejects invalid input (no staging) and stages valid apex.
 *   - `cancelStaged` discards staged back to last-committed.
 *   - `apply()` success: committed <- staged, staged cleared, { ok: true }.
 *   - `apply()` admin-denied: staged retained, committed unchanged, envelope.
 *   - `apply()` config-write failure: staged retained, writeHosts NOT called.
 *   - `apply()` with null staged: no-op, neither port called.
 *   - Serialization: two rapid `apply()` calls run strictly one-at-a-time,
 *     never in parallel — `writeHosts` called twice, the second only after the
 *     first settles.
 *
 * State is reset in `beforeEach` via `setState`. The module-private Apply queue
 * (`runChain`) is always settled between tests (every test awaits all applies
 * it starts), so it does not leak across tests.
 */

jest.mock('../src/native/specs/NativeConfigStoreSpec', () => ({
  __esModule: true,
  default: {
    readConfig: jest.fn(),
    writeConfig: jest.fn(),
  },
}));

jest.mock('../src/native/specs/NativeShellRunnerSpec', () => ({
  __esModule: true,
  default: {
    writeHosts: jest.fn(),
    readHostsSection: jest.fn(),
  },
}));

import { useDomainStore } from '../src/domain/store';
import { useTimerStore } from '../src/domain/timerStore';
import { useClockStore } from '../src/domain/clockStore';
import * as shellRunner from '../src/hosts/shellRunner';
import * as effectiveBlocklistModule from '../src/domain/effectiveBlocklist';
import { stagedChangeCount } from '../src/domain/stagedChangeCount';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Config, Schedule, Weekday } from '../src/config/types';
import {
  hashPassword,
  GATE_MAX_ATTEMPTS,
  GATE_THROTTLE_MS,
} from '../src/config/password';
import type { WriteResult } from '../src/hosts/shellRunner';

type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
type NativeShellMock = { writeHosts: jest.Mock; readHostsSection: jest.Mock };
const configNative = require('../src/native/specs/NativeConfigStoreSpec')
  .default as unknown as NativeConfigMock;
const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as NativeShellMock;

/** Flush a few microtasks so an enqueued Apply run has a chance to start. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  configNative.readConfig.mockReset();
  configNative.writeConfig.mockReset();
  shellNative.writeHosts.mockReset();
  shellNative.readHostsSection.mockReset();
  // Sensible defaults: a successful config write + hosts write. NOTE: the
  // store calls `readConfig()` exactly once, at module-eval time (before any
  // `beforeEach` runs), so it already saw the native mock's default `undefined`
  // return and fell back to DEFAULT_CONFIG — there is no per-test `readConfig`
  // mockReturnValue here, because none would ever be consumed (setting one
  // would be false confidence). Store STATE is reset via `setState` below.
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });

  // Reset store state to a clean baseline. The module-private `runChain` is
  // always settled between tests (each test awaits its applies), so only the
  // store STATE needs resetting. `drift` is reset to null (unchecked);
  // `lastReadSection` is reset to null (Story 2.6 — the viewer's verbatim body
  // source). Story 3.2 — the gate runtime state (`gateOpen`/`gateAction`/
  // `gateAttempts`/`gateThrottleUntil`) is reset too so a prior test's wrong
  // attempts or an open gate can't leak into the next test.
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    // Story 5.1 — the staged schedule draft resets alongside the domain
    // buffer so a prior test's schedule toggles can't leak into the next.
    stagedSchedules: null,
    applyStatus: 'idle',
    lastResult: null,
    drift: null,
    lastReadSection: null,
    gateOpen: false,
    gateAction: null,
    gateAttempts: 0,
    gateThrottleUntil: null,
    // Story 4.5 — the Shell-level toast is runtime-only; reset it so a prior
    // test's toast can't leak into the next.
    toast: null,
  });
});

// ---------------------------------------------------------------------------
// stageDomainAdd
// ---------------------------------------------------------------------------

test('stageDomainAdd rejects non-hostname input without staging and reports invalid-domain', () => {
  const before = useDomainStore.getState().staged;
  const result = useDomainStore.getState().stageDomainAdd('not a domain');

  expect(result).toStrictEqual({ ok: false, error: 'invalid-domain' });
  expect(useDomainStore.getState().staged).toBe(before);
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageDomainAdd rejects the injection example without staging', () => {
  const result = useDomainStore.getState().stageDomainAdd('0.0.0.0; rm -rf /');
  expect(result).toStrictEqual({ ok: false, error: 'invalid-domain' });
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageDomainAdd normalises and stages a valid domain as alwaysOn:true', () => {
  const result = useDomainStore.getState().stageDomainAdd('https://www.Example.COM/path');

  expect(result).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
});

test('stageDomainAdd is idempotent: staging an already-staged apex is a no-op', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.getState().stageDomainAdd('example.com');

  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
});

test('stageDomainAdd on an already-committed domain (clean) is a true no-op: staged stays null', () => {
  // Seed committed so example.com is already present, with no staged draft.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  const result = useDomainStore.getState().stageDomainAdd('example.com');

  expect(result).toStrictEqual({ ok: true });
  // Staged stays null — no dirty draft that would force a redundant admin
  // prompt on the next Apply for an identical config.
  expect(useDomainStore.getState().staged).toBeNull();
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
});

test('stageDomainAdd stacks additional domains on top of the current draft', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.getState().stageDomainAdd('social.com');

  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
});

// Story 2.2 — pins the mid-run-edit invariant for `stageDomainAdd`. The
// apply-queue's retain-newer-draft detection (`s.staged === stagedSnapshot` at
// store.ts:182) relies on a newer draft being a DIFFERENT array reference from
// the snapshot a running Apply captured. `stageDomainAdd` spreads `base`
// (`store.ts:119`), so each add produces a NEW ref — but this was only
// asserted for the toggle today, not for add. Two successive adds must yield
// two distinct `staged` references (not in-place mutation), otherwise a second
// add staged during an in-flight Apply would be silently clobbered on success.
test('stageDomainAdd produces a NEW staged array reference on each add (preserves mid-run-edit detection)', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  const ref1 = useDomainStore.getState().staged;
  expect(ref1).not.toBeNull();

  useDomainStore.getState().stageDomainAdd('social.com');
  const ref2 = useDomainStore.getState().staged;
  // NEW array reference, not in-place mutation — a newer draft is always a
  // different reference from the snapshot a running Apply captured.
  expect(ref2).not.toBe(ref1);
  expect(ref2).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
});

// ---------------------------------------------------------------------------
// stageAlwaysOnToggle (Story 2.1)
// ---------------------------------------------------------------------------

test('stageAlwaysOnToggle flips alwaysOn false->true on a committed domain and stages a new draft', () => {
  // Seed committed with one alwaysOn:false domain so toggling is a real change.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: false }],
    },
    staged: null,
  });

  const result = useDomainStore.getState().stageAlwaysOnToggle('example.com');

  expect(result).toStrictEqual({ ok: true });
  // The staged draft carries the flipped alwaysOn value.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  // Committed is untouched — toggle is a STAGED edit, Apply commits.
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
  ]);
});

test('stageAlwaysOnToggle flips alwaysOn true->false on a committed domain', () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  const result = useDomainStore.getState().stageAlwaysOnToggle('example.com');

  expect(result).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
  ]);
});

test('stageAlwaysOnToggle builds on the staged draft when one exists', () => {
  // committed has two domains; a staged draft already flips the first. Toggling
  // the second must build on the draft, not on committed.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: true },
        { hostname: 'social.com', alwaysOn: false },
      ],
    },
    staged: [
      { hostname: 'example.com', alwaysOn: false }, // already toggled
      { hostname: 'social.com', alwaysOn: false },
    ],
  });

  const result = useDomainStore.getState().stageAlwaysOnToggle('social.com');

  expect(result).toStrictEqual({ ok: true });
  // The draft now reflects BOTH toggles; committed is still the original.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ]);
});

test('stageAlwaysOnToggle produces a NEW staged array reference (preserves mid-run-edit detection)', () => {
  // The apply-queue's retain-newer-draft invariant relies on a newer draft
  // being a DIFFERENT array reference from the snapshot a running Apply
  // captured. Toggling must spread, not mutate in place.
  // Seed committed with two domains. Toggling the first then the second
  // produces two successive staged drafts; the second must be a DIFFERENT
  // array reference from the first (spread, not in-place mutation) — this is
  // what the apply-queue's retain-newer-draft invariant relies on. Toggling
  // the same domain twice would clean-revert to null, so two domains are
  // needed to keep the draft non-null across both toggles.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: false },
        { hostname: 'social.com', alwaysOn: false },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageAlwaysOnToggle('example.com');
  const ref1 = useDomainStore.getState().staged;
  expect(ref1).not.toBeNull();

  useDomainStore.getState().stageAlwaysOnToggle('social.com');
  const ref2 = useDomainStore.getState().staged;
  expect(ref2).not.toBe(ref1); // NEW array reference, not in-place mutation
  expect(ref2).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
});

test('stageAlwaysOnToggle clean-revert: toggling a domain off then on reverts staged to null (no redundant Apply)', () => {
  // committed has example.com alwaysOn:true. Toggle off -> staged draft with
  // false. Toggle on -> draft equals committed -> staged reverts to null.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  const r1 = useDomainStore.getState().stageAlwaysOnToggle('example.com');
  expect(r1).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
  ]);

  const r2 = useDomainStore.getState().stageAlwaysOnToggle('example.com');
  expect(r2).toStrictEqual({ ok: true });
  // Net = committed -> staged reverts to null. No redundant admin prompt on
  // the next Apply.
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageAlwaysOnToggle clean-revert: toggling back to committed among multiple edits reverts the WHOLE draft to null', () => {
  // committed has two alwaysOn:true domains. Toggle BOTH off then BOTH on —
  // after the fourth toggle the draft equals committed and staged reverts to
  // null, even though the draft touched more than one domain.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: true },
        { hostname: 'social.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageAlwaysOnToggle('example.com'); // off
  useDomainStore.getState().stageAlwaysOnToggle('social.com'); // off
  expect(useDomainStore.getState().staged).not.toBeNull();

  useDomainStore.getState().stageAlwaysOnToggle('example.com'); // back on
  useDomainStore.getState().stageAlwaysOnToggle('social.com'); // back on

  // The whole draft nets to committed -> staged reverts to null.
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageAlwaysOnToggle does NOT clean-revert when other edits keep the draft dirty', () => {
  // committed has two alwaysOn:true domains. Toggle example.com off, then
  // back on — social.com is untouched, but example.com's net is no-op, so
  // the draft still equals committed here... actually it equals committed
  // (both true). To exercise the "still dirty" branch, toggle example.com
  // off, social.com off, then example.com back on: the draft is now
  // [example:true, social:false] which differs from committed -> stays.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: true },
        { hostname: 'social.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageAlwaysOnToggle('example.com'); // off
  useDomainStore.getState().stageAlwaysOnToggle('social.com'); // off
  useDomainStore.getState().stageAlwaysOnToggle('example.com'); // back on

  // social.com is still off -> draft differs from committed -> stays staged.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ]);
});

test('stageAlwaysOnToggle on an unknown hostname returns not-found and leaves staged unchanged', () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  const before = useDomainStore.getState().staged;
  const result = useDomainStore.getState().stageAlwaysOnToggle('ghost.com');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  expect(useDomainStore.getState().staged).toBe(before);
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageAlwaysOnToggle on an unknown hostname with a staged draft leaves the draft unchanged', () => {
  const draft = [
    { hostname: 'example.com', alwaysOn: false },
  ];
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: draft,
  });

  const result = useDomainStore.getState().stageAlwaysOnToggle('ghost.com');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  // The staged draft reference is unchanged (no new array, no mutation).
  expect(useDomainStore.getState().staged).toBe(draft);
});

test('stageAlwaysOnToggle on an already-committed clean state: toggling is a real change (staged becomes non-null)', () => {
  // Edge: when staged is null and the user toggles, the result is a dirty
  // draft (the toggle always flips). This confirms clean-revert does NOT fire
  // on the FIRST toggle — only when the draft NETS back to committed.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  useDomainStore.getState().stageAlwaysOnToggle('example.com');

  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
  ]);
});

// ===========================================================================
// Story 2.4 — stageDomainRemove (staged removal + clean-revert) and the
// deferred-equality fix (order-agnostic draftEqualsCommitted + stageDomainAdd
// clean-revert). Mirrors the stageAlwaysOnToggle tests above.
// ===========================================================================

test('stageDomainRemove removes a committed domain and stages a new draft (count 1 via stagedChangeCount)', () => {
  // committed has two domains; removing one stages a draft missing it.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: true },
        { hostname: 'social.com', alwaysOn: false },
      ],
    },
    staged: null,
  });

  const result = useDomainStore.getState().stageDomainRemove('example.com');

  expect(result).toStrictEqual({ ok: true });
  // The staged draft no longer contains example.com; committed is untouched.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'social.com', alwaysOn: false },
  ]);
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: false },
  ]);
  // The story's central invariant — `staged != null ⟹ stagedChangeCount >= 1`
  // — directly verified (the spec's Code Map requires "count 1 via
  // stagedChangeCount"). One removed domain -> 1 change.
  expect(
    stagedChangeCount(
      useDomainStore.getState().staged!,
      useDomainStore.getState().committed.domains,
    ),
  ).toBe(1);
});

test('stageDomainRemove removes from a multi-edit staged draft', () => {
  // committed has one domain; a staged draft adds a second + toggles the first.
  // Removing the staged addition must build on the draft, not committed.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: [
      { hostname: 'example.com', alwaysOn: false }, // toggled
      { hostname: 'social.com', alwaysOn: true }, // added
    ],
  });

  const result = useDomainStore.getState().stageDomainRemove('social.com');

  expect(result).toStrictEqual({ ok: true });
  // The draft now reflects the toggle only; the added row is gone.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
  ]);
  // The count reflects the remaining change (the toggle): committed=
  // [example:true], staged=[example:false] -> 1 toggled. Pinned via
  // stagedChangeCount per the spec's Code Map (not just inferred from staged).
  expect(
    stagedChangeCount(
      useDomainStore.getState().staged!,
      useDomainStore.getState().committed.domains,
    ),
  ).toBe(1);
});

test('stageDomainRemove clean-revert: removing the only staged addition reverts staged to null', () => {
  // committed is empty; staged adds one domain. Removing that added domain
  // nets back to committed -> staged clean-reverts to null (no redundant Apply).
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, domains: [] },
    staged: [{ hostname: 'newsite.com', alwaysOn: true }],
  });

  const result = useDomainStore.getState().stageDomainRemove('newsite.com');

  expect(result).toStrictEqual({ ok: true });
  // Net = committed (empty) -> staged reverts to null.
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageDomainRemove produces a NEW staged array reference on each remove', () => {
  // The apply-queue's retain-newer-draft invariant relies on a newer draft
  // being a DIFFERENT array reference from the snapshot a running Apply
  // captured. Removing must filter (new ref), not mutate in place. committed
  // has three domains so successive removes keep the draft non-null (no
  // clean-revert) and we can compare two distinct staged references.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: true },
        { hostname: 'c.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageDomainRemove('a.com');
  const ref1 = useDomainStore.getState().staged;
  expect(ref1).not.toBeNull();

  useDomainStore.getState().stageDomainRemove('b.com');
  const ref2 = useDomainStore.getState().staged;
  // NEW array reference, not in-place mutation.
  expect(ref2).not.toBe(ref1);
  expect(ref2).toStrictEqual([{ hostname: 'c.com', alwaysOn: true }]);
});

test('stageDomainRemove on an unknown hostname returns not-found and leaves staged unchanged', () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: null,
  });

  const before = useDomainStore.getState().staged;
  const result = useDomainStore.getState().stageDomainRemove('ghost.com');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  expect(useDomainStore.getState().staged).toBe(before);
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageDomainRemove on an unknown hostname with a staged draft leaves the draft unchanged', () => {
  const draft = [{ hostname: 'example.com', alwaysOn: false }];
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    staged: draft,
  });

  const result = useDomainStore.getState().stageDomainRemove('ghost.com');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  // The staged draft reference is unchanged (no new array, no mutation).
  expect(useDomainStore.getState().staged).toBe(draft);
});

// ---------------------------------------------------------------------------
// The deferred-equality fix (Story 2.4): stageDomainAdd clean-revert +
// order-agnostic draftEqualsCommitted. Remove makes remove+re-add reachable,
// producing a reordered value-equal draft. Without the fix, stageDomainAdd
// retains it while stagedChangeCount reports 0 -> "0 changes staged" + a
// pulsing Apply on a net-zero draft. The shared order-agnostic
// draftEqualsCommitted clears staged to null.
// ---------------------------------------------------------------------------

test('stageDomainAdd clean-revert: remove + re-add (reorder net-zero) reverts staged to null', () => {
  // committed [a,b,c]; remove b -> staged [a,c] (1 change); re-add b ->
  // stageDomainAdd appends b -> [a,c,b], which value-equals committed as a SET
  // -> order-agnostic draftEqualsCommitted -> staged clean-reverts to null.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: true },
        { hostname: 'c.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  const r1 = useDomainStore.getState().stageDomainRemove('b.com');
  expect(r1).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'c.com', alwaysOn: true },
  ]);

  // Re-add b. The append produces [a,c,b] — a reordered value-equal draft.
  // The order-agnostic clean-revert must clear staged to null.
  const r2 = useDomainStore.getState().stageDomainAdd('b.com');
  expect(r2).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().staged).toBeNull();
});

test('stageDomainAdd clean-revert does NOT fire when the re-add leaves a real change', () => {
  // committed [a,b]; remove a -> staged [b] (1 change); re-add c (a NEW domain)
  // -> [b,c], which does NOT equal committed [a,b] as a set -> stays staged.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageDomainRemove('a.com');
  useDomainStore.getState().stageDomainAdd('c.com');

  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'b.com', alwaysOn: true },
    { hostname: 'c.com', alwaysOn: true },
  ]);
});

test('order-agnostic reorder clean-revert via stageAlwaysOnToggle (committed [a,b,c], toggle a off, remove b, re-add b, toggle a on -> null)', () => {
  // A multi-action net-zero that reorders the draft: confirms the
  // order-agnostic draftEqualsCommitted clears staged across mixed actions.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: true },
        { hostname: 'c.com', alwaysOn: true },
      ],
    },
    staged: null,
  });

  useDomainStore.getState().stageAlwaysOnToggle('a.com'); // off -> [a:false,b,c]
  useDomainStore.getState().stageDomainRemove('b.com'); // -> [a:false,c]
  useDomainStore.getState().stageDomainAdd('b.com'); // -> [a:false,c,b] (reordered)
  // Toggle a back on -> [a:true,c,b] value-equals committed [a,b,c] as a set ->
  // order-agnostic draftEqualsCommitted -> staged reverts to null.
  useDomainStore.getState().stageAlwaysOnToggle('a.com');

  expect(useDomainStore.getState().staged).toBeNull();
});

// ---------------------------------------------------------------------------
// cancelStaged
// ---------------------------------------------------------------------------

test('cancelStaged discards the staged draft back to null', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  expect(useDomainStore.getState().staged).not.toBeNull();

  useDomainStore.getState().cancelStaged();

  expect(useDomainStore.getState().staged).toBeNull();
  // committed is untouched.
  expect(useDomainStore.getState().committed).toStrictEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// apply() — happy path
// ---------------------------------------------------------------------------

test('apply() success commits staged to committed, clears staged, and returns { ok: true }', async () => {
  useDomainStore.getState().stageDomainAdd('example.com');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  // committed now carries the staged domain; staged is cleared.
  const state = useDomainStore.getState();
  expect(state.staged).toBeNull();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.applyStatus).toBe('idle');
  expect(state.lastResult).toStrictEqual({ ok: true });
});

test('apply() success writes config then hosts in strict order with the golden payload', async () => {
  const calls: string[] = [];
  configNative.writeConfig.mockImplementation(() => {
    calls.push('writeConfig');
    return { ok: true };
  });
  shellNative.writeHosts.mockImplementation(() => {
    calls.push('writeHosts');
    return Promise.resolve({ ok: true } as WriteResult);
  });

  useDomainStore.getState().stageDomainAdd('example.com');
  await useDomainStore.getState().apply();

  expect(calls).toStrictEqual(['writeConfig', 'writeHosts']);
  expect(shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
});

// ---------------------------------------------------------------------------
// apply() — admin denied: staged retained, committed unchanged
// ---------------------------------------------------------------------------

test('apply() admin-denied retains staged, leaves committed unchanged, and forwards the envelope', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });
  useDomainStore.getState().stageDomainAdd('example.com');
  const committedBefore = useDomainStore.getState().committed;

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // Staged is retained for retry; committed is unchanged (config.json was
  // written per strict order, but the in-memory committed is only updated on
  // success — so a denied Apply does not advance committed).
  const state = useDomainStore.getState();
  expect(state.staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.committed).toStrictEqual(committedBefore);
  expect(state.applyStatus).toBe('idle');
  expect(state.lastResult).toStrictEqual({ ok: false, error: 'admin-denied' });
});

test('a denied apply can be retried: the second apply re-attempts writeHosts idempotently', async () => {
  shellNative.writeHosts
    .mockResolvedValueOnce({ ok: false, error: 'admin-denied' })
    .mockResolvedValueOnce({ ok: true });

  useDomainStore.getState().stageDomainAdd('example.com');

  const r1 = await useDomainStore.getState().apply();
  expect(r1).toStrictEqual({ ok: false, error: 'admin-denied' });
  expect(useDomainStore.getState().staged).not.toBeNull();

  const r2 = await useDomainStore.getState().apply();
  expect(r2).toStrictEqual({ ok: true });
  // After a successful retry, staged is cleared and committed updated.
  expect(useDomainStore.getState().staged).toBeNull();
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(2);
});

// ---------------------------------------------------------------------------
// apply() — config-write failure: staged retained, writeHosts NOT called
// ---------------------------------------------------------------------------

test('apply() config-write failure retains staged, skips writeHosts, and reports config-write:<detail>', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  useDomainStore.getState().stageDomainAdd('example.com');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(useDomainStore.getState().committed).toStrictEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// apply() — null staged: no-op
// ---------------------------------------------------------------------------

test('apply() with nothing staged is a no-op: { ok: true } and neither port is called', async () => {
  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().staged).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// ---------------------------------------------------------------------------
// apply() — serialization: two rapid calls run strictly one-at-a-time
// ---------------------------------------------------------------------------

test('two rapid apply() calls run writeHosts strictly one-at-a-time, never in parallel', async () => {
  useDomainStore.getState().stageDomainAdd('example.com');

  let writeHostsCalls = 0;
  let resolveFirst: ((v: WriteResult) => void) | null = null;
  const inflight = { current: false };
  let overlapDetected = false;

  shellNative.writeHosts.mockImplementation(() => {
    writeHostsCalls += 1;
    if (writeHostsCalls === 1) {
      inflight.current = true;
      // First call: never resolves until the test resolves it, so the second
      // run cannot start until the first settles (serialization).
      return new Promise<WriteResult>((res) => {
        resolveFirst = res;
      }).then((v) => {
        inflight.current = false;
        return v;
      });
    }
    // Second call: the first MUST already have settled (inflight false). If it
    // has not, the runs overlapped — record it and assert outside the mock so
    // a failure surfaces clearly rather than being swallowed by the port's
    // try/catch.
    if (inflight.current) {
      overlapDetected = true;
    }
    return Promise.resolve({ ok: true } as WriteResult);
  });

  // Two rapid Apply clicks, neither awaited yet.
  const p1 = useDomainStore.getState().apply();
  const p2 = useDomainStore.getState().apply();

  // Let the first run start (microtask): it reaches `await writeHosts` and
  // suspends on the unresolvable first promise. The second run is queued
  // behind it and must NOT have started.
  await flushMicrotasks();
  expect(writeHostsCalls).toBe(1);
  expect(inflight.current).toBe(true);

  // Resolve the first run; the second run starts only AFTER it settles.
  resolveFirst!({ ok: true });

  const [r1, r2] = await Promise.all([p1, p2]);

  expect(writeHostsCalls).toBe(2);
  expect(overlapDetected).toBe(false);
  expect(r1).toStrictEqual({ ok: true });
  expect(r2).toStrictEqual({ ok: true });
});

// ---------------------------------------------------------------------------
// Retain-newer-draft invariant: a draft staged DURING an in-flight Apply is
// not clobbered when that Apply succeeds. This pins the
// `s.staged === stagedSnapshot ? null : s.staged` branch — replacing it with
// `null` keeps every other test green but breaks this behaviour.
// ---------------------------------------------------------------------------

test('a newer draft staged during an in-flight Apply is retained, not clobbered', async () => {
  // Stage A and start an Apply whose writeHosts does not resolve until we
  // release it, so the run stays in flight while we stage a second domain.
  useDomainStore.getState().stageDomainAdd('example.com');
  let resolveFirst: ((v: WriteResult) => void) | null = null;
  shellNative.writeHosts.mockImplementation(
    () => new Promise<WriteResult>((res) => {
      resolveFirst = res;
    }),
  );

  const p = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(useDomainStore.getState().applyStatus).toBe('running');

  // While the first Apply is in flight, stage a SECOND domain. This produces a
  // NEW staged array reference, distinct from the snapshot the running Apply
  // captured — so the success handler must retain it, not clear it.
  useDomainStore.getState().stageDomainAdd('social.com');
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);

  // Release the first Apply. It commits A (the snapshot's intent) and must
  // leave the newer [A, B] draft intact.
  resolveFirst!({ ok: true });
  await p;

  const state = useDomainStore.getState();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(state.applyStatus).toBe('idle');
});

// ---------------------------------------------------------------------------
// Port-contract breach: a rejected writeHosts does not reject apply(), retains
// staged, leaves committed unchanged, and still resets applyStatus (the
// try/finally in apply()).
// ---------------------------------------------------------------------------

test('a rejected writeHosts does not reject apply(), retains staged, and resets applyStatus', async () => {
  // The native rejects, but the shellRunner port catches it and returns
  // { ok:false, error:'port died' } — so runApply resolves (never rejects), the
  // store treats it as a normal failure, and apply() resolves to the envelope.
  shellNative.writeHosts.mockRejectedValue(new Error('port died'));
  useDomainStore.getState().stageDomainAdd('example.com');
  const committedBefore = useDomainStore.getState().committed;

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: false, error: 'port died' });
  // config.json was written (strict order) but the in-memory committed is only
  // advanced on success; staged is retained for retry.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().committed).toStrictEqual(committedBefore);
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  // The failure branch reset applyStatus.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// Compile-time pin: apply() returns Promise<WriteResult>.
const _applyReturnsWriteResult = (
  r: Promise<WriteResult>,
): WriteResult | Promise<WriteResult> => r;
void _applyReturnsWriteResult;

// ===========================================================================
// Story 1.7 — checkDrift + restoreSection
// ===========================================================================

// ---------------------------------------------------------------------------
// checkDrift (sync): readHostsSection -> computeDrift -> set drift -> return
// ---------------------------------------------------------------------------

test('checkDrift reads the section, computes drift, sets state, and returns the result', () => {
  // Seed committed with one alwaysOn domain so the expected lines are GOLDEN.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
  });
  shellNative.readHostsSection.mockReturnValue({
    ok: true,
    section: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.example.com',
      ':: www.example.com',
    ],
  });

  const result = useDomainStore.getState().checkDrift();

  expect(shellNative.readHostsSection).toHaveBeenCalledTimes(1);
  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
  // Story 2.6 — the verbatim on-disk body lines are preserved into
  // `lastReadSection` so the read-only viewer renders the actual section, not
  // the expected/computed set.
  expect(useDomainStore.getState().lastReadSection).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
});

test('checkDrift reports missing when the section is absent but committed has alwaysOn domains', () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
  });
  shellNative.readHostsSection.mockReturnValue({ ok: true, section: null });

  const result = useDomainStore.getState().checkDrift();

  expect(result).toStrictEqual({ drift: true, reason: 'missing' });
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: true,
    reason: 'missing',
  });
  // Story 2.6 — absent section -> lastReadSection null (the viewer's
  // empty-state).
  expect(useDomainStore.getState().lastReadSection).toBeNull();
});

test('checkDrift reports corrupt when readHostsSection returns ok:false', () => {
  shellNative.readHostsSection.mockReturnValue({
    ok: false,
    error: 'markers-mismatch',
  });

  const result = useDomainStore.getState().checkDrift();

  expect(result).toStrictEqual({ drift: true, reason: 'corrupt' });
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: true,
    reason: 'corrupt',
  });
  // Story 2.6 — corrupt read (ok:false) -> lastReadSection null (the section
  // body is unparseable; the viewer shows the corrupt banner + empty body).
  expect(useDomainStore.getState().lastReadSection).toBeNull();
});

test('checkDrift reports in-sync for empty committed + absent section', () => {
  shellNative.readHostsSection.mockReturnValue({ ok: true, section: null });

  const result = useDomainStore.getState().checkDrift();

  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
  // Story 2.6 — absent section -> lastReadSection null.
  expect(useDomainStore.getState().lastReadSection).toBeNull();
});

// ---------------------------------------------------------------------------
// restoreSection (async): enqueue writeHosts(effectiveHostsLines(committed))
// via the shared serialized queue; one admin prompt; on success re-check
// drift -> in-sync; on denied drift remains.
// ---------------------------------------------------------------------------

test('restoreSection enqueues writeHosts with effectiveHostsLines(committed) and returns the envelope', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    drift: { drift: true, reason: 'missing' },
  });
  // The Restore write succeeds; the post-write re-check reads the now-correct
  // section -> in-sync.
  shellNative.writeHosts.mockResolvedValue({ ok: true });
  shellNative.readHostsSection.mockReturnValue({
    ok: true,
    section: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.example.com',
      ':: www.example.com',
    ],
  });

  const result = await useDomainStore.getState().restoreSection();

  expect(result).toStrictEqual({ ok: true });
  // writeHosts received the golden 4-line payload derived from committed.
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
  // No config write — Restore writes HOSTS only (config.json is canonical).
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  // Drift is re-checked after the successful write -> in-sync.
  expect(shellNative.readHostsSection).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
  // Story 2.6 — the post-write re-check preserves the freshly-written on-disk
  // body into `lastReadSection` so the viewer re-renders with the restored
  // lines (and the banner clears).
  expect(useDomainStore.getState().lastReadSection).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toStrictEqual({ ok: true });
});

test('restoreSection does NOT write config (Restore writes HOSTS only)', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
  });
  shellNative.writeHosts.mockResolvedValue({ ok: true });
  shellNative.readHostsSection.mockReturnValue({ ok: true, section: null });

  await useDomainStore.getState().restoreSection();

  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
});

test('restoreSection admin-denied: { ok:false, error:"admin-denied" }, drift remains, /etc/hosts unchanged', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
    drift: { drift: true, reason: 'missing' },
  });
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });

  const result = await useDomainStore.getState().restoreSection();

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // Drift is NOT re-checked on denial (no second readHostsSection call); the
  // drift state remains as it was. The warning stays (no auto-re-add).
  expect(shellNative.readHostsSection).not.toHaveBeenCalled();
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: true,
    reason: 'missing',
  });
  // Story 2.6 — on denial `lastReadSection` is NOT updated (the success branch
  // is the only place Restore sets it). It stays at its pre-call value (null
  // here, the clean baseline). The viewer keeps showing whatever it had.
  expect(useDomainStore.getState().lastReadSection).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toStrictEqual({
    ok: false,
    error: 'admin-denied',
  });
});

test('restoreSection with empty committed writes the markers-only section (effectiveHostsLines([]) === [])', async () => {
  // Empty committed -> effectiveHostsLines = [] -> writeHosts([]) writes the
  // markers with no domain lines (unblocks all). A legitimate "Restore" when
  // there is nothing to enforce clears a stray managed section.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  shellNative.writeHosts.mockResolvedValue({ ok: true });
  shellNative.readHostsSection.mockReturnValue({ ok: true, section: [] });

  const result = await useDomainStore.getState().restoreSection();

  expect(result).toStrictEqual({ ok: true });
  expect(shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([]);
  // Empty committed + empty section -> in-sync.
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

// ---------------------------------------------------------------------------
// Serialization: Restore queues behind an in-flight Apply (shared queue), one
// prompt at a time — never two writeHosts calls concurrent.
// ---------------------------------------------------------------------------

test('restoreSection queues behind an in-flight Apply via the shared serialized queue', async () => {
  // NOTE: do NOT pre-seed committed with `example.com` — if committed already
  // holds the domain, `stageDomainAdd('example.com')` is a no-op (staged stays
  // null) and `apply()` short-circuits to `{ ok: true }` without enqueuing, so
  // the Apply never hits the shared queue and the test would only exercise the
  // Restore. Leaving committed at DEFAULT_CONFIG (empty) makes staging a real
  // draft, so apply() enqueues a genuine run that the Restore must queue behind.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  let writeHostsCalls = 0;
  let resolveFirst: ((v: WriteResult) => void) | null = null;
  const inflight = { current: false };
  let overlapDetected = false;

  shellNative.writeHosts.mockImplementation(() => {
    writeHostsCalls += 1;
    if (writeHostsCalls === 1) {
      // The Apply run: never resolves until the test releases it, so the
      // queued Restore cannot start until the Apply settles.
      inflight.current = true;
      return new Promise<WriteResult>((res) => {
        resolveFirst = res;
      }).then((v) => {
        inflight.current = false;
        return v;
      });
    }
    // The Restore run: the Apply MUST already have settled (inflight false). If
    // it has not, the runs overlapped.
    if (inflight.current) {
      overlapDetected = true;
    }
    return Promise.resolve({ ok: true } as WriteResult);
  });

  // Start an Apply (staged so it is a real run), then immediately call Restore.
  // Both hit the shared queue; Restore must wait for Apply to settle.
  useDomainStore.getState().stageDomainAdd('example.com');
  const applyP = useDomainStore.getState().apply();
  const restoreP = useDomainStore.getState().restoreSection();

  // Let the Apply run start (microtask): it reaches `await writeHosts` and
  // suspends. The Restore is queued behind it and must NOT have started.
  await flushMicrotasks();
  expect(writeHostsCalls).toBe(1);
  expect(inflight.current).toBe(true);

  // Release the Apply; the Restore starts only AFTER it settles.
  // Seed the post-Restore re-check read so the Restore's computeDrift sees the
  // golden section (the Apply committed example.com, so committed is now
  // [{example.com,alwaysOn:true}] and the Restore must write the golden 4 lines
  // against that run-time committed — NOT empty [] from a stale call-time
  // snapshot).
  shellNative.readHostsSection.mockReturnValue({
    ok: true,
    section: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.example.com',
      ':: www.example.com',
    ],
  });
  resolveFirst!({ ok: true });
  const [applyRes, restoreRes] = await Promise.all([applyP, restoreP]);

  expect(writeHostsCalls).toBe(2);
  expect(overlapDetected).toBe(false);
  expect(applyRes).toStrictEqual({ ok: true });
  expect(restoreRes).toStrictEqual({ ok: true });
  // The Restore must have written the golden 4 lines derived from the
  // run-time committed (now example.com), NOT [] from a stale call-time
  // DEFAULT_CONFIG snapshot. With the OLD call-time-snapshot code this would
  // be `[]` and the test would fail here.
  expect(shellNative.writeHosts.mock.calls[1][0]).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ]);
  // The post-Restore re-check clears drift to in-sync.
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
});

test('restoreSection never rejects when writeHosts throws — the port catches it into an envelope', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'example.com', alwaysOn: true }],
    },
  });
  shellNative.writeHosts.mockRejectedValue(new Error('port died'));

  const result = await useDomainStore.getState().restoreSection();

  // The shellRunner port caught the rejection and surfaced its message; the
  // store resolves to the envelope (never rejects). Drift is not re-checked on
  // failure (no readHostsSection call).
  expect(result).toStrictEqual({ ok: false, error: 'port died' });
  expect(shellNative.readHostsSection).not.toHaveBeenCalled();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// ===========================================================================
// Story 3.1 — setPassword (non-block-affecting direct config commit)
// ===========================================================================
//
// setPassword writes `passwordHash` (salt-free SHA-256) straight to config.json
// via writeConfig — NOT through the staged-Apply pipeline, does NOT touch
// /etc/hosts. Sequenced through the shared serialized queue so it cannot
// clobber an in-flight Apply's writeConfig. `committed` is re-read INSIDE the
// enqueue at run time so the password write preserves any domains an ahead-of-
// it Apply just committed.

test('setPassword writes the SHA-256 hash to config, advances committed, and returns { ok: true }', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  const result = await useDomainStore.getState().setPassword('secret123');

  // `writeConfig` returns `{ ok, error: undefined }` (the configStore port
  // always includes the `error` key), so `toEqual` (which ignores undefined
  // keys) is the right matcher — `toStrictEqual` would flag the extra key.
  expect(result).toEqual({ ok: true });
  // writeConfig called exactly once with the full next config carrying the
  // hash. The hash is the salt-free SHA-256 of the plaintext.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.passwordHash).toBe(hashPassword('secret123'));
  // Plaintext is never persisted — the written config contains the hash, not
  // the password.
  expect(configNative.writeConfig.mock.calls[0][0]).not.toContain('secret123');
  // committed advanced to carry the hash.
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret123'),
  );
});

test('setPassword does NOT call writeHosts (non-block-affecting: no /etc/hosts touch)', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  await useDomainStore.getState().setPassword('secret123');

  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

test('setPassword on writeConfig failure returns the envelope and leaves committed unchanged', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  const result = await useDomainStore.getState().setPassword('secret123');

  expect(result).toStrictEqual({ ok: false, error: 'disk-full' });
  // committed.passwordHash stays unset (no half-advance on failure).
  expect(useDomainStore.getState().committed.passwordHash).toBeUndefined();
});

test('setPassword does NOT flip applyStatus (it is not an Apply run)', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG, applyStatus: 'idle' });

  await useDomainStore.getState().setPassword('secret123');

  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

test('setPassword queued behind an in-flight Apply does NOT clobber the Apply\'s writeConfig — password write preserves the Apply\'s committed domains', async () => {
  // Stage a domain and start an Apply whose writeHosts does not resolve until
  // we release it, so the Apply stays in flight while setPassword queues.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  let resolveApply: ((v: WriteResult) => void) | null = null;
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        resolveApply = res;
      }),
  );

  useDomainStore.getState().stageDomainAdd('example.com');
  const applyP = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(useDomainStore.getState().applyStatus).toBe('running');

  // While the Apply is in flight, call setPassword — it queues behind it.
  const pwP = useDomainStore.getState().setPassword('secret123');
  await flushMicrotasks();
  // The Apply has not settled yet, so setPassword must NOT have run — only
  // the Apply's writeConfig (config commit) has happened so far.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);

  // Release the Apply: it commits staged domains, THEN setPassword runs and
  // writes {...committed (now with the Apply's domains), passwordHash}.
  resolveApply!({ ok: true });
  const [applyRes, pwRes] = await Promise.all([applyP, pwP]);

  expect(applyRes).toStrictEqual({ ok: true });
  // setPassword returns the writeConfig envelope, which carries an explicit
  // `error: undefined` key — `toEqual` ignores it.
  expect(pwRes).toEqual({ ok: true });
  // Two writeConfig calls total: the Apply's (config commit) + the password
  // write. setPassword did NOT overlap the Apply's writeConfig.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  // The password write (the second call) built on the RUN-TIME committed,
  // which now carries the Apply's just-committed domains. So the written
  // config preserves domains AND adds passwordHash — no clobber.
  const pwWritten = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  expect(pwWritten.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(pwWritten.passwordHash).toBe(hashPassword('secret123'));
  // Plaintext is never persisted — the serialized config carries the hash only.
  expect(configNative.writeConfig.mock.calls[1][0]).not.toContain('secret123');
  // committed reflects both writes: the Apply's domains + the password hash.
  const state = useDomainStore.getState();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.committed.passwordHash).toBe(hashPassword('secret123'));
  // writeHosts called exactly once (by the Apply) — setPassword never calls it.
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
});
test('back-to-back setPassword calls serialize: the second write carries the latest hash, not a stale snapshot', async () => {
  // Two setPassword calls queue FIFO. The first writes hashA and advances
  // committed; the second re-reads committed at run time (now carrying hashA)
  // and overwrites passwordHash with hashB. Final committed.passwordHash is
  // hashB — the second call did not build on a stale call-time snapshot.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  const [r1, r2] = await Promise.all([
    useDomainStore.getState().setPassword('firstpw'),
    useDomainStore.getState().setPassword('secondpw'),
  ]);

  expect(r1).toEqual({ ok: true });
  expect(r2).toEqual({ ok: true });
  // Two serialized writeConfig calls.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  // The first written config carries hashA; the second carries hashB.
  const first = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  const second = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  expect(first.passwordHash).toBe(hashPassword('firstpw'));
  expect(second.passwordHash).toBe(hashPassword('secondpw'));
  // Final committed reflects the LAST write (hashB), not hashA.
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secondpw'),
  );
});

test('setPassword persists committed only — staged (un-Applied) domain changes are NOT silently written to config', async () => {
  // Guards against a future regression that spreads `staged` instead of
  // `committed` into the password write. The user stages a domain (not yet
  // Applied) then sets a password: the written config must carry the hash on
  // top of `committed` (no staged domain), and the staged draft must remain
  // untouched for a later Apply.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  useDomainStore.getState().stageDomainAdd('example.com');
  // Sanity: the stage took and is not yet committed.
  expect(useDomainStore.getState().staged).not.toBeNull();
  expect(useDomainStore.getState().committed.domains).toStrictEqual([]);

  await useDomainStore.getState().setPassword('secret123');

  // The written config carries the hash but NOT the staged domain.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.passwordHash).toBe(hashPassword('secret123'));
  expect(written.domains).toStrictEqual([]);
  // committed gained the hash but no domain; staged is unchanged.
  expect(useDomainStore.getState().committed.domains).toStrictEqual([]);
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret123'),
  );
  expect(useDomainStore.getState().staged).not.toBeNull();
});

// ===========================================================================
// Story 4.2 — `stageStartTimer` (the focus-session engine swap).
//
// Mirrors `setPassword`'s serialized `enqueue` + run-time `committed` re-read
// (`store.ts:454-460`) and `restoreSection`'s hosts-write + `applyStatus`
// flip (`store.ts:411-415`). Strict config-then-hosts order, one admin
// prompt. Covers: success / config-fail / hosts-deny / race-vs-Apply /
// back-to-back / staged-not-clobbered.
// ===========================================================================

/** A 25-minute duration in ms (mirrors the Timer's default preset). */
const TWENTY_FIVE_MIN_MS = 25 * 60_000;

test('stageStartTimer success: writeConfig (activeTimer) BEFORE writeHosts (strict order), single admin prompt, advances committed.activeTimer', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'a.com', alwaysOn: true }],
    },
    staged: null,
    applyStatus: 'idle',
  });
  const before = Date.now();

  const result = await useDomainStore
    .getState()
    .stageStartTimer({ durationMs: TWENTY_FIVE_MIN_MS, selected: new Set(['a.com', 'b.com']) });

  expect(result).toEqual({ ok: true });
  // Strict order: writeConfig fires once BEFORE writeHosts.
  const writeConfigOrder = configNative.writeConfig.mock.invocationCallOrder[0];
  const writeHostsOrder = shellNative.writeHosts.mock.invocationCallOrder[0];
  expect(writeConfigOrder).toBeLessThan(writeHostsOrder);
  // writeConfig called exactly once with the full next config carrying
  // `activeTimer:{endEpochMs,selectedDomains}`. `endEpochMs` is computed
  // INSIDE the enqueue (run time), so it's `~ now + durationMs`.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([
    { hostname: 'a.com', alwaysOn: true },
  ]);
  expect(written.activeTimer.endEpochMs).toBeGreaterThanOrEqual(before + TWENTY_FIVE_MIN_MS - 5);
  expect(written.activeTimer.endEpochMs).toBeLessThanOrEqual(
    Date.now() + TWENTY_FIVE_MIN_MS + 5,
  );
  expect(written.activeTimer.selectedDomains).toStrictEqual(['a.com', 'b.com']);
  // writeHosts called exactly once with the union of always-on + timer-
  // selected, deduped by apex. `a.com` is in BOTH; the dedupe means it's
  // written ONCE (the spec's "apex is written ONCE" AC). Hosts lines use
  // a single space separator (`0.0.0.0 <apex>`, `:: <apex>`), per
  // `toHostsLines` at normalise.ts:114-125.
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  // The hosts lines must include the timer-selected domains (the Epic 4
  // union contribution). Effective blocklist = alwaysOn ∪ activeTimer,
  // deduped by apex. `a.com` is in BOTH (alwaysOn + timer-selected); the
  // dedupe keeps it once but the apex token still appears in the lines.
  // `b.com` is timer-selected only — without the Epic 4 union contribution
  // `b.com` would be missing from the hosts lines.
  expect(hostsLines.some((l: string) => l.includes('a.com'))).toBe(true);
  expect(hostsLines.some((l: string) => l.includes('b.com'))).toBe(true);
  // Pull out the apex names (the second whitespace-delimited token).
  const distinctApexes = new Set(
    hostsLines.map((l: string) => l.split(/\s+/)[1]),
  );
  // 2 apexes (a.com, b.com), each with `apex` and `www.<apex>` entries =
  // 4 distinct apex tokens. `a.com` appears twice (apex + www.) but the
  // dedupe collapses them — the assertion is on the SET of distinct
  // hostnames.
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'b.com', 'www.a.com', 'www.b.com']));
  // committed.activeTimer advances to the new value.
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: written.activeTimer.endEpochMs,
    selectedDomains: ['a.com', 'b.com'],
  });
  // applyStatus resets to idle on success.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  // lastResult carries the writeHosts envelope.
  expect(useDomainStore.getState().lastResult).toEqual({ ok: true });
});

test('stageStartTimer config-write failure: returns the envelope, does NOT call writeHosts, does NOT flip applyStatus, committed unchanged', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'a.com', alwaysOn: true }],
    },
    staged: null,
    applyStatus: 'idle',
  });

  const result = await useDomainStore
    .getState()
    .stageStartTimer({ durationMs: TWENTY_FIVE_MIN_MS, selected: new Set(['a.com']) });

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  // writeConfig was called (and failed) -> writeHosts is NEVER called.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  // applyStatus is NOT flipped (strict order: config-write fail short-
  // circuits before any elevation).
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  // committed.activeTimer stays null (no advance on failure).
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
});

test('stageStartTimer hosts-deny: committed.activeTimer stays null (retry-safe); applyStatus resets to idle; lastResult carries the envelope', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'a.com', alwaysOn: true }],
    },
    staged: null,
    applyStatus: 'idle',
  });

  const result = await useDomainStore
    .getState()
    .stageStartTimer({ durationMs: TWENTY_FIVE_MIN_MS, selected: new Set(['a.com']) });

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // writeConfig ran (carrying the activeTimer write — accepted drift).
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  // writeHosts ran (admin denied).
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // committed.activeTimer STAYS null (the spec's retry-safe invariant).
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  // applyStatus resets to idle after the hosts call settles.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  // lastResult carries the denial envelope.
  expect(useDomainStore.getState().lastResult).toStrictEqual({
    ok: false,
    error: 'admin-denied',
  });
});

test('stageStartTimer queued behind an in-flight Apply: timer\'s writeConfig preserves the Apply\'s just-committed domains (no clobber)', async () => {
  // Stage a domain and start an Apply whose writeHosts does not resolve
  // until we release it, so the Apply stays in flight while stageStartTimer
  // queues. After release, the Apply commits its staged domains first;
  // stageStartTimer then runs and reads the run-time `committed` (now
  // carrying the Apply's domains) — its writeConfig preserves them.
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
  });
  // Queue of pending writeHosts resolvers — each call enqueues a resolver
  // and we drain them in order. The Apply's call comes first, the timer's
  // second; this keeps the queue strictly FIFO so both calls settle.
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  // Stage and start the Apply.
  useDomainStore.getState().stageDomainAdd('example.com');
  const applyP = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(useDomainStore.getState().applyStatus).toBe('running');
  expect(pendingResolvers).toHaveLength(1); // the Apply's writeHosts

  // While the Apply is in flight, call stageStartTimer — it queues behind.
  const timerP = useDomainStore
    .getState()
    .stageStartTimer({ durationMs: TWENTY_FIVE_MIN_MS, selected: new Set(['b.com']) });
  await flushMicrotasks();
  // The Apply has not settled, so stageStartTimer must NOT have run yet.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // Apply's only
  expect(pendingResolvers).toHaveLength(1); // still just the Apply's

  // Release the Apply: it commits the staged domain, THEN stageStartTimer
  // runs and reaches its own `await writeHosts` (a 2nd pending resolver).
  pendingResolvers.shift()!({ ok: true });
  await flushMicrotasks();
  // Apply has settled; the timer's writeConfig ran; the timer's writeHosts
  // is the new pending entry.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  expect(pendingResolvers).toHaveLength(1); // now the timer's writeHosts

  // Release the timer's writeHosts: it settles the timer run.
  pendingResolvers.shift()!({ ok: true });
  const [applyRes, timerRes] = await Promise.all([applyP, timerP]);

  expect(applyRes).toStrictEqual({ ok: true });
  expect(timerRes).toEqual({ ok: true });
  // The timer's writeConfig (second call) was built on the run-time
  // committed — preserving the Apply's just-committed domain.
  const timerWritten = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  expect(timerWritten.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(timerWritten.activeTimer).toBeDefined();
  expect(timerWritten.activeTimer.selectedDomains).toStrictEqual(['b.com']);
  // committed reflects both: the Apply's domain + the timer's activeTimer.
  const state = useDomainStore.getState();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.committed.activeTimer).toBeDefined();
  expect(state.committed.activeTimer?.selectedDomains).toStrictEqual(['b.com']);
});

test('stageStartTimer back-to-back: 2nd supersedes the 1st cleanly; 2nd\'s endEpochMs >= 1st\'s (computed at run time)', async () => {
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
  });

  const [r1, r2] = await Promise.all([
    useDomainStore.getState().stageStartTimer({
      durationMs: TWENTY_FIVE_MIN_MS,
      selected: new Set(['a.com']),
    }),
    useDomainStore.getState().stageStartTimer({
      durationMs: TWENTY_FIVE_MIN_MS,
      selected: new Set(['b.com']),
    }),
  ]);

  expect(r1).toEqual({ ok: true });
  expect(r2).toEqual({ ok: true });
  // Two serialized writeConfig calls; the second's activeTimer carries b.com.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  const first = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  const second = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  // The 2nd's endEpochMs >= the 1st's (computed at run time; both can land
  // on the same millisecond when the queue drains without a wall-clock
  // tick, so we allow >= not >).
  expect(second.activeTimer.endEpochMs).toBeGreaterThanOrEqual(
    first.activeTimer.endEpochMs,
  );
  // The 2nd supersedes the 1st: only `b.com` survives in the final committed
  // state (stale `a.com` is trimmed by the second write carrying the new
  // selection).
  expect(useDomainStore.getState().committed.activeTimer?.selectedDomains).toStrictEqual([
    'b.com',
  ]);
});

test('stageStartTimer does NOT clobber staged Blocklist edits (staged is intact after the hosts write)', async () => {
  // The user has a staged Blocklist edit (toggled alwaysOn for example.com)
  // when they tap Start. Start's serialized run touches config.json AND
  // hosts — but must NOT touch `staged`. The staged edit remains for a
  // later Apply from Blocklist.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'example.com', alwaysOn: true },
        { hostname: 'social.com', alwaysOn: false },
      ],
    },
    staged: null,
    applyStatus: 'idle',
  });
  // Stage a toggle: example.com becomes alwaysOn:false (the staged edit).
  useDomainStore.getState().stageAlwaysOnToggle('example.com');
  const stagedBefore = useDomainStore.getState().staged;
  expect(stagedBefore).not.toBeNull();

  await useDomainStore.getState().stageStartTimer({
    durationMs: TWENTY_FIVE_MIN_MS,
    selected: new Set(['social.com']),
  });

  // committed advanced to carry the timer's activeTimer (overwrite the
  // committed domains with the same domains — the timer doesn't mutate
  // `domains`).
  expect(useDomainStore.getState().committed.activeTimer).toBeDefined();
  // `staged` is INTACT — the same reference as before, untouched. The next
  // Apply from Blocklist will commit this toggle alongside the running
  // session.
  expect(useDomainStore.getState().staged).toBe(stagedBefore);
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: false },
    { hostname: 'social.com', alwaysOn: false },
  ]);
});

// ===========================================================================
// Story 3.2 — the reusable password gate: `requirePassword` /
// `verifyPassword` / `closeGate` / `clearGateThrottle`. Runtime-only state
// (`gateOpen`/`gateAction`/`gateAttempts`/`gateThrottleUntil`) — NOT persisted
// to `config.json`, NOT in `Config`/`types.ts`. The gate is built ONCE and
// reused by every gated caller; these tests prove the mechanism before 3-3
// wires a real caller.
// ===========================================================================

/** Seed a password into `committed` so the gate has something to compare. */
function seedPassword(pw: string): void {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, passwordHash: hashPassword(pw) },
  });
}

// A stub gated action — records that it ran. The same shape a real caller
// (3-3 change-password, 3-4 Panic, 4-6 end-early) would pass to
// `requirePassword`.
const makeAction = () => {
  const fn = jest.fn();
  return { fn, action: fn as unknown as () => void };
};

// ---------------------------------------------------------------------------
// requirePassword: no-password short-circuit vs sheet-open
// ---------------------------------------------------------------------------

test('requirePassword with NO password set runs the action immediately and does NOT open the gate', () => {
  useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } }); // passwordHash unset
  const { fn, action } = makeAction();

  useDomainStore.getState().requirePassword(action);

  // The action ran immediately (the no-op short-circuit — the gate is never
  // an empty sheet).
  expect(fn).toHaveBeenCalledTimes(1);
  // The gate did NOT open.
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
});

test('requirePassword with an empty-string passwordHash also short-circuits (treats "" as unset)', () => {
  // Guards against a corrupt config that wrote `passwordHash: ""`. The
  // sentinel matches `Settings.tsx` (`passwordHash != null && passwordHash !== ''`).
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, passwordHash: '' },
  });
  const { fn, action } = makeAction();

  useDomainStore.getState().requirePassword(action);

  expect(fn).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateOpen).toBe(false);
});

test('requirePassword with a password set opens the gate and stashes the action (does NOT run it yet)', () => {
  seedPassword('secret123');
  const { fn, action } = makeAction();

  useDomainStore.getState().requirePassword(action);

  // The action has NOT run yet — it waits for a successful verify.
  expect(fn).not.toHaveBeenCalled();
  // The gate opened and stashed the action.
  expect(useDomainStore.getState().gateOpen).toBe(true);
  expect(useDomainStore.getState().gateAction).toBe(action);
});

// ---------------------------------------------------------------------------
// verifyPassword: correct / wrong / throttle / reset
// ---------------------------------------------------------------------------

test('verifyPassword with the correct password returns { ok: true } and resets attempts + throttle', () => {
  seedPassword('secret123');
  // Simulate two prior wrong attempts + an EXPIRED throttle (the countdown
  // interval hasn't ticked yet). A correct entry must clear all of it (the
  // spec's "correct entry -> gateAttempts→0, gateThrottleUntil→null").
  useDomainStore.setState({
    gateAttempts: 2,
    gateThrottleUntil: Date.now() - 1,
  });

  const result = useDomainStore.getState().verifyPassword('secret123');

  expect(result).toEqual({ ok: true });
  expect(useDomainStore.getState().gateAttempts).toBe(0);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
});

test('verifyPassword with a wrong password (tries 1-4) increments attempts and returns triesLeft', () => {
  seedPassword('secret123');

  // 1st wrong.
  let result = useDomainStore.getState().verifyPassword('wrong1');
  expect(result).toEqual({ ok: false, triesLeft: GATE_MAX_ATTEMPTS - 1 });
  expect(useDomainStore.getState().gateAttempts).toBe(1);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();

  // 2nd wrong.
  result = useDomainStore.getState().verifyPassword('wrong2');
  expect(result).toEqual({ ok: false, triesLeft: GATE_MAX_ATTEMPTS - 2 });
  expect(useDomainStore.getState().gateAttempts).toBe(2);

  // 4th wrong (skip to it).
  useDomainStore.setState({ gateAttempts: 3 });
  result = useDomainStore.getState().verifyPassword('wrong4');
  expect(result).toEqual({ ok: false, triesLeft: GATE_MAX_ATTEMPTS - 4 });
  expect(useDomainStore.getState().gateAttempts).toBe(4);
  // Still NOT throttled — the 5th wrong engages the throttle.
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
});

test('verifyPassword on the 5th wrong entry engages the throttle and returns throttleMs', () => {
  seedPassword('secret123');
  useDomainStore.setState({ gateAttempts: GATE_MAX_ATTEMPTS - 1 }); // 4 prior wrong

  const before = Date.now();
  const result = useDomainStore.getState().verifyPassword('wrong5');
  const after = Date.now();

  expect(result.ok).toBe(false);
  expect(result.triesLeft).toBe(0);
  expect(result.throttleMs).toBe(GATE_THROTTLE_MS);
  // The throttle deadline is now + GATE_THROTTLE_MS (allow a 5ms slack for the
  // Date.now() calls bracketing the action).
  const until = useDomainStore.getState().gateThrottleUntil;
  expect(until).not.toBeNull();
  expect(until!).toBeGreaterThanOrEqual(before + GATE_THROTTLE_MS - 5);
  expect(until!).toBeLessThanOrEqual(after + GATE_THROTTLE_MS + 5);
  expect(useDomainStore.getState().gateAttempts).toBe(GATE_MAX_ATTEMPTS);
});

test('verifyPassword while throttled (not yet elapsed) returns throttleMs without comparing', () => {
  seedPassword('secret123');
  // An active throttle 10s in the future. Even the CORRECT password must not
  // verify while throttled — the field is disabled, so this is a defensive
  // guard for a direct store caller / a race.
  useDomainStore.setState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() + 10_000,
  });

  const result = useDomainStore.getState().verifyPassword('secret123');

  expect(result.ok).toBe(false);
  expect(result.throttleMs).toBeGreaterThan(0);
  expect(result.throttleMs).toBeLessThanOrEqual(10_000);
  // Attempts + throttle unchanged (the throttle is still active).
  expect(useDomainStore.getState().gateAttempts).toBe(GATE_MAX_ATTEMPTS);
  expect(useDomainStore.getState().gateThrottleUntil).not.toBeNull();
});

test('verifyPassword on an exact-expiry submit clears the throttle and proceeds (race with the interval tick)', () => {
  seedPassword('secret123');
  // Throttle deadline in the past — the countdown interval hasn't ticked yet,
  // but a submit landing now should clear the throttle and start fresh.
  useDomainStore.setState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() - 1,
  });

  // A WRONG entry after throttle expiry: attempts reset to 0 first, then this
  // is the 1st wrong of a fresh cycle (triesLeft = GATE_MAX_ATTEMPTS - 1).
  const result = useDomainStore.getState().verifyPassword('wrong-fresh');
  expect(result).toEqual({ ok: false, triesLeft: GATE_MAX_ATTEMPTS - 1 });
  expect(useDomainStore.getState().gateAttempts).toBe(1);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
});

test('verifyPassword with no password set returns { ok: true } (defensive — requirePassword short-circuits)', () => {
  // `requirePassword` never opens the gate when no password is set, so
  // `verifyPassword` is never called in that state. But a defensive `ok: true`
  // ensures a misconfigured caller (e.g. a test seeding `gateOpen:true` with
  // no hash) doesn't lock the user out.
  useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });

  const result = useDomainStore.getState().verifyPassword('anything');

  expect(result).toEqual({ ok: true });
});

// ---------------------------------------------------------------------------
// closeGate: clears open + action, PRESERVES attempts + throttle
// ---------------------------------------------------------------------------

test('closeGate clears gateOpen + gateAction and PRESERVES gateAttempts + gateThrottleUntil', () => {
  seedPassword('secret123');
  const { action } = makeAction();
  useDomainStore.getState().requirePassword(action);
  // Simulate 3 prior wrong attempts + an active throttle.
  const until = Date.now() + 10_000;
  useDomainStore.setState({
    gateAttempts: 3,
    gateThrottleUntil: until,
  });
  expect(useDomainStore.getState().gateOpen).toBe(true);

  useDomainStore.getState().closeGate();

  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
  // Attempts + throttle PRESERVED (Esc/cancel does NOT reset the counter — the
  // spec's Never clause).
  expect(useDomainStore.getState().gateAttempts).toBe(3);
  expect(useDomainStore.getState().gateThrottleUntil).toBe(until);
});

test('attempts persist across closeGate + reopen (Esc does not reset the counter)', () => {
  // The spec's AC: "Given wrong attempts were made, when the sheet is closed
  // and reopened, then the attempt counter is unchanged."
  seedPassword('secret123');
  const { fn, action } = makeAction();
  useDomainStore.getState().requirePassword(action);
  // 2 prior wrong attempts.
  useDomainStore.getState().verifyPassword('wrong1');
  useDomainStore.getState().verifyPassword('wrong2');
  expect(useDomainStore.getState().gateAttempts).toBe(2);

  // Esc -> closeGate.
  useDomainStore.getState().closeGate();
  expect(useDomainStore.getState().gateAttempts).toBe(2);

  // Reopen via a new requirePassword — the counter is STILL 2.
  const { fn: fn2, action: action2 } = makeAction();
  useDomainStore.getState().requirePassword(action2);
  expect(useDomainStore.getState().gateOpen).toBe(true);
  expect(useDomainStore.getState().gateAttempts).toBe(2);

  // The 3rd wrong now (attempts 2 -> 3) — NOT a fresh 1st wrong. This proves
  // the counter survived close + reopen.
  const result = useDomainStore.getState().verifyPassword('wrong3');
  expect(result).toEqual({ ok: false, triesLeft: GATE_MAX_ATTEMPTS - 3 });
  expect(useDomainStore.getState().gateAttempts).toBe(3);

  // The first action (from the first requirePassword) was cleared by closeGate
  // and never ran; the second action is the one stashed now.
  expect(fn).not.toHaveBeenCalled();
  expect(fn2).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// clearGateThrottle: nulls throttle + resets attempts (5 fresh tries)
// ---------------------------------------------------------------------------

test('clearGateThrottle nulls gateThrottleUntil and resets gateAttempts to 0', () => {
  seedPassword('secret123');
  useDomainStore.setState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() + 10_000,
  });

  useDomainStore.getState().clearGateThrottle();

  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
  expect(useDomainStore.getState().gateAttempts).toBe(0);
});

test('after clearGateThrottle, 5 fresh tries are available (the counter restarts from 0)', () => {
  seedPassword('secret123');
  // Burn all 5 tries -> throttle.
  for (let i = 0; i < GATE_MAX_ATTEMPTS; i++) {
    useDomainStore.getState().verifyPassword('wrong');
  }
  expect(useDomainStore.getState().gateThrottleUntil).not.toBeNull();

  // Throttle elapses -> clearGateThrottle.
  useDomainStore.getState().clearGateThrottle();
  expect(useDomainStore.getState().gateAttempts).toBe(0);

  // 5 fresh wrong tries before the throttle re-engages.
  for (let i = 0; i < GATE_MAX_ATTEMPTS - 1; i++) {
    const r = useDomainStore.getState().verifyPassword('wrong');
    expect(r.ok).toBe(false);
    expect(r.throttleMs).toBeUndefined();
  }
  // The 5th fresh wrong re-engages the throttle.
  const r5 = useDomainStore.getState().verifyPassword('wrong');
  expect(r5.ok).toBe(false);
  expect(r5.throttleMs).toBe(GATE_THROTTLE_MS);
  expect(useDomainStore.getState().gateThrottleUntil).not.toBeNull();
});

// ---------------------------------------------------------------------------
// requirePassword + verifyPassword end-to-end: success runs the action
// ---------------------------------------------------------------------------

test('a correct verifyPassword after wrong attempts lets the stashed action run via the Shell onVerified flow', () => {
  // This proves the mechanism end-to-end: requirePassword stashes the action,
  // wrong attempts don't run it, a correct verifyPassword resets the counter,
  // and the caller (the Shell's runGateAction in production) reads gateAction
  // + runs it + closeGate.
  seedPassword('secret123');
  const { fn, action } = makeAction();
  useDomainStore.getState().requirePassword(action);
  expect(useDomainStore.getState().gateOpen).toBe(true);

  // 2 wrong attempts — the action does NOT run.
  useDomainStore.getState().verifyPassword('wrong1');
  useDomainStore.getState().verifyPassword('wrong2');
  expect(fn).not.toHaveBeenCalled();

  // Correct entry — verifyPassword resets the counter but does NOT run the
  // action itself (the Shell's onVerified does that).
  const result = useDomainStore.getState().verifyPassword('secret123');
  expect(result).toEqual({ ok: true });
  expect(useDomainStore.getState().gateAttempts).toBe(0);
  expect(fn).not.toHaveBeenCalled();

  // Simulate the Shell's runGateAction: read the stashed action, run it,
  // close the gate.
  const stashed = useDomainStore.getState().gateAction;
  expect(stashed).toBe(action);
  stashed!();
  useDomainStore.getState().closeGate();

  expect(fn).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
});

// ---------------------------------------------------------------------------
// Review patches (step-04): clearGateThrottle guard, VerifyResult shape,
// no-writeConfig invariant
// ---------------------------------------------------------------------------

test('clearGateThrottle is a no-op when NOT throttled (does NOT wipe gateAttempts)', () => {
  // Guard against a stray clearGateThrottle call after a few wrong tries but
  // before the throttle engages — otherwise it would reset the counter and
  // bypass the 5-try limit. The countdown tick only fires while throttled, so
  // this guard does not block the legitimate expiry path.
  seedPassword('secret123');
  useDomainStore.setState({
    gateAttempts: 3,
    gateThrottleUntil: null, // not throttled
  });

  useDomainStore.getState().clearGateThrottle();

  // attempts UNCHANGED (not reset to 0); throttle still null.
  expect(useDomainStore.getState().gateAttempts).toBe(3);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
});

test('verifyPassword while throttled returns triesLeft: 0 (consistent shape with the 5th-wrong branch)', () => {
  // Both throttled results (active-throttle here, 5th-wrong in the wrong-entry
  // path) carry `triesLeft` + `throttleMs`, so a caller reading `triesLeft` on
  // a throttle result never sees `undefined`.
  seedPassword('secret123');
  useDomainStore.setState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() + 5_000,
  });

  const result = useDomainStore.getState().verifyPassword('anything');

  expect(result.ok).toBe(false);
  expect(result.triesLeft).toBe(0);
  expect(typeof result.throttleMs).toBe('number');
});

test('gate actions never call writeConfig (gate state is runtime-only, NOT persisted)', () => {
  // The spec's Always/Never: gateAttempts/gateThrottleUntil are runtime store
  // state — NOT persisted to config.json, NOT added to Config/types.ts.
  // Exercise every gate action (requirePassword, verifyPassword wrong +
  // correct, closeGate, clearGateThrottle) and assert writeConfig is never
  // called — a regression that accidentally persisted gate state would fail
  // here.
  configNative.writeConfig.mockClear();
  seedPassword('secret123');

  const { fn, action } = makeAction();
  useDomainStore.getState().requirePassword(action); // open + stash
  useDomainStore.getState().verifyPassword('wrong'); // wrong-entry path
  useDomainStore.getState().verifyPassword('secret123'); // correct-entry path
  useDomainStore.getState().closeGate(); // Esc/cancel path
  // Throttle + clear path.
  useDomainStore.setState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() + 1000,
  });
  useDomainStore.getState().clearGateThrottle();

  // requirePassword with a password set stashes (does not run) the action.
  expect(fn).not.toHaveBeenCalled();
  // No gate action persisted anything to config.json.
  expect(configNative.writeConfig).not.toHaveBeenCalled();
});

// ===========================================================================
// Story 4.5 — `expireTimer` (the auto-unblock on expiry) + the Shell-level
// runtime-only toast + the module-level expiry trigger.
//
// Mirrors the 4.2 `stageStartTimer` matrix with the inverse write
// (`activeTimer: null`). Covers: success (strict config-then-hosts order,
// hosts payload = always-on lines only, `committed.activeTimer` cleared,
// info toast), also-always-on stays blocked, hosts-deny, hosts-throw,
// config-write fail, the queue-time not-expired guard, the superseding-
// session no-op, double-fire idempotency, queue-behind-Apply (fresh re-read
// of `committed`), `clearToast`, and the fire-and-forget trigger on the
// timer slice's expired false->true transition (including expired-at-mount).
// ===========================================================================

/** Seed a committed config carrying an EXPIRED focus session. */
function seedExpiredSession(opts?: {
  alwaysOn?: Array<string>;
  selected?: Array<string>;
  endEpochMs?: number;
}): number {
  const end = opts?.endEpochMs ?? Date.now() - 1_000;
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: false },
        ...(opts?.alwaysOn ?? []).map((hostname) => ({ hostname, alwaysOn: true })),
      ],
      activeTimer: {
        endEpochMs: end,
        selectedDomains: opts?.selected ?? ['a.com', 'b.com'],
      },
    },
    applyStatus: 'idle',
  });
  return end;
}

test('expireTimer success: writeConfig (activeTimer:null) BEFORE writeHosts, hosts payload = always-on lines only, committed.activeTimer cleared, info toast', async () => {
  const end = seedExpiredSession();

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toEqual({ ok: true });
  // Strict order: writeConfig fires once BEFORE writeHosts.
  const writeConfigOrder = configNative.writeConfig.mock.invocationCallOrder[0];
  const writeHostsOrder = shellNative.writeHosts.mock.invocationCallOrder[0];
  expect(writeConfigOrder).toBeLessThan(writeHostsOrder);
  // writeConfig called exactly once with the full config carrying
  // `activeTimer: null` on top of the committed domains.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
  ]);
  expect(written.activeTimer).toBeNull();
  // writeHosts called exactly once with the ALWAYS-ON lines only — with
  // `activeTimer: null` the Epic 4 timer loop contributes nothing, so the
  // timer-selected `b.com` (alwaysOn:false) is GONE from the hosts payload.
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));
  // `committed.activeTimer` is cleared in memory (badge/countdown revert).
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  // applyStatus resets to idle; lastResult carries the envelope.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toEqual({ ok: true });
  // The success toast (info tone) is raised.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });
});

test('expireTimer success keeps an also-always-on domain blocked (hosts payload retains it; no removal path)', async () => {
  // `b.com` is in the session selection AND alwaysOn. On expiry the session
  // set lifts, but the always-on loop keeps it in the effective blocklist —
  // union precedence by construction. A regression that REMOVED domains from
  // `alwaysOn` (or recomputed the payload from the wrong source) would drop
  // it from the hosts lines and fail here.
  seedExpiredSession({ selected: ['b.com'], alwaysOn: ['b.com'] });

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toEqual({ ok: true });
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  // `alwaysOn` is NOT touched — the domain entry survives untouched.
  expect(written.domains).toContainEqual({ hostname: 'b.com', alwaysOn: true });
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  // Both always-on domains stay blocked after the session lifts.
  expect(distinctApexes).toStrictEqual(
    new Set(['a.com', 'www.a.com', 'b.com', 'www.b.com']),
  );
});

test('expireTimer hosts-deny: committed.activeTimer stays INTACT, applyStatus resets to idle, error toast', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });
  const end = seedExpiredSession();

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // writeConfig ran (carrying the activeTimer:null write — accepted drift).
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // `committed.activeTimer` INTACT in memory (the over-blocking mirror of
  // Start's accepted-drift order; retry-safe).
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: end,
    selectedDomains: ['a.com', 'b.com'],
  });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toStrictEqual({
    ok: false,
    error: 'admin-denied',
  });
  // The failure toast (error tone).
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: "Couldn't update /etc/hosts. No changes made.",
    tone: 'error',
  });
});

test('expireTimer hosts-throw: returns a hosts-throw envelope, keeps activeTimer intact, resets applyStatus, error toast', async () => {
  // shellRunner's writeHosts promise RESOLVES (never rejects) per its port
  // contract — a native-mock rejection is converted to an envelope by the
  // port before the store ever sees it. To exercise the store's DEFENSIVE
  // try/catch (the mirror of Start's Story 4.2 PATCH 2), spy on the
  // shellRunner module namespace: Babel compiles store.ts's named import to
  // a call-time property access, so the spy intercepts the store's call
  // before the port can convert anything. Restored by hand — this file has
  // no afterEach(restoreAllMocks).
  const spy = jest
    .spyOn(shellRunner, 'writeHosts')
    .mockRejectedValue(new Error('osascript exploded'));
  try {
    seedExpiredSession();

    const result = await useDomainStore.getState().expireTimer();

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('hosts-throw:');
    // applyStatus NOT left running; committed.activeTimer INTACT; toast error.
    expect(useDomainStore.getState().applyStatus).toBe('idle');
    expect(useDomainStore.getState().committed.activeTimer).not.toBeNull();
    expect(useDomainStore.getState().toast).toStrictEqual({
      message: "Couldn't update /etc/hosts. No changes made.",
      tone: 'error',
    });
  } finally {
    spy.mockRestore();
  }
});

test('expireTimer config-write failure: short-circuits BEFORE elevation — no writeHosts, applyStatus untouched, committed unchanged, NO toast', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  const end = seedExpiredSession();

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  // Strict order: a config-write fail short-circuits before the elevation.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: end,
    selectedDomains: ['a.com', 'b.com'],
  });
  // NO toast on a config-write failure.
  expect(useDomainStore.getState().toast).toBeNull();
});

test('expireTimer not-expired guard: null activeTimer OR a future end -> no ports, no applyStatus flip, no toast', async () => {
  // Case 1: no session at all.
  useDomainStore.setState({ committed: DEFAULT_CONFIG, applyStatus: 'idle' });
  const r1 = await useDomainStore.getState().expireTimer();
  expect(r1).toStrictEqual({ ok: false, error: 'not-expired' });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();

  // Case 2: a live (future-ended) session — Date.now() < endEpochMs.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      activeTimer: { endEpochMs: Date.now() + 60_000, selectedDomains: ['a.com'] },
    },
    applyStatus: 'idle',
  });
  const r2 = await useDomainStore.getState().expireTimer();
  expect(r2).toStrictEqual({ ok: false, error: 'not-expired' });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().toast).toBeNull();
});

test('expireTimer malformed guard: a NaN endEpochMs can never count as expired -> not-expired, zero ports, no toast', async () => {
  // A malformed (NaN) end time — reachable only through a hand-edited or
  // corrupt config.json that readConfig does not shape-check element values
  // on. `Date.now() < NaN` is false, so the guard's non-finite check is what
  // absorbs this: a corrupt session must NEVER auto-unblock. Mirrors the
  // guard test's structure above (case 3 of the same Always clause).
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'a.com', alwaysOn: true }],
      activeTimer: { endEpochMs: NaN, selectedDomains: ['a.com'] },
    },
    applyStatus: 'idle',
  });

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toStrictEqual({ ok: false, error: 'not-expired' });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: NaN,
    selectedDomains: ['a.com'],
  });
  expect(useDomainStore.getState().toast).toBeNull();
});

test('expireTimer with an EMPTY always-on set writes a markers-only (empty) hosts payload — unblock-all, no domain removal from config', async () => {
  // The session's selected domains are ALL non-always-on and no domain is
  // alwaysOn: when the session set lifts, the effective blocklist is EMPTY,
  // so the hosts payload is the markers-only empty array (unblock all) —
  // and `committed.domains` still carries the non-always-on entry untouched
  // (a regression that removed domains from the config on expiry fails here).
  seedExpiredSession({ selected: ['b.com'], alwaysOn: [] });
  // Narrow the seed's committed to ONLY the non-always-on domain (drop the
  // always-on `a.com` the helper adds).
  useDomainStore.setState({
    committed: {
      ...useDomainStore.getState().committed,
      domains: [{ hostname: 'b.com', alwaysOn: false }],
    },
  });

  const result = await useDomainStore.getState().expireTimer();

  expect(result).toEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The hosts payload is an EMPTY array — the markers-only rewrite that
  // unblocks everything (the 1.5 contract for `lines === []`).
  expect(shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([]);
  // `committed.domains` is NOT mutated by expiry — the session domain stays
  // listed (alwaysOn:false), just no longer in the effective blocklist.
  expect(useDomainStore.getState().committed.domains).toStrictEqual([
    { hostname: 'b.com', alwaysOn: false },
  ]);
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
});

test('expireTimer behind a HUNG queue run: no toast, no committed change, zero port calls from the expiry job while it waits', async () => {
  // The matrix's "Queue busy / hung — no toast while waiting" row: expireTimer
  // only ever runs through the shared `enqueue` chain. With a queued Start's
  // writeHosts promise held pending forever, the expiry job never acquires
  // the queue — so nothing happens AT ALL until the head run settles (no
  // premature toast, no state churn, no out-of-band port calls).
  seedExpiredSession();
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  // Start a session (future end) whose writeHosts NEVER resolves — the
  // queue is now hung on the Start's run.
  const startP = useDomainStore.getState().stageStartTimer({
    durationMs: TWENTY_FIVE_MIN_MS,
    selected: new Set(['a.com']),
  });
  await flushMicrotasks();
  expect(pendingResolvers).toHaveLength(1); // the Start's pending writeHosts
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // the Start's

  // Queue the expiry behind the hung run and drain — nothing may happen.
  const committedBefore = useDomainStore.getState().committed;
  const expireP = useDomainStore.getState().expireTimer();
  await flushMicrotasks();

  // The expiry job has NOT run: no second writeConfig, no toast, no committed
  // change, no lastResult from the expiry. (`applyStatus` reads 'running' —
  // that is the IN-FLIGHT Start's legitimate flip, not the expiry's.)
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // the Start's only
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1); // pending
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().committed).toBe(committedBefore);
  expect(useDomainStore.getState().applyStatus).toBe('running');
  expect(useDomainStore.getState().lastResult).toBeNull();

  // Un-block the fixture: release the Start's writeHosts so the queue (and
  // the test) settle — the expiry run then acquires the queue and no-ops on
  // the fresh FUTURE session (the superseding-session no-op already pins
  // that; here we only release the hang so nothing leaks into later tests).
  pendingResolvers.shift()!({ ok: true });
  await Promise.allSettled([startP, expireP]);
  await flushMicrotasks();
  // Still no failure toast after everything settles: the expiry no-oped on
  // the superseded (future) session.
  expect(useDomainStore.getState().toast).toBeNull();
});

test('expireTimer superseding session no-op: a Start queued ahead rewrites activeTimer with a FUTURE end and the expiry run re-reads it and no-ops', async () => {
  // Seed an EXPIRED session, then start a NEW session (future end) whose
  // writeHosts is held in flight. Queue expireTimer while Start runs: when
  // it acquires the queue, `committed.activeTimer` carries the FUTURE end of
  // the fresh session — the queue-time re-read must no-op and NOT clobber it.
  seedExpiredSession();
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  const startP = useDomainStore.getState().stageStartTimer({
    durationMs: TWENTY_FIVE_MIN_MS,
    selected: new Set(['a.com']),
  });
  await flushMicrotasks();
  expect(pendingResolvers).toHaveLength(1); // the Start's writeHosts

  // Queue the expiry behind the in-flight Start.
  const expireP = useDomainStore.getState().expireTimer();
  await flushMicrotasks();
  // The Start has not settled -> the expiry job has NOT run yet.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // Start's only
  expect(pendingResolvers).toHaveLength(1);

  // Release the Start's writeHosts: it commits the fresh session (FUTURE
  // end); then the expiry job runs, re-reads `committed`, sees the future
  // end, and no-ops WITHOUT touching any port.
  pendingResolvers.shift()!({ ok: true });
  const [startRes, expireRes] = await Promise.all([startP, expireP]);

  expect(startRes).toEqual({ ok: true });
  expect(expireRes).toStrictEqual({ ok: false, error: 'not-expired' });
  // Only the Start's writeConfig + writeHosts ever ran.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The fresh session SURVIVES.
  expect(useDomainStore.getState().committed.activeTimer).not.toBeNull();
  expect(
    useDomainStore.getState().committed.activeTimer!.endEpochMs,
  ).toBeGreaterThanOrEqual(Date.now());
  expect(useDomainStore.getState().toast).toBeNull();
});

test('expireTimer double-fire idempotency: the 2nd call after a successful expiry no-ops with not-expired', async () => {
  seedExpiredSession();

  const r1 = await useDomainStore.getState().expireTimer();
  expect(r1).toEqual({ ok: true });
  const r2 = await useDomainStore.getState().expireTimer();

  expect(r2).toStrictEqual({ ok: false, error: 'not-expired' });
  // Exactly ONE writeConfig + ONE writeHosts across both calls.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The success toast is still the ONE toast (not replaced by a failure).
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });
});

test('expireTimer queued behind an in-flight Apply: re-reads committed at queue time (hosts payload includes the Apply\'s just-committed domain)', async () => {
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
  });
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  // Start an Apply committing `example.com` as alwaysOn.
  useDomainStore.getState().stageDomainAdd('example.com');
  const applyP = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(pendingResolvers).toHaveLength(1); // the Apply's writeHosts

  // While the Apply is in flight, the session expires and expireTimer queues.
  const end = seedExpiredSession();
  const expireP = useDomainStore.getState().expireTimer();
  await flushMicrotasks();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // Apply's only
  expect(pendingResolvers).toHaveLength(1);

  // Release the Apply: it commits `example.com` to `committed` FIRST; the
  // expiry job then acquires the queue, reads the run-time `committed` (now
  // carrying `example.com` + the expired activeTimer) and builds its payload
  // from THAT — not from the pre-Apply snapshot.
  pendingResolvers.shift()!({ ok: true });
  await flushMicrotasks();
  // The expiry job's own writeHosts is the new pending entry — release it.
  expect(pendingResolvers).toHaveLength(1);
  pendingResolvers.shift()!({ ok: true });
  const [applyRes, expireRes] = await Promise.all([applyP, expireP]);

  expect(applyRes).toStrictEqual({ ok: true });
  expect(expireRes).toEqual({ ok: true });
  // Two writeConfig calls (the Apply's, then the expiry's). The expiry's
  // preserves the Apply's just-committed domain and carries activeTimer:null.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  const expiryWritten = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  expect(expiryWritten.domains).toContainEqual({
    hostname: 'example.com',
    alwaysOn: true,
  });
  expect(expiryWritten.activeTimer).toBeNull();
  // The expiry's hosts payload = the ALWAYS-ON lines of the post-Apply
  // committed: `example.com` (the Apply's just-committed alwaysOn domain).
  // A stale pre-Apply snapshot would have produced the seed's `a.com`
  // payload instead — the re-read is the whole point of this test. (The
  // Apply's staged slice REPLACES the domains list, so the seed's `a.com`
  // entry is legitimately gone.)
  const hostsLines = shellNative.writeHosts.mock.calls[1][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(
    new Set(['example.com', 'www.example.com']),
  );
  // The expired session is cleared.
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(end).toBeLessThan(Date.now()); // sanity: the seed was genuinely past
});

test('expireTimer toast lifecycle: set on the outcome, cleared by clearToast (no config/host writes)', async () => {
  seedExpiredSession();
  await useDomainStore.getState().expireTimer();
  expect(useDomainStore.getState().toast).not.toBeNull();

  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  useDomainStore.getState().clearToast();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Story 4.5 — the module-level expiry trigger (store.ts): a useTimerStore
// subscription that fires `expireTimer()` fire-and-forget on the slice's
// expired-parked false->true transition (the self-park driver signal).
// ---------------------------------------------------------------------------

/** Reset the timer slice to a clean non-expired baseline (no driver started). */
function resetTimerSlice(): void {
  useTimerStore.setState({ nowMs: 0, endEpochMs: null, totalMs: null });
}

test('the 4.5 trigger fires expireTimer on the slice expired false->true transition (seeded expired session)', async () => {
  seedExpiredSession();
  resetTimerSlice();
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  const end = useDomainStore.getState().committed.activeTimer!.endEpochMs;
  // Simulate the driver's self-park: the slice lands in the expired-parked
  // state (nowMs AT the end). The subscriber sees false -> true and fires
  // expireTimer.
  useTimerStore.setState({ nowMs: end, endEpochMs: end, totalMs: 60_000 });
  await flushMicrotasks();

  // The trigger ran the whole expiry path: config + hosts + toast.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });

  resetTimerSlice();
});

test('the 4.5 trigger is steady-state safe: a true->true update does NOT re-fire', async () => {
  seedExpiredSession();
  resetTimerSlice();

  const end = useDomainStore.getState().committed.activeTimer!.endEpochMs;
  useTimerStore.setState({ nowMs: end, endEpochMs: end, totalMs: 60_000 });
  await flushMicrotasks();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);

  // A second setState still describing the expired-parked state (true->true)
  // must NOT fire a second expiry.
  useTimerStore.setState({ nowMs: end, endEpochMs: end });
  await flushMicrotasks();

  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);

  resetTimerSlice();
});

test('the 4.5 trigger fires on expired-at-mount: start(expiredEnd) parks immediately and expireTimer runs', async () => {
  seedExpiredSession();
  resetTimerSlice();
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  const end = useDomainStore.getState().committed.activeTimer!.endEpochMs;
  // The Timer/StatusHeader mount path: `start()` with an already-expired end
  // parks the slice IMMEDIATELY (timerStore's park branch) — the same
  // false->true transition the driver's self-park produces.
  useTimerStore.getState().start(end);
  await flushMicrotasks();

  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });

  // The slice's park left no live driver; release the refcount start held.
  useTimerStore.getState().stop();
  resetTimerSlice();
});

test('the 4.5 trigger stays silent while a LIVE session ticks (false->false updates never fire)', async () => {
  seedExpiredSession();
  resetTimerSlice();
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  // A live (future-ended) mirror: the expired flag stays false across ticks.
  const futureEnd = Date.now() + 60_000;
  useTimerStore.setState({ nowMs: Date.now(), endEpochMs: futureEnd, totalMs: 60_000 });
  useTimerStore.setState({ nowMs: Date.now() + 1_000 }); // a tick
  await flushMicrotasks();

  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();

  resetTimerSlice();
});

// ===========================================================================
// Story 4.6 — `endEarly` (the password-gated early escape).
//
// The MIRROR of `expireTimer` with the LOOSER guard: only
// `committed.activeTimer != null` is required — a LIVE session is the
// target, so there is no expiry check. Covers the I/O matrix: success
// (config-then-hosts order, always-on-only payload, N count incl. the
// also-always-on exclusion + the www.-subdomain apex match +
// singular/plural/zero toast), hosts-deny, hosts-throw (lastResult NOW set —
// the 4-5 defer), config-write fail, the no-active-session guard,
// double-fire idempotency, and the queue-behind-Apply re-read.
// ===========================================================================

/**
 * Seed a committed config carrying a LIVE (unexpired) focus session — the
 * expired-session seed's analog with a FUTURE end time (the guard must not
 * care either way; the future end is what makes this genuinely "end early").
 */
function seedLiveSession(opts?: {
  alwaysOn?: Array<string>;
  selected?: Array<string>;
  endEpochMs?: number;
}): number {
  const end = opts?.endEpochMs ?? Date.now() + 10 * 60_000;
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: false },
        ...(opts?.alwaysOn ?? []).map((hostname) => ({ hostname, alwaysOn: true })),
      ],
      activeTimer: {
        endEpochMs: end,
        selectedDomains: opts?.selected ?? ['a.com', 'b.com'],
      },
    },
    applyStatus: 'idle',
  });
  return end;
}

test('endEarly success on a LIVE session: writeConfig (activeTimer:null) BEFORE writeHosts, hosts payload = always-on lines only, committed.activeTimer cleared, N toast', async () => {
  const end = seedLiveSession();

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  // Strict order: writeConfig fires once BEFORE writeHosts.
  const writeConfigOrder = configNative.writeConfig.mock.invocationCallOrder[0];
  const writeHostsOrder = shellNative.writeHosts.mock.invocationCallOrder[0];
  expect(writeConfigOrder).toBeLessThan(writeHostsOrder);
  // writeConfig called exactly once with the full config carrying
  // `activeTimer: null` on top of the committed domains.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([
    { hostname: 'a.com', alwaysOn: true },
    { hostname: 'b.com', alwaysOn: false },
  ]);
  expect(written.activeTimer).toBeNull();
  // writeHosts called exactly once with the ALWAYS-ON lines only — the
  // timer-selected `b.com` (alwaysOn:false) lifts, `a.com` stays (always-on).
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));
  // `committed.activeTimer` is cleared in memory (badge/countdown revert).
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  // applyStatus resets to idle; lastResult carries the envelope.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toEqual({ ok: true });
  // The success toast: N = 1 (b.com lifts; a.com is always-on, not counted) —
  // singular form.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 1 domain unblocked.',
    tone: 'info',
  });
  // `staged` is untouched by end-early — the staging pipeline is a separate
  // concern, and a successful end must not disturb it (the deny test below
  // pins the same invariant).
  expect(useDomainStore.getState().staged).toBeNull();
  // Sanity: the seed was genuinely LIVE (a future end) — this really is an
  // EARLY end, not an expiry.
  expect(end).toBeGreaterThan(Date.now());
});

test('endEarly N count excludes always-on domains (plural) and the toast uses the plural form', async () => {
  // Selected: b.com + c.com (both non-always-on, so both lift -> N = 2);
  // a.com is always-on but NOT selected, so it contributes nothing to N.
  seedLiveSession({ alwaysOn: [], selected: ['b.com', 'c.com'] });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 2 domains unblocked.',
    tone: 'info',
  });
  // Both lifted domains are gone from the hosts payload; a.com stays.
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));
});

test('endEarly with every selected domain also always-on: payload still the always-on lines (unchanged content), N = 0 -> bare "Session ended."', async () => {
  // `b.com` is in the session selection AND alwaysOn. It remains blocked and
  // contributes 0 to N — the whole N count.
  seedLiveSession({ selected: ['b.com'], alwaysOn: ['b.com'] });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  // `alwaysOn` is NOT touched — the domain entry survives untouched.
  expect(written.domains).toContainEqual({ hostname: 'b.com', alwaysOn: true });
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  // Both always-on domains stay blocked after the session lifts.
  expect(distinctApexes).toStrictEqual(
    new Set(['a.com', 'www.a.com', 'b.com', 'www.b.com']),
  );
  // N = 0 -> the bare copy (no "0 domains" grammar).
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended.',
    tone: 'info',
  });
});

test('endEarly N count matches at normaliseDomain level: a selected www.-subdomain vs an always-on apex is still-blocked and not counted', async () => {
  // The selected entry is a SUBDOMAIN of the always-on apex. The
  // `normaliseDomain`-level comparison (the same one `effectiveBlocklist`
  // dedupes by) must count it as still-blocked: N = 0, and the hosts payload
  // keeps twitter.com.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'twitter.com', alwaysOn: true }],
      activeTimer: {
        endEpochMs: Date.now() + 10 * 60_000,
        selectedDomains: ['www.twitter.com'],
      },
    },
    applyStatus: 'idle',
  });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(
    new Set(['twitter.com', 'www.twitter.com']),
  );
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended.',
    tone: 'info',
  });
});

test('endEarly hosts-deny: committed.activeTimer stays INTACT, applyStatus resets to idle, error toast', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });
  const end = seedLiveSession();

  const result = await useDomainStore.getState().endEarly();

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // writeConfig ran (carrying the activeTimer:null write — accepted drift).
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // `committed.activeTimer` INTACT in memory (the over-blocking mirror;
  // retry-safe — retry = a new session, or relaunch via 4.7 re-arm).
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: end,
    selectedDomains: ['a.com', 'b.com'],
  });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().lastResult).toStrictEqual({
    ok: false,
    error: 'admin-denied',
  });
  // The failure toast (error tone) — the shared hosts-failure copy.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: "Couldn't update /etc/hosts. No changes made.",
    tone: 'error',
  });
});

test('endEarly hosts-throw: returns a hosts-throw envelope, keeps activeTimer intact, resets applyStatus, sets lastResult (4-5 defer closed), error toast', async () => {
  // The same shellRunner-namespace spy the expireTimer throw test uses —
  // the native mock's rejection would be converted to an envelope by the
  // port, but the store's DEFENSIVE try/catch must be exercised directly.
  const spy = jest
    .spyOn(shellRunner, 'writeHosts')
    .mockRejectedValue(new Error('osascript exploded'));
  try {
    seedLiveSession();

    const result = await useDomainStore.getState().endEarly();

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('hosts-throw:');
    // applyStatus NOT left running; committed.activeTimer INTACT; toast error.
    expect(useDomainStore.getState().applyStatus).toBe('idle');
    expect(useDomainStore.getState().committed.activeTimer).not.toBeNull();
    expect(useDomainStore.getState().toast).toStrictEqual({
      message: "Couldn't update /etc/hosts. No changes made.",
      tone: 'error',
    });
    // The 4-5 defer closed: lastResult carries the throw envelope, matching
    // what the deny branch already sets.
    expect(useDomainStore.getState().lastResult!.ok).toBe(false);
    expect(String(useDomainStore.getState().lastResult!.error)).toContain(
      'hosts-throw:',
    );
  } finally {
    spy.mockRestore();
  }
});

test('endEarly config-write failure: short-circuits BEFORE elevation — no writeHosts, applyStatus untouched, committed unchanged, NO toast', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  const end = seedLiveSession();

  const result = await useDomainStore.getState().endEarly();

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  // Strict order: a config-write fail short-circuits before the elevation.
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: end,
    selectedDomains: ['a.com', 'b.com'],
  });
  // NO toast on a config-write failure.
  expect(useDomainStore.getState().toast).toBeNull();
});

test('endEarly no-active-session guard: null activeTimer -> no-active-session, zero ports, no toast (idempotent)', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG, applyStatus: 'idle' });

  const r1 = await useDomainStore.getState().endEarly();

  expect(r1).toStrictEqual({ ok: false, error: 'no-active-session' });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().toast).toBeNull();
});

test('endEarly double-fire idempotency: the 2nd call after a successful end no-ops with no-active-session', async () => {
  seedLiveSession();

  const r1 = await useDomainStore.getState().endEarly();
  expect(r1).toEqual({ ok: true });
  const r2 = await useDomainStore.getState().endEarly();

  expect(r2).toStrictEqual({ ok: false, error: 'no-active-session' });
  // Exactly ONE writeConfig + ONE writeHosts across both calls.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The success toast is still the ONE toast (not replaced by a failure).
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 1 domain unblocked.',
    tone: 'info',
  });
});

test('endEarly queued behind an in-flight Apply: re-reads committed at queue time (hosts payload includes the Apply\'s just-committed domain)', async () => {
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
  });
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  // Start an Apply committing `example.com` as alwaysOn.
  useDomainStore.getState().stageDomainAdd('example.com');
  const applyP = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(pendingResolvers).toHaveLength(1); // the Apply's writeHosts

  // While the Apply is in flight, endEarly queues behind it.
  seedLiveSession();
  const endEarlyP = useDomainStore.getState().endEarly();
  await flushMicrotasks();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // Apply's only
  expect(pendingResolvers).toHaveLength(1);

  // Release the Apply: it commits `example.com` to `committed` FIRST; the
  // end-early job then acquires the queue, reads the run-time `committed`
  // (now carrying `example.com` + the live activeTimer) and builds its
  // payload from THAT — not from the pre-Apply snapshot.
  pendingResolvers.shift()!({ ok: true });
  await flushMicrotasks();
  // The end-early job's own writeHosts is the new pending entry — release it.
  expect(pendingResolvers).toHaveLength(1);
  pendingResolvers.shift()!({ ok: true });
  const [applyRes, endEarlyRes] = await Promise.all([applyP, endEarlyP]);

  expect(applyRes).toStrictEqual({ ok: true });
  expect(endEarlyRes).toEqual({ ok: true });
  // Two writeConfig calls (the Apply's, then end-early's). The end-early's
  // preserves the Apply's just-committed domain and carries activeTimer:null.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(2);
  const endEarlyWritten = JSON.parse(configNative.writeConfig.mock.calls[1][0]);
  expect(endEarlyWritten.domains).toContainEqual({
    hostname: 'example.com',
    alwaysOn: true,
  });
  expect(endEarlyWritten.activeTimer).toBeNull();
  // The end-early hosts payload = the ALWAYS-ON lines of the post-Apply
  // committed: `example.com` (the Apply's just-committed alwaysOn domain).
  // A stale pre-Apply snapshot would have produced the seed's `a.com`
  // payload instead — the re-read is the whole point of this test.
  const hostsLines = shellNative.writeHosts.mock.calls[1][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(
    new Set(['example.com', 'www.example.com']),
  );
  // The live session is cleared.
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
});

test('endEarly queue-behind-Expiry re-read is authoritative: an expiry job queued AHEAD clears the session and end-early no-ops with no-active-session', async () => {
  // The session is BOTH live-by-selection and already past its end, so both
  // actions are eligible. The expiry queues first and its writeHosts is held
  // pending; end-early queues BEHIND it. When the expiry settles, the
  // end-early job acquires the queue, re-reads `committed` and must see
  // `activeTimer == null` — no second write, no second toast.
  seedLiveSession({ endEpochMs: Date.now() - 1_000 });
  const pendingResolvers: Array<(v: WriteResult) => void> = [];
  shellNative.writeHosts.mockImplementation(
    () =>
      new Promise<WriteResult>((res) => {
        pendingResolvers.push(res);
      }),
  );

  const expireP = useDomainStore.getState().expireTimer();
  await flushMicrotasks();
  expect(pendingResolvers).toHaveLength(1); // the expiry's writeHosts

  // Queue end-early behind the in-flight expiry.
  const endEarlyP = useDomainStore.getState().endEarly();
  await flushMicrotasks();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1); // expiry's only
  expect(pendingResolvers).toHaveLength(1);

  // Release the expiry; then drain the end-early job (which must no-op
  // WITHOUT reaching writeHosts).
  pendingResolvers.shift()!({ ok: true });
  const [expireRes, endEarlyRes] = await Promise.all([expireP, endEarlyP]);

  expect(expireRes).toEqual({ ok: true });
  expect(endEarlyRes).toStrictEqual({ ok: false, error: 'no-active-session' });
  // Only the expiry's writeConfig + writeHosts ever ran.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The toast is still the expiry's ONE success toast.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });
});

test('endEarly N count dedupes by apex: selected ["b.com", "www.b.com"] lifts ONE domain -> singular toast', async () => {
  // Two raw entries normalising to the same apex count once — the toast must
  // not double-report a single lifted domain.
  seedLiveSession({ selected: ['b.com', 'www.b.com'] });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  // N = 1 (both entries collapse to the b.com apex; a.com is always-on) —
  // singular form, not "2 domains".
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 1 domain unblocked.',
    tone: 'info',
  });
  // The hosts payload is still correct: the whole b.com apex lifted (both
  // entries map to the same apex), only the always-on a.com lines remain.
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));
});

test('endEarly with an EMPTY selectedDomains on a live session: zero branch -> bare "Session ended."', async () => {
  seedLiveSession({ selected: [] });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended.',
    tone: 'info',
  });
  // The hosts payload still rewrites to the always-on lines (a full clear of
  // the timer-selected block — of which there were none).
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));
});

test('endEarly fires on an EXPIRED-but-uncleared session: the guard checks PRESENCE only, not expiry', async () => {
  // The end time is in the past but the expiry trigger has not run yet, so
  // `activeTimer` is still set. The looser guard (vs expireTimer's
  // Date.now/finiteness checks) must let end-early through and clear it.
  seedLiveSession({ endEpochMs: Date.now() - 1_000 });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(JSON.parse(configNative.writeConfig.mock.calls[0][0]).activeTimer).toBeNull();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 1 domain unblocked.',
    tone: 'info',
  });
});

test('endEarly tolerates a malformed (NaN) endEpochMs: a NaN end does NOT block the write', async () => {
  // end-early is not a guard of timer health (that is expireTimer's job) — a
  // corrupted endEpochMs must still let the user end the session.
  seedLiveSession({ endEpochMs: NaN });

  const result = await useDomainStore.getState().endEarly();

  expect(result).toEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. 1 domain unblocked.',
    tone: 'info',
  });
});

// ---------------------------------------------------------------------------
// Story 4.6 — the 4-5 defer closed: the OTHER two hosts-throw catches now set
// `lastResult` too. (`endEarly`'s throw catch is pinned in its own test
// above; these cover `stageStartTimer` (4.2) and re-pin `expireTimer`.)
// ---------------------------------------------------------------------------

test('stageStartTimer hosts-throw: lastResult now carries the throw envelope (4-5 defer closed for the Start path)', async () => {
  const spy = jest
    .spyOn(shellRunner, 'writeHosts')
    .mockRejectedValue(new Error('osascript exploded'));
  try {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'a.com', alwaysOn: true }],
      },
      staged: null,
      applyStatus: 'idle',
    });

    const result = await useDomainStore
      .getState()
      .stageStartTimer({ durationMs: TWENTY_FIVE_MIN_MS, selected: new Set(['a.com']) });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('hosts-throw:');
    // applyStatus NOT left running; committed.activeTimer NOT advanced.
    expect(useDomainStore.getState().applyStatus).toBe('idle');
    expect(useDomainStore.getState().committed.activeTimer).toBeNull();
    // The 4-5 defer: the throw envelope lands in `lastResult`, matching the
    // deny branch.
    expect(useDomainStore.getState().lastResult!.ok).toBe(false);
    expect(String(useDomainStore.getState().lastResult!.error)).toContain(
      'hosts-throw:',
    );
  } finally {
    spy.mockRestore();
  }
});

test('expireTimer hosts-throw also sets lastResult (4-5 defer re-pinned)', async () => {
  const spy = jest
    .spyOn(shellRunner, 'writeHosts')
    .mockRejectedValue(new Error('osascript exploded'));
  try {
    seedExpiredSession();

    await useDomainStore.getState().expireTimer();

    expect(useDomainStore.getState().applyStatus).toBe('idle');
    expect(useDomainStore.getState().lastResult!.ok).toBe(false);
    expect(String(useDomainStore.getState().lastResult!.error)).toContain(
      'hosts-throw:',
    );
  } finally {
    spy.mockRestore();
  }
});

// ===========================================================================
// Story 5.1 — the schedule buffer (`stagedSchedules`) + the widened Apply.
// Mirrors the stageAlwaysOnToggle tests above, applied to the schedule slice:
// toggle (new-ref, clean-revert, not-found), the one-write Apply carrying
// BOTH fields, the per-field mid-run guard, deny retains staged, and
// `cancelStagedSchedules` isolation.
// ===========================================================================

const FOCUS_SCHEDULE: Schedule = {
  id: 'focus',
  name: 'Focus',
  weekdays: [0, 1, 2, 3, 4],
  startTime: '09:00',
  endTime: '17:00',
  enabled: true,
  domains: ['example.com'],
};

const EVENINGS_SCHEDULE: Schedule = {
  id: 'evenings',
  name: 'Evenings',
  weekdays: [5, 6],
  startTime: '20:00',
  endTime: '22:00',
  enabled: false,
  domains: ['example.com'],
};

// ---------------------------------------------------------------------------
// stageScheduleEnabledToggle
// ---------------------------------------------------------------------------

test('stageScheduleEnabledToggle flips enabled on a committed schedule and stages a new draft', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });

  const result = useDomainStore.getState().stageScheduleEnabledToggle('focus');

  expect(result).toStrictEqual({ ok: true });
  // The staged draft carries the flipped enabled value.
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  // Committed is untouched — toggle is a STAGED edit, Apply commits.
  expect(useDomainStore.getState().committed.schedules).toStrictEqual([
    FOCUS_SCHEDULE,
  ]);
});

test('stageScheduleEnabledToggle builds on the staged schedule draft when one exists', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE, EVENINGS_SCHEDULE] },
    stagedSchedules: [
      { ...FOCUS_SCHEDULE, enabled: false }, // already toggled
      EVENINGS_SCHEDULE,
    ],
  });

  const result = useDomainStore
    .getState()
    .stageScheduleEnabledToggle('evenings');

  expect(result).toStrictEqual({ ok: true });
  // The draft now reflects BOTH toggles; committed is still the original.
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    { ...EVENINGS_SCHEDULE, enabled: true },
  ]);
  expect(useDomainStore.getState().committed.schedules).toStrictEqual([
    FOCUS_SCHEDULE,
    EVENINGS_SCHEDULE,
  ]);
});

test('stageScheduleEnabledToggle produces a NEW array reference on each toggle (preserves mid-run-edit detection)', () => {
  // Mirrors the stageAlwaysOnToggle new-ref test: two domains are needed so
  // the draft stays non-null across both toggles (a same-schedule double
  // toggle would clean-revert to null).
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      schedules: [
        FOCUS_SCHEDULE, // enabled: true
        EVENINGS_SCHEDULE, // enabled: false
      ],
    },
    stagedSchedules: null,
  });

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  const ref1 = useDomainStore.getState().stagedSchedules;
  expect(ref1).not.toBeNull();

  useDomainStore.getState().stageScheduleEnabledToggle('evenings');
  const ref2 = useDomainStore.getState().stagedSchedules;
  expect(ref2).not.toBe(ref1); // NEW array reference, not in-place mutation
  expect(ref2).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    { ...EVENINGS_SCHEDULE, enabled: true },
  ]);
});

test('stageScheduleEnabledToggle clean-revert: toggling off then on reverts stagedSchedules to null', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });

  const r1 = useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(r1).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);

  const r2 = useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(r2).toStrictEqual({ ok: true });
  // Net = committed -> the schedule buffer reverts to null. No redundant
  // admin prompt on the next Apply (mirrors stageAlwaysOnToggle's clean-revert).
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// 5-2 review patch: the value key canonicalises a MISSING weekdays/domains
// array to [] (the same as an explicit empty one), so an enable-toggle
// clean-revert works even on a hand-edited or pre-5.2 schedule whose domains
// are empty or absent.
test('stageScheduleEnabledToggle clean-revert on a schedule with committed domains: [] (empty array)', () => {
  const emptyDomainsSchedule: Schedule = { ...FOCUS_SCHEDULE, domains: [] };
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [emptyDomainsSchedule] },
    stagedSchedules: null,
  });

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleEnabledToggle clean-revert on a schedule whose domains field is MISSING entirely', () => {
  const missingDomainsSchedule = {
    ...FOCUS_SCHEDULE,
    domains: undefined,
  } as unknown as Schedule;
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [missingDomainsSchedule] },
    stagedSchedules: null,
  });

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleEnabledToggle clean-revert compares weekday SETS (a reordered list is not a change)', () => {
  // Committed stores weekdays in a non-canonical order; toggling enabled off
  // and on must still clean-revert (weekday order is not part of identity).
  const committedSchedule: Schedule = { ...FOCUS_SCHEDULE, weekdays: [4, 0, 2] };
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [committedSchedule] },
    stagedSchedules: null,
  });

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();

  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleEnabledToggle clean-revert does NOT fire when other schedule edits keep the draft dirty', () => {
  // committed has two schedules. Toggle BOTH (one off, one on) then the first
  // back on — the draft still differs from committed (the second toggle) so
  // the buffer stays.
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE, EVENINGS_SCHEDULE] },
    stagedSchedules: null,
  });

  useDomainStore.getState().stageScheduleEnabledToggle('focus'); // off
  useDomainStore.getState().stageScheduleEnabledToggle('evenings'); // on
  useDomainStore.getState().stageScheduleEnabledToggle('focus'); // back on

  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    FOCUS_SCHEDULE,
    { ...EVENINGS_SCHEDULE, enabled: true },
  ]);
});

test('stageScheduleEnabledToggle on an unknown id returns not-found and leaves the buffer unchanged', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });

  const result = useDomainStore.getState().stageScheduleEnabledToggle('ghost');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleEnabledToggle on an unknown id with a staged draft leaves the draft unchanged', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: [{ ...FOCUS_SCHEDULE, enabled: false }],
  });

  const result = useDomainStore.getState().stageScheduleEnabledToggle('ghost');

  expect(result).toStrictEqual({ ok: false, error: 'not-found' });
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
});

test('a schedule toggle never touches the domain buffer (parallel sibling buffers)', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });
  const stagedBefore = useDomainStore.getState().staged;
  expect(stagedBefore).not.toBeNull();

  useDomainStore.getState().stageScheduleEnabledToggle('focus');

  expect(useDomainStore.getState().staged).toBe(stagedBefore);
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();
});

// ---------------------------------------------------------------------------
// cancelStagedSchedules — isolation from the domain buffer
// ---------------------------------------------------------------------------

test('cancelStagedSchedules clears ONLY the schedule buffer; the staged domain draft is untouched', () => {
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: [{ ...FOCUS_SCHEDULE, enabled: false }],
  });
  const stagedDomains = useDomainStore.getState().staged;
  expect(stagedDomains).not.toBeNull();

  useDomainStore.getState().cancelStagedSchedules();

  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(useDomainStore.getState().staged).toBe(stagedDomains);
});

test('cancelStagedSchedules is a safe no-op when the schedule buffer is already null', () => {
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  useDomainStore.getState().cancelStagedSchedules();
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// ---------------------------------------------------------------------------
// apply() — one writeConfig carries BOTH fields
// ---------------------------------------------------------------------------

test('apply() commits BOTH fields in ONE writeConfig, advances both, and clears both buffers', async () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    staged: null,
    stagedSchedules: null,
  });
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.getState().stageScheduleEnabledToggle('focus');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  // Exactly ONE config write — never two (one admin prompt per Apply).
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // The write carried BOTH staged slices.
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(written.schedules).toStrictEqual([{ ...FOCUS_SCHEDULE, enabled: false }]);
  // committed advanced per field; both buffers cleared.
  const state = useDomainStore.getState();
  expect(state.staged).toBeNull();
  expect(state.stagedSchedules).toBeNull();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.committed.schedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  expect(state.applyStatus).toBe('idle');
  expect(state.lastResult).toStrictEqual({ ok: true });
});

test('apply() with ONLY a schedule draft (staged: null) keeps committed.domains in the write', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      domains: [{ hostname: 'kept.com', alwaysOn: true }],
      schedules: [FOCUS_SCHEDULE],
    },
    staged: null,
    stagedSchedules: null,
  });
  useDomainStore.getState().stageScheduleEnabledToggle('focus');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  // The clean domain slice leaves committed.domains untouched in the write.
  expect(written.domains).toStrictEqual([{ hostname: 'kept.com', alwaysOn: true }]);
  expect(written.schedules).toStrictEqual([{ ...FOCUS_SCHEDULE, enabled: false }]);
  // In-memory committed advanced per field.
  const state = useDomainStore.getState();
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'kept.com', alwaysOn: true },
  ]);
  expect(state.committed.schedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  expect(state.stagedSchedules).toBeNull();
});

test('apply() with ONLY a domain draft preserves NON-EMPTY committed.schedules in the write (VG-1)', async () => {
  // The store-level mirror of apply.test.ts's VG-1 pin: a domains-only
  // Apply must carry non-empty committed.schedules into the written config
  // verbatim — a regression to `schedules: stagedSchedules ?? []` wipes them
  // on disk (surfacing on relaunch) while passing every empty-schedules test.
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      schedules: [FOCUS_SCHEDULE],
    },
    staged: null,
    stagedSchedules: null,
  });
  useDomainStore.getState().stageDomainAdd('example.com');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  // The clean schedule slice leaves the NON-EMPTY committed.schedules
  // untouched — verbatim, not reset to [].
  expect(written.schedules).toStrictEqual([FOCUS_SCHEDULE]);
  const state = useDomainStore.getState();
  expect(state.committed.schedules).toStrictEqual([FOCUS_SCHEDULE]);
});

test('apply() with both buffers clean-reverted to null is a no-op: neither port is called', async () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });
  // Toggle off then on — the clean-revert leaves stagedSchedules null.
  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  useDomainStore.getState().stageScheduleEnabledToggle('focus');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// ---------------------------------------------------------------------------
// apply() — failure retains the schedule draft
// ---------------------------------------------------------------------------

test('apply() admin-denied retains BOTH drafts, leaves committed unchanged, and forwards the envelope', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });
  useDomainStore.getState().stageDomainAdd('example.com');
  useDomainStore.getState().stageScheduleEnabledToggle('focus');
  const committedBefore = useDomainStore.getState().committed;

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  const state = useDomainStore.getState();
  expect(state.staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  expect(state.stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  expect(state.committed).toStrictEqual(committedBefore);
  expect(state.applyStatus).toBe('idle');
  // BH-1 patch: a denied Apply raises the standard failure toast (the frozen
  // matrix's "Deny/throw: staged retained, applyStatus: 'idle', failure
  // toast" row) — the same HOSTS_FAILURE_TOAST copy the timer-end actions
  // raise.
  expect(state.toast).toStrictEqual({
    message: "Couldn't update /etc/hosts. No changes made.",
    tone: 'error',
  });
});

test('apply() config-write failure retains the schedule draft and skips writeHosts', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });
  useDomainStore.getState().stageScheduleEnabledToggle('focus');

  const result = await useDomainStore.getState().apply();

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  // BH-1 patch: a config-write failure also raises the failure toast.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: "Couldn't update /etc/hosts. No changes made.",
    tone: 'error',
  });
});

// ---------------------------------------------------------------------------
// apply() — per-field mid-run guard: a newer draft staged DURING an in-flight
// Apply is retained for its OWN field while the other field commits + clears.
// ---------------------------------------------------------------------------

test('a newer schedule draft staged during an in-flight Apply is retained, not clobbered', async () => {
  // committed has two schedules: focus (enabled) + evenings (disabled).
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      schedules: [FOCUS_SCHEDULE, EVENINGS_SCHEDULE],
    },
    stagedSchedules: null,
  });
  // Stage the first toggle BEFORE the Apply so its snapshot is a real draft.
  useDomainStore.getState().stageScheduleEnabledToggle('focus'); // off

  let resolveFirst: ((v: WriteResult) => void) | null = null;
  shellNative.writeHosts.mockImplementation(
    () => new Promise<WriteResult>((res) => {
      resolveFirst = res;
    }),
  );

  const p = useDomainStore.getState().apply();
  await flushMicrotasks();
  expect(useDomainStore.getState().applyStatus).toBe('running');

  // While the Apply is in flight, toggle the SECOND schedule on top of the
  // draft. This produces a NEW stagedSchedules array reference (a re-toggle of
  // the same schedule would clean-revert to null), distinct from the snapshot
  // the running Apply captured — the success handler must retain it.
  useDomainStore.getState().stageScheduleEnabledToggle('evenings'); // on
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    { ...EVENINGS_SCHEDULE, enabled: true },
  ]);

  // Release the Apply. It commits the SNAPSHOT's intent (focus off, evenings
  // untouched) and must leave the newer draft intact.
  resolveFirst!({ ok: true });
  await p;

  const state = useDomainStore.getState();
  expect(state.committed.schedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    EVENINGS_SCHEDULE,
  ]);
  expect(state.stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    { ...EVENINGS_SCHEDULE, enabled: true },
  ]);
  expect(state.applyStatus).toBe('idle');
});

test('a newer DOMAIN draft staged during an in-flight Apply is retained while the SCHEDULE slice commits + clears', async () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: null,
  });
  useDomainStore.getState().stageScheduleEnabledToggle('focus'); // off

  let resolveFirst: ((v: WriteResult) => void) | null = null;
  shellNative.writeHosts.mockImplementation(
    () => new Promise<WriteResult>((res) => {
      resolveFirst = res;
    }),
  );

  const p = useDomainStore.getState().apply();
  await flushMicrotasks();

  // While the Apply is in flight, stage a domain edit (a NEW staged array
  // reference, distinct from the null the running Apply captured for staged).
  useDomainStore.getState().stageDomainAdd('social.com');

  resolveFirst!({ ok: true });
  await p;

  const state = useDomainStore.getState();
  // The SCHEDULE slice committed + cleared (its snapshot was current).
  expect(state.committed.schedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
  ]);
  expect(state.stagedSchedules).toBeNull();
  // The DOMAIN buffer is retained (the newer draft was NOT part of the run).
  expect(state.staged).toStrictEqual([
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(state.committed.domains).toStrictEqual([]);
});

// ===========================================================================
// Story 5.2 — stageScheduleUpsert (the editor sheet's Save)
//
// Validation + normalisation re-run (the store-side mirror of the editor's
// live gate), upsert semantics (replace same-id in place, else append) on
// `stagedSchedules ?? committed.schedules`, NEW array reference on mutation,
// and the clean-revert (including the DOMAIN-ONLY edit round-trip, which is
// why `scheduleValueKey` must include domains).
// ===========================================================================

// ---------------------------------------------------------------------------
// Validation envelopes
// ---------------------------------------------------------------------------

test('stageScheduleUpsert rejects an empty name without staging', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    name: '   ',
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects 0 weekdays without staging', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    weekdays: [],
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects out-of-range weekdays that leave 0 valid days', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    // A hand-built draft with junk weekday codes: 7 and -1 are dropped, and
    // with nothing valid left the draft is invalid.
    weekdays: [7, -1] as unknown as Schedule['weekdays'],
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test.each([
  '9', // no colon
  '24:00', // hour out of range
  '09:60', // minute out of range
  '', // empty
])('stageScheduleUpsert rejects an unparseable start time %p', (start) => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    startTime: start,
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects an unparseable end time without staging', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    endTime: '9:5:3',
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test.each([
  ['09:00', '09:00'], // equal is invalid (end strictly after start)
  ['17:00', '09:00'], // end before start
])('stageScheduleUpsert rejects end <= start (%p -> %p)', (start, end) => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    startTime: start,
    endTime: end,
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects 0 domains without staging', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    domains: [],
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects domains that all fail normalisation', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    domains: ['not a domain', '0.0.0.0; rm -rf /'],
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert rejects a draft with no usable id without staging', () => {
  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    id: '   ',
  });
  expect(result).toStrictEqual({ ok: false, error: 'invalid-schedule' });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// ---------------------------------------------------------------------------
// Normalisation re-run + upsert behaviour
// ---------------------------------------------------------------------------

test('stageScheduleUpsert APPENDS a new schedule onto the clean committed list (new array reference)', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
  });

  const result = useDomainStore.getState().stageScheduleUpsert({
    id: 'evenings',
    name: '  Evenings  ',
    weekdays: [6, 5], // unsorted; the store sorts + dedupes
    startTime: '9:5', // zero-padded on stage
    endTime: '22:00',
    enabled: false,
    domains: ['NEWS.site', 'news.site', 'https://video.com/watch'], // dupes + scheme
  });

  expect(result).toStrictEqual({ ok: true });
  const state = useDomainStore.getState();
  expect(state.stagedSchedules).toStrictEqual([
    FOCUS_SCHEDULE,
    {
      id: 'evenings',
      name: 'Evenings', // trimmed
      weekdays: [5, 6], // sorted + deduped
      startTime: '09:05', // zero-padded by normaliseTime
      endTime: '22:00',
      enabled: false,
      domains: ['news.site', 'video.com'], // normalised + deduped
    },
  ]);
  // NEW array reference, even though the base was the committed array.
  expect(state.stagedSchedules).not.toBe(state.committed.schedules);
  expect(state.applyStatus).toBe('idle');
});

test('stageScheduleUpsert REPLACES the same-id schedule in place when editing', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE, EVENINGS_SCHEDULE] },
  });

  const result = useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    name: 'Deep focus',
    startTime: '08:00',
    endTime: '12:00',
    domains: ['news.site'],
  });

  expect(result).toStrictEqual({ ok: true });
  const state = useDomainStore.getState();
  expect(state.stagedSchedules).toStrictEqual([
    {
      ...FOCUS_SCHEDULE,
      name: 'Deep focus',
      startTime: '08:00',
      endTime: '12:00',
      domains: ['news.site'],
    },
    EVENINGS_SCHEDULE, // untouched, same position
  ]);
});

test('stageScheduleUpsert builds on the staged draft, not committed, when a draft exists', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
    stagedSchedules: [{ ...FOCUS_SCHEDULE, enabled: false }],
  });

  const result = useDomainStore.getState().stageScheduleUpsert({
    id: 'evenings',
    name: 'Evenings',
    weekdays: [5, 6],
    startTime: '20:00',
    endTime: '22:00',
    enabled: true,
    domains: ['example.com'],
  });

  expect(result).toStrictEqual({ ok: true });
  // The staged toggle is PRESERVED (built on the draft) and the upsert
  // appended after it.
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_SCHEDULE, enabled: false },
    {
      id: 'evenings',
      name: 'Evenings',
      weekdays: [5, 6],
      startTime: '20:00',
      endTime: '22:00',
      enabled: true,
      domains: ['example.com'],
    },
  ]);
});

// ---------------------------------------------------------------------------
// Clean-revert
// ---------------------------------------------------------------------------

test('stageScheduleUpsert clean-reverts to null on a NET-IDENTICAL edit', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
  });

  // Re-stage a toggle first so the buffer is dirty, then Save an upsert that
  // restores the exact committed value (reverting the toggle field).
  useDomainStore.getState().stageScheduleEnabledToggle('focus'); // off
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();

  const result = useDomainStore.getState().stageScheduleUpsert(FOCUS_SCHEDULE);
  expect(result).toStrictEqual({ ok: true });
  // Clean-revert: the draft equals committed (order-agnostic value compare),
  // so the buffer clears — no redundant admin prompt on the next Apply.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('stageScheduleUpsert clean-reverts on a DOMAIN-ONLY edit round-trip (scheduleValueKey includes domains)', () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
  });

  // Domain-only change -> the buffer holds it (and the value key sees it).
  useDomainStore.getState().stageScheduleUpsert({
    ...FOCUS_SCHEDULE,
    domains: ['news.site'],
  });
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();

  // Reverting JUST the domains (every other field unchanged) must also
  // clean-revert — this is the regression the spec's "scheduleValueKey MUST
  // include domains" clause pins: without domains in the key, the second
  // upsert would compare equal and keep a 0-change dirty buffer.
  const result = useDomainStore.getState().stageScheduleUpsert(FOCUS_SCHEDULE);
  expect(result).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// ---------------------------------------------------------------------------
// Mid-run-edit reference discipline
// ---------------------------------------------------------------------------

test('stageScheduleUpsert produces a NEW array reference mid-Apply so the running run retains it', async () => {
  useDomainStore.setState({
    committed: { ...DEFAULT_CONFIG, schedules: [FOCUS_SCHEDULE] },
  });

  // A domain edit gives the Apply something real to run (a clean-everything
  // Apply short-circuits at call time without touching the ports), and its
  // snapshot is what the run carries.
  useDomainStore.getState().stageDomainAdd('social.com');

  let resolveFirst: ((v: WriteResult) => void) | null = null;
  shellNative.writeHosts.mockImplementation(
    () => new Promise<WriteResult>((res) => {
      resolveFirst = res;
    }),
  );

  // The in-flight Apply captures `stagedSchedules: null` (clean schedule
  // buffer at call time).
  const p = useDomainStore.getState().apply();
  await flushMicrotasks();

  // The upsert lands mid-run: a NEW array reference, distinct from the null
  // snapshot, so the success handler retains it rather than clobbering it.
  const result = useDomainStore.getState().stageScheduleUpsert({
    id: 'evenings',
    name: 'Evenings',
    weekdays: [5, 6],
    startTime: '20:00',
    endTime: '22:00',
    enabled: true,
    domains: ['example.com'],
  });
  expect(result).toStrictEqual({ ok: true });

  resolveFirst!({ ok: true });
  await p;

  const state = useDomainStore.getState();
  // The upsert staged BEFORE the run committed, so the run (snapshot null)
  // did not carry it — the buffer is RETAINED for the next Apply. It was
  // appended onto the clean committed list (focus + the new evenings).
  expect(state.stagedSchedules).not.toBeNull();
  expect(state.stagedSchedules).toHaveLength(2);
  expect(state.stagedSchedules![0]).toStrictEqual(FOCUS_SCHEDULE);
  expect(state.stagedSchedules![1].id).toBe('evenings');
  // The DOMAIN slice (the run's own snapshot) committed + cleared normally.
  expect(state.committed.domains).toStrictEqual([
    { hostname: 'social.com', alwaysOn: true },
  ]);
  expect(state.staged).toBeNull();
});

// ---------------------------------------------------------------------------
// Story 5.4 — live schedule transitions: the module-level clock trigger
// (`useClockStore.subscribe` -> `evaluateScheduleTransitions`) and the
// `applyScheduleTransitions` action. The action recomputes
// `effectiveHostsLines(committed, now)` at QUEUE-RUN time with `new Date()`,
// so every test installs fake timers + `setSystemTime` to make that recompute
// deterministic; ticks are driven by `useClockStore.setState({ nowMs })`
// (no interval needed — the trigger fires on any `nowMs` change). Schedules
// are built FROM a local-noon `Date` so the windows are timezone-independent.
// ---------------------------------------------------------------------------

const fiveFourProbe = new Date(1_756_000_000_000);
const dayBase = new Date(
  fiveFourProbe.getFullYear(),
  fiveFourProbe.getMonth(),
  fiveFourProbe.getDate(),
  12,
  0,
  0,
  0,
);

function fiveFourHhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** A schedule window covering `[dayBase, dayBase + minutes)` on dayBase's weekday. */
function makeFiveFourSchedule(
  minutes: number,
  overrides: Partial<Schedule> = {},
): Schedule {
  const end = new Date(dayBase.getTime() + minutes * 60_000);
  return {
    id: 's-5-4',
    name: 'Deep Work',
    weekdays: [((dayBase.getDay() + 6) % 7) as Weekday],
    startTime: fiveFourHhmm(dayBase),
    endTime: fiveFourHhmm(end),
    enabled: true,
    domains: ['x.com'],
    ...overrides,
  };
}

/** Seed a committed config carrying the given schedules and return it. */
function seedFiveFourConfig(schedules: Schedule[]): Config {
  const config: Config = {
    ...DEFAULT_CONFIG,
    domains: [],
    schedules,
    settings: { menuBarEnabled: false },
    activeTimer: null,
  };
  useDomainStore.setState({ committed: config });
  return config;
}

/** Drive the module-level clock trigger with a guaranteed-NEW nowMs value. */
function driveClock(nowMs: number): void {
  const prev = useClockStore.getState().nowMs;
  useClockStore.setState({ nowMs: prev === nowMs ? nowMs + 1 : nowMs });
}

// I/O Matrix: "FIRST evaluation after load sets baseline with ZERO writes".
test('5.4 trigger — the first tick sets the transition baseline and writes nothing', async () => {
  jest.useFakeTimers();
  const config = seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000; // 11:59 local — window not open
  jest.setSystemTime(tBefore);

  driveClock(tBefore);
  await flushMicrotasks();

  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().committed).toBe(config);
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// I/O Matrix: window opens -> exactly ONE hosts-only write + the pinned toast.
test('5.4 trigger — a window opening queues ONE hosts-only write with the started toast', async () => {
  jest.useFakeTimers();
  const config = seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore); // baseline: window closed, zero writes
  await flushMicrotasks();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();

  jest.setSystemTime(tOpen); // the run body recomputes at this wall clock
  driveClock(tOpen); // the boundary tick
  await flushMicrotasks();

  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines = shellNative.writeHosts.mock.calls[0][0] as string[];
  expect(lines).toContain('0.0.0.0 x.com');
  // Hosts-ONLY: config.json is canonical and is never written by a transition.
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  // committed never changes on a transition.
  expect(useDomainStore.getState().committed).toBe(config);
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule "Deep Work" started — domains now blocked.',
    tone: 'info',
  });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// The applyStatus flip: 'running' while the write is in flight, 'idle' after.
test('5.4 action — applyStatus flips running -> idle around the hosts write', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore);
  await flushMicrotasks();

  let resolveWrite!: (r: WriteResult) => void;
  shellNative.writeHosts.mockImplementationOnce(
    () =>
      new Promise<WriteResult>((resolve) => {
        resolveWrite = resolve;
      }),
  );

  jest.setSystemTime(tOpen);
  driveClock(tOpen);
  await flushMicrotasks(3);
  expect(useDomainStore.getState().applyStatus).toBe('running');

  resolveWrite({ ok: true });
  await flushMicrotasks();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// I/O Matrix: window ends -> ONE write removing the lines + the ended toast.
test('5.4 trigger — a window ending writes the shrink and shows the ended toast', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tMid = dayBase.getTime() + 30 * 60_000;
  const tEnd = dayBase.getTime() + 60 * 60_000;
  const tAfter = tEnd + 60_000;
  jest.setSystemTime(tMid);
  driveClock(tMid); // baseline set INSIDE the window
  await flushMicrotasks();
  shellNative.writeHosts.mockClear();

  jest.setSystemTime(tAfter);
  driveClock(tAfter);
  await flushMicrotasks();

  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines = shellNative.writeHosts.mock.calls[0][0] as string[];
  expect(lines).not.toContain('0.0.0.0 x.com');
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule "Deep Work" ended — domains unblocked.',
    tone: 'info',
  });
});

// I/O Matrix: the boundary changes nothing -> skip entirely (no write/prompt/
// toast/applyStatus, baseline unchanged so later ticks still work).
test('5.4 trigger — a still-covered boundary skips without any write or toast', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  // x.com is ALSO always-on: the window opening changes no hosts lines.
  const committedWithAlwaysOn: Config = {
    ...useDomainStore.getState().committed,
    domains: [{ hostname: 'x.com', alwaysOn: true }],
  };
  useDomainStore.setState({ committed: committedWithAlwaysOn });
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore);
  await flushMicrotasks();

  jest.setSystemTime(tOpen);
  driveClock(tOpen);
  await flushMicrotasks();

  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().committed).toBe(committedWithAlwaysOn);
});

// I/O Matrix: two windows flip in one tick -> ONE write + the generic toast.
test('5.4 trigger — two schedule flips in one tick coalesce into ONE write', async () => {
  jest.useFakeTimers();
  // A [12:00, 12:30) on x.com and B [12:30, 13:00) on y.com: at 12:30 A ends
  // and B starts in the same tick — one hosts write, one generic toast.
  const a = makeFiveFourSchedule(30, { id: 'sa', name: 'A', domains: ['x.com'] });
  const bEnd = new Date(dayBase.getTime() + 60 * 60_000);
  const b: Schedule = {
    id: 'sb',
    name: 'B',
    weekdays: [((dayBase.getDay() + 6) % 7) as Weekday],
    startTime: fiveFourHhmm(new Date(dayBase.getTime() + 30 * 60_000)),
    endTime: fiveFourHhmm(bEnd),
    enabled: true,
    domains: ['y.com'],
  };
  seedFiveFourConfig([a, b]);
  const tMid = dayBase.getTime() + 29 * 60_000;
  const tBoundary = dayBase.getTime() + 30 * 60_000;
  jest.setSystemTime(tMid);
  driveClock(tMid); // baseline: x.com only
  await flushMicrotasks();
  shellNative.writeHosts.mockClear();

  jest.setSystemTime(tBoundary);
  driveClock(tBoundary);
  await flushMicrotasks();

  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines = shellNative.writeHosts.mock.calls[0][0] as string[];
  expect(lines).not.toContain('0.0.0.0 x.com');
  expect(lines).toContain('0.0.0.0 y.com');
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule windows changed — blocklist updated.',
    tone: 'info',
  });
});

// One-attempt policy: an admin DENY advances the baseline — the next tick
// must NOT retry (no prompt spam; drift banner owns the failure surface).
test('5.4 — a denied transition write advances the baseline and never retries', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore);
  await flushMicrotasks();

  shellNative.writeHosts.mockResolvedValueOnce({ ok: false, error: 'admin-denied' });
  jest.setSystemTime(tOpen);
  driveClock(tOpen);
  await flushMicrotasks();

  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: "Couldn't update /etc/hosts. No changes made.",
    tone: 'error',
  });

  // The next tick recomputes the SAME lines as the (advanced) baseline -> skip.
  jest.setSystemTime(tOpen + 30_000);
  driveClock(tOpen + 30_000);
  await flushMicrotasks();

  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1); // no retry
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// One-attempt policy, throw path: the write THROWS -> envelope result, the
// failure toast, applyStatus back to idle, baseline advanced (no retry).
test('5.4 — a thrown hosts write advances the baseline, toasts, and never retries', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore);
  await flushMicrotasks();

  const spy = jest
    .spyOn(shellRunner, 'writeHosts')
    .mockRejectedValue(new Error('osascript exploded'));
  try {
    jest.setSystemTime(tOpen);
    driveClock(tOpen);
    await flushMicrotasks();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useDomainStore.getState().lastResult).toStrictEqual({
      ok: false,
      error: 'hosts-throw:Error: osascript exploded',
    });
    expect(useDomainStore.getState().toast).toStrictEqual({
      message: "Couldn't update /etc/hosts. No changes made.",
      tone: 'error',
    });
    expect(useDomainStore.getState().applyStatus).toBe('idle');

    // The next tick recomputes the SAME lines as the (advanced) baseline —
    // no retry. (Asserted while the spy is still installed; the spy
    // intercepts the store's shellRunner call, so the count lives on the spy.)
    jest.setSystemTime(tOpen + 30_000);
    driveClock(tOpen + 30_000);
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1); // no retry
  } finally {
    spy.mockRestore();
  }
});

// Design rule: a committed-changing path already wrote hosts, so a stale
// baseline refreshes SILENTLY — the next tick writes nothing.
test('5.4 — a committed change refreshes the baseline silently (no write)', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tMid = dayBase.getTime() + 30 * 60_000;
  const tLater = dayBase.getTime() + 45 * 60_000;
  jest.setSystemTime(tMid);
  driveClock(tMid); // baseline set with config #1 (inside the window)
  await flushMicrotasks();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();

  // A committed-changing path (here: an Apply-equivalent setState with a NEW
  // config object carrying the same effective lines).
  seedFiveFourConfig([makeFiveFourSchedule(60, { id: 's-2', name: 'Renamed' })]);
  const config2 = useDomainStore.getState().committed;

  jest.setSystemTime(tLater);
  driveClock(tLater);
  await flushMicrotasks();

  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().committed).toBe(config2);
});

// Action contract: skip-if-equal — a direct call whose queue-time recompute
// equals the baseline returns no-transition and touches nothing.
test('5.4 action — skip-if-equal returns no-transition with zero side effects', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tOpen);
  driveClock(tOpen); // baseline = the open-window lines
  await flushMicrotasks();
  shellNative.writeHosts.mockClear();
  useDomainStore.setState({ toast: null });

  const result = await useDomainStore
    .getState()
    .applyScheduleTransitions({ started: ['Deep Work'], ended: [] });

  expect(result).toStrictEqual({ ok: false, error: 'no-transition' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// Action contract: a direct call with a real transition does the hosts-only
// write itself — one write, the pinned toast, committed unchanged.
test('5.4 action — a direct call writes hosts-only and toasts the started copy', async () => {
  jest.useFakeTimers();
  const config = seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tBefore);
  driveClock(tBefore); // baseline: window closed, lines without x.com
  await flushMicrotasks();

  // The action recomputes lines at QUEUE-RUN time with `new Date()` — move
  // the wall clock into the window so the recompute sees the open window.
  jest.setSystemTime(tOpen);
  const result = await useDomainStore
    .getState()
    .applyScheduleTransitions({ started: ['Deep Work'], ended: [] });

  expect(result).toStrictEqual({ ok: true });
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines = shellNative.writeHosts.mock.calls[0][0] as string[];
  expect(lines).toContain('0.0.0.0 x.com');
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().committed).toBe(config);
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule "Deep Work" started — domains now blocked.',
    tone: 'info',
  });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// --- Story 5.4 step-04 review patches (P1/P2/P3) ---

// P1: the ACTION-side queue-race branch — a committed change landing BETWEEN
// the detection tick and the action's queue-run (the exact shape of a
// committed-changing path settling while a transition write sits queued).
// Every sibling test keeps `committed` reference-identical across that gap;
// this one does not.
test('5.4 action — a committed change before the queue-run refreshes the baseline silently (no-transition)', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  jest.setSystemTime(tBefore);
  driveClock(tBefore); // detection tick sets the baseline with config #1
  await flushMicrotasks();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();

  // An Apply-equivalent committed change: a NEW config object (as an Apply
  // would leave behind), landing BEFORE the action's queue-run.
  seedFiveFourConfig([makeFiveFourSchedule(60, { id: 's-2', name: 'Renamed' })]);
  const config2 = useDomainStore.getState().committed;

  const result = await useDomainStore
    .getState()
    .applyScheduleTransitions({ started: [], ended: [] });

  // Stale committedRef -> silent refresh, NO write, NO prompt, NO toast.
  expect(result).toStrictEqual({ ok: false, error: 'no-transition' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(useDomainStore.getState().committed).toBe(config2);

  // The baseline was refreshed (not left stale): a follow-up direct call
  // whose queue-time recompute equals the refreshed baseline no-ops too.
  const again = await useDomainStore
    .getState()
    .applyScheduleTransitions({ started: [], ended: [] });
  expect(again).toStrictEqual({ ok: false, error: 'no-transition' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

// P2: a backwards clock (NTP correction) must not drive a spurious write
// from the inverted measurement window — with an unchanged payload it is a
// plain steady tick (window reset, no write, no toast).
test('5.4 — a backwards clock tick with an unchanged payload writes nothing', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tMid = dayBase.getTime() + 30 * 60_000; // inside the window
  jest.setSystemTime(tMid);
  driveClock(tMid); // baseline: window open, x.com lines
  await flushMicrotasks();
  shellNative.writeHosts.mockClear();
  useDomainStore.setState({ toast: null });

  // Jump the clock BACK, still inside the open window (payload unchanged).
  // With the backwards guard the measurement window resets and the tick goes
  // through the normal steady path — the same no-op a forward steady tick
  // is: no write, no prompt, no toast, no spurious flip names.
  jest.setSystemTime(dayBase.getTime() + 1 * 60_000);
  driveClock(dayBase.getTime() + 1 * 60_000);
  await flushMicrotasks();

  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// P3: a throw inside the clock-trigger's evaluation must never escape into
// the clock driver's interval tick (an uncaught exception per second with
// the transition loop silently dead) — and the next good tick recovers.
test('5.4 — a throwing evaluation is contained by the trigger and the next good tick recovers', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tOpen = dayBase.getTime();
  jest.setSystemTime(tOpen);
  driveClock(tOpen); // baseline set with the window open
  await flushMicrotasks();
  shellNative.writeHosts.mockClear();

  // The simplest honest construction: spy the evaluator module so the
  // trigger's own recompute throws (the same module-namespace spy the
  // hosts-throw tests use for `shellRunner.writeHosts`).
  const spy = jest
    .spyOn(effectiveBlocklistModule, 'effectiveHostsLines')
    .mockImplementation(() => {
      throw new Error('eval exploded');
    });
  try {
    expect(() => {
      jest.setSystemTime(dayBase.getTime() + 61 * 60_000);
      driveClock(dayBase.getTime() + 61 * 60_000); // past the window end
    }).not.toThrow();
    await flushMicrotasks();
    // No write fired from the broken tick.
    expect(shellNative.writeHosts).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }

  // The next GOOD tick recovers: the window has ended, the payload diff is
  // real -> ONE hosts-only write. The flip lists are empty (the boundary
  // crossed during the BROKEN tick, whose window was reset by the catch), so
  // the toast degrades to the generic copy — exactly the documented
  // multi-second-jump degradation.
  jest.setSystemTime(dayBase.getTime() + 62 * 60_000);
  driveClock(dayBase.getTime() + 62 * 60_000);
  await flushMicrotasks();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines = shellNative.writeHosts.mock.calls[0][0] as string[];
  expect(lines).not.toContain('0.0.0.0 x.com');
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule windows changed — blocklist updated.',
    tone: 'info',
  });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// P5 (step-04): a direct caller handing over a malformed change object must
// not turn a SUCCESSFUL hosts write into a hosts-throw envelope — the change
// is normalised before toast selection, so the write succeeds with the
// generic copy.
test('5.4 action — a malformed change object still writes successfully with the generic toast', async () => {
  jest.useFakeTimers();
  seedFiveFourConfig([makeFiveFourSchedule(60)]);
  const tBefore = dayBase.getTime() - 60_000;
  jest.setSystemTime(tBefore);
  driveClock(tBefore); // baseline: window closed, lines without x.com
  await flushMicrotasks();

  // Queue-run with the wall clock inside the window: the lines differ from
  // the baseline, so the write proceeds — and the malformed change (null
  // started, missing ended) must survive toast selection.
  jest.setSystemTime(dayBase.getTime());
  const result = await useDomainStore
    .getState()
    .applyScheduleTransitions({
      started: null,
      ended: undefined,
    } as unknown as Parameters<
      ReturnType<typeof useDomainStore.getState>['applyScheduleTransitions']
    >[0]);

  expect(result).toStrictEqual({ ok: true });
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts.mock.calls[0][0]).toContain('0.0.0.0 x.com');
  // The generic copy (no well-formed flip names to speak), NOT a failure
  // toast and NOT a hosts-throw envelope from a post-write throw.
  expect(useDomainStore.getState().toast).toStrictEqual({
    message: 'Schedule windows changed — blocklist updated.',
    tone: 'info',
  });
  expect(useDomainStore.getState().lastResult).toStrictEqual({ ok: true });
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});
