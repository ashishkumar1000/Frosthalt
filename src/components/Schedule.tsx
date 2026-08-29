/**
 * Schedule — the scheduled-blocking surface (surface 2, Story 5.1).
 *
 * Renders the committed (or staged-draft) schedules as `ScheduleRow`s —
 * `[enable-checkbox] name · summary · [Edit] [Delete]` — plus the staged-
 * then-Apply controls (Apply + Cancel-staged + the "N changes staged" hint)
 * and the empty state, mirroring `Blocklist.tsx`'s surface shape. Reads
 * `useDomainStore` and calls ONLY `stageScheduleEnabledToggle` /
 * `stageScheduleRemove` / `apply` / `cancelStagedSchedules` — no ports, no
 * `child_process`/`fs`/`os` (ports & adapters, one-way:
 * `UI -> domain (Zustand) -> adapters -> ports`).
 *
 * Rows render `stagedSchedules ?? committed.schedules` so a STAGED edit
 * (toggle, add, remove) shows immediately once staged — a disable stages only
 * after its confirm (Story 5.5 below); Apply commits config + hosts
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
 * Add and Edit are REAL in Story 5.2: the surface takes `onAddSchedule` /
 * `onEditSchedule` props (the Shell owns the schedule-editor sheet's open
 * state — component-local state would need a reverse channel to ⌘N/Esc, which
 * live in the Shell's key handler) and wires the empty-state "Add…" button and
 * each row's Edit control to them. Delete is REAL as of Story 5.5: the surface
 * gates it behind a native confirm alert (`Alert.alert`, the 2-4 pattern) and
 * only the confirm stages via `stageScheduleRemove` — a confirm alert, NOT the
 * password gate (config edits, not escapes, per the epic's gate scope).
 *
 * Story 5.5 also routes the enable checkbox through the SAME confirm, but ONLY
 * when the press would DISABLE the row AS RENDERED (the row's schedule comes
 * from `stagedSchedules ?? committed.schedules`, so the branch uses the
 * rendered `enabled` — a staged-disabled row that is re-checked is "enabling"
 * and goes direct, while a staged-enabled newly-added row that is unchecked IS
 * a disable and confirms). Enabling dispatches directly, no alert — adding and
 * re-enabling are exempt from the gate. The confirm gates the STAGING, never
 * the commit; Cancel/Esc stages nothing. The native alert captures keyboard
 * focus, so the Shell's bare Return->Apply stays inert while it is open — no
 * Shell change needed (the 2-4 precedent).
 *
 * On mount, VoiceOver announces "Schedule, N schedules" so the surface's
 * state is spoken on entry (the Shell's own nav announce stays as-is).
 */

import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import { stagedScheduleChangeCount } from '../domain/stagedScheduleChangeCount';
import { tokens } from '../theme/tokens';
import type { Schedule as ScheduleType } from '../config/types';
import { ApplyButton } from './ApplyButton';
import { ScheduleRow } from './ScheduleRow';

export interface ScheduleProps {
  /**
   * Opens the Shell-hosted add schedule editor sheet (empty-state "Add…" and
   * the ⌘N shortcut both land here — the Shell owns the sheet).
   */
  onAddSchedule: () => void;
  /**
   * Opens the Shell-hosted edit schedule editor sheet pre-filled with the
   * given schedule `id` (row Edit controls).
   */
  onEditSchedule: (id: string) => void;
}

/**
 * Empty-state copy (the spec's exact AC string). The primary "Add…" button
 * renders alongside it.
 */
const EMPTY_STATE_TEXT =
  'No schedules yet. Add one to block on a recurring weekly window.';

export function Schedule({
  onAddSchedule,
  onEditSchedule,
}: ScheduleProps): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  const stagedSchedules = useDomainStore((s) => s.stagedSchedules);
  const applyStatus = useDomainStore((s) => s.applyStatus);
  const stageScheduleEnabledToggle = useDomainStore(
    (s) => s.stageScheduleEnabledToggle,
  );
  const stageScheduleRemove = useDomainStore((s) => s.stageScheduleRemove);
  const apply = useDomainStore((s) => s.apply);
  const cancelStagedSchedules = useDomainStore((s) => s.cancelStagedSchedules);

  // The rendered list is the staged draft when one exists, else the committed
  // schedules. A STAGED edit re-renders immediately (a disable stages only
  // after its confirm, Story 5.5); Apply commits; Cancel reverts.
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

  // ----- Story 5.5 — the confirm alerts (delete + disable-on-uncheck) ---------
  // Both confirm gates stage the edit, never the commit: the confirm's
  // `onPress` is the ONLY path that stages (Cancel/Esc stages nothing —
  // exactly the Blocklist.tsx remove-confirm shape, which these mirror
  // verbatim). The native alert captures keyboard focus (so the Shell's
  // Return->Apply gate is inert while it is open) and honours Esc via the
  // cancel-style button — no Shell change. Delete/Disable are
  // `style: 'destructive'` but NOT `isPreferred` — Cancel is the safe
  // Esc/cancel target. No password gate: schedule disable/removal are config
  // edits, not escapes (the epic's resolved gate scope).

  // Delete: the confirm stages `stageScheduleRemove(id)`. The copy states the
  // staged effect plainly and names the Apply step (mirroring 2-4's
  // microcopy).
  const handleDelete = (id: string, name: string) => {
    Alert.alert(
      `Delete ${name}?`,
      'Removing it from your schedule list. This takes effect when you Apply.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => stageScheduleRemove(id),
        },
      ],
    );
  };

  // Enable toggle: confirm ONLY when the press would DISABLE the row AS
  // RENDERED. The row renders `stagedSchedules ?? committed.schedules`, so
  // the branch uses the rendered schedule's `enabled` — a staged-disabled row
  // that is re-checked is "enabling" (exempt, direct dispatch, and the store
  // clean-reverts the buffer to null on net-zero), while a staged-enabled
  // newly-added row that is unchecked IS a disable and confirms. The checkbox
  // flips only on the confirm's `onPress` (the toggle is staged AFTER the
  // confirm, never optimistically before it).
  const handleToggleEnabled = (schedule: ScheduleType) => {
    if (schedule.enabled) {
      Alert.alert(
        `Disable ${schedule.name}?`,
        'Turning off this schedule. This takes effect when you Apply.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disable',
            style: 'destructive',
            onPress: () => stageScheduleEnabledToggle(schedule.id),
          },
        ],
      );
      return;
    }
    // Enabling a disabled schedule is exempt from the gate — dispatch direct.
    stageScheduleEnabledToggle(schedule.id);
  };

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
        // Empty state: the spec's exact AC copy + a primary "Add…" button
        // that opens the Shell-hosted editor sheet (Story 5.2).
        <React.Fragment>
          <Text style={styles.body}>{EMPTY_STATE_TEXT}</Text>
          <Pressable
            onPress={onAddSchedule}
            disabled={running}
            focusable
            enableFocusRing
            accessibilityRole="button"
            accessibilityLabel="Add…"
            accessibilityState={{ disabled: running }}
            // Gated with `disabled={running}` (5-2 review patch): every row
            // control is disabled while an Apply is in flight, and this
            // primary button must not open the editor sheet mid-write either
            // (a draft started against a config that is about to change).
            // The conditional `accessibilityState` replaces review BH-19's
            // "no hard-coded state" rule — the value is now real, not stale
            // noise.
            style={({ pressed }) => [
              styles.addButton,
              pressed && styles.addButtonPressed,
              running && styles.addButtonDisabled,
            ]}
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
                onToggleEnabled={handleToggleEnabled}
                onEdit={onEditSchedule}
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
  addButtonDisabled: {
    opacity: 0.4,
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