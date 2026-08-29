/**
 * ScheduleRow — a single schedule surface row (Story 5.1).
 *
 * Renders `[enable-checkbox] name · summary [Edit] [Delete]`, mirroring
 * `DomainRow.tsx`'s row discipline:
 *   - The checkbox is FIRST so Tab order is enable → name → edit → delete
 *     (mount order; UX-DR16/17).
 *   - The name + summary sit in a focusable `View` wrapper
 *     (`accessibilityRole="text"`, `flex: 1`) whose `accessibilityLabel`
 *     combines the name AND the summary so VoiceOver announces both on the
 *     one stop.
 *   - The Edit/Delete controls are always MOUNTED (keyboard-Tab-reachable +
 *     VoiceOver-visible) and visually revealed on row-hover OR control-focus
 *     (`opacity: hovered || focused ? 1 : 0`), keeping layout + Tab order
 *     stable while hidden.
 *   - The row root is a hover-only `Pressable` (`focusable={false}`, no
 *     `onPress`) driving `onHoverIn`/`onHoverOut`.
 *
 * The summary is derived LIVE from the rendered schedule via the pure
 * `formatScheduleSummary` — never from a stale copy. Edit is REAL as of
 * Story 5.2 (it opens the Shell-hosted editor sheet — the surface forwards the
 * `onEditSchedule` prop); Delete is REAL as of Story 5.5 (it opens the
 * surface's confirm alert): this row forwards the schedule's `id` + `name` so
 * the alert copy can name the schedule, and the whole RENDERED schedule to the
 * enable-toggle so the surface can branch disable-confirm vs enable-direct
 * on the rendered `enabled`.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';
import type { Schedule } from '../config/types';
import { Checkbox } from './Checkbox';
import { formatScheduleSummary } from '../domain/scheduleSummary';

export interface ScheduleRowProps {
  schedule: Schedule;
  /**
   * Enable-toggle handler. Receives the WHOLE rendered schedule (not just the
   * id) so the surface can branch on the rendered `enabled`: a disable press
   * (rendered `enabled === true`) opens the confirm alert first, an enable
   * press dispatches directly (Story 5.5).
   */
  onToggleEnabled: (schedule: Schedule) => void;
  /**
   * Edit handler — opens the Shell-hosted editor sheet (Story 5.2). Receives
   * the schedule's `id`.
   */
  onEdit: (id: string) => void;
  /**
   * Delete handler — opens the surface's confirm alert (Story 5.5). Receives
   * the schedule's `id` and `name` (the alert copy names the schedule).
   */
  onDelete: (id: string, name: string) => void;
  /**
   * Disables the checkbox AND the Edit/Delete controls (e.g. while an Apply
   * is in flight). The name/summary label stays readable — only the
   * interactive controls become non-interactive.
   */
  disabled?: boolean;
}

export function ScheduleRow({
  schedule,
  onToggleEnabled,
  onEdit,
  onDelete,
  disabled = false,
}: ScheduleRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [editFocused, setEditFocused] = useState(false);
  const [deleteFocused, setDeleteFocused] = useState(false);
  // The Edit/Delete controls are visible when the pointer hovers the row OR
  // either control itself is focused (keyboard Tab). Always mounted so
  // Tab/VoiceOver reach them; `opacity: 0` keeps layout + Tab order stable
  // while hidden.
  const controlsVisible = hovered || editFocused || deleteFocused;
  // When disabled (Apply running), reveal on hover but dimmed at 0.4 (the
  // same dim the checkbox + Apply button use), conveying "non-interactive".
  const controlsOpacity = controlsVisible ? (disabled ? 0.4 : 1) : 0;
  // The summary derives live from the rendered schedule (the surface renders
  // `stagedSchedules ?? committed.schedules`, so a staged toggle re-renders
  // this row with the new `enabled` — and any future editor change likewise).
  const summary = formatScheduleSummary(schedule);

  return (
    <Pressable
      // Hover container only — no `onPress`. The checkbox keeps its own
      // press; this Pressable exists solely to track row hover for the
      // Edit/Delete reveal. `focusable={false}` keeps it out of the Tab
      // order so Tab order stays enable -> name -> edit -> delete.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      focusable={false}
      style={styles.row}
    >
      <Checkbox
        checked={schedule.enabled}
        onPress={() => onToggleEnabled(schedule)}
        // State-neutral imperative label (review BH-15): "Enable {name}" not
        // "Enabled for {name}" — VoiceOver already speaks the checked state
        // from `accessibilityState`, so a state-bearing label would read
        // "Enabled for X, checked" / "…, unchecked" (a contradiction when
        // unchecked).
        accessibilityLabel={`Enable ${schedule.name}`}
        disabled={disabled}
      />
      {/* The name + summary are a focusable wrapper so they are one Tab/
          VoiceOver stop AFTER the checkbox (Tab order enable -> name ->
          edit -> delete). The accessibilityLabel carries BOTH the name and
          the summary so VoiceOver announces "name, summary" on the row. */}
      <View
        focusable
        enableFocusRing
        accessibilityRole="text"
        accessibilityLabel={`${schedule.name}, ${summary}`}
        style={styles.labelWrap}
      >
        <Text style={styles.name} numberOfLines={1}>
          {schedule.name}
        </Text>
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
        </Text>
      </View>
      {/* The Edit control (Story 5.2 — opens the Shell-hosted editor sheet).
          Always MOUNTED (Tab/VoiceOver-reachable) and visually revealed on
          row-hover OR focus, so the pointer-only hover path and the keyboard
          Tab path both surface it. */}
      <Pressable
        onPress={() => onEdit(schedule.id)}
        disabled={disabled}
        focusable
        enableFocusRing
        onFocus={() => setEditFocused(true)}
        onBlur={() => setEditFocused(false)}
        accessibilityRole="button"
        accessibilityLabel={`Edit ${schedule.name}`}
        accessibilityState={{ disabled }}
        style={[styles.control, { opacity: controlsOpacity }]}
      >
        <Text style={styles.controlLabel}>Edit</Text>
      </Pressable>
      {/* The Delete control (Story 5.5 — the surface's confirm alert gates
          the staging; NOT password-gated per the epic's gate scope, config
          edits are not escapes). Subdued destructive tint like DomainRow's
          Remove. */}
      <Pressable
        onPress={() => onDelete(schedule.id, schedule.name)}
        disabled={disabled}
        focusable
        enableFocusRing
        onFocus={() => setDeleteFocused(true)}
        onBlur={() => setDeleteFocused(false)}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${schedule.name}`}
        accessibilityState={{ disabled }}
        style={[styles.control, { opacity: controlsOpacity }]}
      >
        <Text style={[styles.controlLabel, styles.deleteLabel]}>Delete</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // 8pt-grid: checkbox, then a small gap, then name/summary, then the
    // trailing Edit/Delete controls.
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.sm,
    borderRadius: tokens.rounded.sm,
  },
  labelWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  name: {
    ...tokens.typography.body,
  },
  // Subdued so the summary reads as a description of the row, not a second
  // primary line (mirrors Blocklist's changesHint dim).
  summary: {
    ...tokens.typography.label,
    opacity: 0.7,
  },
  // The trailing controls sit to the right of the label (labelWrap has
  // `flex: 1`, pushing them to the row's trailing edge). Borderless + subdued
  // so they read as secondary affordances, not primary actions.
  control: {
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: tokens.spacing.xs,
    borderRadius: tokens.rounded.sm,
  },
  controlLabel: {
    ...tokens.typography.label,
    color: tokens.primary,
  },
  deleteLabel: {
    color: tokens.destructive,
  },
});