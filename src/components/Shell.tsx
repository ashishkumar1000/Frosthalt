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
import { useDomainStore } from '../domain/store';

/**
 * ⌘1-⌘4 select the four surfaces; ⌘N focuses the add-domain field (Story 2.2);
 * bare Return / Enter fire Apply on the Blocklist surface when the add field is
 * blurred and there is a staged draft (Story 2.3). Keys outside this set are
 * ignored (the native default applies).
 */
const KEY_DOWN_EVENTS: HandledKeyEvent[] = [
  { key: '1', metaKey: true },
  { key: '2', metaKey: true },
  { key: '3', metaKey: true },
  { key: '4', metaKey: true },
  { key: 'n', metaKey: true },
  { key: 'Return' },
  { key: 'Enter' },
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
  // The staged draft + apply action, read here so the Return -> Apply branch
  // can fire `apply()` iff `staged != null`. Blocklist also reads these; both
  // may read the same store.
  const staged = useDomainStore((s) => s.staged);
  const apply = useDomainStore((s) => s.apply);

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
    AccessibilityInfo.announceForAccessibility(
      `${SURFACE_NAMES[i]}, 0 domains`,
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
    if (!metaKey && (key === 'Return' || key === 'Enter') && surface === 0 && !addFieldFocused && staged != null) {
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
      <StatusHeader />
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