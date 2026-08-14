/**
 * Sidebar — the fixed-width left navigation column (Story 1.3).
 *
 * Exactly four rows in this fixed order: Blocklist, Timer, Schedule, Settings
 * (from `SURFACE_NAMES`). ~180px fixed width. One row is active at a time;
 * the selected row uses `tokens.primary` fill + `tokens.primaryForeground` text
 * (styled inside `SidebarRow`). The row refs are owned by the shell so it can
 * move keyboard focus to the selected row on click / ⌘N / mount; the shell
 * passes them down here to attach to each row.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { View as ViewType } from 'react-native';
import { tokens } from '../theme/tokens';
import { SidebarRow } from './SidebarRow';
import { SURFACE_NAMES } from './surfaces';

/** Fixed sidebar width per DESIGN.md (~180px). */
export const SIDEBAR_WIDTH = 180;

export interface SidebarProps {
  selectedIndex: number;
  onSelect: (index: number) => void;
  rowRefs: Array<React.RefObject<ViewType | null>>;
}

export function Sidebar({
  selectedIndex,
  onSelect,
  rowRefs,
}: SidebarProps): React.ReactElement {
  return (
    <View style={styles.container}>
      {SURFACE_NAMES.map((name, i) => (
        <SidebarRow
          key={name}
          label={name}
          selected={selectedIndex === i}
          onPress={() => onSelect(i)}
          ref={rowRefs[i]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SIDEBAR_WIDTH,
    padding: tokens.spacing.sm,
    // Stack the four rows vertically with a tight 4px (spacing.xs) gap.
    gap: tokens.spacing.xs,
  },
});