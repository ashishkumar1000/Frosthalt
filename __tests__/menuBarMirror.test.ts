/**
 * @format
 *
 * Story 6.2 — the menu-bar badge mirror tests.
 *
 * The mirror is deliberately split into a PURE derivation
 * (`deriveMenuBarBadge`) and thin store wiring (`startMenuBarMirror`), so:
 *
 *   - The derivation matrix runs against fabricated inputs (no store
 *     involvement at all): free, live-session countdown, expired-parked
 *     `00:00`, malformed `endEpochMs`, schedule-only blocking, and the amber
 *     ramp — the SAME matrix `badgeState.test.ts` pins for the in-window
 *     badge, asserting the menu-bar payload mirrors it (same state, same
 *     label words, same countdown strings).
 *   - The wiring tests drive the REAL slices via `setState` (the
 *     store.test.ts seam) with jest fake timers + a fixed system clock, and
 *     assert the native `setBadgeState` calls: the initial push (including
 *     the 4.7 launch re-arm shape), the per-second countdown update, the
 *     dedupe contract, the slot release on session clear, and the
 *     installed-once idempotency.
 *
 * Mock pattern: the three native specs, exactly as `menuBar.test.ts` mocks
 * them (the mirror imports the domain store -> ConfigStore/ShellRunner
 * transitively, plus the MenuBar spec it pushes to).
 */

jest.mock('../src/native/specs/NativeMenuBarSpec', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(() => ({ ok: true })),
    setBadgeState: jest.fn(() => ({ ok: true })),
    onQuickStart: jest.fn(),
    onShowWindow: jest.fn(),
    onQuit: jest.fn(),
  },
}));

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

import {
  deriveMenuBarBadge,
  startMenuBarMirror,
  type MenuBarMirrorInputs,
} from '../src/domain/menuBarMirror';
import { useDomainStore } from '../src/domain/store';
import { useTimerStore, type TimerState } from '../src/domain/timerStore';
import {
  DEFAULT_CONFIG,
  type ActiveTimer,
  type Config,
  type Schedule,
  type Weekday,
} from '../src/config/types';

type NativeMenuBarMock = {
  initialize: jest.Mock;
  setBadgeState: jest.Mock;
  onQuickStart: jest.Mock;
  onShowWindow: jest.Mock;
  onQuit: jest.Mock;
};
const native = require('../src/native/specs/NativeMenuBarSpec')
  .default as unknown as NativeMenuBarMock;

const T0 = 1_756_000_000_000; // the badgeState.test.ts epoch — arbitrary + fixed

const MIN = 60_000;

/** A fabricated idle-ish timer slice state — no driver, no store churn. */
function timerState(
  endEpochMs: number | null,
  nowMs: number,
  totalMs: number | null = null,
): TimerState {
  return { nowMs, endEpochMs, totalMs, start: jest.fn(), stop: jest.fn() };
}

/** A committed config with a live timer ending `msFromT0` after `T0`. */
function configWithTimer(msFromT0: number): Config {
  const activeTimer: ActiveTimer = {
    endEpochMs: T0 + msFromT0,
    selectedDomains: ['x.com'],
  };
  return { ...DEFAULT_CONFIG, activeTimer };
}

// ---------------------------------------------------------------------------
// Pure derivation matrix — fabricated inputs, no store involvement.
// ---------------------------------------------------------------------------

test('free config derives the Free badge + no-active-timer row', () => {
  const badge = deriveMenuBarBadge({
    committed: DEFAULT_CONFIG,
    nowMs: T0,
    timer: timerState(null, T0),
  });
  expect(badge).toEqual({
    state: 'free',
    buttonTitle: 'Free',
    rowTitle: 'Free · no active timer',
  });
});

test('live session derives the countdown button + Blocked row', () => {
  const badge = deriveMenuBarBadge({
    committed: configWithTimer(25 * MIN),
    nowMs: T0,
    timer: timerState(T0 + 25 * MIN, T0, 25 * MIN),
  });
  expect(badge).toEqual({
    state: 'blocked',
    buttonTitle: '25:00',
    rowTitle: 'Blocked · 25:00',
  });
});

test('expired-parked session holds 00:00 exactly like the header', () => {
  const badge = deriveMenuBarBadge({
    committed: configWithTimer(0),
    nowMs: T0,
    // The slice's self-park shape: nowMs parked AT endEpochMs.
    timer: timerState(T0, T0, 0),
  });
  expect(badge).toEqual({
    state: 'blocked',
    buttonTitle: '00:00',
    rowTitle: 'Blocked · 00:00',
  });
});

test('malformed endEpochMs lands in the no-timer branch (header normalisation)', () => {
  const malformed = {
    ...DEFAULT_CONFIG,
    activeTimer: { endEpochMs: 'soon', selectedDomains: [] } as unknown as ActiveTimer,
  };
  const badge = deriveMenuBarBadge({
    committed: malformed,
    nowMs: T0,
    timer: timerState(null, T0),
  });
  // No NaN:NaN countdown, no crash — the free branch with the placeholder.
  expect(badge).toEqual({
    state: 'free',
    buttonTitle: 'Free',
    rowTitle: 'Free · no active timer',
  });
});

test('schedule-only blocking shows the badge word with no active timer', () => {
  // A live window covering `now` (the badgeState.test.ts fixture shape),
  // no timer: the button carries the badge WORD, not a countdown.
  const probe = new Date(T0);
  const noon = new Date(
    probe.getFullYear(),
    probe.getMonth(),
    probe.getDate(),
    12,
    0,
    0,
    0,
  );
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const schedule: Schedule = {
    id: 's1',
    name: 'Deep Work',
    weekdays: [((noon.getDay() + 6) % 7) as Weekday],
    startTime: hhmm(noon),
    endTime: hhmm(new Date(noon.getTime() + 60 * MIN)),
    enabled: true,
    domains: ['x.com'],
  };
  const badge = deriveMenuBarBadge({
    committed: { ...DEFAULT_CONFIG, schedules: [schedule] },
    nowMs: noon.getTime() + 30 * MIN,
    timer: timerState(null, noon.getTime() + 30 * MIN),
  });
  expect(badge).toEqual({
    state: 'blocked',
    buttonTitle: 'Blocked',
    rowTitle: 'Blocked · no active timer',
  });
});

test('amber ramp derives the Blocking word + amber state', () => {
  // The 5.4 amber fixture: window [12:00, 13:00), at 12:55 the end is 5 min
  // away and the boundary shrinks the blocklist — the mirror payload must
  // carry the SAME amber state + word the in-window badge shows.
  const probe = new Date(T0);
  const noon = new Date(
    probe.getFullYear(),
    probe.getMonth(),
    probe.getDate(),
    12,
    0,
    0,
    0,
  );
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const schedule: Schedule = {
    id: 's1',
    name: 'Deep Work',
    weekdays: [((noon.getDay() + 6) % 7) as Weekday],
    startTime: hhmm(noon),
    endTime: hhmm(new Date(noon.getTime() + 60 * MIN)),
    enabled: true,
    domains: ['x.com'],
  };
  const nowMs = noon.getTime() + 55 * MIN;
  const badge = deriveMenuBarBadge({
    committed: { ...DEFAULT_CONFIG, schedules: [schedule] },
    nowMs,
    timer: timerState(null, nowMs),
  });
  expect(badge).toEqual({
    state: 'amber',
    buttonTitle: 'Blocking',
    rowTitle: 'Blocking · no active timer',
  });
});

// ---------------------------------------------------------------------------
// Wiring — the REAL slices, driven via setState (store.test.ts seam).
//
// Order matters: `startMenuBarMirror()` installs its subscriptions ONCE per
// module (the idempotency contract), so the launch-re-arm test below is the
// one that starts the mirror. Each test clears the session in afterEach so
// the next test's session acquires a FRESH driver under its own fake timers
// (the mirror's held-slot bookkeeping releases on the clear).
// ---------------------------------------------------------------------------

describe('startMenuBarMirror wiring', () => {
  let setIntervalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    native.setBadgeState.mockClear();
  });

  afterEach(() => {
    // Release the mirror's timer-slice slot (a committed clear fires the
    // subscription -> syncTimerSlot -> stop), then reset the slice state so
    // no bookkeeping leaks between tests. Balanced start/stop pairs keep the
    // timerStore module refcount at 0 across the describe.
    useDomainStore.setState({ committed: DEFAULT_CONFIG });
    useTimerStore.setState({ nowMs: T0, endEpochMs: null, totalMs: null });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('initial push mirrors a persisted live session (launch re-arm shape)', () => {
    // 4.7's launch shape: a live session is already in `committed` when the
    // mirror starts — the FIRST push must acquire the slot and show the
    // correct countdown, not Free.
    useDomainStore.setState({ committed: configWithTimer(25 * MIN) });
    startMenuBarMirror();

    expect(native.setBadgeState).toHaveBeenCalledTimes(1);
    expect(native.setBadgeState).toHaveBeenCalledWith({
      state: 'blocked',
      buttonTitle: '25:00',
      rowTitle: 'Blocked · 25:00',
    });
    // The slot was acquired: the shared per-second driver is installed.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test('a per-second tick updates the countdown in the next push', () => {
    // New session (afterEach cleared the previous one): a fresh slot +
    // driver under THIS test's fake timers.
    useDomainStore.setState({ committed: configWithTimer(25 * MIN) });
    expect(native.setBadgeState).toHaveBeenLastCalledWith({
      state: 'blocked',
      buttonTitle: '25:00',
      rowTitle: 'Blocked · 25:00',
    });

    jest.advanceTimersByTime(1000);
    expect(native.setBadgeState).toHaveBeenLastCalledWith({
      state: 'blocked',
      buttonTitle: '24:59',
      rowTitle: 'Blocked · 24:59',
    });
  });

  test('unchanged derivation across store churn fires NO native call', () => {
    useDomainStore.setState({ committed: configWithTimer(25 * MIN) });
    const callsAfterStart = native.setBadgeState.mock.calls.length;

    // A new committed reference with the SAME visible content (a domains
    // array copy — an unrelated Apply-shaped change): the derived triple is
    // identical, so the dedupe blocks the push.
    const churned: Config = {
      ...configWithTimer(25 * MIN),
      domains: [...DEFAULT_CONFIG.domains],
    };
    useDomainStore.setState({ committed: churned });

    expect(native.setBadgeState.mock.calls.length).toBe(callsAfterStart);
  });

  test('clearing the session pushes Free and releases the timer slot', () => {
    useDomainStore.setState({ committed: configWithTimer(25 * MIN) });

    const stopSpy = jest.spyOn(useTimerStore.getState(), 'stop');
    useDomainStore.setState({ committed: DEFAULT_CONFIG });

    expect(native.setBadgeState).toHaveBeenLastCalledWith({
      state: 'free',
      buttonTitle: 'Free',
      rowTitle: 'Free · no active timer',
    });
    expect(stopSpy).toHaveBeenCalled();
  });

  test('a second startMenuBarMirror() is a no-op (installed once)', () => {
    const subscribeSpy = jest.spyOn(useDomainStore, 'subscribe');
    const callsBefore = native.setBadgeState.mock.calls.length;

    startMenuBarMirror();

    // No new subscriptions installed, no new push — the module guard holds.
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(native.setBadgeState.mock.calls.length).toBe(callsBefore);
  });
});