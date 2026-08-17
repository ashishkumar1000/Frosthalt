/**
 * SetPassword — the set-password form (Story 3.1).
 *
 * Two `secureTextEntry` fields (entry + confirm) with per-field Show/Hide
 * toggles, live length + match validation mirroring `AddDomain`'s inline-error
 * pattern (`accessibilityRole="alert"` + `tokens.destructive`), and a
 * disabled-until-clean submit that calls `useDomainStore.setPassword` and
 * clears the fields on success.
 *
 * The form is the FIRST half of the password gate (the ability to SET a
 * password and persist it hashed). The reusable gate sheet, throttle, change-
 * password, and Panic are Stories 3-2/3-3/3-4 — do NOT build them here.
 *
 * Ports & adapters, one-way: reads `committed.passwordHash` + `setPassword`
 * from the Zustand store and calls `setPassword` only — no ports, no
 * `child_process`/`fs`/`os`. Plaintext lives only in the field `useState`; it
 * is cleared on success and never persisted (the store hashes via salt-free
 * SHA-256 before writing `config.json`, AD-9).
 *
 * Validation is purely DERIVED from the two `useState` strings (entry +
 * confirm), so it can never drift from what `setPassword` would write:
 *   - empty/blank either field -> submit disabled (clean gate), no error spam
 *   - entry shorter than `PASSWORD_MIN_LENGTH` -> inline length error, disabled
 *   - confirm mismatches entry -> inline match error, disabled
 *   - clean (length ok + match) -> submit enabled
 *
 * Field a11y (the spec's Always + Acceptance): `secureTextEntry`,
 * `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`,
 * `autoComplete="off"`; paste allowed (no `secureTextEntry` override on paste);
 * Show/Hide toggle with VoiceOver labels on the field AND the toggle; no
 * password field is ever the window default (the submit button is a plain
 * `Pressable`, not a default-button binding).
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDomainStore } from '../domain/store';
import { PASSWORD_MIN_LENGTH } from '../config/password';
import { tokens } from '../theme/tokens';

/** Inline error: entry shorter than the minimum length. */
const TOO_SHORT_MSG = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
/** Inline error: confirm field does not match the entry. */
const MISMATCH_MSG = "Passwords don't match.";
/** Inline error surfaced when the store's `writeConfig` fails. */
const SAVE_FAILED_MSG = "Couldn't save password. No changes made.";
/** Success confirmation shown after the password is set. */
const SET_CONFIRM_MSG = 'Password set.';

export function SetPassword(): React.ReactElement {
  const setPassword = useDomainStore((s) => s.setPassword);

  const [entry, setEntry] = useState('');
  const [confirm, setConfirm] = useState('');
  // Per-field Show/Hide toggles. Independent so the user can reveal one to
  // verify while typing the other (a common password-manager workflow).
  const [showEntry, setShowEntry] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Saving state: while the enqueued `setPassword` write is in flight (waits
  // behind any in-flight Apply via the shared queue), the submit button is
  // disabled and labelled "Saving…". Resolves in a single microtask when the
  // queue is idle (writeConfig is a sync native call).
  const [saving, setSaving] = useState(false);
  // Settled status: 'idle' | 'saved' | 'error'. 'saved' clears the form and
  // shows the success line; 'error' surfaces SAVE_FAILED_MSG and retains the
  // fields so the user can retry without retyping.
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const entryTrimmed = entry.trim();
  const confirmTrimmed = confirm.trim();

  // Error precedence: empty -> none (clean gate, no spam); entry too short ->
  // TOO_SHORT; confirm non-empty but mismatched -> MISMATCH. The length check
  // keys off the ENTRY (the field that matters); a short entry is the primary
  // rejection. The match check keys off BOTH fields being non-empty so an
  // empty confirm does not spam "mismatch" before the user has typed it.
  const tooShort = entryTrimmed !== '' && entryTrimmed.length < PASSWORD_MIN_LENGTH;
  const mismatch =
    entryTrimmed !== '' &&
    confirmTrimmed !== '' &&
    entryTrimmed !== confirmTrimmed;
  const error: string | null = tooShort
    ? TOO_SHORT_MSG
    : mismatch
      ? MISMATCH_MSG
      : null;

  // Submit is enabled only for a genuinely clean, matching, length-ok entry.
  // `saving` disables it while the write is in flight; `status === 'saved'`
  // hides the form entirely (the parent Settings screen re-renders to the
  // "Password set" state via `committed.passwordHash`, but in case the parent
  // has not re-rendered yet the local 'saved' status also short-circuits).
  //
  // The gate encodes the contract DIRECTLY — entry long enough AND confirm
  // filled AND the two equal — rather than negating the error flags. The
  // error flags above intentionally suppress "mismatch" when the confirm is
  // empty (to avoid spamming the user before they type the retype), but that
  // suppression must NOT open the gate: an empty confirm is still a mismatch
  // for submission purposes (the matrix's "empty in either field -> submit
  // disabled" row + AC-3). Negating `mismatch`/`isEmpty` here would let a
  // valid-length entry with a blank confirm through — setting a password
  // with no retype confirmation. So the gate is positive and self-contained.
  const canSubmit =
    !saving &&
    status !== 'saved' &&
    entryTrimmed.length >= PASSWORD_MIN_LENGTH &&
    confirmTrimmed !== '' &&
    entryTrimmed === confirmTrimmed;

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    // Pass the trimmed entry — `setPassword` hashes via `hashPassword` (salt-
    // free SHA-256) and writes `passwordHash` to `config.json`. The plaintext
    // is used only inside this call and never persisted.
    //
    // `.catch` is the single safety net for ANY rejection (the store's
    // `writeConfig` port never throws — it returns a `{ok,error?}` envelope —
    // so under the current contract the promise resolves, never rejects; but a
    // UI must never leave a spinner stuck on an unforeseen rejection, so this
    // flips `saving` off and surfaces the error state regardless of cause).
    setPassword(entryTrimmed)
      .then((result) => {
        setSaving(false);
        if (result.ok) {
          // Clear the fields on success (plaintext leaves the field lifecycle).
          setEntry('');
          setConfirm('');
          setShowEntry(false);
          setShowConfirm(false);
          setStatus('saved');
        } else {
          // writeConfig failed: surface the error, retain the fields so the
          // user can retry without retyping. committed.passwordHash is
          // unchanged (the store leaves committed unchanged on failure).
          setStatus('error');
        }
      })
      .catch(() => {
        setSaving(false);
        setStatus('error');
      });
  };

  // Editing either field after a save failure clears the stale save-error so a
  // valid correction isn't shown alongside a contradictory "Couldn't save"
  // message. Validation errors are re-derived on every render, so they update
  // naturally; only the settled `status === 'error'` line needs this reset.
  const onEntryChange = (text: string) => {
    setEntry(text);
    setStatus((s) => (s === 'error' ? 'idle' : s));
  };
  const onConfirmChange = (text: string) => {
    setConfirm(text);
    setStatus((s) => (s === 'error' ? 'idle' : s));
  };

  // After a successful save the parent Settings screen swaps to the "Password
  // set" state via `committed.passwordHash`; until then, show a success line.
  if (status === 'saved') {
    return (
      <View style={styles.container}>
        <Text style={styles.body}>{SET_CONFIRM_MSG}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.fieldGroup}>
        <Text style={styles.label}>Password</Text>
        <View style={styles.row}>
          <TextInput
            value={entry}
            onChangeText={onEntryChange}
            secureTextEntry={!showEntry}
            placeholder="Enter password"
            accessibilityLabel="New password"
            accessibilityHint={`At least ${PASSWORD_MIN_LENGTH} characters`}
            // Disable every OS-level text rewriting so a typed password
            // reaches `setPassword` verbatim. Paste is left enabled
            // (secureTextEntry does not block paste; password-manager paste
            // is a supported workflow per the spec).
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            // `editable={!saving}` freezes the field while a write is queued
            // (e.g. behind an in-flight Apply) so the value shown always
            // matches what was hashed. `maxLength` caps a paste so the pure-JS
            // SHA-256 can't be made to churn on a huge input.
            editable={!saving}
            maxLength={1024}
            onSubmitEditing={handleSubmit}
            submitBehavior="submit"
            style={styles.input}
          />
          <Pressable
            onPress={() => setShowEntry((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showEntry ? 'Hide password' : 'Show password'}
            style={styles.toggle}
          >
            <Text style={styles.toggleLabel}>{showEntry ? 'Hide' : 'Show'}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.label}>Confirm password</Text>
        <View style={styles.row}>
          <TextInput
            value={confirm}
            onChangeText={onConfirmChange}
            secureTextEntry={!showConfirm}
            placeholder="Re-enter password"
            accessibilityLabel="Confirm new password"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            editable={!saving}
            maxLength={1024}
            onSubmitEditing={handleSubmit}
            submitBehavior="submit"
            style={styles.input}
          />
          <Pressable
            onPress={() => setShowConfirm((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={
              showConfirm ? 'Hide confirm password' : 'Show confirm password'
            }
            style={styles.toggle}
          >
            <Text style={styles.toggleLabel}>
              {showConfirm ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        </View>
      </View>

      {error != null ? (
        // `accessibilityRole="alert"` so VoiceOver announces the error when it
        // appears (mirrors `AddDomain`'s inline-error pattern). No
        // `numberOfLines` — the corrective hint must not truncate.
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {status === 'error' ? (
        // The save-failure error is surfaced separately from the validation
        // errors so a validation fix + retry does not clear it prematurely
        // (it clears on the next successful submit). Also an alert role so
        // VoiceOver speaks it.
        <Text style={styles.error} accessibilityRole="alert">
          {SAVE_FAILED_MSG}
        </Text>
      ) : null}

      <Pressable
        onPress={handleSubmit}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityLabel="Set password"
        accessibilityState={{ disabled: !canSubmit, busy: saving }}
        style={({ pressed }) => [
          styles.submit,
          { backgroundColor: tokens.primary },
          pressed && styles.pressed,
          !canSubmit && styles.disabled,
        ]}
      >
        <Text style={styles.submitLabel}>
          {saving ? 'Saving…' : 'Set password'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: tokens.spacing.md,
  },
  fieldGroup: {
    flexDirection: 'column',
    gap: tokens.spacing.xs,
  },
  label: {
    ...tokens.typography.label,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
  },
  input: {
    flex: 1,
    ...tokens.typography.body,
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
  },
  body: {
    ...tokens.typography.body,
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