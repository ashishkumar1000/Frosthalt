/**
 * The timer slice — the SCOPED live-countdown source (Story 4.3).
 *
 * Deliberately a SEPARATE Zustand store from `useDomainStore` (epic-4-context,
 * "Countdown lives in a scoped Zustand slice that DOES NOT live on the same
 * store as `committed` / `staged` / `applyStatus`"): the Timer surface (4.3),
 * the status header (4.4) and the menu bar (6.2) subscribe here, while the
 * blocklist / settings / schedule trees never re-render on a countdown tick.
 *
 * State (runtime-only — nothing here is persisted; wall-clock is the source
 * of truth, mirroring the Epic 3 runtime-only gate-state model):
 *   - `nowMs`      — the per-second wall-clock mirror, advanced by a single
 *     module-level `setInterval(1000)` driver.
 *   - `endEpochMs` — the running session's absolute end time, mirrored from
 *     `committed.activeTimer.endEpochMs` by the consumer's `start()` call.
 *     `null` when no session is mirrored.
 *   - `totalMs`    — the session's full duration, captured ONCE at the first
 *     `start()` for a given `endEpochMs` (`endEpochMs - Date.now()`), so
 *     consumers derive the ring's `progress = 1 - remaining/total` without
 *     duplicating the total-derivation math (the design-note alternative; the
 *     4.4 mini ring wants the same derivation). Sticky across subscriber
 *     remounts so the ring reflects elapsed wall-clock progress when the
 *     surface re-mounts mid-session, never a reset-to-full ring.
 *
 * Actions:
 *   - `start(endEpochMs)` — acquire a subscriber slot. Idempotent + defensive:
 *     any existing interval is cleared before a new one starts (no
 *     double-driver, even on a double-mount / StrictMode re-run), and a
 *     non-finite or already-expired `endEpochMs` parks the slice IMMEDIATELY
 *     (no zero-second tick loop). Refcounted: every `start` increments the
 *     internal count so
 *     Timer (4.3) + status header (4.4) + menu bar (6.2) can coexist without
 *     three drivers.
 *   - `stop()` — release a subscriber slot. When the refcount hits 0 the
 *     interval clears and `nowMs` parks at `Date.now()` (the ring pauses).
 *     Defensive: calling `stop()` with no live subscribers is a no-op on the
 *     refcount but still clears + parks.
 *
 * Self-park on expiry: when a tick observes `nowMs >= endEpochMs` the driver
 * clears itself and parks `nowMs` AT `endEpochMs` (remaining reads exactly
 * 0 — no negative ring). 4.3 does NOT unblock on expiry — Story 4.5 owns the
 * privileged write; surfaces keep showing `00:00` until it runs.
 */

import { create } from 'zustand';

export interface TimerState {
  /** Per-second wall-clock mirror (never persisted). */
  nowMs: number;
  /** The running session's absolute end time, or `null` when none mirrored. */
  endEpochMs: number | null;
  /** Full session duration (captured at first `start`), or `null` when none. */
  totalMs: number | null;
  /**
   * Acquire a subscriber slot + (re)start the per-second driver. Idempotent:
   * clears any existing interval first. Parks immediately (no interval) when
   * `endEpochMs` is non-finite or already expired.
   */
  start: (endEpochMs: number) => void;
  /**
   * Release a subscriber slot. At refcount 0 the driver clears and `nowMs`
   * parks at `Date.now()`.
   */
  stop: () => void;
}

/**
 * The single derived value consumers subscribe to: milliseconds remaining in
 * the running session, clamped at 0. When no session is mirrored
 * (`endEpochMs == null`) the selector returns 0 — consumers gate rendering on
 * their own `activeTimer != null` state, not on this selector.
 */
export const selectRemainingMs = (s: TimerState): number =>
  Math.max(0, (s.endEpochMs ?? 0) - s.nowMs);

/**
 * The ring's progress fraction, `0..1` (`1 - remaining/total`): 1 = just
 * started (full ring), 0 = empty/expired. Derived INSIDE the slice so stroke
 * + numeral + ring stay single-derivation (the 4.3 design note) — every
 * countdown consumer (Timer surface 4.3, status header 4.4, menu bar 6.2)
 * reads the exact same pair and can never desync.
 *
 * `total <= 0` (no session mirrored / expired park) reads 0 — an empty ring,
 * never a NaN or a negative dash. The result is clamped defensively so a
 * drifted value never over- or under-draws the dash.
 */
export const selectProgress = (s: TimerState): number => {
  const total = s.totalMs ?? 0;
  if (total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, 1 - selectRemainingMs(s) / total));
};

/**
 * The shared zero-padded `mm:ss` formatter (Story 4.4 moved Timer.tsx's
 * inline math here so the numeral is single-derivation too). Minutes are NOT
 * capped at two digits: a 24 h session renders `1440:00` — the same string
 * the Timer surface numeral has always shown (frozen-spec-conformant). The
 * input is clamped at 0 so a negative remaining (defensive) renders `00:00`,
 * never a negative numeral; a NON-FINITE input (NaN / Infinity — unreachable
 * through the current consumers, but this is the shared derivation source)
 * also renders `00:00`, never `NaN:NaN`.
 */
export const formatMmSs = (remainingMs: number): string => {
  if (!Number.isFinite(remainingMs)) {
    return '00:00';
  }
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(remainingSec / 60)
    .toString()
    .padStart(2, '0');
  const ss = (remainingSec % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
};

// ----- Module-level driver state (NOT reactive — the interval handle and the
// subscriber refcount are implementation details; putting them in the store
// would make every tick a state churn for no consumer benefit). -----

let intervalId: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

/** Clear the per-second driver if it is running. */
function clearDriver(): void {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export const useTimerStore = create<TimerState>()((set, get) => ({
  nowMs: Date.now(),
  endEpochMs: null,
  totalMs: null,

  start: (endEpochMs) => {
    // Acquire the subscriber slot BEFORE the park check: even an
    // already-expired session holds its subscriber slot so a later `stop()`
    // stays balanced (refcount semantics are start/stop pairs).
    refCount += 1;
    // Idempotent: no double-driver. A `start` while an interval is live
    // clears it first, so at most ONE `setInterval(1000)` ever runs.
    clearDriver();

    // NOTE: `readConfig` validates config.json at the TOP LEVEL only — it
    // does not shape-check element values, so a malformed `activeTimer` can
    // hand this action a non-numeric `endEpochMs`. `NaN <= Date.now()` is
    // false and a string would coerce into an interval that NEVER parks, so
    // non-finite values are parked exactly like expired ones.
    if (!Number.isFinite(endEpochMs) || endEpochMs <= Date.now()) {
      // Defensive: an already-expired (or malformed) end time parks
      // immediately — no zero-second tick loop. A malformed value parks at
      // wall-clock so `selectRemainingMs` reads exactly 0 (never NaN through
      // to the numeral); `totalMs: 0` keeps the ring empty.
      set({
        nowMs: Date.now(),
        endEpochMs: Number.isFinite(endEpochMs) ? endEpochMs : Date.now(),
        totalMs: 0,
      });
      return;
    }

    // `totalMs` is sticky per session: capture the full duration at the FIRST
    // start for this `endEpochMs` so a subscriber remount (surface navigation)
    // does not reset the ring to full. A new (superseding) session re-captures.
    const prev = get();
    const totalMs =
      prev.endEpochMs === endEpochMs && prev.totalMs != null
        ? prev.totalMs
        : Math.max(0, endEpochMs - Date.now());

    set({ nowMs: Date.now(), endEpochMs, totalMs });

    intervalId = setInterval(() => {
      const now = Date.now();
      const end = get().endEpochMs;
      if (end == null || now >= end) {
        // Expired (or the mirror was cleared): self-park. `nowMs` parks AT
        // `endEpochMs` so `selectRemainingMs` reads exactly 0 — the numeral
        // holds `00:00` and the ring holds empty until Story 4.5's expiry
        // path clears `committed.activeTimer`.
        clearDriver();
        set({ nowMs: end ?? now });
        return;
      }
      set({ nowMs: now });
    }, 1000);
  },

  stop: () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      // Last subscriber gone (or a defensive stop with none): clear the
      // driver and park `nowMs` at wall-clock now — the ring pauses. The
      // next `start(endEpochMs)` restarts cleanly from wall-clock.
      clearDriver();
      set({ nowMs: Date.now() });
    }
  },
}));