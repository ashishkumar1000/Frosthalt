/**
 * The menu-bar click actions — the timer slice saga's click-side wiring
 * (Story 6.3).
 *
 * A module-level DOMAIN subscriber (the same pattern as 6.2's
 * `menuBarMirror.ts`), not a React component: the menu-bar item clicks arrive
 * as native events and need a lifetime-long handler set, not a hook.
 * `startMenuBarActions()` (called once from `App.tsx`'s mount effect, right
 * after `initializeMenuBar()` / `startMenuBarMirror()`) subscribes to the
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
 *     quit ENTRY lives in JS. Since 6.5 this is not the destination — the
 *     dispatched `NSApp.terminate` funnels through the native
 *     `applicationShouldTerminate:` gate right back into `onQuitRequested`
 *     below, one path shared with ⌘Q / Dock / the storyboard Quit item.
 *
 *   - `onQuitRequested` (Story 6.5) — the quit-confirm DECISION. Native has
 *     already cancelled every un-confirmed quit and asks here. The gate is
 *     live session ONLY (`committed.activeTimer != null` with a finite
 *     `endEpochMs` — the Timer.tsx normalisation; `applyStatus === 'running'`
 *     does NOT trigger the confirm — 6.3's apply pipeline writes hosts
 *     atomically, so a mid-Apply quit leaves hosts consistent):
 *
 *       - no live session -> native `confirmQuit()` immediately: the
 *         terminate resumes with no dialog and NO window fronting (⌘Q never
 *         flashes the window to dismiss it).
 *       - live session -> native `presentQuitConfirm()` (front the RN window
 *         so the `Alert.alert` sheet — a sheet on that window — is visible
 *         even when it was closed to the menu bar), then the repo's standard
 *         two-button confirm `Alert.alert` (Blocklist.tsx / Schedule.tsx
 *         shape): `Cancel` style `cancel` first, `Quit` style `destructive`.
 *         Cancel/Esc (the native sheet maps Esc to the cancel button — no JS
 *         keyboard listener) keeps the app alive; Quit resets the pending
 *         guard and calls `confirmQuit()`.
 *
 *     A module-level staleness-windowed `quitDialogPendingSince` guard makes a
 *     duplicate terminate
 *     attempt while the dialog is open a no-op (no second dialog; the second
 *     attempt simply cancels inside the gate) and the guard resets on BOTH
 *     buttons, so the gate re-arms for a later ⌘Q.
 *
 * Dependency direction (the 6.2 rule): this module imports `store.ts` and the
 * native adapter one-way — `store.ts` does not import this, the UI never
 * imports it (`App.tsx` is the only starter), so there is no cycle.
 */

import { Alert } from 'react-native';
import NativeMenuBar from '../native/specs/NativeMenuBarSpec';
import { confirmQuit, presentQuitConfirm, quitApp } from '../native/menuBar';
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

// ---------------------------------------------------------------------------
// Quit gate (Story 6.5)
// ---------------------------------------------------------------------------

/**
 * The quit-confirm confirm copy — plain and factual (state the situation and
 * the choice; the epic-6 UX rule: no dramatization), in the two-button shape
 * Blocklist.tsx / Schedule.tsx use.
 */
const QUIT_CONFIRM_TITLE = 'Quit Frosthalt?';
const QUIT_CONFIRM_BODY =
  'A focus session is running. The session ends if the app quits.';

/**
 * When the quit-confirm dialog went up, or null while it is down. A
 * module-level STALENESS-WINDOWED GUARD (the mirror image of native's
 * terminate flag): a second terminate attempt arriving mid-dialog (double
 * ⌘Q) lands back in `handleQuitRequested` after the gate re-armed — within
 * the window this makes that attempt a no-op (no second dialog, no double
 * `confirmQuit()`), not a confirmation loop. Reset on BOTH buttons so the
 * gate re-arms for whichever way the dialog closes.
 *
 * The window exists because the dialog is not guaranteed to end through a
 * button: the sheet dies un-pressed if the window closes mid-dialog (⌘W) or
 * the system dismisses it. A plain boolean would stay pending forever and
 * every later quit would be a silent no-op — so a request arriving after
 * `QUIT_DIALOG_STALE_MS` is treated as an orphaned guard: reset and
 * re-show, never brick.
 */
const QUIT_DIALOG_STALE_MS = 10_000;
let quitDialogPendingSince: number | null = null;

/**
 * The quit-requested handler — native has cancelled an un-confirmed quit and
 * asked JS for the verdict. Reads the store via `useDomainStore.getState()`
 * at EVENT time (never cached), decides confirm-vs-go:
 *
 *   - duplicate attempt mid-dialog (fresh request) -> no-op (the pending
 *     guard);
 *   - stale-pending (the dialog died without a button press) -> orphaned
 *     guard: reset and re-show;
 *   - no live session -> `confirmQuit()` directly: resume the terminate with
 *     NO dialog and NO window fronting (no flash);
 *   - live session -> `presentQuitConfirm()` (front the RN window — a sheet
 *     on an ordered-out window is invisible) THEN the confirm `Alert.alert`.
 *
 * The gate is live session ONLY (`applyStatus === 'running'` is deliberately
 * not a gate: 6.3's apply pipeline writes hosts atomically, so a mid-Apply
 * quit cannot leave hosts torn — the 6.3 matrix).
 */
function handleQuitRequested(): void {
  if (
    quitDialogPendingSince != null &&
    Date.now() - quitDialogPendingSince < QUIT_DIALOG_STALE_MS
  ) {
    return;
  }
  quitDialogPendingSince = null;
  const { committed } = useDomainStore.getState();
  // The SAME liveness normalisation Timer.tsx:191-196 applies
  // (`activeTimer != null && Number.isFinite(endEpochMs)`), so a malformed
  // persisted `endEpochMs` cannot hold an idle app hostage behind a confirm
  // dialog (and never masks a live session as idle).
  const rawEndEpochMs = committed.activeTimer?.endEpochMs ?? null;
  const hasActiveTimer =
    committed.activeTimer != null &&
    rawEndEpochMs != null &&
    Number.isFinite(rawEndEpochMs);
  if (!hasActiveTimer) {
    // No dialog, no window flash: set the confirm flag and resume the
    // terminate natively.
    confirmQuit();
    return;
  }
  quitDialogPendingSince = Date.now();
  // Front the window BEFORE the alert: the RN alert presents as a sheet on
  // the RN window, which is invisible while that window is closed to the
  // menu bar. (Deliberately SKIPPED on the no-timer path above.)
  presentQuitConfirm();
  Alert.alert(QUIT_CONFIRM_TITLE, QUIT_CONFIRM_BODY, [
    // Cancel first, style 'cancel' — Esc maps to the native sheet's cancel
    // button (the Blocklist/Schedule pattern): no new JS keyboard listener.
    // NOT isPreferred — quitting is never the default (epic-6 a11y floor).
    {
      text: 'Cancel',
      style: 'cancel',
      onPress: () => {
        quitDialogPendingSince = null;
        // Cancelled: stay alive. The native gate already re-armed (its
        // terminate was returned as cancelled), so a later ⌘Q re-asks.
      },
    },
    {
      text: 'Quit',
      style: 'destructive',
      onPress: () => {
        quitDialogPendingSince = null;
        // The confirmed terminate: flag set natively, then NSApp.terminate —
        // the delegate consumes it and the 6.4 willTerminate frame flush
        // still runs (confirmQuit never exits by force).
        confirmQuit();
      },
    },
  ]);
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
  // Story 6.5 — every un-confirmed quit (⌘Q, Dock, the storyboard Quit, and
  // the `quitApp()` entry below all funnel through the native
  // `applicationShouldTerminate:` gate) lands here; THIS is where the quit
  // confirm decision lives.
  NativeMenuBar.onQuitRequested(handleQuitRequested);
  // The menu-bar "Quit" click is just a quit ENTRY: `quitApp()` dispatches
  // `NSApp.terminate`, which rides the same gate into `onQuitRequested`
  // above. The body status must be `void` (the emitter's handler signature),
  // so the `{ok,error?}` envelope is dropped — quit has no JS-side UI to
  // report to.
  NativeMenuBar.onQuit(() => {
    quitApp();
  });
}
