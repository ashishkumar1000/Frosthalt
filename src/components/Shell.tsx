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
import type { View as ViewType, HandledKeyEvent, NativeKeyEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sidebar } from './Sidebar';
import { StatusHeader } from './StatusHeader';
import { SurfacePlaceholder, SURFACE_NAMES, type SurfaceIndex } from './surfaces';

/** ⌘1-⌘4 are the four surfaces; keys outside this set are ignored. */
const KEY_DOWN_EVENTS: HandledKeyEvent[] = [
  { key: '1', metaKey: true },
  { key: '2', metaKey: true },
  { key: '3', metaKey: true },
  { key: '4', metaKey: true },
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

  const selectRow = (i: number) => {
    setSurface(i as SurfaceIndex);
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
        <SurfacePlaceholder surface={surface} />
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