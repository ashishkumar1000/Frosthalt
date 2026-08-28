/**
 * Shell — the window shell: sidebar + persistent status header + active
 * surface placeholder (Story 1.3).
 *
 * Holds the active-surface `useState` (UI-chrome state — no Zustand; see the
 * spec Design Notes) and the `rowRefs` used to move keyboard focus to the
 * selected row. The focusable root `View` carries `onKeyDown` +
 * `keyDownEvents` so `⌘1`-`⌘4` select rows 0-3; the event fires at the first
 * responder (the focused row) and bubbles up the React tree to this handler
 * (per the react-native-macos key-event contract). On every navigation
 * (click or ⌘ key) the shell calls `AccessibilityInfo.announceForAccessibility`
 * so VoiceOver speaks the surface.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  HandledKeyEvent,
  NativeKeyEvent,
  TextInput as TextInputType,
  View as ViewType,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sidebar } from './Sidebar';
import { StatusHeader } from './StatusHeader';
import { SurfacePlaceholder, SURFACE_NAMES, BLOCKLIST_SURFACE_INDEX, type SurfaceIndex } from './surfaces';
import { Blocklist } from './Blocklist';
import { Schedule } from './Schedule';
import { Settings } from './Settings';
import { Timer } from './Timer';
import { HostsViewer } from './HostsViewer';
import { PasswordGate } from './PasswordGate';
import { ScheduleEditor } from './ScheduleEditor';
import { useDomainStore } from '../domain/store';
import { effectiveBlocklist } from '../domain/effectiveBlocklist';
import { tokens } from '../theme/tokens';

/** Auto-dismiss timeout for the Shell-level toast (Story 4.5 — 8 s, the same
 * Ask-First choice Panic's component-local toast uses). */
const TOAST_AUTO_DISMISS_MS = 8000;

/**
 * ⌘1-⌘4 select the four surfaces; ⌘N focuses the add-domain field (Story 2.2)
 * except on surface 2, where it opens the add schedule editor sheet (Story
 * 5.2, no-op while already open); bare Return / Enter fire Apply on a surface
 * with a staged draft — Blocklist (surface 0, Story 2.3, when the add field is
 * blurred) or Schedule (surface 2, Story 5.1, when the schedule buffer is
 * dirty) — but never while an overlay is open (hosts viewer 2.6, password gate
 * 3.2, schedule editor 5.2); bare Escape closes the topmost open overlay
 * (password gate 3.2, hosts viewer 2.6, schedule editor 5.2, in that branch
 * order). Keys outside this set are ignored (the native default applies).
 */
const KEY_DOWN_EVENTS: HandledKeyEvent[] = [
  { key: '1', metaKey: true },
  { key: '2', metaKey: true },
  { key: '3', metaKey: true },
  { key: '4', metaKey: true },
  { key: 'n', metaKey: true },
  { key: 'Return' },
  { key: 'Enter' },
  { key: 'Escape' },
];

export function Shell(): React.ReactElement {
  const [surface, setSurface] = useState<SurfaceIndex>(0); // 0=Blocklist … 3=Settings
  const insets = useSafeAreaInsets();
  const rowRefs: Array<React.RefObject<ViewType | null>> = [
    useRef<ViewType>(null),
    useRef<ViewType>(null),
    useRef<ViewType>(null),
    useRef<ViewType>(null),
  ];
  // The add-domain field ref. ⌘N focuses it (`addFieldRef.current?.focus()`),
  // mirroring the `selectRow` ref-focus pattern below. Owned here so the Shell
  // can drive focus; passed down to <Blocklist/> -> <AddDomain/>.
  const addFieldRef = useRef<TextInputType>(null);
  // Whether the add field is currently focused, tracked via the AddDomain
  // `onFocusChange` callback (Story 2.3). Used to gate bare Return -> Apply: the
  // focused field ALWAYS owns Return (-> Add); only a blurred field lets Return
  // fall through to Apply. Deterministic + unit-testable — no reliance on
  // uncertain Return bubble semantics.
  const [addFieldFocused, setAddFieldFocused] = useState(false);
  // Whether the read-only hosts viewer overlay (Story 2.6) is open. The viewer
  // is an OVERLAY, not a 5th sidebar surface — `SurfaceIndex`/`SURFACE_NAMES`
  // stay a fixed 4-tuple. Shell owns this boolean; Esc and the viewer's Close
  // button call `setViewerOpen(false)`, the StatusHeader "View hosts" link calls
  // `setViewerOpen(true)`. While open, bare Return must NOT fire Apply (the
  // viewer is a window-level inert surface, mirroring how the native alert
  // inert-ifies the Shell's Return gate).
  const [viewerOpen, setViewerOpen] = useState(false);
  // Story 5.2 — the schedule editor sheet's open state. `'new'` opens the ADD
  // editor (empty draft); a schedule `id` opens the EDIT editor pre-filled
  // from the rendered (staged ?? committed) schedule; `null` (the initial)
  // means closed. Shell-owned for the same reason as `viewerOpen`: ⌘N, bare
  // Escape, and the bare-Return gate all live in this component's key handler,
  // and component-local state inside `<Schedule>` would need a reverse
  // channel. The sheet itself is the scratchpad — nothing stages until its
  // Save (which calls `onClose` after `stageScheduleUpsert` succeeds).
  const [scheduleEditorTarget, setScheduleEditorTarget] = useState<
    'new' | string | null
  >(null);
  // The staged draft + apply action, read here so the Return -> Apply branch
  // can fire `apply()` iff `staged != null`. Blocklist also reads these; both
  // may read the same store.
  const staged = useDomainStore((s) => s.staged);
  const stagedSchedules = useDomainStore((s) => s.stagedSchedules);
  const apply = useDomainStore((s) => s.apply);
  // `committed` is read here so the nav announce (`selectRow`) can speak the
  // real effective blocked count (Story 2.5), replacing the hardcoded "0
  // domains" placeholder. `committed` updates only on Apply success, so the
  // spoken count matches what is enforced right now.
  const committed = useDomainStore((s) => s.committed);
  // Story 3.2 — the reusable password gate. The Shell hosts the SINGLE
  // `<PasswordGate>` instance; `gateOpen` mounts/unmounts it. `closeGate` is
  // the Esc/Cancel handler (preserves attempts). `runGateAction` (defined
  // below) is the `onVerified` callback: it reads the stashed `gateAction`
  // from the store at call time, runs it, then closes the gate.
  const gateOpen = useDomainStore((s) => s.gateOpen);
  const closeGate = useDomainStore((s) => s.closeGate);

  // Story 4.5 — the Shell-level toast. The store sets it (expiry, and later
  // 4.6/4.7); the Shell is the one component mounted on every surface, so it
  // renders the single toast element. Runtime-only state in the store (never
  // persisted) — the same precedent as 3.2's gate state. Epic 5 owns a real
  // toast primitive; this stays minimal (no queue, no stack, one message).
  const toast = useDomainStore((s) => s.toast);
  const clearToast = useDomainStore((s) => s.clearToast);

  // Toast lifecycle: announce the message to VoiceOver when it appears (the
  // `accessibilityLiveRegion="polite"` below is Android-only / a no-op on
  // macOS — the explicit announce is what VoiceOver hears, mirroring how the
  // Shell announces nav changes) and auto-dismiss after 8 s. Keyed on the
  // toast OBJECT so a new message (or tone) re-announces and re-arms the
  // timer; the cleanup clears the pending timer on change/unmount so a
  // quickly-replaced toast never dismisses its successor early.
  useEffect(() => {
    if (toast == null) {
      return;
    }
    AccessibilityInfo.announceForAccessibility(toast.message);
    const timer = setTimeout(() => {
      clearToast();
    }, TOAST_AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast, clearToast]);

  const selectRow = (i: number) => {
    setSurface(i as SurfaceIndex);
    // Reset add-field focus tracking on every navigation. Navigating away from
    // surface 0 unmounts <Blocklist> (and its TextInput); the TextInput's
    // native `onBlur` is queued async by RCTEventDispatcher and dropped when the
    // view is destroyed, so `onFocusChange(false)` never fires and
    // `addFieldFocused` would stay stale-true. Navigating back to surface 0
    // mounts a fresh, unfocused field whose `onFocus` doesn't fire either, so
    // the stale state would persist — silently breaking the bare Return -> Apply
    // gate (`!addFieldFocused`). After any `selectRow` focus is on a sidebar
    // row, never the field, so `false` is correct in every case. Story 2.3.
    setAddFieldFocused(false);
    rowRefs[i].current?.focus();
    // Story 2.5 — the nav announce uses the real effective blocked count
    // (always-on domains enforced in /etc/hosts right now), not the hardcoded
    // "0 domains" placeholder. Singular/plural applies. The spoken cue and the
    // visible status header agree — both derive from `effectiveBlocklist(committed)`.
    const count = effectiveBlocklist(committed).length;
    AccessibilityInfo.announceForAccessibility(
      `${SURFACE_NAMES[i]}, ${count} ${count === 1 ? 'domain' : 'domains'}`,
    );
  };

  // Focus row 0 on mount so ⌘-keys work before any click (the key handler fires
  // at the first responder; without focus on a row the events never reach us).
  useEffect(() => {
    rowRefs[0].current?.focus();
    // Mount-only — we intentionally run this exactly once to focus row 0
    // before any interaction. (`selectRow` is a fresh closure each render,
    // but we only need the initial focus, so it is not a dependency here.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: { nativeEvent: NativeKeyEvent }) => {
    const { metaKey, key } = event.nativeEvent;
    // Story 3.2 — bare Escape closes the password gate sheet when it is open
    // (mirrors the hosts-viewer Esc branch below). Placed FIRST so that while
    // the gate is open no other key branch (Return -> Apply, ⌘1-⌘4 nav) is
    // even considered — the gate is a window-level inert surface that owns
    // Escape. `closeGate` clears `gateOpen` + `gateAction` and PRESERVES the
    // attempt counter (Esc does NOT reset it — the spec's Never clause). No
    // ⌘Esc (bare Escape only), matching the macOS overlay dismiss contract.
    if (!metaKey && key === 'Escape' && gateOpen) {
      closeGate();
      return;
    }
    // Bare Escape closes the read-only hosts viewer overlay (Story 2.6). Placed
    // BEFORE the Return -> Apply branch so that while the viewer is open Return
    // is never even considered for Apply (the viewer is a window-level inert
    // surface). No ⌘Esc (bare Escape only), matching the macOS overlay dismiss
    // contract. The `KEY_DOWN_EVENTS` declaration above marks Escape as handled
    // so the native default does not swallow it.
    if (!metaKey && key === 'Escape' && viewerOpen) {
      setViewerOpen(false);
      return;
    }
    // Story 5.2 — bare Escape closes the schedule editor sheet (the third
    // overlay, after the gate and the hosts viewer). Placed BEFORE the ⌘N and
    // Return branches so that while the sheet is open bare Escape never
    // reaches them — the sheet is a window-level inert surface that owns
    // Escape, and closing it must discard the scratchpad draft WITHOUT
    // touching `stagedSchedules` (the editor's Cancel semantics; the store is
    // untouched because nothing stages until Save). No ⌘Esc (bare Escape
    // only), matching the macOS overlay dismiss contract. The gate and viewer
    // branches above stay first: with overlays stacked, Escape peels the
    // topmost-armed one (gate, then viewer, then the sheet).
    if (!metaKey && key === 'Escape' && scheduleEditorTarget != null) {
      setScheduleEditorTarget(null);
      return;
    }
    // ⌘N is context-aware (Story 5.2): on surface 2 (Schedule) it opens the
    // ADD schedule editor sheet — a NO-OP while the sheet is already open
    // (re-opening must not wipe a half-typed draft). The open is also gated
    // with `!gateOpen && !viewerOpen` (5-2 review patch): the gate and the
    // hosts viewer are window-level inert surfaces, and mounting the editor
    // sheet ABOVE either would break the modal layering — the same
    // `!gateOpen`/`!viewerOpen` parity bare Return already carries. On every
    // other surface ⌘N keeps the Story 2.2 focus behaviour unchanged (⌘N
    // focuses the add-domain field; the ref is always attached and a no-op
    // focus when the surface is absent is harmless). No announce + no surface
    // change in either case.
    if (metaKey && key === 'n') {
      if (surface === 2 && !gateOpen && !viewerOpen) {
        if (scheduleEditorTarget == null) {
          setScheduleEditorTarget('new');
        }
        return;
      }
      addFieldRef.current?.focus();
      return;
    }
    // Bare Return / Enter fires Apply on a surface that has a staged draft
    // (the default-button binding): surface 0 (Blocklist, Story 2.3) gates on
    // the domain buffer (`staged != null`) and keeps the add-field guard —
    // the focused field ALWAYS owns Return (its `onSubmitEditing` -> Add);
    // `addFieldFocused` is tracked via the AddDomain `onFocusChange`
    // callback so this is deterministic, not reliant on uncertain Return
    // bubble semantics. Surface 2 (Schedule, Story 5.1 — review patch BH-5)
    // gates on the schedule buffer (`stagedSchedules != null`); it renders no
    // text field, so no field guard applies there. The epic context pins
    // "Apply button on the Schedule surface is the default (Return-bound)".
    // No ⌘Return (bare Return only, matching the macOS default-button
    // contract). Placed before the ⌘1-⌘4 branch because this is a bare-key
    // (no metaKey) path.
    //
    // Story 2.6: gated with `!viewerOpen` so bare Return does NOT fire Apply
    // while the read-only hosts viewer overlay is open (the overlay is a
    // window-level inert surface, mirroring how the native alert inert-ifies
    // the Shell's Return gate).
    // Story 3.2: also gated with `!gateOpen` so bare Return does NOT fire
    // Apply while the password gate sheet is open (the gate is a window-level
    // inert surface; the gate's own field owns Return when focused).
    // Story 5.2: also gated with `scheduleEditorTarget == null` so bare
    // Return does NOT fire Apply while the schedule editor sheet is open —
    // the sheet is a window-level inert surface, and an Apply firing under a
    // half-typed draft would be wrong (the editor's Save is the ONLY path
    // that stages from the sheet).
    if (
      !metaKey &&
      (key === 'Return' || key === 'Enter') &&
      !viewerOpen &&
      !gateOpen &&
      scheduleEditorTarget == null &&
      ((surface === 0 && !addFieldFocused && staged != null) ||
        (surface === 2 && stagedSchedules != null))
    ) {
      void apply();
      return;
    }
    // Gate on ⌘ AND key in 1-4. A plain 1-4 (no ⌘) must NOT navigate.
    if (metaKey && key >= '1' && key <= '4') {
      selectRow(Number(key) - 1);
    }
  };

  // Story 3.2 — the gate's `onVerified` callback. Reads the stashed
  // `gateAction` from the store AT CALL TIME (not at render time — the action
  // is stashed by `requirePassword` when the gate opens, and a stale closure
  // here would run the wrong action if the Shell re-rendered between open and
  // verify). Runs the action, then closes the gate (clears `gateOpen` +
  // `gateAction`; `verifyPassword` already reset attempts + throttle on the
  // successful compare).
  //
  // try/finally: if the stashed action throws, `closeGate` still runs so the
  // sheet doesn't get stuck open with a stale `gateAction`.
  //
  // Re-open guard: close ONLY if the action did not synchronously re-open the
  // gate (e.g. a future caller whose action re-enters `requirePassword`). A
  // re-open replaces `gateAction` with a new function; comparing identity
  // (still the same function we just ran) tells "action did not re-open" from
  // "action re-opened with a new gate" — closing in the latter case would
  // clobber the freshly opened gate.
  const runGateAction = () => {
    const action = useDomainStore.getState().gateAction;
    try {
      if (action != null) {
        action();
      }
    } finally {
      if (useDomainStore.getState().gateAction === action) {
        closeGate();
      }
    }
  };

  return (
    <View
      focusable
      enableFocusRing={false}
      keyDownEvents={KEY_DOWN_EVENTS}
      onKeyDown={onKeyDown}
      style={[
        styles.root,
        {
          paddingTop: insets.top,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <StatusHeader onViewHosts={() => setViewerOpen(true)} />
      <View style={styles.body}>
        <Sidebar
          selectedIndex={surface}
          onSelect={selectRow}
          rowRefs={rowRefs}
        />
        {surface === 0 ? (
          <Blocklist
            addFieldRef={addFieldRef}
            onFocusChange={setAddFieldFocused}
          />
        ) : surface === 1 ? (
          // Story 4.1: the Timer surface (Free-state). Threads
          // `onOpenBlocklist` so the empty-state + running-state
          // placeholders can navigate back to Blocklist without
          // duplicating surface state in the store. Mirrors Settings'
          // `onNavigateBlocklist` threading (Shell.tsx:266-273). The Timer
          // component itself owns the Free-state UI + Start engine; the
          // Shell stays surface-routing-only.
          <Timer onOpenBlocklist={() => selectRow(BLOCKLIST_SURFACE_INDEX)} />
        ) : surface === 2 ? (
          // Story 5.1: the Schedule surface — rows + enable toggles riding
          // the staged-then-Apply pipeline. Story 5.2 threads the editor-sheet
          // openers (the Shell owns the sheet's open state, since ⌘N/Esc live
          // in this component's key handler): the empty-state Add… and each
          // row's Edit control land here.
          <Schedule
            onAddSchedule={() => setScheduleEditorTarget('new')}
            onEditSchedule={(id) => setScheduleEditorTarget(id)}
          />
        ) : surface === 3 ? (
          // Story 3-4: <Panic>'s success-toast "Re-enable your blocklist"
          // link navigates the user to Blocklist (row 0). Threading the
          // navigation callback here keeps surface state owned by Shell and
          // avoids duplicating the selectRow machinery — Settings receives
          // the same callable the sidebar rows use. Uses the named
          // `BLOCKLIST_SURFACE_INDEX` constant (not a literal `0`) so the
          // nav cannot silently break if `SURFACE_NAMES` is reordered.
          //
          // Gate-guard (P6 review patch): if `gateOpen` is true when the
          // link fires, swap surfaces mid-gate is genuinely unsafe (the
          // gate's onVerified reads `gateAction` at call time and expects
          // the same shell state). For v1, we no-op the nav — the user is
          // mid-verification and the link's surface swap is not worth the
          // complexity of closeGate + deferred nav. In practice the Panic
          // flow closes the gate before the toast appears, so this is a
          // defensive only-once-per-universe check.
          <Settings
            onNavigateBlocklist={() => {
              if (useDomainStore.getState().gateOpen) {
                return;
              }
              selectRow(BLOCKLIST_SURFACE_INDEX);
            }}
          />
        ) : (
          <SurfacePlaceholder surface={surface} />
        )}
      </View>
      {viewerOpen ? (
        <HostsViewer onClose={() => setViewerOpen(false)} />
      ) : null}
      {gateOpen ? (
        <PasswordGate onVerified={runGateAction} onClose={closeGate} />
      ) : null}
      {scheduleEditorTarget != null ? (
        // Story 5.2 — the schedule editor sheet, mounted after the overlays
        // (hosts viewer, password gate) and BEFORE the toast, so the toast
        // still paints on top of it (the HostsViewer/PasswordGate mount-order
        // precedent). `target` is `'new'` (add draft) or the schedule `id`
        // (edit, pre-filled from the rendered staged ?? committed schedule).
        // The editor's own Save + Cancel call `onClose`; bare Escape closes it
        // via the key branch above. Closing NEVER touches `stagedSchedules` —
        // the sheet is a scratchpad and only its Save stages.
        <ScheduleEditor
          key={scheduleEditorTarget}
          target={scheduleEditorTarget}
          onClose={() => setScheduleEditorTarget(null)}
        />
      ) : null}
      {toast ? (
        // Story 4.5 — the Shell-level toast, rendered AFTER the overlays
        // (hosts viewer, password gate) so it paints on top. `tone: 'error'`
        // renders in the destructive token; `'info'` stays neutral with the
        // primary border (Panic's success-toast pattern, Panic.tsx:335-365 —
        // not migrated; that component-local toast stays as-is).
        // `pointerEvents="none"`: the absolute overlay must never intercept
        // touches in its area for the full 8 s it is showing — the surface
        // underneath (e.g. Blocklist rows) stays interactive.
        <View
          style={styles.toast}
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          accessibilityLabel={toast.message}
        >
          <Text
            style={[
              styles.toastText,
              toast.tone === 'error' && styles.toastTextError,
            ]}
          >
            {toast.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  // Story 4.5 — the Shell-level toast. A compact grouped View pinned at the
  // bottom of the window (absolute so it overlays whichever surface is
  // active — expiry can fire on ANY surface), reusing the Panic success-toast
  // token pattern (border + body typography, Panic.tsx styles.toast). Two
  // legibility/behaviour guards: `backgroundColor` uses the HostsViewer
  // panel token (`monoBg`) so the text is never floating directly over
  // whatever the active surface painted (e.g. domain rows), and the JSX
  // carries `pointerEvents="none"` so the overlay never intercepts touches
  // in its area while showing.
  toast: {
    position: 'absolute',
    left: tokens.spacing.md,
    right: tokens.spacing.md,
    bottom: tokens.spacing.md,
    backgroundColor: tokens.monoBg,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    borderColor: tokens.primary,
  },
  toastText: {
    ...tokens.typography.body,
  },
  // The error tone renders in the destructive token (the "Couldn't update
  // /etc/hosts" copy reads as a failure, not a success).
  toastTextError: {
    color: tokens.destructive,
  },
});