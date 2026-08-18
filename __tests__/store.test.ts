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
import { stagedChangeCount } from '../src/domain/stagedChangeCount';
import { DEFAULT_CONFIG } from '../src/config/types';
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
    applyStatus: 'idle',
    lastResult: null,
    drift: null,
    lastReadSection: null,
    gateOpen: false,
    gateAction: null,
    gateAttempts: 0,
    gateThrottleUntil: null,
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
