/**
 * SidebarRow — one sidebar navigation row (Story 1.3).
 *
 * A `Pressable` that is `focusable` + `enableFocusRing` so the selected row
 * receives keyboard focus via `ref.focus()` (wired by the shell) and shows
 * the native macOS focus ring. `accessibilityRole="button"` +
 * `accessibilityLabel={label}` expose the row to VoiceOver. The selected row
 * uses `tokens.primary` fill + `tokens.primaryForeground` text; unselected
 * rows use the default surface (transparent background, default text).
 *
 * Forwarded ref is the underlying `View` so the shell can call
 * `rowRefs[i].current?.focus()` on select / on mount.
 */

import React, { forwardRef } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { View } from 'react-native';
import { tokens } from '../theme/tokens';

export interface SidebarRowProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

export const SidebarRow = forwardRef<View, SidebarRowProps>(
  function SidebarRow({ label, selected, onPress }, ref) {
    return (
      <Pressable
        ref={ref}
        onPress={onPress}
        focusable
        enableFocusRing
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        style={({ pressed }) => [
          styles.row,
          selected && styles.selected,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.label, selected && styles.selectedText]}>
          {label}
        </Text>
      </Pressable>
    );
  },
);

const styles = StyleSheet.create({
  row: {
    borderRadius: tokens.rounded.sm,
    // DESIGN.md sidebar-row padding: {spacing.sm} {spacing.md} (8px 16px).
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  selected: {
    backgroundColor: tokens.primary,
  },
  pressed: {
    opacity: 0.85,
  },
  label: {
    ...tokens.typography.label,
  },
  selectedText: {
    color: tokens.primaryForeground,
  },
});