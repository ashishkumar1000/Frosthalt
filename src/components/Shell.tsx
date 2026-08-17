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
import { SurfacePlaceholder, SURFACE_NAMES, type SurfaceIndex } from './surfaces';
import { Blocklist } from './Blocklist';
import { HostsViewer } from './HostsViewer';
import { useDomainStore } from '../domain/store';
import { effectiveBlocklist } from '../domain/effectiveBlocklist';

/**
 * ⌘1-⌘4 select the four surfaces; ⌘N focuses the add-domain field (Story 2.2);
 * bare Return / Enter fire Apply on the Blocklist surface when the add field is
 * blurred and there is a staged draft (Story 2.3); bare Escape closes the
 * read-only hosts viewer overlay when it is open (Story 2.6). Keys outside this
 * set are ignored (the native default applies).
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
  // The staged draft + apply action, read here so the Return -> Apply branch
  // can fire `apply()` iff `staged != null`. Blocklist also reads these; both
  // may read the same store.
  const staged = useDomainStore((s) => s.staged);
  const apply = useDomainStore((s) => s.apply);
  // `committed` is read here so the nav announce (`selectRow`) can speak the
  // real effective blocked count (Story 2.5), replacing the hardcoded "0
  // domains" placeholder. `committed` updates only on Apply success, so the
  // spoken count matches what is enforced right now.
  const committed = useDomainStore((s) => s.committed);

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
    // ⌘N focuses the add-domain field (context-aware — only the Blocklist
    // surface renders the field, but the ref is always attached and a no-op
    // focus when the surface is absent is harmless). No announce + no
    // surface change: ⌘N is a focus shortcut, not navigation.
    if (metaKey && key === 'n') {
      addFieldRef.current?.focus();
      return;
    }
    // Bare Return / Enter fires Apply on the Blocklist surface (surface 0)
    // when the add field is blurred and there is a staged draft (Story 2.3 —
    // the default-button binding). The focused field ALWAYS owns Return (its
    // `onSubmitEditing` -> Add); `addFieldFocused` is tracked via the
    // AddDomain `onFocusChange` callback so this is deterministic, not reliant
    // on uncertain Return bubble semantics. No ⌘Return (bare Return only,
    // matching the macOS default-button contract). Placed before the ⌘1-⌘4
    // branch because this is a bare-key (no metaKey) path.
    //
    // Story 2.6: gated with `!viewerOpen` so bare Return does NOT fire Apply
    // while the read-only hosts viewer overlay is open (the overlay is a
    // window-level inert surface, mirroring how the native alert inert-ifies
    // the Shell's Return gate).
    if (!metaKey && (key === 'Return' || key === 'Enter') && surface === 0 && !addFieldFocused && staged != null && !viewerOpen) {
      void apply();
      return;
    }
    // Gate on ⌘ AND key in 1-4. A plain 1-4 (no ⌘) must NOT navigate.
    if (metaKey && key >= '1' && key <= '4') {
      selectRow(Number(key) - 1);
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
        ) : (
          <SurfacePlaceholder surface={surface} />
        )}
      </View>
      {viewerOpen ? (
        <HostsViewer onClose={() => setViewerOpen(false)} />
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
});