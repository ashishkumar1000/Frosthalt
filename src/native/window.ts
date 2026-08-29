/**
 * Story 6.4 — thin JS entry point for the Window TurboModule.
 *
 * `configureWindowFrame()` just forwards the domain constants
 * (`WINDOW_RULES`, `src/domain/windowFrame.ts`) to the native spec's
 * `configureWindow()` and returns its `{ ok, error? }` envelope untouched —
 * a dumb one-line forwarder like the three `menuBar.ts` wrappers. No JS-side
 * frame logic lives here: native owns capture/restore/zoom, the domain owns
 * validation + persistence, and this adapter only carries the numbers.
 */

import NativeWindow, {
  WindowRules,
  WindowResult,
} from './specs/NativeWindowSpec';

/**
 * Applies the min/max clamps + zoom-target standard size to the RN main
 * window. Intended to be called exactly once, on app mount, from
 * `startWindowFrameSync()` (see `src/domain/windowFrame.ts`).
 */
export function configureWindowFrame(rules: WindowRules): WindowResult {
  return NativeWindow.configureWindow(rules);
}
