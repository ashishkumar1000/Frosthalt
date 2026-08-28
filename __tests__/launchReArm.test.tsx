/**
 * @format
 *
 * Story 4.7 — closed-mid-session persistence + re-arm on launch.
 *
 * The launch-path suite the epic's AC explicitly demands: a re-arm test from
 * a PERSISTED config. Every other suite seeds `activeTimer` via
 * `useDomainStore.setState`, so a store-creation regression (e.g. dropping
 * `readConfig()` from the `create(...)` body) would pass the whole suite.
 * Here the state is seeded ONLY through the disk seam:
 * `configNative.readConfig` returns a persisted `config.json`, and the REAL
 * launch chain is exercised end to end —
 *
 *   `jest.isolateModules` fresh store require (module eval ->
 *   `committed: readConfig()`) -> StatusHeader real mount (the always-mounted
 *   header is the launch trigger: its `useLayoutEffect` calls the slice's
 *   `start(...)`) -> timer slice start -> the 4.5 module-level expiry
 *   trigger.
 *
 * Coverage (spec I/O matrix):
 *   1. Resume — a persisted FUTURE session re-arms the countdown from disk;
 *      badge Blocked; ZERO `writeConfig`/`writeHosts`/`readHostsSection`
 *      calls at launch (the anti-cheat invariant: nothing removes blocks
 *      while the app is closed; no launch-time drift check exists) and a
 *      null toast (no "Session resumed" announce — Ask-first forbids one).
 *   2. Expired — the real mount chain parks the slice -> the 4.5 trigger ->
 *      config write (`activeTimer: null`) BEFORE the hosts write
 *      (`invocationCallOrder`), always-on-only hosts payload,
 *      `committed.activeTimer` cleared, badge reverts to Free.
 *   3. Also-always-on — the expiry hosts payload KEEPS the always-on line and
 *      drops the timer-only domains.
 *   4. Equality boundary — a persisted `endEpochMs` EXACTLY equal to
 *      `Date.now()` at launch takes the EXPIRED branch: `sliceExpiredParked`
 *      and the slice's park both use `>=`, so the boundary moment is expiry,
 *      not resume (the off-by-one pin).
 *   5. Malformed `endEpochMs` — fail-safe for BOTH malformed variants:
 *      a hand-edited STRING and a persisted null (a NaN serialises to null
 *      through the real `JSON.stringify` disk seam, so null is the
 *      JSON-realistic variant): no crash, the header normalises to null,
 *      the slice never starts, no port write, and Start remains available
 *      on the Timer surface.
 *   6. Denied-expiry relaunch — disk says `activeTimer: null` while hosts
 *      still block: NO re-arm is possible, `expireTimer()` no-ops with
 *      `not-expired`, zero writes. The user's escape is the hosts-viewer
 *      drift banner + Restore (`HostsViewer.tsx` mount -> `checkDrift`).
 *      This is the CORRECTED behaviour: spec-4-5's matrix wording
 *      "Retry = relaunch (4.7 re-arm)" is stale — a relaunch after a denied
 *      expiry cannot re-arm, because 4.5's config-first order already cleared
 *      `activeTimer` on disk. Recorded in this spec's Change Log, not by
 *      editing 4-5's frozen spec block.
 *
 * ---- The jest.isolateModules test seam ----
 *
 * No other suite uses `jest.isolateModules`. The fresh store require happens
 * INSIDE `isolateModules(() => {...})` TOGETHER with StatusHeader/Timer (the
 * outer module instance is bound to the outer store, so importing them at
 * file top would defeat the disk-seeded launch). Two registry facts the
 * helper relies on:
 *
 *   - Mocked modules (the native specs) resolve to the SAME mock instance in
 *     the isolated registry as outside (jest's explicit-mock registry is
 *     shared), so seeding/asserting through the handles captured INSIDE the
 *     callback is correct in either world — shared or re-factored per
 *     registry.
 *   - `react` is NOT isolated: a fresh registry would re-evaluate react,
 *     producing a second React copy whose hooks crash under the outer
 *     renderer ("Invalid hook call"). `jest.mock('react', () =>
 *     jest.requireActual('react'))` pins EVERY require of react — outer and
 *     isolated — to the single shared instance, so components required
 *     inside the isolate render with the outer react-test-renderer.
 *
 * Fake timers are installed BEFORE the launch so module eval, the store's
 * `readConfig()` and every `Date.now()` down the chain see the same fixed
 * wall clock (the same T the 4.3/4.4 suites use).
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

// Keep ONE React instance across the isolated registry (see the seam note in
// the file header). A second copy makes every hook call in the isolated
// components fail with "Invalid hook call".
jest.mock('react', () => jest.requireActual('react'));

// ApplyButton uses Animated.createAnimatedComponent(Pressable), which cannot
// re-render under react-test-renderer with this react/RN version pairing —
// the same pre-existing mismatch Timer.test.tsx works around. Only the
// malformed-end test mounts the Timer surface (for the "Start remains
// available" assertion), and it needs the Start button's contract props only.
jest.mock('../src/components/ApplyButton', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const ApplyButton = (props: {
    label: string;
    onPress: () => void;
    onPressIn?: () => void;
    onPressOut?: () => void;
    disabled?: boolean;
    busy?: boolean;
    pulse?: boolean;
  }) =>
    React.createElement(
      Pressable,
      {
        onPress: props.onPress,
        onPressIn: props.onPressIn,
        onPressOut: props.onPressOut,
        disabled: props.disabled,
        accessibilityRole: 'button',
        accessibilityLabel: props.label,
        accessibilityState: { disabled: !!props.disabled, busy: !!props.busy },
      },
      React.createElement(Text, null, props.label),
    );
  return { __esModule: true, ApplyButton };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { useDomainStore } from '../src/domain/store';
import type { useTimerStore } from '../src/domain/timerStore';
import type { Config, Domain } from '../src/config/types';

type DomainStoreApi = typeof useDomainStore;
type TimerStoreApi = typeof useTimerStore;

type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
type NativeShellMock = { writeHosts: jest.Mock; readHostsSection: jest.Mock };

/**
 * Everything one launch produces. All handles are captured INSIDE the
 * `isolateModules` callback so seeding and assertions bind to exactly the
 * module instances the launch chain used.
 */
interface LaunchHandles {
  configNative: NativeConfigMock;
  shellNative: NativeShellMock;
  useDomainStore: DomainStoreApi;
  useTimerStore: TimerStoreApi;
  StatusHeader: React.ComponentType<{ onViewHosts: () => void }>;
  Timer: React.ComponentType<{ onOpenBlocklist: () => void }>;
}

/** Fixed wall-clock epoch for the deterministic tests (Timer.test's T). */
const T = 1_756_000_000_000;

/** The always-on-only / expired-session hosts payload for one apex. */
function hostsLines(apex: string): string[] {
  return [
    `0.0.0.0 ${apex}`,
    `:: ${apex}`,
    `0.0.0.0 www.${apex}`,
    `:: www.${apex}`,
  ];
}

/**
 * Builds the persisted `config.json` body the (mocked) native `readConfig`
 * returns. Shape-checked by `readConfig`'s TOP-LEVEL validation only —
 * `activeTimer` element shape is deliberately unchecked (the 4-3 defer), so
 * a malformed `activeTimer` can ride through here exactly as a hand-edited
 * config would at real launch.
 */
function persistedConfig(overrides: {
  domains: Domain[];
  activeTimer: Config['activeTimer'];
}): Config {
  return {
    domains: overrides.domains,
    schedules: [],
    settings: { menuBarEnabled: false },
    activeTimer: overrides.activeTimer,
  };
}

let currentRenderer: ReactTestRenderer.ReactTestRenderer | null = null;
let currentLaunch: LaunchHandles | null = null;

/**
 * The launch: `readConfig` is seeded to return `persisted` (the DISK seam —
 * the only seeding that counts as a re-arm test), then a FRESH store +
 * StatusHeader + Timer are required inside `jest.isolateModules`. The store's
 * `committed: readConfig()` (store.ts:448, module eval, exactly once) runs
 * during the `require`, which is the whole point.
 */
function launchFromDisk(persisted: Config): LaunchHandles {
  let handles!: LaunchHandles;
  jest.isolateModules(() => {
    const configNative = (
      require('../src/native/specs/NativeConfigStoreSpec') as unknown as {
        default: NativeConfigMock;
      }
    ).default;
    const shellNative = (
      require('../src/native/specs/NativeShellRunnerSpec') as unknown as {
        default: NativeShellMock;
      }
    ).default;

    configNative.readConfig.mockReset();
    configNative.writeConfig.mockReset();
    shellNative.writeHosts.mockReset();
    shellNative.readHostsSection.mockReset();
    // Disk: the persisted config.json. Writes/hosts default to success.
    configNative.readConfig.mockReturnValue({
      ok: true,
      data: JSON.stringify(persisted),
    });
    configNative.writeConfig.mockReturnValue({ ok: true });
    shellNative.writeHosts.mockResolvedValue({ ok: true });
    shellNative.readHostsSection.mockResolvedValue({ ok: true, data: '' });

    // The REAL launch chain, in require order: store (module eval reads the
    // seeded config) -> the slice + header + surface that consume it. The
    // module-level 4.5 expiry trigger registers itself on THIS fresh store's
    // slice during the same require.
    const useDomainStore = (
      require('../src/domain/store') as unknown as {
        useDomainStore: DomainStoreApi;
      }
    ).useDomainStore;
    const useTimerStore = (
      require('../src/domain/timerStore') as unknown as {
        useTimerStore: TimerStoreApi;
      }
    ).useTimerStore;
    const StatusHeader = (
      require('../src/components/StatusHeader') as unknown as {
        StatusHeader: LaunchHandles['StatusHeader'];
      }
    ).StatusHeader;
    const Timer = (
      require('../src/components/Timer') as unknown as {
        Timer: LaunchHandles['Timer'];
      }
    ).Timer;

    handles = { configNative, shellNative, useDomainStore, useTimerStore, StatusHeader, Timer };
  });
  return handles;
}

/** Mounts the always-mounted StatusHeader (plus, optionally, the Timer surface). */
function mountLaunch(
  launch: LaunchHandles,
  withTimer = false,
): ReactTestRenderer.ReactTestRenderer {
  let testRenderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    const children: React.ReactNode[] = [
      React.createElement(launch.StatusHeader, {
        key: 'header',
        onViewHosts: jest.fn(),
      }),
    ];
    if (withTimer) {
      children.push(
        React.createElement(launch.Timer, {
          key: 'timer',
          onOpenBlocklist: jest.fn(),
        }),
      );
    }
    testRenderer = ReactTestRenderer.create(React.createElement(React.Fragment, null, children));
  });
  currentRenderer = testRenderer;
  currentLaunch = launch;
  return testRenderer;
}

/** Flush a few microtask rounds so the enqueued expiry run fully settles. */
async function drainQueue(rounds = 12): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  });
}

/** Walks a react-test-renderer JSON tree concatenating text nodes. */
function extractText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'children' in node) {
    return extractText((node as { children: unknown }).children);
  }
  return '';
}

/** Locates the countdown numeral by its accessibility label prefix. */
function findNumeral(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Time remaining'),
  )[0];
}

/** Locate a button by its accessibility label (the Start-button finder). */
function findButton(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label,
  )[0];
}

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
  if (currentLaunch) {
    // Force the isolated slice's refcount back to 0 and reset its state so
    // no per-second driver (or stale `endEpochMs`) leaks between tests.
    // Extra stops are no-ops.
    currentLaunch.useTimerStore.getState().stop();
    currentLaunch.useTimerStore.getState().stop();
    currentLaunch.useTimerStore.setState({
      nowMs: 0,
      endEpochMs: null,
      totalMs: null,
    });
    currentLaunch = null;
  }
  if (jest.isMockFunction(setTimeout)) {
    jest.useRealTimers();
  }
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Launch — resume: a persisted FUTURE session re-arms from disk, anti-cheat
// ---------------------------------------------------------------------------

test('launch resume: a persisted FUTURE session re-arms the countdown from disk with ZERO port writes (anti-cheat)', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const end = T + 5 * 60_000;

  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: false }],
      activeTimer: { endEpochMs: end, selectedDomains: ['a.com'] },
    }),
  );
  const testRenderer = mountLaunch(launch);

  // `committed` came from DISK (module-eval `readConfig()`), not from
  // setState — this is the seam no other suite exercises.
  const committed = launch.useDomainStore.getState().committed;
  expect(committed.activeTimer).toStrictEqual({
    endEpochMs: end,
    selectedDomains: ['a.com'],
  });

  // The header's real mount started the slice: the live Blocked form with
  // the wall-clock-accurate remaining time.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Blocked');
  expect(text).toContain('05:00');
  expect(text).toContain('1 domain');
  expect(text).not.toContain('no active timer');
  expect(findNumeral(testRenderer.root)).toBeDefined();

  // The slice re-armed from the persisted end: mirrored end + the remaining
  // duration as the ring total (ring starts full — the documented 4.7 defer).
  expect(launch.useTimerStore.getState().endEpochMs).toBe(end);
  expect(launch.useTimerStore.getState().totalMs).toBe(5 * 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);

  // The countdown TICKS.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('04:59');

  // Drain the queue so any stray launch-time write would have surfaced.
  await drainQueue();

  // ANTI-CHEAT structural pin: with a persisted FUTURE session, launch
  // performs ZERO `writeConfig` / `writeHosts` calls before any user action —
  // nothing removes blocks while the app is closed, and re-arming is pure
  // in-memory mirroring.
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();
  // And zero `readHostsSection` calls: no launch-time drift check exists —
  // the drift comparison runs only on the hosts viewer's mount (HostsViewer),
  // never at launch (the Code Map's "no launch-time drift check" fact,
  // pinned structurally).
  expect(launch.shellNative.readHostsSection).not.toHaveBeenCalled();

  // No launch-time toast on the resume branch: a "Session resumed" announce
  // is Ask-first territory (re-arm is a silent in-memory re-mirror).
  expect(launch.useDomainStore.getState().toast).toBeNull();
});

// ---------------------------------------------------------------------------
// Launch — expired: the real mount chain runs the full 4.5 shape
// ---------------------------------------------------------------------------

test('launch expired: the real mount chain fires the 4.5 shape — config write (activeTimer: null) BEFORE the hosts write, committed cleared, badge reverts', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);

  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: false }],
      activeTimer: { endEpochMs: T - 1000, selectedDomains: ['a.com'] },
    }),
  );
  const testRenderer = mountLaunch(launch);

  // The launch window (documented, not fixed): before the expiry run settles
  // the persisted expired session reads `Blocked · 00:00` with hosts still
  // blocking — acceptable under the no-enforcement-while-closed posture.
  const preText = extractText(testRenderer.toJSON());
  expect(preText).toContain('Blocked');
  expect(extractText(findNumeral(testRenderer.root)!.props.children)).toBe(
    '00:00',
  );

  await drainQueue();

  // Config FIRST: `activeTimer: null` persisted.
  expect(launch.configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(launch.configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();

  // Hosts SECOND, always-on only: this persisted session selected a
  // timer-only domain (nothing always-on), so the whole set lifts and the
  // payload is EMPTY — still exactly one hosts write (the same Apply path,
  // not a removal shortcut).
  expect(launch.shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(launch.shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([]);

  // The strict config-then-hosts order, asserted structurally.
  expect(launch.configNative.writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
    launch.shellNative.writeHosts.mock.invocationCallOrder[0],
  );

  // `committed.activeTimer` cleared + the success toast.
  expect(launch.useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(launch.useDomainStore.getState().toast).toStrictEqual({
    message: 'Session ended. Domains unblocked.',
    tone: 'info',
  });

  // The badge reverts to the Epic-2 Free form through the SAME mounted tree.
  const postText = extractText(testRenderer.toJSON());
  expect(postText).toContain('Free');
  expect(postText).toContain('no active timer');
  expect(postText).not.toContain('Blocked');
  expect(findNumeral(testRenderer.root)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Launch — expired with an also-always-on domain in the session
// ---------------------------------------------------------------------------

test('launch expired with an also-always-on domain: the hosts payload keeps the always-on line and drops the timer-only domain', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);

  const launch = launchFromDisk(
    persistedConfig({
      domains: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'b.com', alwaysOn: false },
      ],
      activeTimer: {
        endEpochMs: T - 1000,
        selectedDomains: ['a.com', 'b.com'],
      },
    }),
  );
  mountLaunch(launch);
  await drainQueue();

  // The 4.5 shape ran once; the payload keeps ONLY the also-always-on apex
  // (union precedence by construction — no removal code path) and drops the
  // timer-only domain entirely.
  expect(launch.configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(launch.shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const lines: string[] = launch.shellNative.writeHosts.mock.calls[0][0];
  expect(lines).toStrictEqual(hostsLines('a.com'));
  expect(lines.join('\n')).not.toContain('b.com');
});

// ---------------------------------------------------------------------------
// Launch — equality boundary: endEpochMs EXACTLY Date.now() expires
// ---------------------------------------------------------------------------

test('launch at the exact boundary: a persisted endEpochMs equal to Date.now() takes the EXPIRED branch (the >= off-by-one pin)', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);

  // `endEpochMs` exactly equals the wall clock at launch. `sliceExpiredParked`
  // (store.ts) and the slice's park both compare `nowMs >= endEpochMs`, and
  // the slice's `start()` parks when `endEpochMs <= Date.now()` — so the
  // boundary moment is EXPIRY, never resume. The resume test pins strictly-
  // future and the expired test pins strictly-past; this pins the `=`.
  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: false }],
      activeTimer: { endEpochMs: T, selectedDomains: ['a.com'] },
    }),
  );
  mountLaunch(launch);
  await drainQueue();

  // The expired branch ran exactly once: config FIRST with `activeTimer:
  // null`, then the hosts write.
  expect(launch.configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(launch.configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(launch.shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(launch.configNative.writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
    launch.shellNative.writeHosts.mock.invocationCallOrder[0],
  );

  // The timer-only selection lifts entirely (nothing always-on) — the same
  // empty payload the strictly-past test documents.
  expect(launch.shellNative.writeHosts.mock.calls[0][0]).toStrictEqual([]);

  // `committed.activeTimer` cleared and the badge reverts to Free.
  expect(launch.useDomainStore.getState().committed.activeTimer).toBeNull();
  const postText = extractText(currentRenderer!.toJSON());
  expect(postText).toContain('Free');
  expect(postText).toContain('no active timer');
  expect(postText).not.toContain('Blocked');
});

// ---------------------------------------------------------------------------
// Launch — malformed endEpochMs (hand-edited config): fail-safe
// ---------------------------------------------------------------------------

test('launch with a malformed (string) endEpochMs: fail-safe — no crash, no slice start, no write, Start still available', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

  // `readConfig` validates the TOP level only, so a hand-edited
  // `activeTimer.endEpochMs` ("tomorrow") lands in `committed` verbatim —
  // the runtime hole the header's normalisation must gate out.
  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: true }],
      activeTimer: {
        endEpochMs: 'tomorrow',
        selectedDomains: ['a.com'],
      } as unknown as Config['activeTimer'],
    }),
  );
  const testRenderer = mountLaunch(launch, true);

  // No crash + the no-session form: normalisation returned null, so the
  // header never enters the live branch.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(findNumeral(testRenderer.root)).toBeUndefined();

  // The slice never started: no driver, no mirror, no park.
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(launch.useTimerStore.getState().endEpochMs).toBeNull();

  await drainQueue();

  // No port write: a malformed session never re-arms, never unblocks.
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();

  // Start remains available on the Timer surface (Free path rendered,
  // `canStart` true with a preset + pre-checked domains + idle queue).
  const start = findButton(testRenderer.root, 'Start');
  expect(start).toBeDefined();
  expect(start!.props.accessibilityState.disabled).toBe(false);

  // The 4.5 trigger's finite guard holds even if expiry were forced: a
  // non-finite end can never count as expired (the stuck session stays
  // blocked — fail-safe direction).
  const result = await launch.useDomainStore.getState().expireTimer();
  expect(result).toStrictEqual({ ok: false, error: 'not-expired' });
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Launch — malformed endEpochMs, persisted-null variant: fail-safe
// ---------------------------------------------------------------------------

test('launch with a persisted null endEpochMs (the NaN-via-JSON variant): fail-safe — no crash, no slice start, no write, Free form', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

  // The JSON-realistic malformed variant: `JSON.stringify({ endEpochMs: NaN })`
  // writes `endEpochMs: null` (NaN serialises to null), so a hand-edited or
  // NaN-touched `config.json` lands a NULL end at the header through the real
  // disk seam — not the string the sibling test pins. Same fail-safe shape.
  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: true }],
      activeTimer: {
        endEpochMs: null,
        selectedDomains: ['a.com'],
      } as unknown as Config['activeTimer'],
    }),
  );
  const testRenderer = mountLaunch(launch);

  // No crash + the no-session form: the nullish normalisation gates it out.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(findNumeral(testRenderer.root)).toBeUndefined();

  // The slice never started: no driver, no mirror, no park.
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(launch.useTimerStore.getState().endEpochMs).toBeNull();

  await drainQueue();

  // No port write in either direction: the stuck session is left exactly as
  // it was on disk (fail-safe direction — still blocked, never auto-lifted).
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();
  expect(launch.shellNative.readHostsSection).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Launch after a denied expiry: no re-arm is possible
// ---------------------------------------------------------------------------

test('launch after a denied expiry: disk says activeTimer null — no re-arm, expireTimer no-ops with not-expired, zero writes', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);

  // The disk state after an admin-denied expiry (4.5's config-first order):
  // `activeTimer` already null while `/etc/hosts` still blocks the session
  // domains. The persisted session CANNOT re-arm from this state.
  const launch = launchFromDisk(
    persistedConfig({
      domains: [{ hostname: 'a.com', alwaysOn: false }],
      activeTimer: null,
    }),
  );
  const testRenderer = mountLaunch(launch);

  // Free badge — nothing to re-arm; the slice mirrors nothing.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(launch.useTimerStore.getState().endEpochMs).toBeNull();

  // Zero port writes at launch: no re-arm machinery exists (by design —
  // there is one expiry path, and the disk no longer describes a session).
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();

  // Forcing `expireTimer` no-ops through the queue-time guard.
  const result = await launch.useDomainStore.getState().expireTimer();
  expect(result).toStrictEqual({ ok: false, error: 'not-expired' });
  expect(launch.configNative.writeConfig).not.toHaveBeenCalled();
  expect(launch.shellNative.writeHosts).not.toHaveBeenCalled();
  expect(launch.useDomainStore.getState().toast).toBeNull();

  // Corrected behaviour (this spec's Change Log): the escape is the
  // hosts-viewer drift banner + Restore (`HostsViewer.tsx` mount ->
  // `checkDrift` — the ONLY drift surface; no launch-time drift check
  // exists), or Panic. Spec-4-5's matrix wording "Retry = relaunch
  // (4.7 re-arm)" is stale — recorded here, not by editing that frozen
  // spec block.
  expect(extractText(testRenderer.toJSON())).toContain('Free');
});