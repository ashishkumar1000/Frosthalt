/**
 * DomainRow — a single blocklist row (Story 2.1).
 *
 * Renders `[Checkbox] hostname` with the checkbox first so Tab order is
 * checkbox -> domain (per the epic's UX-DR16 / UX-DR17 keyboard + a11y
 * guidance). The checkbox is a focusable macOS checkbox (visible focus ring)
 * driving the optimistic `alwaysOn` toggle through `onToggleAlwaysOn`. The
 * hostname is a focusable Text wrapper so VoiceOver reaches it as its own
 * stop after the checkbox; it carries `accessibilityRole="text"` so
 * VoiceOver speaks the hostname verbatim.
 *
 * The row reads `domain.hostname` directly — it is already the normalised
 * lowercase apex in config (Story 1.6), so there is no re-normalisation at
 * display time.
 *
 * Reused by Story 2.4, which appends a remove button to the right of the
 * hostname (the remove slot is intentionally absent here — 2.1's Never
 * clause).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { View as ViewType } from 'react-native';
import { tokens } from '../theme/tokens';
import type { Domain } from '../config/types';
import { Checkbox } from './Checkbox';

export interface DomainRowProps {
  domain: Domain;
  onToggleAlwaysOn: (hostname: string) => void;
  /**
   * Disables the checkbox (e.g. while an Apply is in flight). The hostname
   * label itself stays readable — only the toggle becomes non-interactive.
   */
  disabled?: boolean;
}

export function DomainRow({
  domain,
  onToggleAlwaysOn,
  disabled = false,
}: DomainRowProps): React.ReactElement {
  return (
    <View style={styles.row}>
      <Checkbox
        checked={domain.alwaysOn}
        onPress={() => onToggleAlwaysOn(domain.hostname)}
        accessibilityLabel={`Always-on for ${domain.hostname}`}
        disabled={disabled}
      />
      {/* The hostname is a focusable Text wrapper so it is its own Tab/VoiceOver
          stop AFTER the checkbox (Tab order checkbox -> domain). */}
      <View
        focusable
        enableFocusRing
        accessibilityRole="text"
        accessibilityLabel={domain.hostname}
        style={styles.labelWrap}
      >
        <Text style={styles.label} numberOfLines={1}>
          {domain.hostname}
        </Text>
      </View>
    </View>
  );
}

// Re-export the host View type so callers (Story 2.4) can attach a ref to the
// row container when they extend it with a remove button.
export type DomainRowHostRef = ViewType;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // 8pt-grid: checkbox, then a small gap, then the hostname.
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: tokens.rounded.sm,
  },
  labelWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  label: {
    ...tokens.typography.body,
  },
});