/**
 * AddDomain — the add-domain field with live normalisation (Story 2.2).
 *
 * An always-visible `TextInput` + Add button (the `ApplyButton` primitive
 * reused, label "Add") with a live normalised-form preview as the user types
 * and inline errors for invalid / duplicate input. Add stays disabled until the
 * input is clean (valid + non-duplicate + non-empty). Pressing Add (or Return
 * in the field) calls the existing 1.6 `stageDomainAdd` (normalises + stages
 * `alwaysOn:true`); the field clears on `{ ok: true }` and the new row appears
 * staged, committed by the existing 2.1 Apply button. No new privileged code.
 *
 * Ports & adapters, one-way: AddDomain reads `committed`/`staged` from the
 * Zustand store and calls `stageDomainAdd` only — no ports, no
 * `child_process`/`fs`/`os`.
 *
 * Live preview + validation reuse the existing pure `normaliseDomain`
 * (`normalise.ts:59`) — the SAME helper the store uses — so the preview is
 * always exactly what would enter config on Add. No re-normalisation logic in
 * the UI.
 *
 * The UI does its OWN duplicate gate: `stageDomainAdd` returns `{ ok:true }`
 * idempotently for a duplicate and leaves `staged` untouched, so without a UI
 * gate a duplicate Add would clear the field without adding. The UI checks
 * `(staged ?? committed.domains).some((d) => d.hostname === normalised)` and
 * disables Add, so Add only fires for a genuinely new domain.
 *
 * `forwardRef` exposes the underlying `TextInput` ref so the Shell can focus it
 * on ⌘N (`addFieldRef.current?.focus()`, mirroring the `selectRow` ref-focus
 * pattern at `Shell.tsx:48`).
 */

import React, { forwardRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useDomainStore } from '../domain/store';
import { normaliseDomain } from '../domain/normalise';
import { tokens } from '../theme/tokens';
import { ApplyButton } from './ApplyButton';

/** Inline error: non-hostname input. Matches the spec I/O matrix verbatim. */
const INVALID_MSG = 'Invalid domain. Try `example.com`.';
/** Inline error: normalised apex already in committed/staged. */
const DUPLICATE_MSG = 'Already in your list.';

export interface AddDomainProps {
  /**
   * Optional accessibility label for the text field. Tests and the ⌘N focus
   * path locate the field by its contract props (`onChangeText` + `value`),
   * not by label, but the label is kept explicit for VoiceOver.
   */
  accessibilityLabel?: string;
  /**
   * Focus-change signal for the Shell's Return -> Apply gating (Story 2.3).
   * Fired with `true` on `onFocus` and `false` on `onBlur`. The Shell tracks
   * `addFieldFocused` via this callback so the focused field deterministically
   * owns bare Return (-> Add), and a blurred field lets Return fall through to
   * Apply. Deterministic + unit-testable (no reliance on Return bubble
   * semantics, which are uncertain in react-native-macos).
   */
  onFocusChange?: (focused: boolean) => void;
}

/**
 * The add field. Reads `committed`/`staged` + `stageDomainAdd` from the store
 * and owns only the raw-input `useState` — `normalised`, `isDuplicate`, the
 * preview, the error, and the Add-enabled gate are all DERIVED from `raw` +
 * the store, so they can never drift from what `stageDomainAdd` would do.
 */
export const AddDomain = forwardRef<TextInputType, AddDomainProps>(
  function AddDomain({ accessibilityLabel = 'Add domain', onFocusChange }, ref) {
    const [raw, setRaw] = useState('');
    const committed = useDomainStore((s) => s.committed);
    const staged = useDomainStore((s) => s.staged);
    const stageDomainAdd = useDomainStore((s) => s.stageDomainAdd);

    // Derive the preview + validation from the raw input + the store. The
    // empty case (whitespace-only) is distinguished from invalid so an empty
    // field shows NEITHER preview NOR error — the field is just idle.
    const trimmed = raw.trim();
    const isEmpty = trimmed === '';
    const normalised = isEmpty ? null : normaliseDomain(raw);
    // The duplicate check uses the SAME list the store's `stageDomainAdd`
    // builds on (`staged ?? committed.domains`), so the UI gate and the store
    // agree on what "duplicate" means.
    const domains = staged ?? committed.domains;
    const isDuplicate =
      normalised != null && domains.some((d) => d.hostname === normalised);

    // Error precedence: empty -> none; invalid -> INVALID_MSG; duplicate ->
    // DUPLICATE_MSG; clean -> none. The preview shows whenever the input
    // normalises to a valid apex (including the duplicate case, per the spec
    // I/O matrix: a duplicate still previews `-> example.com`).
    const error: string | null = isEmpty
      ? null
      : normalised == null
        ? INVALID_MSG
        : isDuplicate
          ? DUPLICATE_MSG
          : null;
    const preview = normalised != null ? `→ ${normalised}` : null;
    // Add is enabled only for a genuinely new, valid, non-empty input. This is
    // the UI gate that prevents a duplicate Add from clearing the field
    // silently (stageDomainAdd returns { ok:true } idempotently for dupes).
    const addEnabled = !isEmpty && normalised != null && !isDuplicate;

    const handleAdd = () => {
      if (!addEnabled) {
        return;
      }
      // Pass the RAW input — `stageDomainAdd` normalises internally via the
      // same `normaliseDomain`, so the UI and the store share one
      // normalisation path (no re-normalisation in the UI).
      const result = stageDomainAdd(raw);
      if (result.ok) {
        // Clear the field, preview, and error on success. They are all derived
        // from `raw`, so a single `setRaw('')` clears them together.
        setRaw('');
      }
    };

    return (
      <View style={styles.container}>
        <View style={styles.row}>
          <TextInput
            ref={ref}
            value={raw}
            onChangeText={setRaw}
            // Return in the field fires Add (clean input only — `handleAdd`
            // early-returns when `!addEnabled`). `submitBehavior="submit"`
            // sends the submit event WITHOUT blurring, so after a successful
            // Add the field stays focused and ready for the next domain.
            onSubmitEditing={handleAdd}
            submitBehavior="submit"
            placeholder="example.com"
            accessibilityLabel={accessibilityLabel}
            // Focus-change signal for the Shell's Return -> Apply gating
            // (Story 2.3). The focused field owns bare Return (-> Add); a
            // blurred field lets Return fall through to Apply.
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            // Disable every form of OS-level text rewriting so a typed domain
            // reaches `normaliseDomain` verbatim — autocorrect can mangle a
            // hostname (`example.com` -> `example.con`), autocapitalize would
            // uppercase the first letter, and spell-check/autocomplete can
            // substitute a dictionary word. Domains must be entered verbatim.
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            style={styles.input}
          />
          <ApplyButton
            label="Add"
            onPress={handleAdd}
            disabled={!addEnabled}
          />
        </View>
        {preview != null ? (
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
        ) : null}
        {error != null ? (
          // `accessibilityRole="alert"` so VoiceOver announces the error when
          // it appears as the user types (sighted users see it; this levels
          // that). No `numberOfLines` — the corrective hint
          // ("Invalid domain. Try `example.com`.") must not truncate with an
          // ellipsis on a narrow window.
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: tokens.spacing.xs,
    // A touch of separation from the row list below (Blocklist composes this
    // above the rows / empty-state copy).
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
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    // `focusable` is implicit on TextInput; the visible focus ring comes from
    // the native field's own focus state.
  },
  preview: {
    ...tokens.typography.body,
    // Subdued so the preview reads as a hint, not a result.
    opacity: 0.7,
  },
  error: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
});