/**
 * TurboModule TS spec for NativeWindow (Story 6.4).
 *
 * This file is BOTH the codegen input and the JS-side contract. App-level
 * codegen (`codegenConfig` in package.json: name `FrosthaltSpecs`, type
 * `modules`, jsSrcsDir `src/native/specs`) reads this spec and generates the
 * native `<NativeWindowSpecSpec>` protocol header that the Obj-C++ glue in
 * `macos/Frosthalt-macOS/NativeWindow.mm` conforms to.
 *
 * This is the FOURTH native TurboModule in the repo. It owns the RN main
 * window's frame behaviour (Story 6.4): `configureWindow` hands native the
 * three size pairs (standard, min, max — six numbers) — ALL of them live in
 * `src/domain/windowFrame.ts` and are passed THROUGH here; native pins its
 * own copies (corrupt-restore standard fallback + restore clamps; they run
 * before JS exists) — and `onWindowFrameChanged` carries the debounced frame
 * native captured off `didEndLiveResize` + `didMove` back to the domain
 * subscriber (`src/domain/windowFrame.ts`'s `startWindowFrameSync()`), which
 * validates and commits it. Restore itself is native + launch-time
 * (`WindowPersistence.attach()` from `applicationDidFinishLaunching`) — there
 * is deliberately NO JS method on this module that applies a frame (the
 * spec's Never clause: no JS-driven restore).
 *
 * Same conventions as NativeMenuBar: uniform `{ ok, error? }` envelope over
 * JSI, zero-listener emitters are harmless, main-thread NSWindow mutations.
 */

import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Uniform result envelope for `configureWindow` (same `{ ok, error? }` shape
 * as the other three native modules). Declared as a `type` alias (not an
 * interface) for codegen compatibility.
 */
export type WindowResult = {
  ok: boolean;
  error?: string;
};

/**
 * The persisted/captured window frame crossing the bridge — the exact
 * `Settings.windowFrame` shape. Numbers are AppKit screen coordinates handed
 * through untouched (bottom-left origin); JS never interprets or transforms
 * them, only validates (`normaliseWindowFrame`) and persists them.
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility.
 */
export type WindowFramePayload = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The four size constants, JS-single-sourced in `src/domain/windowFrame.ts`
 * (`WINDOW_RULES`) and handed to native once at mount:
 *
 * - `standardWidth` / `standardHeight` — the app-standard size (the zoom
 *   toggle's target when zooming OFF a custom frame; the corrupt-restore
 *   fallback native pins separately must match).
 * - `minWidth` / `minHeight` — applied to `NSWindow.minSize` (AppKit clamps
 *   live during the drag, never snap-back).
 * - `maxWidth` / `maxHeight` — applied to `NSWindow.maxSize`.
 *
 * Declared as a `type` alias for codegen compatibility.
 */
export type WindowRules = {
  standardWidth: number;
  standardHeight: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};

export interface Spec extends TurboModule {
  /**
   * Applies the min/max clamps + records the zoom-target standard size on the
   * RN main window (main-thread dispatched, nil-guarded — a call before the
   * window exists is a no-op). Called exactly once, on app mount, by
   * `startWindowFrameSync()`; a repeat call just re-states the same rules.
   */
  configureWindow(rules: WindowRules): WindowResult;

  /**
   * Fires approximately 500 ms AFTER the last resize end / move settles, with
   * the final frame (`{x, y, width, height}`) — the debounce coalesces
   * intermediate frames into ONE emission. Not fired for zoom-initiated frame
   * changes (a zoom must not overwrite the user's custom size), nor while no
   * main window / miniaturized. Zero JS listeners is harmless (the 6.1
   * contract); the domain subscriber (`startWindowFrameSync()`) validates the
   * payload and fires `commitWindowFrame` at event time.
   */
  readonly onWindowFrameChanged: CodegenTypes.EventEmitter<WindowFramePayload>;
}

/**
 * JS-side handle to the native module. `getEnforcing` throws if the module is
 * not registered in the native binary — a build/link failure, surfaced loudly.
 */
export default TurboModuleRegistry.getEnforcing<Spec>('NativeWindow');
