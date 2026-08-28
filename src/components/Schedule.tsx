/**
 * Schedule — the scheduled-blocking surface (surface 2, Story 5.1).
 *
 * Renders the committed (or staged-draft) schedules as `ScheduleRow`s —
 * `[enable-checkbox] name · summary · [Edit] [Delete]` — plus the staged-
 * then-Apply controls (Apply + Cancel-staged + the "N changes staged" hint)
 * and the empty state, mirroring `Blocklist.tsx`'s surface shape. Reads
 * `useDomainStore` and calls ONLY `stageScheduleEnabledToggle` / `apply` /
 * `cancelStagedSchedules` — no ports, no `child_process`/`fs`/`os` (ports &
 * adapters, one-way: `UI -> domain (Zustand) -> adapters -> ports`).
 *
 * Optimistic toggle: rows render `stagedSchedules ?? committed.schedules` so
 * a pending enable-toggle shows immediately; Apply commits config + hosts
 * (the existing 1.6 serialized pipeline — one config write carries BOTH the
 * domain and schedule buffers); Cancel discards only the schedule draft (the
 * Blocklist's staged edits are untouched). The enable control is a macOS
 * checkbox (never a switch). No password gate anywhere on this surface.
 *
 * Apply is disabled when `running || stagedSchedules == null` (no redundant
 * admin prompt for a clean schedule draft — `stageScheduleEnabledToggle`'s
 * clean-revert keeps the buffer null on a net-no-op toggle). The Schedule
 * surface's Apply gates on the SCHEDULE buffer only; the Blocklist surface
 * gates on the DOMAIN buffer only — while the shared `apply()` commits both
 * fields in one write.
 *
 * Edit/Delete/Add are ANNOUNCE-ONLY placeholders: Story 5.2 owns the editor
 * sheet, Story 5.5 owns the removal confirm alert (which is a confirm alert,
 * NOT password-gated — escapes only, per the epic's gate scope). Each press
 * announces the placeholder to VoiceOver and raises a small component-local
 * toast (the 4.3 placeholder-toast precedent — no store toast, no gate, no
 * staging, no port call).
 *
 * On mount, VoiceOver announces "Schedule, N schedules" so the surface's
 * state is spoken on entry (the Shell's own nav announce stays as-is).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import { stagedScheduleChangeCount } from '../domain/stagedScheduleChangeCount';
import { tokens } from '../theme/tokens';
import { ApplyButton } from './ApplyButton';
import { ScheduleRow } from './ScheduleRow';

/**
 * Empty-state copy (the spec's exact AC string). The primary "Add…"
 * placeholder button renders alongside it.
 */
const EMPTY_STATE_TEXT =
  'No schedules yet. Add one to block on a recurring weekly window.';

// ----- Story 5.2 / 5.5 placeholder copy ------------------------------------
// Each placeholder is labelled for its future owner. The EDIT copy is the
// Story 5.2 editor-sheet placeholder; the DELETE copy is the Story 5.5
// removal-confirm placeholder; the ADD copy covers both the empty-state
// "Add…" button and (later) the ⌘N add-editor entry point.
const ADD_PLACEHOLDER_TEXT = 'Adding a schedule is coming soon.';
const EDIT_PLACEHOLDER_TEXT = 'Editing schedules is coming soon.';
const DELETE_PLACEHOLDER_TEXT = 'Removing schedules is coming soon.';
// Auto-dismiss timeout for the component-local placeholder toast (8 s, the
// same auto-dismiss the Shell-level store toast uses).
const PLACEHOLDER_TOAST_DISMISS_MS = 8000;

export function Schedule(): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  const stagedSchedules = useDomainStore((s) => s.stagedSchedules);
  const applyStatus = useDomainStore((s) => s.applyStatus);
  const stageScheduleEnabledToggle = useDomainStore(
    (s) => s.stageScheduleEnabledToggle,
  );
  const apply = useDomainStore((s) => s.apply);
  const cancelStagedSchedules = useDomainStore((s) => s.cancelStagedSchedules);

  // The rendered list is the optimistic draft when one exists, else the
  // committed schedules. Toggle -> stageScheduleEnabledToggle -> re-render
  // with the flipped value immediately; Apply commits; Cancel reverts.
  const schedules = stagedSchedules ?? committed.schedules;
  const running = applyStatus === 'running';
  const hasStaged = stagedSchedules != null;
  const isEmpty = committed.schedules.length === 0 && stagedSchedules == null;
  // The "N changes staged" hint count. Diffed by `id` + all fields via the
  // pure `stagedScheduleChangeCount` sibling (order-agnostic; the clean-revert
  // clears the buffer to null on net-zero). Only computed when
  // `stagedSchedules != null` (invariant: buffer != null ⟹ count >= 1).
  const changeCount = stagedSchedules != null
    ? stagedScheduleChangeCount(stagedSchedules, committed.schedules)
    : 0;
  const changesHint =
    changeCount === 1 ? '1 change staged' : `${changeCount} changes staged`;

  // ----- Story 5.2 / 5.5 placeholders (announce-only) -----------------------
  // A small component-local toast (the 4.3 placeholder-toast precedent):
  // the message is announced to VoiceOver AND rendered as a subdued inline
  // toast for 8 s. No store toast (the Shell-level toast is for write
  // outcomes), no gate, no staging, no port call. Auto-dismisses via a
  // module-level timeout captured in a ref, cleared on unmount + on every
  // re-show (the Panic.tsx local-toast timer discipline).
  const [placeholderToast, setPlaceholderToast] = useState<string | null>(null);
  const placeholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    return () => {
      if (placeholderTimerRef.current != null) {
        clearTimeout(placeholderTimerRef.current);
      }
    };
  }, []);
  const showPlaceholder = (message: string) => {
    AccessibilityInfo.announceForAccessibility(message);
    setPlaceholderToast(message);
    if (placeholderTimerRef.current != null) {
      clearTimeout(placeholderTimerRef.current);
    }
    placeholderTimerRef.current = setTimeout(() => {
      setPlaceholderToast(null);
    }, PLACEHOLDER_TOAST_DISMISS_MS);
  };
  // Story 5.2 owns the real add-editor sheet (⌘N while on this surface).
  const handleAdd = () => showPlaceholder(ADD_PLACEHOLDER_TEXT);
  // Story 5.2 owns the real editor sheet.
  const handleEdit = () => showPlaceholder(EDIT_PLACEHOLDER_TEXT);
  // Story 5.5 owns the removal confirm alert (NOT password-gated — escapes
  // only, per the epic's gate scope).
  const handleDelete = () => showPlaceholder(DELETE_PLACEHOLDER_TEXT);

  // Mount announce: "Schedule, N schedules". N is the rendered list length
  // (staged or committed) — what the user sees. Runs once on mount; later
  // changes are spoken by the toggle/Apply interactions themselves.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(
      `Schedule, ${schedules.length} ${
        schedules.length === 1 ? 'schedule' : 'schedules'
      }`,
    );
    // Mount-only — we want the entry announce, not a re-announce on every
    // toggle. The checkbox's `accessibilityState` conveys toggle changes to
    // VoiceOver on the row itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Schedule</Text>
      {isEmpty ? (
        // Empty state: the spec's exact AC copy + a primary "Add…"
        // placeholder button (Story 5.2 owns the real add editor).
        <React.Fragment>
          <Text style={styles.body}>{EMPTY_STATE_TEXT}</Text>
          <Pressable
            onPress={handleAdd}
            focusable
            enableFocusRing
            accessibilityRole="button"
            accessibilityLabel="Add…"
            // No `accessibilityState` here (review BH-19): a hard-coded
            // `disabled: false` is redundant noise — the enabled state is the
            // default VoiceOver reading, and a hard-coded value would go
            // stale the moment this placeholder gains real gating (5.2).
            style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
          >
            <Text style={styles.addButtonLabel}>Add…</Text>
          </Pressable>
        </React.Fragment>
      ) : (
        <>
          <View style={styles.list}>
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onToggleEnabled={stageScheduleEnabledToggle}
                onEdit={handleEdit}
                onDelete={handleDelete}
                disabled={running}
              />
            ))}
          </View>
          <View style={styles.controls}>
            <ApplyButton
              label={running ? 'Applying…' : 'Apply'}
              onPress={() => {
                void apply();
              }}
              disabled={running || !hasStaged}
              pulse={hasStaged && !running}
              busy={running}
            />
            {hasStaged ? (
              <React.Fragment>
                <PressableGhost
                  label="Cancel"
                  onPress={cancelStagedSchedules}
                  disabled={running}
                />
                <Text style={styles.changesHint}>{changesHint}</Text>
              </React.Fragment>
            ) : null}
          </View>
        </>
      )}
      {placeholderToast != null ? (
        // The component-local placeholder toast (subdued inline strip — the
        // 4.3 placeholder-toast precedent, Panic.tsx's local toast styling).
        <View style={styles.placeholderToast}>
          <Text style={styles.placeholderToastText}>{placeholderToast}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A borderless "ghost" button for the Cancel-staged action. Subdued text, no
 * fill — visually secondary to the primary-filled ApplyButton. A local copy
 * of Blocklist's `PressableGhost` (that one is file-private and Story 2.1's
 * only consumer; extraction into a shared primitive is deferred until a third
 * consumer lands).
 */
function PressableGhost({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      focusable
      enableFocusRing
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.ghost,
        pressed && styles.ghostPressed,
        disabled && styles.ghostDisabled,
      ]}
    >
      <Text style={styles.ghostLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: tokens.spacing.lg,
  },
  title: {
    ...tokens.typography.title,
    marginBottom: tokens.spacing.sm,
  },
  body: {
    ...tokens.typography.body,
    marginBottom: tokens.spacing.md,
  },
  // The empty-state "Add…" placeholder — primary-filled (the ApplyButton
  // fill + typography), because the spec calls it the PRIMARY action of the
  // empty state. A plain Pressable (no pulse/busy — those are Apply-only).
  addButton: {
    alignSelf: 'flex-start',
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    backgroundColor: tokens.primary,
  },
  addButtonPressed: {
    opacity: 0.85,
  },
  addButtonLabel: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
  list: {
    flex: 1,
    flexDirection: 'column',
    gap: tokens.spacing.xs,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginTop: tokens.spacing.md,
  },
  changesHint: {
    ...tokens.typography.body,
    // Subdued so the hint reads as a count, not a primary affordance.
    opacity: 0.7,
  },
  // The component-local placeholder toast: a compact subdued strip pinned
  // under the controls (not an overlay — nothing else competes with it on
  // this surface), reusing the mono panel pairing for legibility.
  placeholderToast: {
    marginTop: tokens.spacing.md,
    alignSelf: 'flex-start',
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    borderColor: tokens.primary,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  placeholderToastText: {
    ...tokens.typography.label,
  },
  ghost: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
  },
  ghostPressed: {
    opacity: 0.85,
  },
  ghostLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  ghostDisabled: {
    opacity: 0.4,
  },
});