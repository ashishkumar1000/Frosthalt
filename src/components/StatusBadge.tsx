/**
 * StatusBadge — pill, white label text over the status-ramp fill.
 *
 * Leftmost element in the persistent status header. Fill comes from the status
 * tokens (systemGreen / systemOrange / systemRed), so it adapts to light/dark
 * automatically. The badge is never decorative: an unrecognised status renders
 * nothing (`null`) rather than a neutral pill.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { statusFill, tokens, type StatusKey } from '../theme/tokens';
import { badgeStateLabels } from '../domain/badgeState';

export interface StatusBadgeProps {
  status: StatusKey;
}

export function StatusBadge({ status }: StatusBadgeProps): React.ReactElement | null {
  // Since Story 6.2 the label words come from the domain's single-source
  // `badgeStateLabels` (the menu-bar mirror reads the same map), so the two
  // badge renderers can never show different words for the same state.
  const label = badgeStateLabels[status];

  // Defensive: a status with no label renders nothing. The badge is never
  // decorative — there is no neutral/default fill. (TS types `label` as string
  // because Record<StatusKey, string> covers every union key, but a runtime
  // value outside the union — e.g. a JS caller or a stale prop — still lands
  // here as `undefined`, and this guard returns null for it.)
  if (!label) {
    return null;
  }

  return (
    <View
      style={[styles.badge, { backgroundColor: statusFill(status) }]}
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label}`}
    >
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: tokens.rounded.full,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    alignSelf: 'flex-start',
  },
  text: {
    ...tokens.typography.label,
    color: tokens.primaryForeground,
  },
});
