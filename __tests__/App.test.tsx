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
    // Story 6.3 — App mount now also subscribes (startMenuBarActions), so
    // the emitters return a usable subscription shape (see menuBar.test.ts).
    onQuickStart: jest.fn(() => ({ remove: jest.fn() })),
    onShowWindow: jest.fn(() => ({ remove: jest.fn() })),
    onQuit: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});
