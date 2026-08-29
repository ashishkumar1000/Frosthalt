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
 * returns `{ ok: true }`. Story 6.2 adds `setBadgeState` — the live badge /
 * countdown mirror (all derivation stays in JS, native just renders the final
 * strings + color). Actual click handling in JS (6.3) stays out of scope:
 * each actionable item fires its matching `EventEmitter<void>` with no
 * payload, and it is fine for no JS listener to exist yet.
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

/**
 * The live badge mirror payload (Story 6.2). All derivation happens in JS (the
 * domain mirror, `src/domain/menuBarMirror.ts` — the SAME Zustand slices the
 * in-window StatusHeader reads); native is a dumb renderer of the final
 * strings plus a color key:
 *
 * - `state`        — which badge-state color to paint the status-item title
 *                    with (`systemGreen` / `systemOrange` / `systemRed`, the
 *                    same NSColor names `tokens.status` maps). Native fails
 *                    toward blocked/red on an unknown value, mirroring
 *                    `computeBadgeState`'s fail-safe direction.
 * - `buttonTitle`  — the status-item button's title: the live `mm:ss` while a
 *                    session runs, else the badge label word.
 * - `rowTitle`     — the disabled first menu row's title:
 *                    `"{label} · {mm:ss | 'no active timer'}"`.
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility,
 * same as `MenuBarResult`.
 */
export type MenuBarBadgeState = {
  state: 'free' | 'amber' | 'blocked';
  buttonTitle: string;
  rowTitle: string;
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
   * Renders the live badge mirror: paints the status-item button's attributed
   * title with the `state` color + `buttonTitle` text, and swaps the disabled
   * first menu row's title for `rowTitle`. Main-thread dispatched,
   * fire-and-forget — always returns `{ ok: true }`. Safe before the build
   * block has run only by main-queue FIFO ordering (App calls `initialize()`
   * first); the nil-guard makes an out-of-order call a no-op, not a crash.
   */
  setBadgeState(badge: MenuBarBadgeState): MenuBarResult;

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
