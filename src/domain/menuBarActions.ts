/**
 * The menu-bar click actions — the timer slice saga's click-side wiring
 * (Story 6.3).
 *
 * A module-level DOMAIN subscriber (the same pattern as 6.2's
 * `menuBarMirror.ts`), not a React component: the menu-bar item clicks arrive
 * as native events and need a lifetime-long handler set, not a hook.
 * `startMenuBarActions()` (called once from `App.tsx`'s mount effect, right
 * after `initializeMenuBar()` / `startMenuBarMirror()`) subscribes to the two
 * actionable events and never returns.
 *
 *   - `onQuickStart` — "Start 25-min focus": reuses the EXISTING Epic 4 start
 *     path verbatim — one `stageStartTimer({durationMs, selected})` call, so
 *     the store's own validation, serialized apply queue, and the ONE admin
 *     prompt inside its `writeHosts` are inherited unchanged (no reimplementation,
 *     no new privileged logic, no separate hosts pipeline). Selection defaults
 *     to ALL committed domain hostnames — the Timer UI's own first-run fallback
 *     (`Timer.tsx`'s `initialSelection`), the only workable reading of
 *     "last-used" since the app persists no selection outside a live session
 *     (`activeTimer.selectedDomains` dies with it) and a menu quick-start
 *     typically happens while idle.
 *
 *     The gates replicate `handleStart`'s (Timer.tsx:418-474), re-read from
 *     `useDomainStore.getState()` at EVENT time (never cached): no-op when a
 *     session is already live, when an Apply is running, or when
 *     `committed.domains` is empty. The result is intentionally un-announced —
 *     the menu bar IS the feedback surface (the 6.2 mirror flips the badge the
 *     moment `committed` changes); a quiet `{ok:false}` (admin deny, store
 *     error) just leaves the badge at Free.
 *
 *   - `onShowWindow` — deliberately UNLISTENED: show-window is pure AppKit
 *     activation with no state, no gating, nothing for JS to decide
 *     (`MenuBar.swift`'s `handleShowWindow` does it natively on click), so no
 *     round-trip through JS exists. The event still fires — harmless with no
 *     listeners (the 6.1 contract).
 *
 *   - `onQuit` — "Quit": routes to the native `quitApp()` adapter so the
 *     termination decision lives in JS. STORY 6.5 FORWARD-REFERENCE: the
 *     quit-CONFIRM dialog (⌘Q with a live session, Esc to cancel) extends
 *     THIS handler — an unconditional quit stays correct until then; the
 *     handler below is where the confirm-before-quit lands.
 *
 * Dependency direction (the 6.2 rule): this module imports `store.ts` and the
 * native adapter one-way — `store.ts` does not import this, the UI never
 * imports it (`App.tsx` is the only starter), so there is no cycle.
 */

import NativeMenuBar from '../native/specs/NativeMenuBarSpec';
import { quitApp } from '../native/menuBar';
import { useDomainStore } from './store';
import { PRESET_MINUTES } from './timerPresets';

/**
 * The quick-start duration — the FIRST preset (25 minutes), single-sourced
 * with the Timer surface's chip row via the hoisted domain constant.
 */
const QUICK_START_MS = PRESET_MINUTES[0] * 60_000;

/**
 * The quick-start click handler. Reads state ONLY via
 * `useDomainStore.getState()` at event time, then (if every gate passes)
 * fires the same `stageStartTimer` action the Timer surface's Start button
 * uses — fire-and-forget (`void`): the faithful result path is the mirror
 * re-deriving `committed`, not a toast this module has no surface to show.
 */
function handleQuickStart(): void {
  const { committed, applyStatus, stageStartTimer } = useDomainStore.getState();
  // Empty blocklist: nothing to select, and the store's `empty-selection`
  // guard would reject the call anyway — bail before reaching the store
  // (spec's I/O matrix: "store NOT called").
  const isEmpty = committed.domains.length === 0;
  if (isEmpty) {
    return;
  }
  // Live session — the SAME liveness normalisation Timer.tsx:189-194 applies
  // (`activeTimer != null && Number.isFinite(endEpochMs)`), so a malformed
  // persisted `endEpochMs` cannot mask an idle app into a do-nothing
  // quick-start (and conversely never double-starts over a live one).
  const rawEndEpochMs = committed.activeTimer?.endEpochMs ?? null;
  const hasActiveTimer =
    committed.activeTimer != null &&
    rawEndEpochMs != null &&
    Number.isFinite(rawEndEpochMs);
  if (hasActiveTimer) {
    return;
  }
  // Apply in flight — a start would queue behind (or interleave with) the
  // run and raise a second admin prompt. Timer's Start gates on the
  // call-time `applyStatus === 'running'`; so does this handler.
  if (applyStatus === 'running') {
    return;
  }
  // All-committed selection: the pre-check fallback the Timer UI uses on
  // first use (there is no persisted selection to restore — see header).
  const selected = new Set(committed.domains.map((d) => d.hostname));
  void stageStartTimer({
    durationMs: QUICK_START_MS,
    selected,
    // The result is deliberately dropped: `{ok:false}` (admin deny / store
    // error) leaves the badge at Free — the same quiet outcome a denied
    // in-window start produces on the header (Design Notes).
  });
}

/** Installed-once guard: a second `startMenuBarActions()` is a no-op. */
let started = false;

/**
 * Install the menu-bar click handlers. Idempotent — a second call (double
 * mount, StrictMode re-run) registers nothing twice (the 6.2 mirror pattern).
 * Intended to be called exactly once, on app mount, after `initializeMenuBar()`
 * (and the mirror start): the emitters tolerate zero listeners before this
 * runs, so clicks fired during the gap are simply dropped, not queued.
 */
export function startMenuBarActions(): void {
  if (started) {
    return;
  }
  started = true;
  NativeMenuBar.onQuickStart(handleQuickStart);
  // Story 6.5 lands its confirm before this call site — today it is an
  // unconditional quit (the store/apply pipeline's own atomicity leaves
  // hosts consistent if an Apply is mid-run when the app exits). The body
  // status must be `void` (the emitter's handler signature), so the
  // `{ok,error?}` envelope is dropped — quit has no JS-side UI to report to.
  NativeMenuBar.onQuit(() => {
    quitApp();
  });
}
