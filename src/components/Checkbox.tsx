/**
 * Checkbox — a macOS checkbox primitive (Story 2.1).
 *
 * A `Pressable` square with a tick glyph when checked, exposing
 * `accessibilityRole="checkbox"` + `accessibilityState={{ checked, disabled }}`
 * so VoiceOver announces "checked"/"unchecked" (and "dimmed" when disabled)
 * and toggles via the press action.
 * `focusable` + `enableFocusRing` give it a visible native focus ring so
 * keyboard users can Tab to it and press Space/Return to toggle.
 *
 * Visual primitive only — it owns no state. The checked value and the toggle
 * callback are owned by the caller (the Blocklist surface via the store's
 * `stageAlwaysOnToggle`). Reused by Story 2.2 (add-domain always-on default)
 * and 2.4 (row remove confirm) so the a11y contract stays in one place.
 *
 * Not an iOS switch: per the epic's UX decisions, always-on toggles as a
 * macOS checkbox (UX-DR6), consistent with the desktop platform convention.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { tokens } from '../theme/tokens';

export interface CheckboxProps {
  checked: boolean;
  onPress: () => void;
  /**
   * VoiceOver label — should describe what the checkbox controls, e.g.
   * "Always-on for example.com". Falls back to "Always-on" when omitted.
   */
  accessibilityLabel?: string;
  /** Disables the press + dims the box (e.g. while an Apply is in flight). */
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onPress,
  accessibilityLabel = 'Always-on',
  disabled = false,
}: CheckboxProps): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      focusable
      enableFocusRing
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled }}
      style={({ pressed }) => [
        styles.box,
        checked && styles.checked,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {checked ? <Text style={styles.tick}>&#x2713;</Text> : null}
    </Pressable>
  );
}

const BOX_SIZE = 16;

const styles = StyleSheet.create({
  box: {
    width: BOX_SIZE,
    height: BOX_SIZE,
    borderRadius: tokens.rounded.sm,
    borderWidth: 1,
    borderColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checked: {
    backgroundColor: tokens.primary,
  },
  tick: {
    color: tokens.primaryForeground,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: BOX_SIZE,
    // Keep the glyph centred in the 16px box across font metrics.
    textAlign: 'center',
    includeFontPadding: false,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.4,
  },
});