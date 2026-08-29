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

import NativeMenuBar, { MenuBarResult } from './specs/NativeMenuBarSpec';

/**
 * Builds the app's one NSStatusItem + NSMenu, idempotently (a second call is
 * a no-op that still resolves `{ ok: true }`). Intended to be called exactly
 * once, on app mount (see `App.tsx`).
 */
export function initializeMenuBar(): MenuBarResult {
  return NativeMenuBar.initialize();
}
