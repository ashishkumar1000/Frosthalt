/**
 * The menu-bar badge mirror — the timer slice's designed THIRD subscriber
 * (Story 6.2).
 *
 * A module-level DOMAIN subscriber (the same pattern as the store's 4.5
 * expiry trigger and 5.4 schedule-transition trigger), not a React
 * component: the menu bar is native and has no render tree, so it needs a
 * store subscription, not a hook. `startMenuBarMirror()` (called once from
 * `App.tsx`'s mount effect, right after `initializeMenuBar()`) installs the
 * subscriptions and pushes the initial state; from then on the mirror is
 * fully driven by store churn.
 *
 * ONE SOURCE OF TRUTH, TWO RENDERERS (the epic-6 invariant): the mirror
 * derives from the EXACT inputs the in-window StatusHeader reads —
 *   - `useDomainStore`'s `committed`,
 *   - `useClockStore`'s per-second `nowMs` mirror (the badge + window state),
 *   - `useTimerStore`'s scoped countdown slice (the `mm:ss`),
 * through the SAME pure helpers (`computeBadgeState`, `selectRemainingMs`,
 * `formatMmSs`) with the SAME liveness normalisation (`!= null &&
 * Number.isFinite`, StatusHeader's exact check), so the menu-bar mirror and
 * the in-window header can never disagree. Nothing here re-derives badge or
 * countdown math independently.
 *
 * The mirror holds its OWN refcounted slot on the timer slice
 * (`start`/`stop` keyed on the normalised `activeTimer.endEpochMs`): the
 * slice was deliberately designed for three coexisting subscribers (Timer
 * surface 4.3 + StatusHeader 4.4 + menu bar 6.2), and owning a slot keeps
 * the mirror correct even if the header's lifecycle ever changes. It is a
 * PASSIVE subscriber to the clock slice (no slot) — the always-mounted
 * StatusHeader owns that driver, the same reliance the store's 5.4
 * transition trigger already makes.
 *
 * Native is a DUMB RENDERER: `deriveMenuBarBadge()` computes the final
 * strings + color key here in JS (Jest-testable), and the adapter
 * (`setMenuBarBadge`) just forwards them. The push is DEDUPED on the derived
 * triple — a tick whose derivation changes nothing fires no JSI call, and
 * churn that only touches unrelated store state fires none either.
 *
 * Dependency direction: domain -> native adapter (`src/native/menuBar.ts`),
 * never the reverse, never the UI. This module imports `store.ts` one-way —
 * `store.ts` does not import this (App.tsx is the only starter), so there is
 * no cycle.
 */

import type { Config } from '../config/types';
import { setMenuBarBadge } from '../native/menuBar';
import { computeBadgeState, badgeStateLabels, type BadgeState } from './badgeState';
import { useClockStore } from './clockStore';
import { useDomainStore } from './store';
import {
  useTimerStore,
  selectRemainingMs,
  formatMmSs,
  type TimerState,
} from './timerStore';

/**
 * The payload pushed to native — the final render strings plus the
 * badge-state color key. Structurally the spec's `MenuBarBadgeState`
 * (single `type` alias for codegen); re-declared here so the domain layer
 * does not import the TurboModule spec type into its derivation surface.
 */
export interface MenuBarBadge {
  /** Which badge-state color native paints the title with. */
  state: BadgeState;
  /**
   * The status-item button's title: the live `mm:ss` while a session runs
   * (the highest-value glance; the color carries the badge state), else the
   * badge label word.
   */
  buttonTitle: string;
  /** The disabled first menu row: `"{label} · {mm:ss | 'no active timer'}"`. */
  rowTitle: string;
}

/**
 * The inputs the pure derivation needs — exactly the three slices the
 * StatusHeader reads, so a test (or a future consumer) hands over the same
 * state the real mirror subscribes to.
 */
export interface MenuBarMirrorInputs {
  committed: Config;
  /** The clock slice's wall-clock mirror (drives the badge + windows). */
  nowMs: number;
  /** The timer slice's current state (drives the countdown). */
  timer: TimerState;
}

/**
 * Derive the menu-bar mirror payload. PURE — no store reads, no
 * `Date.now()`, no native calls — the single derivation both the mirror
 * wiring and the tests go through.
 *
 * Liveness (`hasActiveTimer`) mirrors StatusHeader's normalisation exactly
 * (`activeTimer != null && Number.isFinite(endEpochMs)`): `readConfig`
 * validates config.json at the top level only, so a malformed `endEpochMs`
 * must land in the no-timer branch here exactly as it does in the header —
 * never a `NaN:NaN` countdown in the menu bar.
 *
 * TOTAL: `computeBadgeState` never throws (fail-safe `'blocked'`) and
 * `formatMmSs` clamps non-finite input to `'00:00'`, so neither branch can
 * produce junk text for a malformed config.
 */
export function deriveMenuBarBadge({
  committed,
  nowMs,
  timer,
}: MenuBarMirrorInputs): MenuBarBadge {
  const state = computeBadgeState(committed, new Date(nowMs));
  const rawEndEpochMs = committed.activeTimer?.endEpochMs ?? null;
  const hasActiveTimer = rawEndEpochMs != null && Number.isFinite(rawEndEpochMs);
  const label = badgeStateLabels[state];
  if (!hasActiveTimer) {
    return { state, buttonTitle: label, rowTitle: `${label} · no active timer` };
  }
  const countdown = formatMmSs(selectRemainingMs(timer));
  return { state, buttonTitle: countdown, rowTitle: `${label} · ${countdown}` };
}

// ----- Module-level mirror state (NOT reactive — wiring bookkeeping, same
// convention as the store's transition baseline). -----

/** Installed-once guard: a second `startMenuBarMirror()` is a no-op. */
let started = false;

/**
 * The timer-slice slot the mirror currently holds (`endEpochMs` it last
 * called `start()` with, `null` when it holds none). Drives the
 * start/stop pairing in `syncTimerSlot` so the mirror's refcount contribution
 * stays balanced across session starts, supersessions and clears.
 */
let heldEndEpochMs: number | null = null;

/** The last payload pushed to native — the dedupe baseline. */
let lastPushed: MenuBarBadge | null = null;

/**
 * StatusHeader's liveness normalisation, isolated: the finite `endEpochMs`
 * when a live session is mirrored, else `null`.
 */
function normalisedActiveEnd(committed: Config): number | null {
  const raw = committed.activeTimer?.endEpochMs ?? null;
  return raw != null && Number.isFinite(raw) ? raw : null;
}

/**
 * Keep the mirror's timer-slice slot paired with the mirrored session:
 * `start(newEnd)` on a session appearing/changing, `stop()` on it clearing.
 * A same-value restart (an unrelated `committed` reference change, e.g. a
 * blocklist Apply during a live session) is skipped — the slot is already
 * held for that end, and churn would needlessly clear + reinstall the shared
 * driver.
 *
 * RE-ENTRANCY: `heldEndEpochMs` is booked BEFORE the `start()`/`stop()` call.
 * Both actions `set()` slice state, which notifies THIS module's own slice
 * subscription and re-enters `pushMirror` — by then the guard must already
 * read the NEW value, or the pair would ping-pong forever (start -> set ->
 * pushMirror -> "slot out of sync" -> start -> ...). The re-entrant push is
 * then harmless: it skips the sync, derives from the state the action just
 * wrote, and the outer derivation dedupes against it.
 */
function syncTimerSlot(committed: Config): void {
  const end = normalisedActiveEnd(committed);
  if (end === heldEndEpochMs) {
    return;
  }
  const prev = heldEndEpochMs;
  heldEndEpochMs = end;
  if (prev != null) {
    useTimerStore.getState().stop();
  }
  if (end != null) {
    useTimerStore.getState().start(end);
  }
}

/**
 * Derive from the CURRENT state of all three slices and push to native if
 * the derived triple actually changed. Called from every subscription (any
 * of the three stores churning may change the derivation) — the dedupe keeps
 * the native call count at "once per visible change", not once per churn.
 *
 * The slot sync runs BEFORE the derivation so a session-start push reads the
 * slice state that `start()` just mirrored (`start` sets `endEpochMs`/
 * `nowMs` synchronously) — the first push of a new session already shows the
 * correct countdown, never a stale `00:00`.
 *
 * The push itself is wrapped defensively: the native contract never throws,
 * but if it ever did, the dedupe baseline is cleared so the next churn
 * retries instead of silently pinning the menu bar to the pre-throw state.
 */
function pushMirror(): void {
  const committed = useDomainStore.getState().committed;
  syncTimerSlot(committed);
  const badge = deriveMenuBarBadge({
    committed,
    nowMs: useClockStore.getState().nowMs,
    timer: useTimerStore.getState(),
  });
  if (
    lastPushed != null &&
    lastPushed.state === badge.state &&
    lastPushed.buttonTitle === badge.buttonTitle &&
    lastPushed.rowTitle === badge.rowTitle
  ) {
    return;
  }
  lastPushed = badge;
  try {
    setMenuBarBadge(badge);
  } catch {
    lastPushed = null;
  }
}

/**
 * Install the mirror's subscriptions and push the initial state. Idempotent
 * — a second call (double mount, StrictMode re-run) is a no-op. Intended to
 * be called exactly once, on app mount, AFTER `initializeMenuBar()`: both
 * native calls dispatch onto the serial main queue in call order, so the
 * build is guaranteed to run before the first badge push lands.
 */
export function startMenuBarMirror(): void {
  if (started) {
    return;
  }
  started = true;
  // Any of the three slices churning can change the derivation — re-derive
  // from current state on each notification (the store's 4.5/5.4 trigger
  // pattern: derive in the subscriber, never cache across notifications).
  useDomainStore.subscribe(() => pushMirror());
  useClockStore.subscribe(() => pushMirror());
  useTimerStore.subscribe(() => pushMirror());
  // The initial push: covers both the fresh-launch Free state and the 4.7
  // launch re-arm (a persisted live session is derived — and its slot
  // acquired — on the very first push).
  pushMirror();
}