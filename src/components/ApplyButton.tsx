/**
 * ApplyButton — the primary-filled default-intent button primitive.
 *
 * `controlAccentColor` fill (follows the user's Accent Color), primary-foreground
 * white text, rounded.md. Visual primitive only: the window default-button pulse
 * + Return binding is delivered with the window shell in Story 1.3 (see the
 * spec's Design Notes — react-native-macos 0.81 exposes no `defaultButton` /
 * `keyEquivalent` / `pulse` prop on its `Button`).
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { tokens } from '../theme/tokens';

export interface ApplyButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export function ApplyButton({
  label,
  onPress,
  disabled = false,
}: ApplyButtonProps): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: tokens.primary },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.4,
  },
});
