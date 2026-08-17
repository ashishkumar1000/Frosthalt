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
import { DEFAULT_CONFIG } from '../src/config/types';
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
  // store STATE needs resetting. `drift` is reset to null (unchecked).
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
    lastResult: null,
    drift: null,
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
});

test('checkDrift reports in-sync for empty committed + absent section', () => {
  shellNative.readHostsSection.mockReturnValue({ ok: true, section: null });

  const result = useDomainStore.getState().checkDrift();

  expect(result).toStrictEqual({ drift: false, reason: 'in-sync' });
  expect(useDomainStore.getState().drift).toStrictEqual({
    drift: false,
    reason: 'in-sync',
  });
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