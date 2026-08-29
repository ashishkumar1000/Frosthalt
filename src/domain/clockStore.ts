/**
 * The clock slice — the SCOPED per-second wall-clock mirror (Story 5.4).
 *
 * A tiny Zustand store `{ nowMs }` whose value advances once per second while
 * at least one subscriber holds a slot. It is the ONE place in the domain
 * layer that calls `Date.now()` per tick: every consumer (the store's
 * schedule-transition trigger, StatusHeader's live count + badge) reads the
 * mirrored `nowMs` and derives a `Date` from it, so all evaluation stays pure
 * with an injected `now`.
 *
 * ONE-WAY IMPORT RULE: this module imports NOTHING from `store.ts` (the same
 * rule `timerStore.ts` carries — store -> timerStore, never back). The
 * dependency direction is `UI -> domain -> adapters -> ports`; the clock slice
 * sits at the domain layer's leaf, and `store.ts` may subscribe to it, but it
 * must never reach into the store — that would create a cycle and invert the
 * layering.
 *
 * Driver pattern: copied verbatim from `timerStore.ts` (the Story 4.3
 * refcounted module-level driver) — `refCount` + `clearDriver()` + a single
 * module interval so at most ONE 1s interval ever runs, no matter how many
 * components subscribe. `start()` is idempotent-per-call (it clears any
 * existing driver before installing a fresh one) and the LAST `stop()`
 * clears the driver and parks `nowMs` at the wall clock. Unlike the timer
 * slice there is no self-park: the clock runs while the app runs.
 *
 * Runtime-only, never persisted — `nowMs` is a mirror, not state.
 */

import { create } from 'zustand';

export interface ClockState {
  /**
   * Per-second wall-clock mirror in epoch ms. Updated by the driver's tick
   * (once per second while refCount > 0) and re-synced from the wall clock
   * on every `start()` / last `stop()`. Never persisted.
   */
  nowMs: number;
  /**
   * Acquire a subscriber slot and (re)start the per-second driver. Safe to
   * call from a mount effect: the refcount makes nested/duplicate subscribers
   * share ONE interval.
   */
  start: () => void;
  /**
   * Release a subscriber slot. The driver only dies when the LAST slot is
   * released (refCount reaches 0) — at which point `nowMs` is parked at the
   * wall clock so a later re-mount starts from a fresh, correct time. An
   * unpaired `stop()` (no slot held) is a TRUE no-op: it neither decrements
   * nor re-syncs `nowMs`, so it can never fire a spurious mirror update at
   * subscribers with no live driver.
   */
  stop: () => void;
}

// Module-level driver state (the timerStore pattern verbatim): one interval
// max, refcounted across subscribers.
let intervalId: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function clearDriver(): void {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export const useClockStore = create<ClockState>()((set) => ({
  // Initialised from the wall clock at module load; the driver keeps it fresh
  // while subscribed and re-syncs it on start/stop boundaries.
  nowMs: Date.now(),

  start: () => {
    refCount += 1;
    // Clear-then-reinstall (the timerStore pattern): at most one driver ever
    // runs, and a restart always begins from a fresh wall-clock read.
    clearDriver();
    // Sync immediately so the first subscriber sees a current `nowMs` (and
    // any store-level tick subscriber sees the mount-time evaluation) before
    // the first interval tick lands.
    set({ nowMs: Date.now() });
    intervalId = setInterval(() => {
      set({ nowMs: Date.now() });
    }, 1000);
  },

  stop: () => {
    if (refCount === 0) {
      // Unpaired stop: nothing held, nothing to release, nothing to re-sync.
      // A re-sync here would fire subscribers (the store's transition
      // trigger) with no live driver behind the mirror.
      return;
    }
    refCount -= 1;
    if (refCount === 0) {
      // Last subscriber gone: kill the driver and park the mirror at the
      // wall clock (no stale time carried across a remount).
      clearDriver();
      set({ nowMs: Date.now() });
    }
  },
}));