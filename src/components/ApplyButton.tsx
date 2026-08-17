/**
 * ApplyButton — the primary-filled default-intent button primitive.
 *
 * `controlAccentColor` fill (follows the user's Accent Color), primary-foreground
 * white text, rounded.md. Visual primitive with an optional `pulse` (the
 * codebase's FIRST animation — Story 2.3) and a `busy` accessibilityState.
 *
 * The pulse: an `Animated.loop` on opacity via `Animated.createAnimatedComponent
 * (Pressable)`, `useNativeDriver: true` (opacity-only, off-main-thread). The
 * loop oscillates opacity 1.0 ↔ ~0.8 over ~800ms each way. It is started/stopped
 * in a `useEffect` keyed on the `pulse` prop; on stop the opacity is reset to 1
 * so a mid-cycle stop never leaves a dimmed opacity that would clash with a
 * later `disabled` (opacity 0.4) state. The animation itself is native-runtime
 * (not unit-testable in the node jest env); tests assert the `pulse`/`busy`
 * props are forwarded.
 *
 * Style is a STATIC array (not a Pressable press-state function): the
 * `Animated.createAnimatedComponent` wrapper intercepts the `style` prop and
 * does not resolve a function-style the way a plain `Pressable` does, so the
 * pressed affordance is driven by `onPressIn`/`onPressOut` state instead. The
 * animated `opacity` is only in the array while pulsing (otherwise the static
 * disabled 0.4 / pressed 0.85 / default 1 styles own opacity cleanly, so an
 * animated value never shadows them in the rendered style).
 *
 * The caller swaps the label for "Applying…" and passes `busy` while an Apply
 * run is in flight — Apply's in-flight work is the osascript admin prompt, so a
 * label change + disabled + `busy` is the in-flight cue (no spinner).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { tokens } from '../theme/tokens';

// Module-level animated Pressable: created once (creating per-render would
// re-mount the animated node on every render and break the loop).
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface ApplyButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /**
   * When true, the button gently pulses (opacity 1.0 ↔ ~0.8) to draw the eye as
   * the default "notice me" button. Driven `hasStaged && !running` by the
   * Blocklist. Opacity-only so `useNativeDriver: true` holds (off-main-thread).
   */
  pulse?: boolean;
  /**
   * Surfaced on `accessibilityState.busy` so VoiceOver announces the button is
   * busy while an Apply run is in flight (the label swaps to "Applying…").
   */
  busy?: boolean;
}

export function ApplyButton({
  label,
  onPress,
  disabled = false,
  pulse = false,
  busy = false,
}: ApplyButtonProps): React.ReactElement {
  // The opacity value the loop drives. Starts at 1 (fully opaque) so a render
  // with `pulse: false` never has a stale dimmed value.
  const opacityRef = useRef<Animated.Value>(new Animated.Value(1));
  const opacity = opacityRef.current;
  // Press feedback is driven by state (not a Pressable style function) because
  // `Animated.createAnimatedComponent` does not resolve a function-style the
  // way a plain `Pressable` does — see the file header.
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    if (pulse) {
      // Two timings in a sequence: 1.0 -> 0.8 (dim) -> 1.0 (restore). Looped so
      // it repeats until `pulse` turns false. `useNativeDriver: true` keeps the
      // animation off-main-thread (opacity-only — no transform plumbing).
      const dim = Animated.timing(opacity, {
        toValue: 0.8,
        duration: 800,
        useNativeDriver: true,
      });
      const restore = Animated.timing(opacity, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      });
      const loop = Animated.loop(Animated.sequence([dim, restore]));
      // `useNativeDriver: true` animations require the native animated runtime,
      // which is not present in the node jest env (the view connection throws).
      // The pulse is a native-runtime visual (not unit-testable — the tests
      // assert the `pulse`/`busy` prop WIRING instead, per the spec's caveat).
      // Guard the start so it no-ops in jest without changing native behavior.
      try {
        loop.start();
      } catch {
        // No native animated runtime — the loop is skipped; the `pulse` prop
        // remains forwarded so tests can assert wiring.
      }
      return () => {
        loop.stop();
        // Reset to fully opaque on stop so a mid-cycle stop never leaves a
        // dimmed opacity clashing with a later `disabled` (opacity 0.4) state.
        opacity.setValue(1);
      };
    }
    // When pulse is false, ensure the opacity is the default (in case it was
    // left dimmed by a previous run that stopped mid-fade — the unmount path
    // above already resets, but a prop-flip false without unmount also needs
    // the reset so the disabled style reads correctly).
    opacity.setValue(1);
  }, [pulse, opacity]);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={[
        styles.button,
        { backgroundColor: tokens.primary },
        // Only drive opacity via the animated value while pulsing. When not
        // pulsing the static disabled (0.4) / pressed (0.85) / default (1)
        // styles own opacity cleanly, so an animated value never shadows them
        // in the rendered style (and the disabled look reads stably in tests).
        pulse ? { opacity } : null,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.text}>{label}</Text>
    </AnimatedPressable>
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
    // When `disabled` is true `pulse` is false (the caller drives
    // `pulse={hasStaged && !running}`, `disabled={running || !hasStaged}`), so
    // the animated `opacity` is not in the array and this 0.4 wins — the last
    // opacity entry in the flattened array. Keeps the disabled look stable.
    opacity: 0.4,
  },
});