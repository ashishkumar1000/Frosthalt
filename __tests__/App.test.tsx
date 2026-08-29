/**
 * @format
 */

// Shell now imports the Blocklist surface (Story 2.1), which pulls in the
// domain store -> configStore -> NativeConfigStoreSpec TurboModule. The
// TurboModule is not registered in the jest node env, so the spec's
// `TurboModuleRegistry.getEnforcing(...)` throws at module load. Mock both
// native specs (the store.test.ts:21-35 / Blocklist.test.tsx seam) so the
// transitive import resolves. App's own test only asserts that the tree
// renders; it does not exercise the store.
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

// Story 6.1 — App now calls `initializeMenuBar()` on mount, which imports
// NativeMenuBarSpec. Mock it the same way (see menuBar.test.ts for real
// coverage of the wrapper + mount-once behavior); this file only needs the
// transitive import to resolve. Story 6.2 — App also starts the domain
// mirror, whose initial push calls `setBadgeState`; it needs to resolve too
// (the mirror-test suite owns the push coverage).
jest.mock('../src/native/specs/NativeMenuBarSpec', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(() => ({ ok: true })),
    setBadgeState: jest.fn(() => ({ ok: true })),
    quit: jest.fn(() => ({ ok: true })),
    // Story 6.5 — the quit-gate methods the mount does not call directly,
    // but the spec surface must resolve for the adapter import.
    confirmQuit: jest.fn(() => ({ ok: true })),
    presentQuitConfirm: jest.fn(() => ({ ok: true })),
    // Story 6.3 — App mount now also subscribes (startMenuBarActions), so
    // the emitters return a usable subscription shape (see menuBar.test.ts).
    onQuickStart: jest.fn(() => ({ remove: jest.fn() })),
    onShowWindow: jest.fn(() => ({ remove: jest.fn() })),
    onQuit: jest.fn(() => ({ remove: jest.fn() })),
    onQuitRequested: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

// Story 6.4 — App mount now also calls `startWindowFrameSync()`, which
// imports NativeWindowSpec (and `src/native/window.ts`). Mock it the same way
// (see windowFrame.test.ts for real coverage of the wiring); this file only
// needs the transitive import to resolve.
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

// The 6.5 App-mount assertion (the 6-4 assertion style): a created renderer
// is retained so the mount (not some later re-render) is provably the caller.
let testRenderer!: ReactTestRenderer.ReactTestRenderer;

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<App />);
  });

  // Story 6.5 — the mount effect runs `startMenuBarActions()`, which
  // subscribes the quit gate's JS arbitration exactly once: every quit
  // source (⌘Q, Dock, both Quit items) routes through this one handler.
  const native = require('../src/native/specs/NativeMenuBarSpec')
    .default as { onQuitRequested: jest.Mock };
  expect(native.onQuitRequested).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });

  // Unmounting must not double-register (and the mount effect has no
  // cleanup): still exactly one.
  expect(native.onQuitRequested).toHaveBeenCalledTimes(1);
});
