/**
 * StatusHeader — the persistent status bar above the content (Story 1.3).
 *
 * Always visible across all four surfaces. Renders the "Free" `StatusBadge`
 * followed by the static placeholders `"0 domains"` and `"no active timer"`
 * (label typography), separated by middle dots. The real domain count lands
 * in Epic 2 and the countdown in Epic 4; this story pins the placeholders.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';
import { StatusBadge } from './StatusBadge';

export function StatusHeader(): React.ReactElement {
  return (
    <View style={styles.container}>
      <StatusBadge status="free" />
      <Text style={styles.separator}>·</Text>
      <Text style={styles.text}>0 domains</Text>
      <Text style={styles.separator}>·</Text>
      <Text style={styles.text}>no active timer</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    // DESIGN.md: compact bar pinned above the content area. Pad with the
    // 8pt-grid spacing scale; a single `md` (16px) horizontal pad keeps the
    // header aligned with the content column.
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  text: {
    ...tokens.typography.label,
  },
  separator: {
    ...tokens.typography.label,
  },
});