/**
 * TimerDomainList — the domain-pick list on the Timer surface (Story 4.1).
 *
 * Renders one row per host in `hostnames` with a macOS `<Checkbox/>` +
 * hostname label. Rows are `disabled` while an Apply is in flight so a
 * mid-Apply toggle cannot race the serialized pipeline.
 *
 * The accessibility label switches with `selected` state:
 *   - checked:   `Selected: <host>`
 *   - unchecked: `Select: <host>`
 * matching the spec's UX-DR17 VoiceOver contract verbatim.
 *
 * The list reads `hostnames` (a `string[]`, NOT `Domain[]`) from the
 * parent — picking happens against `committed.domains` hostnames (the
 * BLOCKLIST canonical source of truth), never against the optimistic
 * `staged` draft. The parent owns `selected: Set<string>` + `onToggle`
 * so this component stays purely presentational.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';
import { Checkbox } from './Checkbox';

export interface TimerDomainListProps {
  /** Hostnames to render, in display order (canonical blocklist order). */
  hostnames: string[];
  /** Currently-selected hostname set. */
  selected: Set<string>;
  /** Fired when a row's checkbox is toggled with the row hostname. */
  onToggle: (hostname: string) => void;
  /** Disables every row's checkbox (e.g. while an Apply is in flight). */
  disabled?: boolean;
}

export function TimerDomainList({
  hostnames,
  selected,
  onToggle,
  disabled = false,
}: TimerDomainListProps): React.ReactElement {
  if (hostnames.length === 0) {
    // The parent (Timer) gates the empty-blocklist empty state; this branch
    // is defensive — if a parent ever calls <TimerDomainList/> with an empty
    // `hostnames` we render nothing (no Apply, no chip), keeping the row tree
    // out of the layout instead of leaving a stranded wrapper.
    return <View style={styles.container} />;
  }
  return (
    <View style={styles.container}>
      {hostnames.map((hostname) => {
        const isSelected = selected.has(hostname);
        return (
          <View key={hostname} style={styles.row}>
            <Checkbox
              checked={isSelected}
              onPress={() => onToggle(hostname)}
              accessibilityLabel={
                isSelected ? `Selected: ${hostname}` : `Select: ${hostname}`
              }
              disabled={disabled}
            />
            {/* The hostname label is a focusable Text wrapper so it is its
                own Tab stop AFTER the checkbox (Tab order: checkbox ->
                hostname -> next row's checkbox -> …). Mirrors the Blocklist
                row layout (DomainRow.tsx:86-96). */}
            <View
              focusable
              enableFocusRing
              accessibilityRole="text"
              accessibilityLabel={hostname}
              style={styles.labelWrap}
            >
              <Text style={styles.label} numberOfLines={1}>
                {hostname}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: tokens.spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
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