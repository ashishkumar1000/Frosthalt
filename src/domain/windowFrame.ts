/**
 * The window-frame domain — sizes, normalisation, and the JS-side sync
 * (Story 6.4).
 *
 * Single source of truth for the three size PAIRS (six numbers: app-standard,
 * min, max — Design Notes) and the ONLY JS->native configurator:
 * `startWindowFrameSync` calls `configureWindow(WINDOW_RULES)` exactly once so
 * native (which pins its own copies of the standard/min/max fallback for the
 * corrupt-restore + restore-clamp cases, the "must match" comment in
 * `WindowPersistence.swift`) gets min/max + standard from here instead of
 * second copies drifting.
 *
 * Persistence flows the established direction: NATIVE captures the frame
 * (didEndLiveResize + didMove, debounced ~500 ms) and emits
 * `onWindowFrameChanged{frame}`; THIS module is the domain subscriber that
 * validates the payload at EVENT time and fires `commitWindowFrame(frame)`.
 * There is deliberately no JS-driven frame application at launch (Never
 * clause) — restore happens natively inside `applicationDidFinishLaunching`,
 * before the JS bundle runs, because a JS restore would visibly jump and
 * ConfigStore is only readable from JS.
 *
 * `normaliseWindowFrame` is the JS read normaliser for
 * `settings.windowFrame` (types.ts): a stored value with wrong types,
 * non-finite or non-positive width/height is CORRUPT -> `null` (never a
 * crash, never a config rejection — the `Schedule.domains` per-field-
 * defensive precedent). It is also the event-time validator: a malformed
 * native payload is dropped, nothing committed.
 *
 * Idempotency (StrictMode / remount): `startWindowFrameSync()` is
 * installed-once — the native configure call and the event subscription each
 * happen exactly once no matter how often it is invoked (the 6.2/6.3 mirror/
 * actions pattern). Zero listeners before this runs are harmless (the 6.1
 * contract the emitters carry).
 *
 * Dependency direction: domain -> native adapters + store, one-way, exactly
 * like `menuBarActions.ts` — `store.ts` never imports this (no cycle: the
 * frame normaliser lives here so the store action can stay a pure
 * setPassword-discipline clone, and any JS reader of `settings.windowFrame`
 * normalises through THIS module), and the UI never imports it.
 */

import NativeWindow from '../native/specs/NativeWindowSpec';
import type {
  WindowFramePayload,
  WindowRules,
} from '../native/specs/NativeWindowSpec';
import { configureWindowFrame } from '../native/window';
import { useDomainStore } from './store';

/**
 * The three size pairs (Design Notes — planner decision, UX-DR18 leaves
 * them numeric-free): app-standard 1280x720 (parity with what the app opens
 * at today), min 880x560 (sidebar + status header fit comfortably), max
 * 2560x1440. Adjusting them later is a one-line change HERE.
 *
 * The native side carries its own PINNED copies of all three pairs (they run
 * before JS exists and cannot be configured from here): the corrupt-restore
 * standard fallback and the restore-time clamp bounds in
 * `WindowPersistence.swift`, under ONE "must match" comment block pointing at
 * this constant. If you change one, change BOTH — the drift is guarded by a
 * running test (`__tests__/windowFrame.test.ts` reads the Swift file as
 * text), not just a comment.
 */
export const WINDOW_RULES: WindowRules = {
  standardWidth: 1280,
  standardHeight: 720,
  minWidth: 880,
  minHeight: 560,
  maxWidth: 2560,
  maxHeight: 1440,
};

/**
 * The persisted window frame, or the null-typed WINDOW frame stored value.
 * NOTE: this is the payload shape crossing the bridge (the spec's
 * `WindowFramePayload`); the domain re-declares it physically as the config
 * type via `normaliseWindowFrame` (single validation, both directions).
 */
export type { WindowFramePayload };

/**
 * Validate + normalise an unknown value into a `WindowFrame`. TOTAL and
 * PURE: returns `null` for anything that is not a plain object holding four
 * finite numbers with positive width and height — a corrupt stored value or
 * a malformed native payload must never crash a reader (Never clause) and
 * must never reject an otherwise-valid config (configStore's whole-config
 * gate is untouched; corruption is folded to ABSENT per types.ts).
 *
 * The four fields are required TOGETHER: a partial frame is corrupt, not
 * half-usable (native can only set a complete `NSRect`). The returned value
 * is a fresh snapshot built from the validated numbers — the original object
 * (hand-edited config or a foreign emitter payload) is never aliased.
 */
export function normaliseWindowFrame(
  value: unknown
): WindowFramePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const x = raw.x;
  const y = raw.y;
  const width = raw.width;
  const height = raw.height;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null;
  }
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

/** Event-time handler: validate then direct-commit (fire-and-forget). */
function handleFrameChanged(payload: unknown): void {
  const frame = normaliseWindowFrame(payload);
  if (frame == null) {
    // Corrupt/foreign payload: dropped at the event seam, nothing written.
    return;
  }
  void useDomainStore
    .getState()
    .commitWindowFrame(frame)
    .catch(() => {
      // Defensive — the enqueue body never rejects, but a fire-and-forget
      // trigger must never surface an unhandled rejection.
    });
}

/** Installed-once guard: a second `startWindowFrameSync()` is a no-op. */
let started = false;

/**
 * Configure the native window (min/max clamps + the zoom-target standard
 * size, all from WINDOW_RULES) and subscribe the frame-change emitter. Both
 * installs happen EXACTLY once on success: a second call (double mount,
 * StrictMode re-run) registers nothing and re-configures nothing. Intended to
 * be called exactly once, on app mount (the menu-bar FIFO pattern in
 * `App.tsx` — the ordering matters only for install sequencing; routes to
 * native are independent so there is no ordering hazard).
 */
export function startWindowFrameSync(): void {
  if (started) {
    return;
  }
  // Throw-safety (6.4 review): the guard flips to true ONLY after both
  // installs succeeded. If either call throws (native seam hiccup), the flag
  // stays false (a re-configure is idempotent; a double-subscribe cannot
  // happen because the thrown call is the one that never completed), so a
  // later mount retries the install instead of being permanently blocked by
  // a stuck started=true.
  try {
    // A `{ok:false, error}` envelope is still dropped (not thrown) — the
    // window works on AppKit's own defaults; only a synchronous throw rewinds.
    configureWindowFrame(WINDOW_RULES);
    NativeWindow.onWindowFrameChanged(handleFrameChanged);
  } catch (e) {
    started = false;
    throw e;
  }
  started = true;
}
