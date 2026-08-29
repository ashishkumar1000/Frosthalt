/**
 * Story 6.3 — menu-bar quick-start / quit action coverage.
 *
 * The menu-bar module emits plain click events into JS (`onQuickStart`,
 * `onQuit`); `startMenuBarActions()` subscribes to them, so Jest CAN drive
 * the whole path: the mock spec captures the handlers registered by
 * `startMenuBarActions()`, and each test invokes one directly — the same
 * "no NSMenu in Jest" boundary the 6.2 suite noted, but on the JS side of
 * the seam.
 *
 * Covered (the spec's I/O matrix):
 *   - Registration: quick-start + quit subscribe exactly once, on the first
 *     call; "Show window" is deliberately never subscribed (native-only);
 *     a second `startMenuBarActions()` is a no-op (the 6.2 mirror guard).
 *   - Quick-start args: `stageStartTimer({ durationMs: 25*60_000, selected })`
 *     with ALL committed hostnames (the Timer UI's own fallback).
 *   - Guard no-ops — store action never invoked — for a live session, a
 *     running Apply, and an empty blocklist; a malformed `endEpochMs`
 *     conversely counts as NO live session (Timer's normalisation).
 *   - Event-time state read: a handler registered while idle still sees
 *     domains committed afterwards (state is read via `getState()` at click
 *     time, never cached at registration).
 *   - Quit: the registered handler calls the native `quitApp()` adapter once —
 *     including while a session is live (unconditional; the confirm is 6.5's).
 *   - One integration pass through the REAL store action (mocked ports), so
 *     the reuse claim — the Epic 4 start path, its serialized queue, ONE
 *     admin prompt — is actually exercised, not just assumed.
 *
 * Mock pattern mirrors `menuBar.test.ts` / `store.test.ts`. NOTE on the
 * module-once guard: the store (and the actions module) are per-FILE
 * singletons in Jest, so the FIRST `startMenuBarActions()` here installs the
 * real handlers for the rest of the file — handler references are stable and
 * state-safe because the handlers read `getState()` at event time, never
 * capturing store state.
 */

jest.mock('../src/native/specs/NativeMenuBarSpec', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(() => ({ ok: true })),
    setBadgeState: jest.fn(() => ({ ok: true })),
    quit: jest.fn(() => ({ ok: true })),
    onQuickStart: jest.fn(() => ({ remove: jest.fn() })),
    onShowWindow: jest.fn(() => ({ remove: jest.fn() })),
    onQuit: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('../src/native/menuBar', () => ({
  __esModule: true,
  initializeMenuBar: jest.fn(() => ({ ok: true })),
  setMenuBarBadge: jest.fn(() => ({ ok: true })),
  quitApp: jest.fn(() => ({ ok: true })),
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

import { startMenuBarActions } from '../src/domain/menuBarActions';
import { quitApp } from '../src/native/menuBar';
import { useDomainStore } from '../src/domain/store';
// The quick-start duration is derived from the SAME hoisted domain constant
// both the menu-bar action and the Timer chips read — so this suite asserts
// the quick-start value BY CONSTRUCTION (a menu-value vs chip-value drift
// would fail here), not by mirroring a hand-copied number.
import { PRESET_MINUTES } from '../src/domain/timerPresets';
import { DEFAULT_CONFIG, type Config } from '../src/config/types';

type NativeMenuBarMock = {
  quit: jest.Mock;
  onQuickStart: jest.Mock;
  onShowWindow: jest.Mock;
  onQuit: jest.Mock;
};
const native = require('../src/native/specs/NativeMenuBarSpec')
  .default as unknown as NativeMenuBarMock;

type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
type NativeShellMock = { writeHosts: jest.Mock; readHostsSection: jest.Mock };
const configNative = require('../src/native/specs/NativeConfigStoreSpec')
  .default as unknown as NativeConfigMock;
const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as NativeShellMock;

/** The quick-start duration — the first hoisted preset, same expression as `menuBarActions.ts`. */
const QUICK_START_MS = PRESET_MINUTES[0] * 60_000;

/** A committed config with always-on domains. */
function configWithDomains(hostnames: string[]): Config {
  return {
    ...DEFAULT_CONFIG,
    domains: hostnames.map((hostname) => ({ hostname, alwaysOn: true })),
  };
}

// ---------------------------------------------------------------------------
// Handler access — `startMenuBarActions()` is once-only per module, so tests
// share the one registration and fire the memoized handlers.
// ---------------------------------------------------------------------------

let quickStartHandler: (() => void) | null = null;
let quitHandler: (() => void) | null = null;

function ensureSubscribed(): void {
  if (quickStartHandler != null) {
    return;
  }
  startMenuBarActions();
  quickStartHandler = native.onQuickStart.mock.calls[0][0] as () => void;
  quitHandler = native.onQuit.mock.calls[0][0] as () => void;
}

function fireQuickStart(): void {
  ensureSubscribed();
  quickStartHandler!();
}

function fireQuit(): void {
  ensureSubscribed();
  quitHandler!();
}

/** Flush a few microtasks so an enqueued start run can settle. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

type StageStartTimerAction = ReturnType<
  typeof useDomainStore.getState
>['stageStartTimer'];

let realStageStartTimer: StageStartTimerAction;

beforeEach(() => {
  (quitApp as jest.Mock).mockClear();
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });

  // The store seam (store.test.ts pattern): reset committed/idle. NOTE the
  // subscribe mocks are NOT cleared — the one-time registration happened (or
  // happens via `ensureSubscribed`) and its handler is captured above.
  useDomainStore.setState({
    committed: DEFAULT_CONFIG,
    staged: null,
    stagedSchedules: null,
    applyStatus: 'idle',
    lastResult: null,
  });

  // Replace the store action with a jest.fn so arg/no-op assertions are
  // exact; the REAL action is restored in afterEach (the integration test
  // temporarily re-installs it).
  realStageStartTimer = useDomainStore.getState().stageStartTimer;
  useDomainStore.setState({
    stageStartTimer: jest.fn(() =>
      Promise.resolve({ ok: true } as const)
    ) as unknown as StageStartTimerAction,
  });
});

afterEach(() => {
  // Restore the real action so the store instance is not left with a mock.
  useDomainStore.setState({ stageStartTimer: realStageStartTimer });
});

// ---------------------------------------------------------------------------
// Registration + idempotency
// ---------------------------------------------------------------------------

test('startMenuBarActions subscribes to onQuickStart + onQuit once; a second call is a no-op', () => {
  // Declared FIRST so this test is the file's first caller of the module
  // guard (Jest runs tests in declaration order).
  const quickStartBefore = native.onQuickStart.mock.calls.length;
  const quitBefore = native.onQuit.mock.calls.length;

  startMenuBarActions();
  expect(native.onQuickStart.mock.calls.length).toBe(quickStartBefore + 1);
  expect(native.onQuit.mock.calls.length).toBe(quitBefore + 1);
  // "Show window" never routes through JS — no subscription is taken.
  expect(native.onShowWindow).not.toHaveBeenCalled();

  startMenuBarActions();
  expect(native.onQuickStart.mock.calls.length).toBe(quickStartBefore + 1);
  expect(native.onQuit.mock.calls.length).toBe(quitBefore + 1);
});

// ---------------------------------------------------------------------------
// Quick-start args
// ---------------------------------------------------------------------------

test('quick-start stages a 25-min session over ALL committed domains', () => {
  useDomainStore.setState({
    committed: configWithDomains(['x.com', 'y.org']),
  });

  fireQuickStart();

  const spy = useDomainStore.getState().stageStartTimer as unknown as jest.Mock;
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith({
    durationMs: QUICK_START_MS,
    selected: new Set(['x.com', 'y.org']),
  });
});

// ---------------------------------------------------------------------------
// Guard no-ops — the store action is never invoked.
// ---------------------------------------------------------------------------

test('quick-start is a no-op while a session is live', () => {
  const live: Config = {
    ...configWithDomains(['x.com']),
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['x.com'],
    },
  };
  useDomainStore.setState({ committed: live });

  fireQuickStart();

  expect(
    useDomainStore.getState().stageStartTimer as unknown as jest.Mock
  ).not.toHaveBeenCalled();
});

test('quick-start is a no-op while an Apply is running', () => {
  useDomainStore.setState({
    committed: configWithDomains(['x.com']),
    applyStatus: 'running',
  });

  fireQuickStart();

  expect(
    useDomainStore.getState().stageStartTimer as unknown as jest.Mock
  ).not.toHaveBeenCalled();
});

test('quick-start is a no-op with an empty blocklist', () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG });

  fireQuickStart();

  expect(
    useDomainStore.getState().stageStartTimer as unknown as jest.Mock
  ).not.toHaveBeenCalled();
});

test('a malformed endEpochMs counts as NO live session (Timer normalisation)', () => {
  const malformed = {
    ...configWithDomains(['x.com']),
    activeTimer: { endEpochMs: 'soon' } as unknown as Config['activeTimer'],
  };
  useDomainStore.setState({ committed: malformed });

  fireQuickStart();

  expect(
    useDomainStore.getState().stageStartTimer as unknown as jest.Mock
  ).toHaveBeenCalledTimes(1);
});

test('the handler reads state at EVENT time, not registration time', () => {
  // Register while the blocklist is still empty (would no-op forever if the
  // guard captured registration-time state), then commit domains first.
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  ensureSubscribed();
  useDomainStore.setState({ committed: configWithDomains(['x.com']) });

  fireQuickStart();

  expect(
    useDomainStore.getState().stageStartTimer as unknown as jest.Mock
  ).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

test('quit routes to the native quitApp() adapter', () => {
  fireQuit();

  expect(quitApp).toHaveBeenCalledTimes(1);
  expect(quitApp).toHaveBeenCalledWith();
});

test('quit still routes while a session is live (unconditional in 6.3)', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuit();

  expect(quitApp).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Integration — the REAL store action, one pass through the Epic 4 path.
// ---------------------------------------------------------------------------

test('quick-start drives the real store start path (config write + ONE hosts write)', async () => {
  useDomainStore.setState({ committed: configWithDomains(['x.com']) });
  useDomainStore.setState({ stageStartTimer: realStageStartTimer });

  fireQuickStart();
  await flushMicrotasks();

  const state = useDomainStore.getState();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  expect(state.committed.activeTimer).toEqual({
    endEpochMs: expect.any(Number),
    selectedDomains: ['x.com'],
  });
  const endEpochMs = state.committed.activeTimer?.endEpochMs ?? 0;
  expect(endEpochMs - Date.now()).toBeLessThanOrEqual(QUICK_START_MS);
  expect(state.applyStatus).toBe('idle');
});
