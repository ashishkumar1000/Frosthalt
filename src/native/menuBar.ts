/**
 * Story 6.1 — thin JS entry point for the MenuBar TurboModule.
 *
 * `initializeMenuBar()` just forwards to the native spec's `initialize()` and
 * returns its `{ ok, error? }` envelope untouched — there is no JS-side
 * shape/resilience logic here (unlike `configStore.ts`'s JSON parsing):
 * `initialize()` has no payload to parse and the native side never throws
 * (mirrors the other two modules' never-throw contract), so nothing needs
 * normalising on the way back.
 */

import NativeMenuBar, {
  MenuBarBadgeState,
  MenuBarResult,
} from './specs/NativeMenuBarSpec';

/**
 * Builds the app's one NSStatusItem + NSMenu, idempotently (a second call is
 * a no-op that still resolves `{ ok: true }`). Intended to be called exactly
 * once, on app mount (see `App.tsx`).
 */
export function initializeMenuBar(): MenuBarResult {
  return NativeMenuBar.initialize();
}

/**
 * Story 6.2 — renders the live badge mirror (button title + first menu row).
 * Forwards the payload untouched and returns the `{ ok, error? }` envelope:
 * all derivation lives in the domain mirror (`src/domain/menuBarMirror.ts`),
 * which is the only intended caller (once per actual state change).
 */
export function setMenuBarBadge(badge: MenuBarBadgeState): MenuBarResult {
  return NativeMenuBar.setBadgeState(badge);
}

/**
 * Story 6.3 — quits the app (main-thread-dispatched `NSApp.terminate(nil)` in
 * the Swift impl). Since Story 6.5 this is just a quit ENTRY — the terminate
 * rides through the native `applicationShouldTerminate:` gate, which defers
 * any un-confirmed quit back to JS via `onQuitRequested`. Forwards the
 * payload-less call untouched and returns the `{ ok, error? }` envelope: the
 * quit DECISION lives in JS (`startMenuBarActions`), so this stays a dumb
 * one-line forwarder like the two wrappers above.
 */
export function quitApp(): MenuBarResult {
  return NativeMenuBar.quit();
}

/**
 * Story 6.5 — the "go" leg of the quit confirm: sets the native terminate-
 * confirm flag and dispatches `NSApp.terminate(nil)`, which the delegate
 * consumes (flag reset — the gate re-arms). Called ONLY from the
 * `onQuitRequested` handler (no-timer quit, or the dialog's Quit button);
 * forwards untouched like the wrappers above.
 */
export function confirmQuit(): MenuBarResult {
  return NativeMenuBar.confirmQuit();
}

/**
 * Story 6.5 — fronts the main window (activate + deminiaturize/order front)
 * so the JS confirm `Alert.alert` — a sheet on the RN window — is visible
 * when the window was closed to the menu bar. Called only when a dialog is
 * about to show; forwards untouched like the wrappers above.
 */
export function presentQuitConfirm(): MenuBarResult {
  return NativeMenuBar.presentQuitConfirm();
}
