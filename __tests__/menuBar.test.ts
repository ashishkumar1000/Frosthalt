/**
 * Story 6.1 — MenuBar TurboModule JS-side coverage.
 *
 * NSMenu clicks aren't Jest-drivable (per the spec's Design Notes), so this
 * suite covers the JS-testable half only:
 *   - `initializeMenuBar()` forwards to the native spec's `initialize()` and
 *     returns its `{ ok, error? }` envelope untouched.
 *   - Mounting `<App/>` calls `initializeMenuBar()` (native `initialize()`)
 *     exactly once, on mount.
 *
 * Mock pattern mirrors `configStore.test.ts` (the repo's first native-module
 * mock): `jest.mock` replaces the spec module — whose default export would
 * otherwise throw via `TurboModuleRegistry.getEnforcing` in a pure-node Jest
 * environment — with a fake whose methods are `jest.fn()`s.
 */

jest.mock('../src/native/specs/NativeMenuBarSpec', () => {
  const mock = {
    initialize: jest.fn(),
    setBadgeState: jest.fn(),
    quit: jest.fn(),
    // Event emitters return a subscription whose `remove()` the runtime
    // would call on teardown; Story 6.3's App mount now SUBSCRIBES (the
    // `menuBarActions` handler), so these mocks return a usable
    // subscription shape like the real codegen emitters do.
    onQuickStart: jest.fn(() => ({ remove: jest.fn() })),
    onShowWindow: jest.fn(() => ({ remove: jest.fn() })),
    onQuit: jest.fn(() => ({ remove: jest.fn() })),
  };
  return {
    __esModule: true,
    default: mock,
  };
});

// App also transitively imports the other native specs (Blocklist ->
// domain store -> configStore / shellRunner; Story 6.4 adds NativeWindowSpec
// via `startWindowFrameSync()`) — mock them the same way the other
// App-mounting suites do, so the import resolves.
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

jest.mock('../src/native/specs/NativeWindowSpec', () => ({
  __esModule: true,
  default: {
    configureWindow: jest.fn(() => ({ ok: true })),
    onWindowFrameChanged: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import {
  initializeMenuBar,
  setMenuBarBadge,
  quitApp,
} from '../src/native/menuBar';
import { WINDOW_RULES } from '../src/domain/windowFrame';
import type {
  MenuBarBadgeState,
  MenuBarResult,
} from '../src/native/specs/NativeMenuBarSpec';

type NativeMenuBarMock = {
  initialize: jest.Mock;
  setBadgeState: jest.Mock;
  quit: jest.Mock;
  onQuickStart: jest.Mock;
  onShowWindow: jest.Mock;
  onQuit: jest.Mock;
};
const native = require('../src/native/specs/NativeMenuBarSpec')
  .default as unknown as NativeMenuBarMock;

// Story 6.4 — the window sync shares this mount effect. Captured here so the
// App-mount test can prove the mount (not some other wiring) drove it.
type NativeWindowMock = {
  configureWindow: jest.Mock;
  onWindowFrameChanged: jest.Mock;
};
const windowNative = require('../src/native/specs/NativeWindowSpec')
  .default as unknown as NativeWindowMock;

beforeEach(() => {
  native.initialize.mockReset();
  native.setBadgeState.mockReset();
  native.quit.mockReset();
});

// ---------------------------------------------------------------------------
// initializeMenuBar() — thin wrapper forwarding
// ---------------------------------------------------------------------------

test('initializeMenuBar forwards to the native initialize() and returns its result', () => {
  const result: MenuBarResult = { ok: true };
  native.initialize.mockReturnValue(result);

  expect(initializeMenuBar()).toBe(result);
  expect(native.initialize).toHaveBeenCalledTimes(1);
  expect(native.initialize).toHaveBeenCalledWith();
});

test('initializeMenuBar surfaces a native { ok: false, error } result untouched', () => {
  native.initialize.mockReturnValue({ ok: false, error: 'boom' });

  expect(initializeMenuBar()).toEqual({ ok: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// setMenuBarBadge() — Story 6.2 badge-mirror forwarding
// ---------------------------------------------------------------------------

test('setMenuBarBadge forwards the payload to the native setBadgeState() and returns its result', () => {
  const result: MenuBarResult = { ok: true };
  native.setBadgeState.mockReturnValue(result);
  const badge: MenuBarBadgeState = {
    state: 'blocked',
    buttonTitle: '25:00',
    rowTitle: 'Blocked · 25:00',
  };

  expect(setMenuBarBadge(badge)).toBe(result);
  expect(native.setBadgeState).toHaveBeenCalledTimes(1);
  expect(native.setBadgeState).toHaveBeenCalledWith(badge);
});

test('setMenuBarBadge surfaces a native { ok: false, error } result untouched', () => {
  native.setBadgeState.mockReturnValue({ ok: false, error: 'boom' });

  expect(
    setMenuBarBadge({
      state: 'free',
      buttonTitle: 'Free',
      rowTitle: 'Free · no active timer',
    })
  ).toEqual({ ok: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// quitApp() — Story 6.3 quit forwarding
// ---------------------------------------------------------------------------

test('quitApp forwards to the native quit() and returns its result', () => {
  const result: MenuBarResult = { ok: true };
  native.quit.mockReturnValue(result);

  expect(quitApp()).toBe(result);
  expect(native.quit).toHaveBeenCalledTimes(1);
  expect(native.quit).toHaveBeenCalledWith();
});

test('quitApp surfaces a native { ok: false, error } result untouched', () => {
  native.quit.mockReturnValue({ ok: false, error: 'boom' });

  expect(quitApp()).toEqual({ ok: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// App mount — initializeMenuBar() + mirror/actions wiring called on mount
// ---------------------------------------------------------------------------

test('mounting App calls the native initialize() exactly once and registers the 6.3 action handlers', async () => {
  native.initialize.mockReturnValue({ ok: true });

  let testRenderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(React.createElement(App));
  });

  expect(native.initialize).toHaveBeenCalledTimes(1);
  // Story 6.3 — the mount effect also starts `startMenuBarActions()`, which
  // subscribes quick-start + quit to the emitters exactly once. (App's mount
  // effect additionally runs `startMenuBarMirror()`; a single mount calls
  // each emitter once for the actions registration — the mirror's push
  // exercise is owned by `menuBarMirror.test.ts`.)
  expect(native.onQuickStart).toHaveBeenCalledTimes(1);
  expect(native.onQuit).toHaveBeenCalledTimes(1);
  // "Show window" is native-only (activation in MenuBar.swift's click
  // handler) — App never subscribes to it.
  expect(native.onShowWindow).not.toHaveBeenCalled();

  // Story 6.4 — the SAME mount effect must run `startWindowFrameSync()`: the
  // window constants reach native from the domain (WINDOW_RULES verbatim —
  // the single-source rule) and the frame emitter is subscribed. This file
  // only mounts App once, so the absolute counts are the mount's doing; if
  // the App.tsx call is ever deleted, this assertion fails the suite (the
  // per-module wiring tests in windowFrame.test.ts capture the module-load
  // install and cannot see an App-mount regression).
  expect(windowNative.configureWindow).toHaveBeenCalledTimes(1);
  expect(windowNative.configureWindow).toHaveBeenCalledWith(WINDOW_RULES);
  expect(windowNative.onWindowFrameChanged).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });

  // Unmounting does not re-trigger either registration, and there is no
  // cleanup call either (the mount effect has no return) — still one call
  // of each total.
  expect(native.initialize).toHaveBeenCalledTimes(1);
  expect(native.onQuickStart).toHaveBeenCalledTimes(1);
  expect(native.onQuit).toHaveBeenCalledTimes(1);
  expect(windowNative.configureWindow).toHaveBeenCalledTimes(1);
  expect(windowNative.onWindowFrameChanged).toHaveBeenCalledTimes(1);
});
