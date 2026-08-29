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
 *   - Quit: the "Quit" menu item routes to the native `quitApp()` adapter
 *     (the quit ENTRY — from any session state; the confirm decision is the
 *     native gate's, not this handler's).
 *   - Quit gate (6.5): `onQuitRequested` with no live session calls
 *     `confirmQuit()` immediately (no dialog, no window fronting — including
 *     while an Apply is running and for a malformed `endEpochMs`); with a
 *     live session it fronts the window (`presentQuitConfirm()`) then opens
 *     the two-button confirm `Alert.alert` (Cancel first style `cancel`, Quit
 *     style `destructive`), where Quit (never Cancel) proceeds to
 *     `confirmQuit()`; a duplicate request mid-dialog is a no-op, and BOTH
 *     buttons reset the guard so the dialog returns on a later request.
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
    confirmQuit: jest.fn(() => ({ ok: true })),
    presentQuitConfirm: jest.fn(() => ({ ok: true })),
    onQuickStart: jest.fn(() => ({ remove: jest.fn() })),
    onShowWindow: jest.fn(() => ({ remove: jest.fn() })),
    onQuit: jest.fn(() => ({ remove: jest.fn() })),
    onQuitRequested: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('../src/native/menuBar', () => ({
  __esModule: true,
  initializeMenuBar: jest.fn(() => ({ ok: true })),
  setMenuBarBadge: jest.fn(() => ({ ok: true })),
  quitApp: jest.fn(() => ({ ok: true })),
  confirmQuit: jest.fn(() => ({ ok: true })),
  presentQuitConfirm: jest.fn(() => ({ ok: true })),
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
import { confirmQuit, presentQuitConfirm, quitApp } from '../src/native/menuBar';
import { useDomainStore } from '../src/domain/store';
// The quick-start duration is derived from the SAME hoisted domain constant
// both the menu-bar action and the Timer chips read — so this suite asserts
// the quick-start value BY CONSTRUCTION (a menu-value vs chip-value drift
// would fail here), not by mirroring a hand-copied number.
import { PRESET_MINUTES } from '../src/domain/timerPresets';
import { DEFAULT_CONFIG, type Config } from '../src/config/types';
// `Alert.alert` is spied on (NOT the whole `react-native` module) so the
// rest of react-native keeps working — the Blocklist/Schedule suites' seam.
// The handlers under test import the same `Alert` object, so the spy sees
// their `Alert.alert` calls.
import { Alert } from 'react-native';
import type { AlertButton } from 'react-native';

// @types/node is not bundled, so the CommonJS `__dirname` jest injects at
// runtime is declared at module scope (real in the executed CJS module) —
// the windowFrame.test.ts drift-guard declaration, reused by the native
// quit-gate drift guards at the bottom of this file.
declare const __dirname: string;

const alertSpy = jest.spyOn(Alert, 'alert');

function alertButtons(callIndex = 0): AlertButton[] {
  return alertSpy.mock.calls[callIndex][2] as AlertButton[];
}

type NativeMenuBarMock = {
  quit: jest.Mock;
  onQuickStart: jest.Mock;
  onShowWindow: jest.Mock;
  onQuit: jest.Mock;
  onQuitRequested: jest.Mock;
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
let quitRequestedHandler: (() => void) | null = null;

function ensureSubscribed(): void {
  if (quickStartHandler != null) {
    return;
  }
  startMenuBarActions();
  quickStartHandler = native.onQuickStart.mock.calls[0][0] as () => void;
  quitHandler = native.onQuit.mock.calls[0][0] as () => void;
  quitRequestedHandler = native.onQuitRequested.mock.calls[0][0] as () => void;
}

function fireQuickStart(): void {
  ensureSubscribed();
  quickStartHandler!();
}

function fireQuit(): void {
  ensureSubscribed();
  quitHandler!();
}

function fireQuitRequested(): void {
  ensureSubscribed();
  quitRequestedHandler!();
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
  // Close any dialog a PREVIOUS test left open: the module-level
  // `quitDialogPendingSince` guard is per-file singleton state, and a dialog
  // abandoned mid-test would make every later quit-request no-op. Pressing
  // its Cancel resets the guard (and, being Cancel, proves the reset is not
  // confused with a quit). The Cancel-first shape is the repo's dialog
  // contract (Blocklist/Schedule/Quit confirm) — assert it so this teardown
  // fails loudly if any dialog drifts and `buttons[0]` stops being Cancel
  // (pressing a non-Cancel first button here would silently QUIT).
  const lastCall = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
  if (lastCall) {
    const firstButton = (lastCall[2] as AlertButton[])?.[0];
    expect(firstButton?.style).toBe('cancel');
    firstButton?.onPress?.();
  }
  (quitApp as jest.Mock).mockClear();
  (confirmQuit as jest.Mock).mockClear();
  (presentQuitConfirm as jest.Mock).mockClear();
  alertSpy.mockClear();
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

test('startMenuBarActions subscribes to onQuickStart + onQuit + onQuitRequested once; a second call is a no-op', () => {
  // Declared FIRST so this test is the file's first caller of the module
  // guard (Jest runs tests in declaration order).
  const quickStartBefore = native.onQuickStart.mock.calls.length;
  const quitBefore = native.onQuit.mock.calls.length;
  const quitRequestedBefore = native.onQuitRequested.mock.calls.length;

  startMenuBarActions();
  expect(native.onQuickStart.mock.calls.length).toBe(quickStartBefore + 1);
  expect(native.onQuit.mock.calls.length).toBe(quitBefore + 1);
  // Story 6.5 — the quit gate's JS decision lives on this subscription.
  expect(native.onQuitRequested.mock.calls.length).toBe(quitRequestedBefore + 1);
  // "Show window" never routes through JS — no subscription is taken.
  expect(native.onShowWindow).not.toHaveBeenCalled();

  startMenuBarActions();
  expect(native.onQuickStart.mock.calls.length).toBe(quickStartBefore + 1);
  expect(native.onQuit.mock.calls.length).toBe(quitBefore + 1);
  expect(native.onQuitRequested.mock.calls.length).toBe(quitRequestedBefore + 1);
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
// Quit — the "Quit" menu-item ENTRY (6.3) + the quit gate (Story 6.5)
// ---------------------------------------------------------------------------

test('quit routes to the native quitApp() adapter', () => {
  fireQuit();

  expect(quitApp).toHaveBeenCalledTimes(1);
  expect(quitApp).toHaveBeenCalledWith();
});

test('the "Quit" entry routes to quitApp() from ANY session state — the native gate decides the rest', () => {
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

  // The entry itself stays unconditional: the dispatched `NSApp.terminate`
  // re-enters `onQuitRequested` NATIVELY, so the confirm dialog is never the
  // "Quit" handler's business.
  expect(quitApp).toHaveBeenCalledTimes(1);
  expect(confirmQuit).not.toHaveBeenCalled();
  expect(presentQuitConfirm).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
});

test('quit-requested with a live session fronts the window then opens the two-button confirm', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();

  // Window fronting happens BEFORE the alert (the RN alert is a sheet on the
  // RN window — invisible while that window is closed to the menu bar), and
  // the terminate does NOT proceed until the dialog answers.
  expect(presentQuitConfirm).toHaveBeenCalledTimes(1);
  expect(
    (presentQuitConfirm as jest.Mock).mock.invocationCallOrder[0]
  ).toBeLessThan(alertSpy.mock.invocationCallOrder[0]);
  expect(confirmQuit).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledTimes(1);
  const [title, body, buttons] = alertSpy.mock.calls[0];
  expect(typeof title).toBe('string');
  expect(typeof body).toBe('string');
  expect((body as string).length).toBeGreaterThan(0);
  // Cancel first (style 'cancel' — the Esc target), Quit destructive — the
  // Blocklist/Schedule two-button shape, destructive never the default.
  // (toMatchObject: the button objects legitimately also carry their
  // onPress handlers.)
  expect(alertButtons()[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
  expect(alertButtons()[1]).toMatchObject({
    text: 'Quit',
    style: 'destructive',
  });
});

test('confirming the dialog resets the guard and proceeds to confirmQuit()', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();
  alertButtons()[1].onPress?.();

  expect(confirmQuit).toHaveBeenCalledTimes(1);
  expect(alertSpy).toHaveBeenCalledTimes(1);
});

test('the dialog Quit button — never Cancel — resumes the termination', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();
  alertButtons()[0].onPress?.(); // Cancel / Esc

  expect(confirmQuit).not.toHaveBeenCalled();
});

test('a duplicate quit request mid-dialog is a no-op (no second dialog)', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();
  fireQuitRequested();

  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(presentQuitConfirm).toHaveBeenCalledTimes(1);
});

test('a stale-pending guard recovers: past the 10s window the request re-shows the dialog', () => {
  // The dialog is not guaranteed to end through a button: the sheet dies
  // un-pressed if the window closes mid-dialog (⌘W) or the system dismisses
  // it. A plain boolean guard would brick every later quit — the staleness
  // window makes an orphaned guard reset AND re-show instead.
  jest.useFakeTimers();
  try {
    useDomainStore.setState({
      committed: {
        ...configWithDomains(['x.com']),
        activeTimer: {
          endEpochMs: Date.now() + 60_000,
          selectedDomains: ['x.com'],
        },
      },
    });

    fireQuitRequested();
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // Still fresh at 5s — the ordinary double-⌘Q window: no-op.
    jest.advanceTimersByTime(5_000);
    fireQuitRequested();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(presentQuitConfirm).toHaveBeenCalledTimes(1);

    // Past the staleness window the guard is orphaned: reset AND re-show,
    // never brick.
    jest.advanceTimersByTime(10_002); // 15_002ms since the dialog went up
    fireQuitRequested();
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(presentQuitConfirm).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

test('the gate re-arms after a cancel — a later request re-opens the dialog', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();
  alertButtons()[0].onPress?.(); // cancel

  fireQuitRequested();

  expect(alertSpy).toHaveBeenCalledTimes(2);
  expect(alertButtons(1)[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
});

test('the gate re-arms after a confirm — a later request re-opens the dialog', () => {
  useDomainStore.setState({
    committed: {
      ...configWithDomains(['x.com']),
      activeTimer: {
        endEpochMs: Date.now() + 60_000,
        selectedDomains: ['x.com'],
      },
    },
  });

  fireQuitRequested();
  alertButtons()[1].onPress?.(); // quit
  (confirmQuit as jest.Mock).mockClear();

  fireQuitRequested();

  expect(alertSpy).toHaveBeenCalledTimes(2);
  // And the second dialog's Quit proceeds the same way.
  alertButtons(1)[1].onPress?.();
  expect(confirmQuit).toHaveBeenCalledTimes(1);
});

test('quit-requested with NO live session resumes the terminate with no dialog and no window flash', () => {
  useDomainStore.setState({ committed: configWithDomains(['x.com']) });

  fireQuitRequested();

  expect(confirmQuit).toHaveBeenCalledTimes(1);
  expect(presentQuitConfirm).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
});

test('an Apply running does NOT gate the quit (hosts left consistent by the apply pipeline)', () => {
  useDomainStore.setState({
    committed: configWithDomains(['x.com']),
    applyStatus: 'running',
  });

  fireQuitRequested();

  expect(confirmQuit).toHaveBeenCalledTimes(1);
  expect(alertSpy).not.toHaveBeenCalled();
});

test('a malformed endEpochMs counts as NO live session (Timer normalisation) — quits unconditionally', () => {
  const malformed = {
    ...configWithDomains(['x.com']),
    activeTimer: { endEpochMs: 'soon' } as unknown as Config['activeTimer'],
  };
  useDomainStore.setState({ committed: malformed });

  fireQuitRequested();

  expect(confirmQuit).toHaveBeenCalledTimes(1);
  expect(alertSpy).not.toHaveBeenCalled();
});

test('a null endEpochMs counts as NO live session — no confirm dialog', () => {
  const idle = {
    ...configWithDomains(['x.com']),
    activeTimer: null,
  };
  useDomainStore.setState({ committed: idle });

  fireQuitRequested();

  expect(confirmQuit).toHaveBeenCalledTimes(1);
  expect(alertSpy).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Native quit-gate drift guards (running, not comment-only)
// ---------------------------------------------------------------------------

describe('native quit-gate drift guards', () => {
  // Node built-ins, hand-typed/`require`d at the point of use (the
  // windowFrame.test.ts Swift-file-scan pattern; the app tsconfig bundles no
  // @types/node). These pin the load-bearing NATIVE half of the quit gate,
  // which jest cannot reach directly — there is no XCTest target — so a
  // source scan is the only running contract over the invariants the whole
  // confirm flow depends on.
  const nodePath = require('path') as { resolve: (...p: string[]) => string };
  const nodeFs = require('fs') as {
    readFileSync: (path: string, encoding: string) => string;
  };

  function readSource(relativePath: string): string {
    return nodeFs.readFileSync(
      nodePath.resolve(__dirname, '..', relativePath),
      'utf8'
    );
  }

  test('AppDelegate.mm wires both close/terminate delegate hooks', () => {
    const source = readSource('macos/Frosthalt-macOS/AppDelegate.mm');
    // Close-to-menu-bar: closing the last window must NOT terminate.
    expect(source).toContain('applicationShouldTerminateAfterLastWindowClosed');
    // The single arbitration point for EVERY quit source, forwarding to the
    // shared MenuBar instance.
    expect(source).toContain('applicationShouldTerminate');
    expect(source).toContain(
      'NativeMenuBar sharedInstance] handleShouldTerminate'
    );
    // The Bool->reply enum mapping is EXPLICIT (NSTerminateNow = 0,
    // NSTerminateCancel = 1 — numerically inverted against Bool; returning a
    // raw BOOL would cancel every confirmed quit and terminate every
    // cancelled one).
    expect(source).toContain('NSTerminateNow');
    expect(source).toContain('NSTerminateCancel');
  });

  test('Info.plist disables both auto-quit vectors', () => {
    const source = readSource('macos/Frosthalt-macOS/Info.plist');
    // NSSupportsAutomaticTermination (auto-quit after last window close) and
    // NSSupportsSuddenTermination (SIGKILL-style, skips BOTH
    // applicationShouldTerminate: and 6.4's willTerminateNotification frame
    // flush): each must be present AND false.
    expect(source).toMatch(
      /NSSupportsAutomaticTermination[\s\S]{0,80}?<false\/>/
    );
    expect(source).toMatch(/NSSupportsSuddenTermination[\s\S]{0,80}?<false\/>/);
  });

  test('MenuBar.swift keeps the gate, the re-entrancy flag, and confirmQuit', () => {
    const source = readSource('macos/Frosthalt-macOS/MenuBar.swift');
    // The arbitration point itself, the JS-confirmed terminate flag it
    // consumes/resets, and the "go" leg's terminate (never exit()/forced).
    expect(source).toContain('func handleShouldTerminate');
    expect(source).toContain('terminateConfirmedByJS');
    // Bound the scan at the NEXT method after confirmQuit so a stray textual
    // mention earlier in the file cannot empty the slice.
    const confirmStart = source.indexOf('func confirmQuit');
    const sliceEnd = source.indexOf('func presentQuitConfirm', confirmStart);
    const confirmQuitBody = source.slice(
      confirmStart,
      sliceEnd === -1 ? undefined : sliceEnd
    );
    expect(confirmQuitBody).toContain('NSApp.terminate');
  });
});
