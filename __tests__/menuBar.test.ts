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
    onQuickStart: jest.fn(),
    onShowWindow: jest.fn(),
    onQuit: jest.fn(),
  };
  return {
    __esModule: true,
    default: mock,
  };
});

// App also transitively imports the other two native specs (Blocklist ->
// domain store -> configStore / shellRunner) — mock them the same way the
// other App-mounting suites do, so the import resolves.
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
import App from '../App';
import { initializeMenuBar, setMenuBarBadge } from '../src/native/menuBar';
import type {
  MenuBarBadgeState,
  MenuBarResult,
} from '../src/native/specs/NativeMenuBarSpec';

type NativeMenuBarMock = {
  initialize: jest.Mock;
  setBadgeState: jest.Mock;
  onQuickStart: jest.Mock;
  onShowWindow: jest.Mock;
  onQuit: jest.Mock;
};
const native = require('../src/native/specs/NativeMenuBarSpec')
  .default as unknown as NativeMenuBarMock;

beforeEach(() => {
  native.initialize.mockReset();
  native.setBadgeState.mockReset();
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
    }),
  ).toEqual({ ok: false, error: 'boom' });
});

// ---------------------------------------------------------------------------
// App mount — initializeMenuBar() called exactly once, on mount
// ---------------------------------------------------------------------------

test('mounting App calls the native initialize() exactly once', async () => {
  native.initialize.mockReturnValue({ ok: true });

  let testRenderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(React.createElement(App));
  });

  expect(native.initialize).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });

  // Unmounting does not re-trigger it, and there is no cleanup call either
  // (the mount effect has no return) — still exactly one call total.
  expect(native.initialize).toHaveBeenCalledTimes(1);
});
