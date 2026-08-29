/**
 * PasswordGate — the reusable password-gate sheet (Story 3.2).
 *
 * A Shell-hosted overlay (scrim+panel mirroring `HostsViewer`) with one
 * `secureTextEntry` field + Show/Hide (mirroring `SetPassword`). The store's
 * `requirePassword(action)` opens this sheet when a password is set; the
 * user types their password, `verifyPassword` re-hashes + compares to
 * `committed.passwordHash`, and on success `onVerified` fires (the Shell
 * runs the stashed action + closes the gate). Wrong entries clear the field
 * and show a neutral "That didn't match. N tries left." (no leakage of
 * which part failed); after `GATE_MAX_ATTEMPTS` (5) wrong a throttle shows a
 * visible countdown and disables the field + submit until it elapses, then
 * the countdown tick calls `clearGateThrottle()` for 5 fresh tries. Esc
 * (handled by the Shell) cancels and aborts the action without firing it.
 *
 * Ports & adapters, one-way: reads `verifyPassword` + `clearGateThrottle` +
 * `gateAttempts` + `gateThrottleUntil` from the Zustand store ONLY — no
 * ports, no `child_process`/`fs`/`os`, no `writeConfig`/`writeHosts`. The
 * gate is the SECOND of two distinct gates (the OS admin prompt is the
 * first) and must never be conflated with it (epic-3-context).
 *
 * Built ONCE here and reused by every gated caller (3-3 change-password, 3-4
 * Panic, 4-6 end-early) — do NOT fork per caller. The Shell renders the
 * single hosted instance when `gateOpen` is true.
 *
 * Field a11y (the spec's Always): `secureTextEntry`, `autoCapitalize="none"`,
 * `autoCorrect={false}`, `spellCheck={false}`, `autoComplete="off"`, paste
 * allowed, Show/Hide toggle with VoiceOver labels, `maxLength`. The gate
 * sheet is never the window default (the submit button is a plain
 * `Pressable`, not a default-button binding); Esc cancels.
 */

import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import { tokens } from '../theme/tokens';
import { GATE_MAX_ATTEMPTS } from '../config/password';

export interface PasswordGateProps {
  /** Called when `verifyPassword` returns `{ ok: true }` — the Shell runs the stashed action + closes the gate. */
  onVerified: () => void;
  /** Called on Esc / Cancel — the Shell calls `closeGate` (preserves attempts). */
  onClose: () => void;
}

const TITLE = 'Enter password';
const CANCEL_LABEL = 'Cancel';
const SUBMIT_LABEL = 'Verify';
const PLACEHOLDER = 'Enter your password';
const THROTTLE_HEADLINE = 'Too many attempts.';

export function PasswordGate({
  onVerified,
  onClose,
}: PasswordGateProps): React.ReactElement {
  const verifyPassword = useDomainStore((s) => s.verifyPassword);
  const clearGateThrottle = useDomainStore((s) => s.clearGateThrottle);
  const gateAttempts = useDomainStore((s) => s.gateAttempts);
  const gateThrottleUntil = useDomainStore((s) => s.gateThrottleUntil);

  // Plaintext lives only in this `useState` — cleared on every submit (wrong)
  // and on success (the component unmounts as the gate closes). Never logged,
  // never persisted (the spec's Never clause).
  const [entry, setEntry] = useState('');
  // Per-field Show/Hide toggle (mirrors `SetPassword`).
  const [show, setShow] = useState(false);
  // The visible countdown value (ms remaining). `null` when not throttled.
  const [countdown, setCountdown] = useState<number | null>(null);

  const now = Date.now();
  const throttled =
    gateThrottleUntil != null && gateThrottleUntil > now;

  // Countdown interval: while throttled, tick every 1s; at 0 call
  // `clearGateThrottle()` (the spec's "setInterval calling clearGateThrottle()
  // at 0"). The effect re-runs when `gateThrottleUntil` changes (null -> a
  // number starts the interval; a number -> null stops it via cleanup).
  useEffect(() => {
    if (gateThrottleUntil == null) {
      setCountdown(null);
      return;
    }
    const tick = () => {
      const remaining = gateThrottleUntil - Date.now();
      if (remaining <= 0) {
        clearGateThrottle();
        setCountdown(null);
      } else {
        setCountdown(remaining);
      }
    };
    // Run once immediately so the countdown shows on mount / throttle engage
    // without waiting a full second for the first tick.
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [gateThrottleUntil, clearGateThrottle]);

  // NO auto-focus on mount — deliberately (crash hotfix, found on the first
  // real `pnpm macos` run of the 6.2 badge). Programmatic `.focus()` on a
  // `secureTextEntry` field takes AppKit's `selectText:` path
  // (`NSWindow makeFirstResponder:` -> `NSTextField selectText:` ->
  // `NSCell selectWithFrame:...`), and macOS 12+ asserts INSIDE that path:
  // "NSSecureTextFieldCell is not secure because the secure field editor's
  // delegate must be an NSSecureTextField!" — react-native-macos's
  // `RCTUISecureTextField` is a plain `NSTextField` subclass that only swaps
  // in an `NSSecureTextFieldCell` (PR #612), so the assertion fires and the
  // app SIGABRTs the moment the gate opens. The USER-CLICK edit path
  // (`NSCell editWithFrame:...`) does NOT hit the assertion — typing into the
  // secure SetPassword fields has always worked — so the gate is fully usable
  // without auto-focus; the user just clicks the field first. Do NOT re-add
  // `.focus()`/`autoFocus` here or on ANY `secureTextEntry` field on macOS
  // (the plain-field mount focuses in Shell/ScheduleEditor are safe — the
  // assertion is secure-editor-only).
  //
  // If the gate mounts with a throttle timestamp already in the past (e.g. the
  // sheet was closed mid-throttle and re-opened after expiry, before the
  // countdown tick ran), clear it now so the user isn't shown "0 tries left".
  // `clearGateThrottle` is a guarded no-op when not throttled, and resets
  // attempts for 5 fresh tries when the timestamp is stale-but-present.
  // Mount-only (empty-deps pattern).
  useEffect(() => {
    if (gateThrottleUntil != null && gateThrottleUntil <= Date.now()) {
      clearGateThrottle();
    }
  }, []);

  const handleSubmit = () => {
    // Trim before verify to match 3-1's `SetPassword` (which trims at submit
    // before hashing) — otherwise a password typed with accidental surrounding
    // spaces would never verify and the user would be locked out. The emptiness
    // gate uses the same trimmed value so the two stay consistent.
    const trimmed = entry.trim();
    // Recompute throttle with a fresh clock — the render-time `throttled` can
    // be up to ~1s stale (the countdown ticks every 1s), and a submit landing
    // right after expiry should proceed, not be blocked by a stale render.
    const freshThrottled =
      gateThrottleUntil != null && gateThrottleUntil > Date.now();
    if (trimmed === '' || freshThrottled) {
      return;
    }
    const result = verifyPassword(trimmed);
    if (result.ok) {
      // The Shell's `onVerified` runs the stashed action + closes the gate
      // (which unmounts this component). Don't clear the field here — the
      // unmount discards it, and a setState after unmount is a no-op warning.
      onVerified();
      return;
    }
    // Wrong or throttled: clear the field (the spec's "Field cleared" on
    // wrong; on a throttle-during-submit the field also clears). The store
    // state (`gateAttempts`/`gateThrottleUntil`) drives the message +
    // countdown on the next render.
    setEntry('');
  };

  // The neutral tries-left message: shows only after a wrong attempt
  // (`gateAttempts > 0`) and NOT while throttled (the countdown replaces it).
  // N = `GATE_MAX_ATTEMPTS - gateAttempts` (the spec's "N = 5−attempts").
  // Clamp at 0 so a seeded over-count (attempts > GATE_MAX_ATTEMPTS) can't
  // render a negative "N tries left". Normal flow caps attempts at the throttle
  // threshold, so this is defensive.
  const triesLeft = Math.max(0, GATE_MAX_ATTEMPTS - gateAttempts);
  const showTriesLeft = gateAttempts > 0 && !throttled;

  // Submit is disabled until clean (non-empty entry) and during throttle (the
  // spec's "submit disabled until clean and during throttle").
  const canSubmit = entry.trim() !== '' && !throttled;

  // Countdown display: round up so the user sees "30s" immediately, then
  // counts down to "1s" before clearing. Tabular nums (tokens.typography.countdown)
  // keep the digit width fixed so the line doesn't jitter.
  const countdownSeconds =
    countdown != null ? Math.max(1, Math.ceil(countdown / 1000)) : 0;

  return (
    <View style={styles.scrim} accessibilityLabel="Password gate overlay">
      {/* No `accessibilityRole` on the panel container: `alert` would make
          VoiceOver re-announce the whole panel on every countdown tick. The
          panel is a plain grouping; the dynamic tries-left + throttle messages
          below carry their own `accessibilityRole="alert"` so they announce on
          appearance/change. */}
      <View style={styles.panel} accessibilityLabel="Password gate">
        <View style={styles.header}>
          <Text style={styles.title}>{TITLE}</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={CANCEL_LABEL}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.closePressed,
            ]}
          >
            <Text style={styles.closeText}>{CANCEL_LABEL}</Text>
          </Pressable>
        </View>

        <View style={styles.fieldGroup}>
          <View style={styles.row}>
            <TextInput
              value={entry}
              onChangeText={setEntry}
              secureTextEntry={!show}
              placeholder={PLACEHOLDER}
              accessibilityLabel="Gate password"
              // Disable every OS-level text rewriting so a typed password
              // reaches `verifyPassword` verbatim. Paste is left enabled
              // (secureTextEntry does not block paste; password-manager paste
              // is a supported workflow per the spec).
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              // `editable={!throttled}` freezes the field during the throttle
              // (the spec's "field+submit disabled until it elapses").
              editable={!throttled}
              maxLength={1024}
              onSubmitEditing={handleSubmit}
              submitBehavior="submit"
              style={styles.input}
            />
            <Pressable
              onPress={() => setShow((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={show ? 'Hide password' : 'Show password'}
              style={styles.toggle}
            >
              <Text style={styles.toggleLabel}>{show ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
        </View>

        {showTriesLeft ? (
          // Neutral tries-left message (the spec's "That didn't match. N tries
          // left." — no leakage of which part failed). `accessibilityRole="alert"`
          // so VoiceOver announces it when it appears (mirrors `SetPassword`'s
          // inline-error pattern). No `numberOfLines` — the message must not
          // truncate.
          <Text style={styles.error} accessibilityRole="alert">
            That didn&apos;t match. {triesLeft} tries left.
          </Text>
        ) : null}

        {throttled ? (
          // Throttle countdown: a visible wait. The headline + the seconds
          // remaining. `accessibilityRole="alert"` so VoiceOver speaks the
          // throttle. Tabular nums on the seconds keep the digit width fixed.
          <View style={styles.throttle} accessibilityRole="alert">
            <Text style={styles.throttleHeadline}>{THROTTLE_HEADLINE}</Text>
            <Text style={styles.throttleCountdown}>
              Try again in {countdownSeconds}s.
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={SUBMIT_LABEL}
          accessibilityState={{ disabled: !canSubmit }}
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: tokens.primary },
            pressed && styles.pressed,
            !canSubmit && styles.disabled,
          ]}
        >
          <Text style={styles.submitLabel}>{SUBMIT_LABEL}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // A dim scrim focuses attention on the panel (mirrors `HostsViewer`).
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panel: {
    backgroundColor: tokens.monoBg,
    borderRadius: tokens.rounded.lg,
    width: '80%',
    maxWidth: 480,
    padding: tokens.spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.md,
  },
  title: {
    ...tokens.typography.title,
    color: tokens.monoFg,
  },
  closeButton: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    backgroundColor: tokens.monoBg,
  },
  closeText: {
    ...tokens.typography.body,
    color: tokens.monoFg,
  },
  closePressed: {
    opacity: 0.85,
  },
  fieldGroup: {
    flexDirection: 'column',
    gap: tokens.spacing.xs,
    marginBottom: tokens.spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  input: {
    flex: 1,
    ...tokens.typography.body,
    color: tokens.monoFg,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  toggle: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.rounded.md,
  },
  toggleLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  error: {
    ...tokens.typography.body,
    color: tokens.destructive,
    marginBottom: tokens.spacing.md,
  },
  throttle: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
    backgroundColor: tokens.destructive,
  },
  throttleHeadline: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
  throttleCountdown: {
    ...tokens.typography.countdown,
    color: tokens.primaryForeground,
    marginTop: tokens.spacing.xs,
  },
  submit: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  submitLabel: {
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