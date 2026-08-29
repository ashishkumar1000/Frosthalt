/**
 * TimerDurationPicker — duration section of the Timer surface (Story 4.1).
 *
 * Three preset chips ("25 min" / "45 min" / "60 min") + a numeric
 * `TextInput` for custom minute input. Selection is exclusive — choosing a
 * preset deselects the custom input and vice versa. Pure presentational:
 * the parent owns `value` (`{ kind: 'preset' | 'custom'; minutes: number }`)
 * and a single `onChange` callback.
 *
 * Each preset is a `Pressable` with `accessibilityRole="button"` +
 * `accessibilityState={{ selected }}` so VoiceOver announces
 * "25 min, selected" / "25 min, not selected" — matching the spec's a11y AC.
 *
 * The custom input is `keyboardType="number-pad"` with
 * `accessibilityLabel="Custom duration in minutes"`. It is uncontrolled in
 * the sense that the OWNER owns the `value` string; this component re-emits
 * `onChange` on every keystroke so the owner (Timer) can derive the parsed
 * minute count + invalid-reason message via the shared
 * `parseDurationMinutes` helper.
 *
 * Visual: idle chip is a bordered rounded pill with `bg-chip` background;
 * selected chip flips to `primary` fill with `primary-fg` text — mirroring
 * the Blocklist chip styling. Custom input border + fill change with the
 * `selected` state.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { tokens } from '../theme/tokens';
import { formatDurationLabel } from '../config/duration';
// Story 6.3 — the preset list is single-sourced in the domain layer (UI →
// domain); the local 4.1 copy was hoisted to `src/domain/timerPresets.ts` so
// the menu bar's quick-start and this chip row share ONE constant.
import { PRESET_MINUTES } from '../domain/timerPresets';

export type DurationPickerValue =
  | { kind: 'preset'; minutes: number }
  | { kind: 'custom'; minutes: number };

export interface TimerDurationPickerProps {
  /**
   * The current selection. The parent derives this from local state
   * (`useState<DurationPickerValue>`); the picker is presentational.
   */
  value: DurationPickerValue;
  /**
   * Raw custom-minute input string. Owned by the parent so the input field's
   * text survives a preset click (the spec: "preset click clears custom" —
   * the parent re-renders with `customRaw: ''` when a preset is picked).
   * `undefined` means the custom input is unmounted (preset selected).
   */
  customRaw: string | undefined;
  /**
   * Fired on a preset chip press with the new value (kind='preset', the
   * chip's minute count).
   */
  onPresetSelect: (minutes: number) => void;
  /**
   * Fired on every keystroke in the custom input. The parent decides whether
   * the new text parses to a valid minute count.
   */
  onCustomChange: (text: string) => void;
  /**
   * Fired when the user focuses the custom input (taps or Tabs to it). The
   * parent switches `value` to `{ kind: 'custom' }` so the chip row deselects
   * and the input border lights up. Mirrors the preset chip's exclusive-
   * selection contract — without this callback a Tab to the field would not
   * show it as selected.
   */
  onCustomFocus: () => void;
}

export function TimerDurationPicker({
  value,
  customRaw,
  onPresetSelect,
  onCustomChange,
  onCustomFocus,
}: TimerDurationPickerProps): React.ReactElement {
  const isCustom = value.kind === 'custom';
  return (
    <View style={styles.container}>
      <View style={styles.presetRow}>
        {PRESET_MINUTES.map((m) => {
          const selected = value.kind === 'preset' && value.minutes === m;
          const label = formatDurationLabel(m);
          return (
            <Pressable
              key={m}
              onPress={() => onPresetSelect(m)}
              focusable
              enableFocusRing
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipSelected,
                pressed && !selected && styles.chipPressed,
              ]}
            >
              <Text
                style={[
                  styles.chipLabel,
                  selected && styles.chipLabelSelected,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        value={customRaw ?? ''}
        onChangeText={onCustomChange}
        onFocus={onCustomFocus}
        placeholder="Custom minutes"
        keyboardType="number-pad"
        accessibilityLabel="Custom duration in minutes"
        // A custom-pad keeps the numeric keyboard tidy on macOS; the user can
        // paste and the digits land in the field.
        style={[
          styles.customInput,
          isCustom && styles.customInputSelected,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: tokens.spacing.sm,
  },
  presetRow: {
    flexDirection: 'row',
    gap: tokens.spacing.sm,
  },
  chip: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.rounded.full,
    borderWidth: 1,
    borderColor: tokens.primary,
    // Idle chip background — same translucent surface the Blocklist chips use
    // (chips are tokens-typed surfaces, not free hex). When `selected`, the
    // `chipSelected` style overrides the background to `primary`.
    backgroundColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: tokens.primary,
  },
  chipPressed: {
    opacity: 0.85,
  },
  chipLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  chipLabelSelected: {
    color: tokens.primaryForeground,
  },
  customInput: {
    ...tokens.typography.body,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: tokens.rounded.sm,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    backgroundColor: 'transparent',
  },
  customInputSelected: {
    backgroundColor: tokens.primary,
    color: tokens.primaryForeground,
  },
});