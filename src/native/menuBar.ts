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
