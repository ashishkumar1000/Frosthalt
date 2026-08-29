/**
 * @format
 *
 * Story 4.4 — the status header countdown tests.
 *
 * Renders `<StatusHeader onViewHosts={...}/>` with `react-test-renderer`
 * against the REAL stores (the `useDomainStore` domain store + the scoped
 * `useTimerStore` slice), with the two NATIVE specs mocked so
 * `readConfig()` at module-eval time falls back to DEFAULT_CONFIG — the
 * Timer.test.tsx conventions exactly (real stores, per-file native mocks,
 * fake timers where a tick is asserted). Covers the full 4.4 I/O matrix:
 *
 *   - No session: the Epic-2 form verbatim (`Free` badge · `N domains` ·
 *     "no active timer" · View hosts) and the slice NOT started by the
 *     header (no `setInterval`, `endEpochMs` stays null).
 *   - Live session: `Blocked` badge · count · tabular `mm:ss` · the 16×16
 *     ring (`tokens.status.blocked` track + `tokens.primary` arc), and the
 *     numeral decrements after one fake tick.
 *   - Malformed end time (`endEpochMs` NaN / string): the NO-SESSION form —
 *     the normalisation gates it out before any slice call.
 *   - Expired at mount: `Blocked` badge + `00:00` + empty ring, and the
 *     slice parks immediately (no tick loop).
 *   - Session cleared: the Epic-2 form returns and the header's `stop()`
 *     releases its refcount (driver cleared at refcount 0).
 *   - Co-subscriber: the Timer surface (Blocked) + the header both mounted
 *     share ONE driver (refcount 2); unmounting the Timer keeps the header
 *     counting — the 4.3 "interval stays alive across surface navigation"
 *     AC becomes real.
 *   - A11y: the numeral carries `accessibilityLabel="Time remaining mm:ss"`
 *     — the label EMBEDS the live value (an accessibilityLabel REPLACES the
 *     text content, so a static label would never speak the time) — and the
 *     header emits NO announce on ticks or minute rollovers (the Timer
 *     surface owns those, UX-DR17).
 *
 * Story 5.4 additions: the header now also OWNS the scoped clock slice
 * (`useClockStore`) — an unconditional `start()` on mount / `stop()` on
 * cleanup — and the badge/count are driven by the clock mirror:
 *
 *   - Mount starts the CLOCK driver too (one extra `setInterval` on top of
 *     the timer slice's): the interval-count assertions below pin 2 during a
 *     live session (timer + clock) and 1 with no session (clock only).
 *   - The badge ramps across a schedule boundary while the app runs: driving
 *     `useClockStore`'s `nowMs` through a window boundary flips the badge
 *     Free -> Blocking(amber) -> Blocked with NO `committed` change and no
 *     Apply — and the module-level transition trigger fires exactly ONE
 *     hosts-only write (config.json never touched) for the same boundary.
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

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import { StatusHeader } from '../src/components/StatusHeader';
import { Timer } from '../src/components/Timer';
import { useDomainStore } from '../src/domain/store';
import { useClockStore } from '../src/domain/clockStore';
import { useTimerStore, selectRemainingMs } from '../src/domain/timerStore';
import { tokens } from '../src/theme/tokens';
import { DEFAULT_CONFIG } from '../src/config/types';
import type {
  ActiveTimer,
  Config,
  Domain,
  Schedule,
  Weekday,
} from '../src/config/types';

const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

/** Fixed wall-clock epoch for the deterministic tests (Timer.test's T). */
const T = 1_756_000_000_000;

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

/**
 * Locates the countdown numeral by its accessibility label. The label EMBEDS
 * the live value (`"Time remaining mm:ss"` — Story 4.4 review), so the finder
 * matches the prefix, never an exact-equality against the old static label.
 */
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

/** Locates the CountdownRing instances by their `progress` prop. */
function findRings(root: ReactTestRenderer.ReactTestInstance) {
  return root.findAll((node) => node.props && 'progress' in node.props);
}

/** Locates the StatusBadge by its `Status: ...` accessibility label. */
function findBadge(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Status:'),
  )[0];
}

/** Locates the "View hosts" link by its contract props. */
function findViewHosts(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'View hosts',
  )[0];
}

/**
 * Seeds the domain store for a test. Mirrors Timer.test's `seedState` (real
 * stores; the native specs are mocked so no config/host write ever runs).
 */
function seedState(overrides: {
  domains?: Domain[];
  activeTimer?: ActiveTimer | null;
}): void {
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    const committed: Config = {
      ...DEFAULT_CONFIG,
      domains: overrides.domains ?? DEFAULT_CONFIG.domains,
      activeTimer:
        overrides.activeTimer !== undefined
          ? overrides.activeTimer
          : DEFAULT_CONFIG.activeTimer,
    };
    useDomainStore.setState({
      committed,
      staged: null,
      applyStatus: 'idle',
      lastResult: null,
      drift: null,
    });
  });
}

let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
  jest.restoreAllMocks();
  // Force the scoped timer slice's refcount back to 0 and reset its state so
  // a live test can never leak a per-second driver (or a stale `endEpochMs`)
  // into another test. Extra stops are no-ops.
  useTimerStore.getState().stop();
  useTimerStore.getState().stop();
  useTimerStore.setState({ nowMs: 0, endEpochMs: null, totalMs: null });
  // Reset the domain store to the empty baseline so no committed seed leaks.
  // (This runs BEFORE the clock reset below: the store's module-level 5.4
  // transition trigger reads `committed` on every clock-slice change, so the
  // baseline must refresh against the clean config first.)
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG },
      staged: null,
      // Story 5.4 — a boundary drive in one test can leave a transition
      // toast behind; reset it so no toast leaks into the next test.
      toast: null,
    });
  });
  // Story 5.4 — the same defensive reset for the scoped CLOCK slice: the
  // header's mount holds one refcount slot, so unmount + spare stops force
  // the module-level refcount back to 0 before the state reset. Against the
  // clean DEFAULT_CONFIG committed these evaluations can never write.
  useClockStore.getState().stop();
  useClockStore.getState().stop();
  useClockStore.setState({ nowMs: 0 });
  if (jest.isMockFunction(setTimeout)) {
    jest.useRealTimers();
  }
});

function renderHeader(
  onViewHosts: () => void = jest.fn(),
): ReturnType<typeof ReactTestRenderer.create> {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <StatusHeader onViewHosts={onViewHosts} />,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// ---------------------------------------------------------------------------
// I/O Matrix: no session — the Epic-2 form verbatim, slice NOT started
// ---------------------------------------------------------------------------

test('no active session renders the Epic-2 form and does NOT start the slice', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const onViewHosts = jest.fn();

  const testRenderer = renderHeader(onViewHosts);
  const text = extractText(testRenderer.toJSON());

  // The Epic-2 form: Free badge · 0 domains · "no active timer" · View hosts.
  expect(text).toContain('Free');
  expect(text).toContain('0 domains');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(text).not.toContain('00:00');
  expect(findViewHosts(testRenderer.root)).toBeDefined();
  expect(findNumeral(testRenderer.root)).toBeUndefined();
  expect(findRings(testRenderer.root)).toHaveLength(0);

  // The TIMER slice is NOT started by the header: no mirrored session. (Since
  // Story 5.4 the header's unconditional CLOCK driver IS installed at mount —
  // exactly one interval on top of the timer slice's zero.)
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(useTimerStore.getState().endEpochMs).toBeNull();
  expect(selectRemainingMs(useTimerStore.getState())).toBe(0);
  expect(onViewHosts).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// I/O Matrix: live session — Blocked badge + mm:ss + ring, decrements per tick
// ---------------------------------------------------------------------------

test('a live session renders Blocked, the mm:ss countdown and the 16x16 ring; one fake tick decrements', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  const text = extractText(testRenderer.toJSON());

  // The live form: Blocked badge · count · countdown · View hosts; the
  // static placeholder is gone.
  expect(text).toContain('Blocked');
  expect(text).not.toContain('Free');
  expect(text).toContain('1 domain');
  expect(text).not.toContain('no active timer');
  expect(extractText(findNumeral(testRenderer.root)!.props.children)).toBe(
    '05:00',
  );

  // The slice IS started by the header and mirrors the session end. Two
  // intervals total since Story 5.4: the timer slice's driver + the header's
  // unconditional clock driver.
  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  expect(useTimerStore.getState().endEpochMs).toBe(T + 5 * 60_000);

  // The 16x16 mini ring with the UX-DR5 colours: `status-blocked` track +
  // `primary` remaining arc (the same pair as the Timer surface ring).
  const rings = findRings(testRenderer.root);
  expect(rings.length).toBeGreaterThanOrEqual(1);
  const ring = rings[0];
  expect(ring.props.size).toBe(16);
  expect(ring.props.strokeWidth).toBe(1.5);
  expect(ring.props.trackColor).toBe(tokens.status.blocked);
  expect(ring.props.remainingColor).toBe(tokens.primary);
  expect(ring.props.progress).toBe(0);

  // One tick -> the numeral decrements AND the ring arc shrinks.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('04:59');
  expect(findRings(testRenderer.root)[0].props.progress).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// I/O Matrix: malformed end time — the normalisation gates it out
// ---------------------------------------------------------------------------

test('a malformed (NaN) endEpochMs renders the no-session form and never reaches the slice', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    // Malformed config shape: readConfig validates top-level only, so a
    // non-numeric endEpochMs can land here. Cast mirrors the runtime hole.
    activeTimer: {
      endEpochMs: Number.NaN,
      selectedDomains: ['a.com'],
    } as unknown as ActiveTimer,
  });

  const testRenderer = renderHeader();
  const text = extractText(testRenderer.toJSON());

  // The no-session form — never a NaN numeral, never a Blocked badge.
  expect(text).toContain('Free');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(text).not.toContain('NaN');
  expect(findNumeral(testRenderer.root)).toBeUndefined();

  // The slice never receives the malformed value: no timer driver, no mirror
  // (the clock driver's single mount interval is separate — Story 5.4).
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(useTimerStore.getState().endEpochMs).toBeNull();
});

test('a malformed (string) endEpochMs renders the no-session form too', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: 'tomorrow' as unknown as number,
      selectedDomains: ['a.com'],
    } as unknown as ActiveTimer,
  });

  const testRenderer = renderHeader();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('no active timer');
  expect(text).not.toContain('Blocked');
  expect(findNumeral(testRenderer.root)).toBeUndefined();
  expect(useTimerStore.getState().endEpochMs).toBeNull();
});

// ---------------------------------------------------------------------------
// I/O Matrix: expired at mount — Blocked + 00:00 + empty ring, no tick loop
// ---------------------------------------------------------------------------

test('an expired-at-mount session renders Blocked + 00:00 with an empty ring, parks the slice (no tick loop), and fires the 4.5 expiry trigger through the real mount path', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  // Story 4.5 — seed BOTH ports to succeed so the module-level expiry
  // trigger (park -> expireTimer) can run its full config-then-hosts path
  // through the header's real start() -> immediate-park hop.
  // NOTE: this file declares `require` locally as `(id: string) => unknown`
  // (the RN tsconfig ships no @types/node), so cast the require RESULT, then
  // take `.default` — the same mocks Shell.test.tsx seeds for its e2e.
  const configNative = (
    require('../src/native/specs/NativeConfigStoreSpec') as {
      default: { writeConfig: jest.Mock };
    }
  ).default;
  const shellNative = (
    require('../src/native/specs/NativeShellRunnerSpec') as {
      default: { writeHosts: jest.Mock };
    }
  ).default;
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T - 1000, // expired 1s before mount
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  const text = extractText(testRenderer.toJSON());

  // Blocked badge + 00:00 (expiry handling is 4.5's job — the header holds).
  expect(text).toContain('Blocked');
  expect(text).not.toContain('no active timer');
  expect(extractText(findNumeral(testRenderer.root)!.props.children)).toBe(
    '00:00',
  );
  // The ring renders but is EMPTY (progress 0 — the conditional-arc guard
  // draws no arc at all).
  const ring = findRings(testRenderer.root)[0];
  expect(ring).toBeDefined();
  expect(ring.props.progress).toBe(0);

  // The slice parked immediately: no TIMER tick loop was installed (the
  // clock driver's one mount interval is the only one — Story 5.4), and time
  // passage changes the timer nothing.
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(5000);
  expect(selectRemainingMs(useTimerStore.getState())).toBe(0);
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('00:00');

  // Story 4.5 — the park fires the store's module-level expiry trigger
  // through the header's REAL start() mount path (the hop 4.7's re-arm
  // builds on). Drain the microtask chain so the enqueued expireTimer run
  // settles, then assert it ran: config written with `activeTimer: null`,
  // `committed.activeTimer` cleared, and the header reverted to the Epic-2
  // Free form (numeral gone).
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  const postText = extractText(testRenderer.toJSON());
  expect(postText).toContain('no active timer');
  expect(postText).not.toContain('Blocked');
  expect(findNumeral(testRenderer.root)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// I/O Matrix: session cleared — the Epic-2 form returns, refcount released
// ---------------------------------------------------------------------------

test('clearing activeTimer reverts the header to the Epic-2 form and releases the refcount', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  expect(extractText(testRenderer.toJSON())).toContain('05:00');
  expect(useTimerStore.getState().endEpochMs).toBe(T + 5 * 60_000);

  // The privileged expiry/end paths (4.5 / 4.6) clear `activeTimer`; the
  // header must revert and its stop() must release its refcount slot (the
  // last one -> the driver clears).
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        activeTimer: null,
      },
    });
  });

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('no active timer');
  expect(text).not.toContain('05:00');
  expect(findNumeral(testRenderer.root)).toBeUndefined();
  expect(findRings(testRenderer.root)).toHaveLength(0);
  // Refcount hit 0 -> the driver cleared.
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Co-subscriber: Timer (Blocked) + header share ONE driver; unmounting the
// Timer keeps the header counting (the 4.3 cross-navigation AC)
// ---------------------------------------------------------------------------

test('the Timer surface and the header co-subscribe to ONE driver; unmounting the Timer keeps the header counting', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  // Two separate renderers: the Timer surface (Blocked path) + the header —
  // exactly the co-subscriber configuration of the app with the Timer
  // surface open mid-session.
  let timerRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  let headerRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    timerRenderer = ReactTestRenderer.create(
      <Timer onOpenBlocklist={jest.fn()} />,
    );
  });
  ReactTestRenderer.act(() => {
    headerRenderer = ReactTestRenderer.create(
      <StatusHeader onViewHosts={jest.fn()} />,
    );
  });

  // Refcount 2, ONE timer driver: two timer starts -> two timer setInterval
  // calls (the second cleared the first before re-installing — at most one
  // timer interval alive, ever). Story 5.4 adds the header's clock driver:
  // a third setInterval call, with nothing to clear (the clock slice's first
  // start finds no existing driver).
  expect(setIntervalSpy).toHaveBeenCalledTimes(3);
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  expect(useTimerStore.getState().endEpochMs).toBe(T + 5 * 60_000);
  expect(
    extractText(findNumeral(headerRenderer.root)!.props.children),
  ).toBe('05:00');

  // The user navigates Timer -> Blocklist: the Timer surface unmounts. The
  // header's refcount slot (refcount 2 -> 1) keeps the driver ALIVE.
  ReactTestRenderer.act(() => {
    timerRenderer.unmount();
  });
  // `advanceTimersByTime` also advances the fake wall clock, so the driver's
  // tick reads Date.now() = T + 1000 -> remaining 4:59.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  // The header's numeral kept counting (04:59) — the 4.3 "interval stays
  // alive across surface navigation" AC is now real.
  expect(
    extractText(findNumeral(headerRenderer.root)!.props.children),
  ).toBe('04:59');

  // Cleanup bookkeeping: only the header's stop() remains (its unmount in
  // afterEach releases the last slot).
  currentRenderer = headerRenderer;
});

// ---------------------------------------------------------------------------
// A11y: the numeral's label; no per-tick / per-minute announce from the header
// ---------------------------------------------------------------------------

test('the countdown numeral carries accessibilityLabel "Time remaining mm:ss"', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  const numeral = findNumeral(testRenderer.root);
  expect(numeral).toBeDefined();
  // The label EMBEDS the live value (an accessibilityLabel REPLACES the text
  // content, so a static label would never speak the time): "Time remaining"
  // AND the rendered mm:ss, in one string.
  const label = numeral!.props.accessibilityLabel as string;
  expect(label).toContain('Time remaining');
  expect(label).toContain('05:00');
  expect(label).toBe('Time remaining 05:00');
  // No accessibilityLiveRegion — Android-only, a no-op on macOS (4.3), and
  // the header announces nothing per-minute.
  expect(numeral!.props.accessibilityLiveRegion).toBeUndefined();
});

test('the header emits NO announce on countdown ticks or minute rollovers', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  // The mount does not announce (the first-run guard skips it; the count
  // never changed) and the slice start is silent.
  announceForAccessibility.mockClear();

  // Cross TWO minute boundaries — the Timer surface would announce each one;
  // the header must stay silent (the passive-readout design note).
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(60_000);
  });
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });

  expect(announceForAccessibility).not.toHaveBeenCalled();
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('03:59');
});

// ---------------------------------------------------------------------------
// Always clause: the numeral keeps tabular figures; the View hosts link and
// the on-change count announce behaviour stay intact
// ---------------------------------------------------------------------------

test('the countdown numeral uses tabular figures (fontVariant tabular-nums)', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  const numeral = findNumeral(testRenderer.root)!;
  const style = Array.isArray(numeral.props.style)
    ? numeral.props.style
    : [numeral.props.style];
  const variants: string[] = [];
  for (const entry of style) {
    if (entry != null && Array.isArray((entry as { fontVariant?: unknown }).fontVariant)) {
      variants.push(...((entry as { fontVariant: string[] }).fontVariant));
    }
  }
  expect(variants).toContain('tabular-nums');
});

test('the "View hosts" link still opens the viewer (onViewHosts fires) while a session is live', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const onViewHosts = jest.fn();
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader(onViewHosts);
  const link = findViewHosts(testRenderer.root);
  expect(link).toBeDefined();
  ReactTestRenderer.act(() => {
    link!.props.onPress();
  });
  expect(onViewHosts).toHaveBeenCalledTimes(1);
});

test('the on-change count announce still fires when committed changes (preserved Epic-2 behaviour)', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
  });
  const testRenderer = renderHeader();
  // Mount announce skipped by the first-run guard; clear so the on-change
  // announce is isolated.
  announceForAccessibility.mockClear();

  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
        ],
      },
    });
  });

  expect(extractText(testRenderer.toJSON())).toContain('2 domains');
  expect(announceForAccessibility).toHaveBeenCalledWith('2 domains blocked');
});

test('a live-session header does NOT announce the count when a tick fires (count unchanged)', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: T + 5 * 60_000,
      selectedDomains: ['a.com'],
    },
  });
  const testRenderer = renderHeader();
  announceForAccessibility.mockClear();

  // Ticks re-render the header but never change `count` -> no announce.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(3000);
  });
  expect(announceForAccessibility).not.toHaveBeenCalled();
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('04:57');
});

// ---------------------------------------------------------------------------
// I/O Matrix: live -> expiry WHILE mounted — the driver self-parks, the
// header holds Blocked + 00:00 (Story 4.5 owns the badge flip)
// ---------------------------------------------------------------------------

test('a session expiring while the header is mounted parks the driver: numeral holds 00:00, badge stays Blocked', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const end = T + 3000;
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: true }],
    activeTimer: {
      endEpochMs: end,
      selectedDomains: ['a.com'],
    },
  });

  const testRenderer = renderHeader();
  // Live at mount: 3 seconds on the clock, one driver installed.
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('00:03');
  expect(extractText(testRenderer.toJSON())).toContain('Blocked');
  expect(useTimerStore.getState().endEpochMs).toBe(end);
  const intervalsBeforePark = setIntervalSpy.mock.calls.length;
  // The timer driver + the header's clock driver (Story 5.4).
  expect(intervalsBeforePark).toBe(2);

  // Advance to (and just past) the end: the driver's tick observes
  // nowMs >= endEpochMs and SELF-PARKS, pinning nowMs AT the end so the
  // remaining reads exactly 0 — never negative.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(3000);
  });

  // The numeral holds 00:00 and the badge still reads Blocked: the header
  // does NOT flip to Free on expiry (Story 4.5 owns clearing activeTimer —
  // the spec's Never clause; the expired-at-mount form holds).
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('00:00');
  expect(extractText(testRenderer.toJSON())).toContain('Blocked');
  expect(extractText(testRenderer.toJSON())).not.toContain('no active timer');
  // The parked mirror keeps the session end — the header's slice slot was
  // never released by the park, only by an unmount / a cleared activeTimer.
  expect(useTimerStore.getState().endEpochMs).toBe(end);
  expect(selectRemainingMs(useTimerStore.getState())).toBe(0);

  // After the park the driver is GONE: more time passage changes nothing and
  // installs no new interval (no tick loop, no restart storm).
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(60_000);
  });
  expect(
    extractText(findNumeral(testRenderer.root)!.props.children),
  ).toBe('00:00');
  expect(setIntervalSpy.mock.calls.length).toBe(intervalsBeforePark);
  expect(useTimerStore.getState().nowMs).toBe(end);
});

// ---------------------------------------------------------------------------
// Source-subscriber guard (review step-04): the scoped slice must stay
// SCOPED — walking src/ and asserting the exact subscriber allowlist keeps
// the epic-4-context "exactly three consumers" boundary honest.
// ---------------------------------------------------------------------------

// The RN tsconfig ships no @types/node, so declare the minimal Node surface
// this guard needs and pull the modules in with CommonJS `require` (jest's
// node env provides both, and `__dirname`, at runtime).
declare const __dirname: string;
declare const require: (id: string) => unknown;
type NodeFs = {
  readdirSync(
    dir: string,
    opts: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean }>;
  readFileSync(file: string, encoding: string): string;
};
type NodePath = {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  sep: string;
};

test('only the header, the Timer surface, the slice itself and the 4.5 expiry trigger in store.ts reference useTimerStore in src/', () => {
  const fs = require('fs') as NodeFs;
  const path = require('path') as NodePath;
  // Walk src/ recursively, collecting every .ts/.tsx file that mentions
  // `useTimerStore`. Normalise path separators so the assertion is OS-safe.
  const srcDir = path.join(__dirname, '..', 'src');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        if (fs.readFileSync(full, 'utf8').includes('useTimerStore')) {
          found.push(
            path
              .relative(path.join(__dirname, '..'), full)
              .split(path.sep)
              .join('/'),
          );
        }
      }
    }
  };
  walk(srcDir);

  // The exact allowlist: the status header (4.4), the Timer surface (4.3),
  // the slice's own definition — and, since Story 4.5, the domain store,
  // whose module-level expiry trigger subscribes to the slice's expired-park
  // transition (`store.ts`'s `useTimerStore.subscribe` — a ONE-WAY
  // store -> timerStore import, no cycle). The store subscription reads the
  // slice's STATE TRANSITION, never `nowMs` per tick, so the tick's re-render
  // blast radius is unchanged; the allowlist entry is a conscious widening
  // (the spec's Design Notes: "Why the trigger lives in store.ts (not a
  // component)"). Story 6.2's menu bar will JOIN this allowlist when it
  // subscribes — updating the list should be a conscious act, not a silent
  // widening of the tick's blast radius.
  expect(found.sort()).toEqual([
    'src/components/StatusHeader.tsx',
    'src/components/Timer.tsx',
    'src/domain/store.ts',
    'src/domain/timerStore.ts',
  ]);
});
// ---------------------------------------------------------------------------
// Story 5.4 — the badge ramp + the live count across a schedule boundary,
// driven by the scoped clock slice (no `committed` change, no Apply).
// ---------------------------------------------------------------------------

// A schedule window covering [noon54, noon54 + minutes) on noon54's weekday —
// derived from the LOCAL clock so the tests are timezone-independent.
const probe54 = new Date(T);
const noon54 = new Date(
  probe54.getFullYear(),
  probe54.getMonth(),
  probe54.getDate(),
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

function makeFiveFourSchedule(minutes: number): Schedule {
  const end = new Date(noon54.getTime() + minutes * 60_000);
  return {
    id: 's-header-5-4',
    name: 'Deep Work',
    weekdays: [((noon54.getDay() + 6) % 7) as Weekday],
    startTime: fiveFourHhmm(noon54),
    endTime: fiveFourHhmm(end),
    enabled: true,
    domains: ['x.com'],
  };
}

function seedFiveFourCommitted(schedules: Schedule[]): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG, domains: [], schedules, activeTimer: null },
      staged: null,
      applyStatus: 'idle',
      lastResult: null,
      drift: null,
    });
  });
}

test('a schedule window opening live flips the badge Free -> Blocked, bumps the count, and fires ONE hosts-only write', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(noon54.getTime() - 60_000); // 11:59 — window closed
  const configNative = (
    require('../src/native/specs/NativeConfigStoreSpec') as {
      default: { writeConfig: jest.Mock };
    }
  ).default;
  const shellNative = (
    require('../src/native/specs/NativeShellRunnerSpec') as {
      default: { writeHosts: jest.Mock };
    }
  ).default;
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();
  seedFiveFourCommitted([makeFiveFourSchedule(60)]);

  const testRenderer = renderHeader();
  // Before the boundary: the Epic-2 Free form, 0 domains.
  expect(findBadge(testRenderer.root)!.props.accessibilityLabel).toBe(
    'Status: Free',
  );
  expect(extractText(testRenderer.toJSON())).toContain('0 domains');

  // Drive the clock slice straight through the boundary (12:00): no
  // `committed` change, no Apply — only the clock mirror moves.
  // The inline drain loop is the per-file twin of store.test.ts's
  // `flushMicrotasks(rounds)` helper — jest collects every __tests__ file as
  // a suite, so the helper cannot be shared across files.
  await ReactTestRenderer.act(async () => {
    jest.setSystemTime(noon54.getTime());
    useClockStore.setState({ nowMs: noon54.getTime() });
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });

  // The badge flipped live (the count's memo deps include nowMs) and the
  // count followed the window with no Apply in between.
  expect(findBadge(testRenderer.root)!.props.accessibilityLabel).toBe(
    'Status: Blocked',
  );
  expect(extractText(testRenderer.toJSON())).toContain('1 domain');
  expect(extractText(testRenderer.toJSON())).not.toContain('0 domains');
  // The same boundary tick fired the store's transition trigger: exactly ONE
  // hosts write, and config.json is NEVER touched by a transition.
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts.mock.calls[0][0]).toContain('0.0.0.0 x.com');
  expect(configNative.writeConfig).not.toHaveBeenCalled();
});

test('ending-soon (amber) renders with NO write when the window is already reflected in /etc/hosts', async () => {
  jest.useFakeTimers();
  // Mount INSIDE the window (12:30): the header's first clock evaluation sets
  // the transition baseline with the window already open — ZERO writes.
  jest.setSystemTime(noon54.getTime() + 30 * 60_000);
  const configNative = (
    require('../src/native/specs/NativeConfigStoreSpec') as {
      default: { writeConfig: jest.Mock };
    }
  ).default;
  const shellNative = (
    require('../src/native/specs/NativeShellRunnerSpec') as {
      default: { writeHosts: jest.Mock };
    }
  ).default;
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();
  seedFiveFourCommitted([makeFiveFourSchedule(60)]);

  const testRenderer = renderHeader();
  expect(extractText(testRenderer.toJSON())).toContain('Blocked');

  // Zero-port-write at mount: the first clock evaluation only sets the
  // baseline (the spec's FIRST-evaluation rule) — nothing is written.
  // (Inline drain loop — the per-file twin of store.test.ts's
  // `flushMicrotasks(rounds)`; see the boundary test above.)
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(configNative.writeConfig).not.toHaveBeenCalled();

  // 12:55 — five minutes to the end, inside SCHEDULE_ENDING_SOON_MS, and the
  // boundary would shrink the blocklist (x.com lifts at 13:00): amber.
  await ReactTestRenderer.act(async () => {
    jest.setSystemTime(noon54.getTime() + 55 * 60_000);
    useClockStore.setState({ nowMs: noon54.getTime() + 55 * 60_000 });
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });
  expect(findBadge(testRenderer.root)!.props.accessibilityLabel).toBe(
    'Status: Blocking',
  );
  expect(extractText(testRenderer.toJSON())).toContain('1 domain');
  // No transition: the lines are unchanged from the baseline, so the trigger
  // skipped entirely — no write, no prompt, no toast.
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
  expect(useDomainStore.getState().toast).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

// ---------------------------------------------------------------------------
// P11 (step-04) — the clock lifecycle's explicit unmount-refcount test: the
// timer slice has one; the clock lifecycle's cleanup deserves the same pin.
// ---------------------------------------------------------------------------

test('unmounting the header releases its clock-driver slot: the driver clears, a spare stop is a true no-op', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  seedState({});

  const testRenderer = renderHeader();
  // No session: the clock driver is the ONLY interval the mount installed.
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  const clearsBefore = clearIntervalSpy.mock.calls.length;

  // Unmount (the timer-slice unmount test's technique): the cleanup runs the
  // clock slice's stop() — the header held the only slot, so refcount hits 0,
  // the driver is cleared and the mirror parks at the wall clock.
  ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });
  currentRenderer = null; // afterEach must not try to unmount again
  expect(clearIntervalSpy).toHaveBeenCalledTimes(clearsBefore + 1);
  expect(useClockStore.getState().nowMs).toBe(Date.now());

  // The slot is GONE (not merely paused): a subsequent unpaired stop is a
  // true no-op — no further clearInterval, no spurious mirror re-sync.
  const parked = useClockStore.getState().nowMs;
  useClockStore.getState().stop();
  expect(clearIntervalSpy).toHaveBeenCalledTimes(clearsBefore + 1);
  expect(useClockStore.getState().nowMs).toBe(parked);
});
