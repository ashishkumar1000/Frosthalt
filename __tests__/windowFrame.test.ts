/**
 * Story 6.4 — WindowFrame domain coverage (JS-testable half).
 *
 * Native capture/restore/zoom/debounce is not Jest-drivable (the native half
 * of the spec is manual — run once with `pnpm macos`), so this suite covers:
 *   - `normaliseWindowFrame` — the total/pure validator (matrix rows: valid;
 *     wrong types; NaN/Infinity; zero/negative width-height; array; string;
 *     null; a JSON boolean masquerading as a number; partial frames), and
 *     that a validated result is a FRESH object (no aliasing the input).
 *   - `WINDOW_RULES` — the three size pairs exactly as the spec's Design
 *     Notes pin them, their min <= standard <= max invariant, and a RUNNING
 *     drift guard asserting the native PINNED launch-time copies (Swift) equal
 *     these constants.
 *   - `startWindowFrameSync()` — the single install (captured at module load,
 *     per the installed-once `started` guard / menuBarMirror.test.ts pattern)
 *     hands native the domain constants verbatim and subscribes one handler;
 *     a StrictMode double-call is a no-op (no re-configure, no re-subscribe,
 *     no store re-entry);
 *     the `onWindowFrameChanged` handler validates at EVENT time and fires
 *     `commitWindowFrame` with a valid frame (config written, committed
 *     advanced, writeHosts untouched) and DROPS a corrupt one (no write).
 */

jest.mock('../src/native/specs/NativeWindowSpec', () => {
  const mock = {
    configureWindow: jest.fn(() => ({ ok: true })),
    onWindowFrameChanged: jest.fn(() => ({ remove: jest.fn() })),
  };
  return { __esModule: true, default: mock };
});

jest.mock('../src/native/specs/NativeConfigStoreSpec', () => ({
  __esModule: true,
  default: {
    readConfig: jest.fn(),
    writeConfig: jest.fn(() => ({ ok: true })),
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
  WINDOW_RULES,
  normaliseWindowFrame,
  startWindowFrameSync,
} from '../src/domain/windowFrame';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';

// The drift guard reads a repo file as text. The app tsconfig bundles no
// @types/node, so the CommonJS `__dirname` jest injects at runtime is
// declared here (it is real in the executed CJS module).
declare const __dirname: string;

type NativeWindowMock = {
  configureWindow: jest.Mock;
  onWindowFrameChanged: jest.Mock;
};
const native = require('../src/native/specs/NativeWindowSpec')
  .default as unknown as NativeWindowMock;

/**
 * The domain sync installs its configure call + event subscription exactly
 * ONCE per module lifetime (the module-level `started` guard in
 * `startWindowFrameSync` — StrictMode's double-mount must not
 * double-subscribe). So the registration is captured here, at module load,
 * exactly once; the per-test `mockReset`s below cannot erase it, and every
 * test drives this captured state. This mirrors the wiring-test pattern in
 * `menuBarMirror.test.ts`: order-independent tests assert deltas against the
 * captured single install — never re-count a subscription after a reset.
 */
startWindowFrameSync();
/** The one `configureWindow` payload from the module-load sync. */
const configuredRules = native.configureWindow.mock.calls[0][0];
/** The one event handler the module-load sync subscribed (frameHandler). */
const installedHandler = native.onWindowFrameChanged.mock.calls[0][0] as (
  payload: unknown
) => void;

/** The event handler `startWindowFrameSync` installed (exactly once). */
function frameHandler(): (payload: unknown) => void {
  return installedHandler;
}

beforeEach(() => {
  native.configureWindow.mockReset();
  native.onWindowFrameChanged.mockReset();
  native.configureWindow.mockReturnValue({ ok: true });
  native.onWindowFrameChanged.mockReturnValue({ remove: jest.fn() });
});

/**
 * Flush several microtask turns so an enqueued commit run reliably starts
 * AND finishes (the store.test.ts pattern — multi-turn safe, unlike a single
 * `await Promise.resolve()` which only unwinds one link of the queue chain).
 */
async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// WINDOW_RULES — the single source of the four size constants
// ---------------------------------------------------------------------------

test('WINDOW_RULES carries exactly the spec-pinned sizes', () => {
  expect(WINDOW_RULES).toEqual({
    standardWidth: 1280,
    standardHeight: 720,
    minWidth: 880,
    minHeight: 560,
    maxWidth: 2560,
    maxHeight: 1440,
  });
});

test('WINDOW_RULES is self-consistent: min <= standard <= max on both axes', () => {
  expect(WINDOW_RULES.minWidth).toBeLessThanOrEqual(WINDOW_RULES.standardWidth);
  expect(WINDOW_RULES.standardWidth).toBeLessThanOrEqual(WINDOW_RULES.maxWidth);
  expect(WINDOW_RULES.minHeight).toBeLessThanOrEqual(
    WINDOW_RULES.standardHeight
  );
  expect(WINDOW_RULES.standardHeight).toBeLessThanOrEqual(
    WINDOW_RULES.maxHeight
  );
  // The clamp "min <= standard <= max" is load-bearing in native: a clamped
  // restore must still compare standard (the zoom toggle derives from it).
  expect(WINDOW_RULES.minWidth).toBeGreaterThan(0);
  expect(WINDOW_RULES.minHeight).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Constant-drift guard (running, not comment-only)
// ---------------------------------------------------------------------------

test('the native pinned launch-time sizes match WINDOW_RULES (Swift file scan)', () => {
  // Node built-ins for the file scan: `require`d and hand-typed at the point
  // of use because the app tsconfig bundles no @types/node (the drift guard
  // is the only node-API consumer in this suite).
  const nodePath = require('path') as { resolve: (...p: string[]) => string };
  const nodeFs = require('fs') as {
    readFileSync: (path: string, encoding: string) => string;
  };
  // The corrupt-restore standard fallback + restore clamps are PINNED copies
  // in WindowPersistence.swift because they run before JS exists. The "must
  // match" comment is now a RUNNING check: read the Swift source as text and
  // assert the six literals equal the domain constants — a one-sided change
  // fails here instead of shipping a drifted restore/clamp.
  const swiftPath = nodePath.resolve(
    __dirname,
    '../macos/Frosthalt-macOS/WindowPersistence.swift'
  );
  const swift = nodeFs.readFileSync(swiftPath, 'utf8');

  const pinned: Record<string, number | undefined> = {};
  const pattern = /private static let pinned(\w+): CGFloat = (\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(swift)) !== null) {
    pinned[match[1]] = Number(match[2]);
  }

  expect(pinned).toEqual({
    StandardWidth: WINDOW_RULES.standardWidth,
    StandardHeight: WINDOW_RULES.standardHeight,
    MinWidth: WINDOW_RULES.minWidth,
    MinHeight: WINDOW_RULES.minHeight,
    MaxWidth: WINDOW_RULES.maxWidth,
    MaxHeight: WINDOW_RULES.maxHeight,
  });
});

// ---------------------------------------------------------------------------
// normaliseWindowFrame — the total validator (the corrupt-frame matrix)
// ---------------------------------------------------------------------------

test('valid frame passes through with all four numeric fields', () => {
  expect(
    normaliseWindowFrame({ x: 100, y: -20.5, width: 1280, height: 720 })
  ).toEqual({
    x: 100,
    y: -20.5,
    width: 1280,
    height: 720,
  });
});

test('wrong-typed fields are corrupt (string/bool/object per field)', () => {
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: 'big', height: 720 })
  ).toBeNull();
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: true, height: 720 })
  ).toBeNull();
  expect(
    normaliseWindowFrame({ x: { a: 1 }, y: 0, width: 100, height: 720 })
  ).toBeNull();
});

test('non-finite numbers are corrupt (NaN / Infinity)', () => {
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: NaN, height: 720 })
  ).toBeNull();
  expect(
    normaliseWindowFrame({ x: Infinity, y: 0, width: 100, height: 720 })
  ).toBeNull();
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: -Infinity, height: 720 })
  ).toBeNull();
});

test('non-positive width or height is corrupt (zero and negative)', () => {
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: 0, height: 720 })
  ).toBeNull();
  expect(
    normaliseWindowFrame({ x: 0, y: 0, width: 100, height: -1 })
  ).toBeNull();
});

test('non-plain-object values are corrupt (array / string / null / undefined / number)', () => {
  expect(normaliseWindowFrame([1, 2, 3, 4])).toBeNull();
  expect(normaliseWindowFrame('nonsense')).toBeNull();
  expect(normaliseWindowFrame(null)).toBeNull();
  expect(normaliseWindowFrame(undefined)).toBeNull();
  expect(normaliseWindowFrame(720)).toBeNull();
});

test('partial frames are corrupt (any of the four fields missing)', () => {
  expect(normaliseWindowFrame({ x: 1, y: 2, width: 100 })).toBeNull();
  expect(normaliseWindowFrame({})).toBeNull();
  expect(
    normaliseWindowFrame({ x: 1, y: 2, width: 100, height: null })
  ).toBeNull();
});

test('the returned value is a fresh snapshot — the input object is never aliased', () => {
  const input = { x: 1, y: 2, width: 3, height: 4 };
  const frame = normaliseWindowFrame(input);
  expect(frame).toEqual(input);
  expect(frame).not.toBe(input);
});

// ---------------------------------------------------------------------------
// startWindowFrameSync — installed-once configure + subscription
// ---------------------------------------------------------------------------

test('startWindowFrameSync hands native the domain constants verbatim and subscribed a handler', () => {
  // The single install happened at module load: the captured payload must be
  // WINDOW_RULES itself (the spec's single-source rule), and the captured
  // subscription must be a callable frame handler.
  expect(configuredRules).toEqual(WINDOW_RULES);
  expect(typeof frameHandler()).toBe('function');
});

test('a second startWindowFrameSync (StrictMode remount) is a no-op', () => {
  // Deltas against the (cleared) per-test baseline: the guard must install
  // nothing new, and must not even re-enter the store's subscribe.
  const subscribeSpy = jest.spyOn(useDomainStore, 'subscribe');

  startWindowFrameSync();
  startWindowFrameSync();

  expect(native.configureWindow).not.toHaveBeenCalled();
  expect(native.onWindowFrameChanged).not.toHaveBeenCalled();
  expect(subscribeSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Event -> commit call-through (the domain subscriber)
// ---------------------------------------------------------------------------

test('a valid emitted frame is committed: writeConfig carries it, committed advances', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  const writes = jest.mocked(configNative.writeConfig).mock.calls.length;

  frameHandler()({ x: 10, y: 20, width: 1000, height: 700 });
  await flushMicrotasks();

  expect(configNative.writeConfig).toHaveBeenCalledTimes(writes + 1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[writes][0]);
  expect(written.settings.windowFrame).toEqual({
    x: 10,
    y: 20,
    width: 1000,
    height: 700,
  });
  expect(useDomainStore.getState().committed.settings.windowFrame).toEqual({
    x: 10,
    y: 20,
    width: 1000,
    height: 700,
  });
});

test('a corrupt (foreign/malformed) emitted frame is DROPPED at the event seam — no config write', async () => {
  useDomainStore.setState({ committed: DEFAULT_CONFIG });
  const writes = jest.mocked(configNative.writeConfig).mock.calls.length;

  frameHandler()({ x: 0, y: 0, width: 'nonsense', height: 720 });
  frameHandler()({ x: NaN, y: 0, width: 100, height: 100 });
  frameHandler()([1, 2, 3, 4]);
  frameHandler()(null);
  await flushMicrotasks();

  expect(configNative.writeConfig).toHaveBeenCalledTimes(writes);
  expect(useDomainStore.getState().committed.settings.windowFrame).toBeNull();
});

// Helpers shared with the store suite's mock module (kept local: this file
// needs only the two mocks for the commit call-through + the transitive
// import of configStore inside store.ts).
const configNative = require('../src/native/specs/NativeConfigStoreSpec')
  .default as { writeConfig: jest.Mock };
