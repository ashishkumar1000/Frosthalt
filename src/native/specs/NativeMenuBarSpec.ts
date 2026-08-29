/**
 * TurboModule TS spec for NativeMenuBar (Story 6.1).
 *
 * This file is BOTH the codegen input and the JS-side contract. App-level
 * codegen (see `codegenConfig` in package.json: name `FrosthaltSpecs`,
 * type `modules`, jsSrcsDir `src/native/specs`) reads this spec and generates
 * the native `<NativeMenuBarSpecSpec>` protocol header that the Obj-C++ glue
 * in `macos/Frosthalt-macOS/NativeMenuBar.mm` conforms to.
 *
 * This is the THIRD and final native TurboModule in the repo (alongside
 * NativeConfigStore and NativeShellRunner) and the FIRST to emit events to
 * JS. It owns exactly one `NSStatusItem` + one `NSMenu`: a disabled
 * placeholder label row ("Free · no active timer" — 6.2 swaps the text, not
 * the item), a separator, then "Start 25-min focus" / "Show window" / "Quit".
 * `initialize()` builds that skeleton once, on the main thread, guarded by a
 * private native `isInitialized` flag — a second call is a no-op that still
 * returns `{ ok: true }`. Live badge/countdown content (6.2) and actual click
 * handling in JS (6.3) are out of scope here: each actionable item fires its
 * matching `EventEmitter<void>` with no payload, and it is fine for no JS
 * listener to exist yet.
 *
 * Every native method returns the uniform `{ ok, error? }` envelope over JSI,
 * matching the two existing native modules' convention.
 */

import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Uniform result envelope for `initialize()` (Consistency Conventions / Error
 * shape — same `{ ok, error? }` shape as NativeConfigStore/NativeShellRunner).
 *
 * - `ok` is always present.
 * - `error` is present only when `ok === false` (a short human-readable
 *   reason; not localised in v1). `initialize()` is not expected to fail in
 *   practice (there is no I/O), but the shape is kept uniform regardless.
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility:
 * codegen treats an exported object type alias as a value struct and emits
 * the matching native record/protocol.
 */
export type MenuBarResult = {
  ok: boolean;
  error?: string;
};

export interface Spec extends TurboModule {
  /**
   * Idempotently builds the one `NSStatusItem` + `NSMenu` (placeholder label
   * row, separator, "Start 25-min focus", "Show window", "Quit"), dispatched
   * onto the main thread. A second call is a no-op — no duplicate status item
   * is created — and both calls return `{ ok: true }`.
   */
  initialize(): MenuBarResult;

  /**
   * Fires with no payload when "Start 25-min focus" is clicked. Unlistened in
   * this story — 6.3 adds the JS handler (reusing the Epic 4 focus-session
   * start path).
   */
  readonly onQuickStart: CodegenTypes.EventEmitter<void>;

  /**
   * Fires with no payload when "Show window" is clicked. Unlistened in this
   * story — 6.3 adds the JS handler.
   */
  readonly onShowWindow: CodegenTypes.EventEmitter<void>;

  /**
   * Fires with no payload when "Quit" is clicked. Unlistened in this story —
   * 6.3 adds the JS handler.
   */
  readonly onQuit: CodegenTypes.EventEmitter<void>;
}

/**
 * JS-side handle to the native module. `getEnforcing` throws if the module is
 * not registered in the native binary — that is a build/link failure, not a
 * runtime user error, and is the right thing to surface loudly.
 */
export default TurboModuleRegistry.getEnforcing<Spec>('NativeMenuBar');
