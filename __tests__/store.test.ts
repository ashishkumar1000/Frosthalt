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
  },
}));

import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { WriteResult } from '../src/hosts/shellRunner';

type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
type NativeShellMock = { writeHosts: jest.Mock };
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
  // store STATE needs resetting.
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    applyStatus: 'idle',
    lastResult: null,
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