/**
 * DomainRow — a single blocklist row (Story 2.1; remove control in Story 2.4).
 *
 * Renders `[Checkbox] hostname [Remove]` with the checkbox first so Tab order
 * is checkbox -> domain -> remove (per the epic's UX-DR16 / UX-DR17 keyboard +
 * a11y guidance). The checkbox is a focusable macOS checkbox (visible focus
 * ring) driving the optimistic `alwaysOn` toggle through `onToggleAlwaysOn`.
 * The hostname is a focusable Text wrapper so VoiceOver reaches it as its own
 * stop after the checkbox; it carries `accessibilityRole="text"` so VoiceOver
 * speaks the hostname verbatim.
 *
 * The remove control (Story 2.4) is always MOUNTED (keyboard-Tab-reachable +
 * VoiceOver-visible) and visually revealed on row-hover OR button-focus
 * (`opacity: hovered || focused ? 1 : 0`), satisfying UX-DR6 (reveal on hover)
 * and UX-DR17 (Tab to remove with a focus ring). It is `disabled` while an
 * Apply is in flight (no staging during Apply), matching the checkbox. The
 * row root is a `Pressable` (hover container only — no `onPress`, not a Tab
 * stop) so `onHoverIn`/`onHoverOut` drive the `hovered` reveal state; the
 * checkbox keeps its own press.
 *
 * The row reads `domain.hostname` directly — it is already the normalised
 * lowercase apex in config (Story 1.6), so there is no re-normalisation at
 * display time. `onRemove` receives that stored apex (raw compare, matching
 * `stageAlwaysOnToggle`/`stageDomainRemove`'s convention).
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { View as ViewType } from 'react-native';
import { tokens } from '../theme/tokens';
import type { Domain } from '../config/types';
import { Checkbox } from './Checkbox';

export interface DomainRowProps {
  domain: Domain;
  onToggleAlwaysOn: (hostname: string) => void;
  /**
   * Remove handler (Story 2.4). The Blocklist wires this to a confirm-alert
   * (`Alert.alert`); only on confirm does it call `stageDomainRemove`.
   * Receives the stored apex (`domain.hostname`), already normalised.
   */
  onRemove: (hostname: string) => void;
  /**
   * Disables the checkbox AND the remove control (e.g. while an Apply is in
   * flight). The hostname label itself stays readable — only the interactive
   * controls become non-interactive.
   */
  disabled?: boolean;
}

export function DomainRow({
  domain,
  onToggleAlwaysOn,
  onRemove,
  disabled = false,
}: DomainRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // The remove control is visible when the pointer hovers the row OR the
  // control itself is focused (keyboard Tab). Always mounted so Tab/VoiceOver
  // reach it; `opacity: 0` keeps layout + Tab order stable while hidden.
  const removeVisible = hovered || focused;
  // When disabled (Apply running), reveal on hover but dimmed at 0.4 (the
  // same dim the checkbox + Apply button use), conveying "non-interactive".
  const removeOpacity = removeVisible ? (disabled ? 0.4 : 1) : 0;

  return (
    <Pressable
      // Hover container only — no `onPress`. The checkbox keeps its own press;
      // this Pressable exists solely to track row hover for the remove-control
      // reveal. `focusable={false}` keeps it out of the Tab order so Tab order
      // stays checkbox -> domain -> remove (no extra stop).
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      focusable={false}
      style={styles.row}
    >
      <Checkbox
        checked={domain.alwaysOn}
        onPress={() => onToggleAlwaysOn(domain.hostname)}
        accessibilityLabel={`Always-on for ${domain.hostname}`}
        disabled={disabled}
      />
      {/* The hostname is a focusable Text wrapper so it is its own Tab/VoiceOver
          stop AFTER the checkbox (Tab order checkbox -> domain -> remove). */}
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
      {/* The remove control (Story 2.4). Always MOUNTED (Tab/VoiceOver-
          reachable) and visually revealed on row-hover OR button-focus, so
          the pointer-only hover path and the keyboard Tab path both surface
          it. `opacity: 0` keeps layout + Tab order stable while hidden.
          `disabled` while an Apply is in flight (no staging during Apply),
          matching the checkbox. No icon library exists in the repo, so a
          subdued "Remove" text label in the destructive color is used
          (implementer's choice per the spec's Ask First). */}
      <Pressable
        onPress={() => onRemove(domain.hostname)}
        disabled={disabled}
        focusable
        enableFocusRing
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${domain.hostname}`}
        accessibilityState={{ disabled }}
        style={[styles.remove, { opacity: removeOpacity }]}
      >
        <Text style={styles.removeLabel}>Remove</Text>
      </Pressable>
    </Pressable>
  );
}

// Re-export the host View type so callers (Story 2.4) can attach a ref to the
// row container when they extend it with a remove button.
export type DomainRowHostRef = ViewType;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // 8pt-grid: checkbox, then a small gap, then the hostname, then remove.
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
  // The remove control sits to the right of the hostname. `labelWrap` has
  // `flex: 1`, pushing this control to the row's trailing edge. Borderless +
  // subdued so it reads as a secondary affordance, not a primary action.
  remove: {
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.rounded.sm,
  },
  removeLabel: {
    ...tokens.typography.label,
    color: tokens.destructive,
  },
});