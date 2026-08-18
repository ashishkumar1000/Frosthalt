/**
 * ChangePassword — the change-password flow (Story 3-3).
 *
 * The FIRST real gate caller: a destructive "Change password" trigger opens
 * the reusable password gate (Story 3-2) to verify the CURRENT password; on
 * verify the gate closes and an inline New+Confirm form (mirroring
 * `SetPassword`) opens. Submitting the form calls the existing `setPassword`
 * (Story 3-1) to overwrite the hash — no new store action, no re-verify inside
 * the form (the gate already verified). Cancel closes the form with no change.
 *
 * Gate-first flow (the spec's Always): the gated action is a UI state flip
 * (`() => setChangeOpen(true)`), NEVER a re-entrant `requirePassword` call —
 * this sidesteps the deferred E1/B3 double-open (deferred-work.md L203-206):
 * the action never calls `requirePassword` again, so it cannot displace its
 * own `gateAction`. The Shell's `runGateAction` (Shell.tsx:208-219) runs the
 * flip, then `closeGate` runs in `finally` — the form opens after the gate
 * closes.
 *
 * Ports & adapters, one-way: reads `setPassword` + `requirePassword` from the
 * Zustand store and calls them only — no ports, no `child_process`/`fs`/`os`.
 * Plaintext lives only in the field `useState`; it is cleared on success and
 * never persisted (the store hashes via salt-free SHA-256 before writing
 * `config.json`, AD-9).
 *
 * The form mirrors `SetPassword` field/a11y/validation/submit-gate exactly:
 * `secureTextEntry` + Show/Hide per field, `autoCapitalize="none"`,
 * `autoCorrect={false}`, `spellCheck={false}`, `autoComplete="off"`,
 * `editable={!saving}`, `maxLength={1024}`, `onSubmitEditing={submit}`,
 * `accessibilityRole="alert"` on errors. Validation:
 * `newTrimmed.length >= PASSWORD_MIN_LENGTH` AND `newTrimmed === confirmTrimmed`
 * (reuse `PASSWORD_MIN_LENGTH` from `password.ts`). The positive submit gate
 * mirrors SetPassword.tsx:103-108.
 *
 * `changeOpen` is COMPONENT-LOCAL UI state — NOT persisted to
 * `config.json`/`Config`/`types.ts` (the spec's Never). It flips true only on a
 * verified gate, and flips false on Cancel or a successful submit.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDomainStore } from '../domain/store';
import { PASSWORD_MIN_LENGTH } from '../config/password';
import { tokens } from '../theme/tokens';

/** Inline error: entry shorter than the minimum length (mirrors SetPassword). */
const TOO_SHORT_MSG = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
/** Inline error: confirm field does not match the entry (mirrors SetPassword). */
const MISMATCH_MSG = "Passwords don't match.";
/** Inline error surfaced when the store's `writeConfig` fails (mirrors SetPassword). */
const SAVE_FAILED_MSG = "Couldn't save password. No changes made.";
/** Success confirmation shown after the password is changed. */
const CHANGE_CONFIRM_MSG = 'Password changed.';
/** Trigger + form submit + cancel labels (distinct so the test finder picks
 *  exactly one button per role even though trigger and submit are never in the
 *  tree at the same time). */
const TRIGGER_LABEL = 'Change password';
const SUBMIT_LABEL = 'Save new password';
const CANCEL_LABEL = 'Cancel';

export function ChangePassword(): React.ReactElement {
  const setPassword = useDomainStore((s) => s.setPassword);

  // `changeOpen` is the UI state flip the gate runs on verify. Component-local
  // state — NOT persisted (the spec's Never).
  const [changeOpen, setChangeOpen] = useState(false);
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
  // Settled status: 'idle' | 'saved' | 'error'. 'saved' closes the form and
  // shows the success line; 'error' surfaces SAVE_FAILED_MSG and retains the
  // fields so the user can retry without retyping.
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  const entryTrimmed = entry.trim();
  const confirmTrimmed = confirm.trim();

  // Error precedence (mirrors SetPassword.tsx:77-86): empty -> none (clean
  // gate, no spam); entry too short -> TOO_SHORT; confirm non-empty but
  // mismatched -> MISMATCH. The length check keys off the ENTRY; the match
  // check keys off BOTH fields being non-empty so an empty confirm does not
  // spam "mismatch" before the user has typed it.
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

  // Submit gate (mirrors SetPassword.tsx:103-108) — positive + self-contained
  // so an empty confirm (suppressed mismatch) can never open the gate: the
  // retype must be present AND equal. `saving` disables it while the write is
  // in flight; `status === 'saved'` hides the form entirely (the closed state
  // renders the trigger instead).
  const canSubmit =
    !saving &&
    status !== 'saved' &&
    entryTrimmed.length >= PASSWORD_MIN_LENGTH &&
    confirmTrimmed !== '' &&
    entryTrimmed === confirmTrimmed;

  // The trigger: gate-first. `requirePassword` short-circuits when no password
  // is set (running the flip immediately, no sheet) — but the parent Settings
  // only renders this component when `hasPassword`, so the gate always opens.
  // The gated action is a UI state flip, NOT a re-entrant `requirePassword`
  // call (the spec's Always — avoids the deferred E1/B3 double-open). Clearing
  // `status` before opening drops any stale success/error from the last flow.
  const onPressChange = () => {
    setStatus('idle');
    useDomainStore.getState().requirePassword(() => setChangeOpen(true));
  };

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    // The gate already verified the current password, so the form's submit
    // only needs to write the new hash — which is exactly `setPassword(newPw)`
    // (store.ts:439-482): enqueue + run-time `committed` re-read +
    // `{ ...committed, passwordHash: hashPassword(pw) }` + writeConfig. No new
    // `changePassword` action, no re-verify (the spec's Never). The plaintext
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
          // Close the form + clear the fields (plaintext leaves the field
          // lifecycle). `committed.passwordHash` has advanced to the new hash;
          // the parent Settings re-renders but `hasPassword` stays true, so the
          // Danger Zone + this component stay mounted — show a local success
          // line via `status === 'saved'` (the closed-state branch below).
          setEntry('');
          setConfirm('');
          setShowEntry(false);
          setShowConfirm(false);
          setChangeOpen(false);
          setStatus('saved');
        } else {
          // writeConfig failed: surface the error, retain the form + fields so
          // the user can retry without retyping. `committed.passwordHash` is
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
  // message (mirrors SetPassword.tsx:151-158). Validation errors are re-derived
  // on every render; only the settled `status === 'error'` line needs this.
  const onEntryChange = (text: string) => {
    setEntry(text);
    setStatus((s) => (s === 'error' ? 'idle' : s));
  };
  const onConfirmChange = (text: string) => {
    setConfirm(text);
    setStatus((s) => (s === 'error' ? 'idle' : s));
  };

  // Cancel closes the form with no change (the spec's matrix). Clear the fields
  // so a re-open starts fresh; reset show flags + status.
  const onCancel = () => {
    setChangeOpen(false);
    setEntry('');
    setConfirm('');
    setShowEntry(false);
    setShowConfirm(false);
    setStatus('idle');
  };

  // Closed state: render the destructive trigger (+ a success line if the last
  // submit succeeded). The success line clears on the next trigger press. The
  // trigger is an OUTLINED destructive button (border + text in
  // `tokens.destructive`), never a filled primary — so it is never the window
  // default (never pulses), per the spec's Never.
  if (!changeOpen) {
    return (
      <View style={styles.container}>
        {status === 'saved' ? (
          <Text style={styles.body} accessibilityRole="alert">
            {CHANGE_CONFIRM_MSG}
          </Text>
        ) : null}
        <Pressable
          onPress={onPressChange}
          accessibilityRole="button"
          accessibilityLabel={TRIGGER_LABEL}
          style={({ pressed }) => [
            styles.trigger,
            { borderColor: tokens.destructive },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.triggerLabel, { color: tokens.destructive }]}>
            {TRIGGER_LABEL}
          </Text>
        </Pressable>
      </View>
    );
  }

  // Open state: the inline New+Confirm form (mirrors SetPassword.tsx:170-283).
  return (
    <View style={styles.container}>
      <View style={styles.fieldGroup}>
        <Text style={styles.label}>New password</Text>
        <View style={styles.row}>
          <TextInput
            value={entry}
            onChangeText={onEntryChange}
            secureTextEntry={!showEntry}
            placeholder="Enter new password"
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
            // so the value shown always matches what was hashed. `maxLength`
            // caps a paste so the pure-JS SHA-256 can't churn on a huge input.
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
        <Text style={styles.label}>Confirm new password</Text>
        <View style={styles.row}>
          <TextInput
            value={confirm}
            onChangeText={onConfirmChange}
            secureTextEntry={!showConfirm}
            placeholder="Re-enter new password"
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
        // appears (mirrors `SetPassword`'s inline-error pattern). No
        // `numberOfLines` — the corrective hint must not truncate.
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {status === 'error' ? (
        // The save-failure error is surfaced separately from the validation
        // errors so a validation fix + retry does not clear it prematurely.
        // Also an alert role so VoiceOver speaks it.
        <Text style={styles.error} accessibilityRole="alert">
          {SAVE_FAILED_MSG}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={SUBMIT_LABEL}
          accessibilityState={{ disabled: !canSubmit, busy: saving }}
          style={({ pressed }) => [
            styles.submit,
            { backgroundColor: tokens.primary },
            pressed && styles.pressed,
            !canSubmit && styles.disabled,
          ]}
        >
          <Text style={styles.submitLabel}>
            {saving ? 'Saving…' : SUBMIT_LABEL}
          </Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={CANCEL_LABEL}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
        >
          <Text style={styles.cancelLabel}>{CANCEL_LABEL}</Text>
        </Pressable>
      </View>
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
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
  },
  // The destructive trigger: an OUTLINED button (border + text in
  // `tokens.destructive`), never a filled primary. A plain Pressable does not
  // bind to the native default-button, so it never pulses — per the spec's
  // Never ("No destructive button is ever the window default").
  trigger: {
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignSelf: 'flex-start',
  },
  triggerLabel: {
    ...tokens.typography.body,
  },
  submit: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitLabel: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
  cancel: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  cancelLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.4,
  },
});