/**
 * ScheduleEditor — the Shell-hosted add/edit schedule sheet (Story 5.2).
 *
 * A scrim+panel overlay mirroring `PasswordGate`/`HostsViewer`: plain `View`
 * panel (NO accessibilityRole — the gate's alert-echo lesson), no animation,
 * `onClose` for Esc/Cancel (the Shell owns the Esc branch and the open state
 * via `scheduleEditorTarget: 'new' | string | null`).
 *
 * The sheet is a SCRATCHPAD: every keystroke lives in component-local
 * `useState` and NOTHING touches the store until Save. Save is the only
 * staging point — it builds the final `Schedule` (existing `id` when editing;
 * `nextScheduleId(name, existingIds)` when adding) and calls the new
 * `stageScheduleUpsert`, then closes and announces
 * "Schedule staged. Apply to save." Cancel/Esc discards the draft entirely
 * (`stagedSchedules` is untouched — a Cancel must never leave a dirty buffer).
 *
 * Fields: name (`TextInput`, autofocused), 7 weekday chips (Mon→Sun, 0=Mon —
 * `Pressable` + `accessibilityRole="checkbox"` + `accessibilityState.checked`),
 * start/end time `TextInput`s, and a domain multi-select. Time entry is
 * validated `HH:mm` TEXT (the spec's library pin: NO new dependency —
 * `@react-native-community/datetimepicker` has no macOS support), normalised
 * LIVE in render via the SAME pure `normaliseTime` the store re-runs on Save
 * (the `AddDomain.tsx` single-source-of-truth precedent), so the preview can
 * never drift from what stages. Same-day windows only: end strictly after
 * start (zero-padded `HH:mm` compares lexically = chronologically).
 *
 * The domain list is `committed.domains` UNION the edited schedule's own
 * domains (deduped, committed order first), so an ORPHANED domain — removed
 * from the blocklist but still scheduled — stays visible and keeps its
 * membership through Save (the timer precedent: a schedule's set is
 * independent of the blocklist). Every read of `Schedule.domains` defends
 * with `Array.isArray` (missing -> `[]`): configStore validates the schedules
 * ARRAY only, not its elements.
 *
 * Per-field inline errors render only after the field is TOUCHED (an empty
 * fresh draft is idle, not erroneous — the AddDomain empty-vs-invalid
 * distinction). Save is disabled while any field is invalid, with
 * `accessibilityState.disabled` for VoiceOver. An empty domain list (no
 * blocklist entries AND no orphaned memberships) renders a short note and
 * keeps Save disabled.
 *
 * Ports & adapters, one-way: reads `committed`/`stagedSchedules` and calls
 * `stageScheduleUpsert` from the Zustand store ONLY — no ports, no gate
 * (FR-15 exempts add/edit), no `child_process`/`fs`/`os`, no direct config
 * or hosts commits.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useDomainStore } from '../domain/store';
import { normaliseDomain, normaliseTime } from '../domain/normalise';
import { nextScheduleId } from '../domain/scheduleId';
import { formatScheduleSummary } from '../domain/scheduleSummary';
import { tokens } from '../theme/tokens';
import type { Schedule, Weekday } from '../config/types';

export interface ScheduleEditorProps {
  /** `'new'` for an add draft; a schedule `id` to edit (pre-filled from the rendered staged ?? committed schedule). */
  target: 'new' | string;
  /** Called on Save success AND on Esc/Cancel — the Shell clears `scheduleEditorTarget`. */
  onClose: () => void;
}

const TITLE_ADD = 'Add schedule';
const TITLE_EDIT = 'Edit schedule';
const CANCEL_LABEL = 'Cancel';
const SAVE_LABEL = 'Save';
const NAME_LABEL = 'Schedule name';
const START_LABEL = 'Start time';
const END_LABEL = 'End time';
/** The exact Save-success announce (the spec's frozen copy). */
const STAGED_ANNOUNCE = 'Schedule staged. Apply to save.';

// Inline error copy — each names the field (the spec's I/O matrix: "inline
// error names the field").
const NAME_ERROR = 'Name is required.';
const WEEKDAYS_ERROR = 'Pick at least one day.';
// One error PER time input (5-2 review patch): the frozen matrix row says the
// inline error NAMES the field, and a shared message cannot say which of the
// two inputs is wrong.
const START_TIME_ERROR = 'Start time: use 24-hour HH:mm, e.g. 09:30.';
const END_TIME_ERROR = 'End time: use 24-hour HH:mm, e.g. 09:30.';
const WINDOW_ERROR = 'End must be after start.';
const DOMAINS_ERROR = 'Pick at least one domain.';
/** Short note rendered when there is nothing to select (empty blocklist + no orphaned memberships). */
const EMPTY_DOMAINS_NOTE =
  'Your blocklist is empty. Add domains first — a schedule blocks at least one.';

/** Chip labels, indexed by the stored `Weekday` value (0 = Monday). */
const WEEKDAY_CHIPS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const ALL_WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export function ScheduleEditor({
  target,
  onClose,
}: ScheduleEditorProps): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  const stagedSchedules = useDomainStore((s) => s.stagedSchedules);
  const stageScheduleUpsert = useDomainStore((s) => s.stageScheduleUpsert);

  // The schedule being edited, resolved from the RENDERED state
  // (`stagedSchedules ?? committed.schedules`) so a pending staged edit is
  // what pre-fills — the same list the row was rendered from. `null` for an
  // add draft (`target === 'new'`) or an unknown id (defensive; the Shell only
  // passes ids it read off rendered rows).
  const renderedSchedules = stagedSchedules ?? committed.schedules;
  const editing: Schedule | null =
    target === 'new'
      ? null
      : renderedSchedules.find((s) => s.id === target) ?? null;

  // Defended + COERCED read of the edited schedule's own domains (5-2 review
  // patch): every entry re-runs the same `normaliseDomain` the store applies
  // on Save, unparseable entries dropped — so the chips shown and checked are
  // exactly what `stageScheduleUpsert` will accept (a hand-edited config can
  // carry junk that must not render as a selectable, checked hostname). The
  // union list below keeps an orphaned domain selectable even though it is no
  // longer in `committed.domains`.
  const editingDomains: string[] = Array.isArray(editing?.domains)
    ? (editing?.domains as unknown[])
        .map((d) => normaliseDomain(d))
        .filter((d): d is string => d != null)
    : [];

  // ----- Scratchpad draft state ( NOTHING stages until Save ) ---------------
  const [name, setName] = useState(editing?.name ?? '');
  const [weekdays, setWeekdays] = useState<Weekday[]>(
    // Mirror the store's coercion (5-2 review patch): junk weekday values in
    // a hand-edited config (e.g. `[7]`) must not survive prefill, or the Save
    // gate would pass a draft the store rejects (`invalid-schedule`) and the
    // sheet would die silently.
    Array.isArray(editing?.weekdays)
      ? ([
          ...new Set(
            (editing?.weekdays as unknown[]).filter(
              (d): d is Weekday =>
                typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
            ),
          ),
        ].sort((a, b) => a - b))
      : [],
  );
  const [startTimeRaw, setStartTimeRaw] = useState(editing?.startTime ?? '');
  const [endTimeRaw, setEndTimeRaw] = useState(editing?.endTime ?? '');
  const [selectedDomains, setSelectedDomains] = useState<string[]>(editingDomains);
  // `enabled` is not edited in the sheet (the row checkbox owns the toggle);
  // a new schedule defaults to enabled, an edit preserves the rendered value
  // with the SAME coercion the store applies — a MISSING field means true
  // (5-2 review patch; `=== true` would resolve missing to false and desync
  // the two sides of the upsert).
  const enabled = typeof editing?.enabled === 'boolean' ? editing.enabled : true;

  // Touched flags gate the inline errors: a fresh add draft is idle, not
  // erroneous. Each flag flips on the first interaction with its field
  // (the AddDomain empty-vs-invalid distinction, per-field).
  const [nameTouched, setNameTouched] = useState(editing != null);
  const [weekdaysTouched, setWeekdaysTouched] = useState(editing != null);
  const [startTouched, setStartTouched] = useState(editing != null);
  const [endTouched, setEndTouched] = useState(editing != null);
  const [domainsTouched, setDomainsTouched] = useState(editing != null);

  // Auto-focus the name field on mount (the PasswordGate precedent). The
  // `.focus()` call is native-runtime (a no-op in the node jest env).
  const nameRef = useRef<TextInputType>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // ----- Derived validity (live, from raw input + the SAME helpers the
  // store re-runs on Save) ---------------------------------------------------
  const trimmedName = name.trim();
  const startParsed = normaliseTime(startTimeRaw);
  const endParsed = normaliseTime(endTimeRaw);
  // Zero-padded HH:mm compares lexically exactly as chronologically, so this
  // plain string compare is the whole same-day window rule (end STRICTLY
  // after start — equal is invalid).
  const windowValid =
    startParsed != null && endParsed != null && endParsed > startParsed;
  const canSave =
    trimmedName !== '' &&
    weekdays.length > 0 &&
    windowValid &&
    selectedDomains.length > 0;

  // The domain multi-select list: committed.domains UNION the edited
  // schedule's own domains — deduped, committed order first — so an orphaned
  // domain stays visible and keeps membership through Save. `editingDomains`
  // is a real dependency (5-2 review patch): it is derived from the rendered
  // schedule, which changes when `stagedSchedules` changes mid-session (e.g.
  // an in-flight Apply completes and the rendered list falls back to
  // committed) — omitting it would show a stale union.
  const domainOptions = useMemo(() => {
    const options: string[] = [];
    for (const d of committed.domains) {
      if (!options.includes(d.hostname)) {
        options.push(d.hostname);
      }
    }
    for (const d of editingDomains) {
      if (!options.includes(d)) {
        options.push(d);
      }
    }
    return options;
  }, [committed.domains, editingDomains, target]);

  // Live summary — `formatScheduleSummary` on the in-progress draft. It is
  // TOTAL (never throws): 0 weekdays renders time-only (`09:00–17:00`), and
  // unparseable times render raw (the inline errors carry the correction).
  const draftSummary = formatScheduleSummary({
    id: target === 'new' ? '' : target,
    name: trimmedName,
    weekdays,
    startTime: startParsed ?? startTimeRaw,
    endTime: endParsed ?? endTimeRaw,
    enabled,
    domains: selectedDomains,
  });

  // ----- Handlers -----------------------------------------------------------
  const toggleWeekday = (day: Weekday) => {
    setWeekdaysTouched(true);
    setWeekdays((prev) =>
      prev.includes(day)
        ? prev.filter((d) => d !== day)
        : [...prev, day].sort((a, b) => a - b),
    );
  };

  const toggleDomain = (hostname: string) => {
    setDomainsTouched(true);
    setSelectedDomains((prev) =>
      prev.includes(hostname)
        ? prev.filter((d) => d !== hostname)
        : [...prev, hostname],
    );
  };

  const handleSave = () => {
    if (!canSave) {
      return;
    }
    // Build the final Schedule HERE (the sheet is a scratchpad). Editing keeps
    // the existing id (upsert replaces in place); adding derives a unique slug
    // from the trimmed name against every existing id so the upsert can never
    // silently overwrite an unrelated schedule.
    const id =
      target === 'new'
        ? nextScheduleId(
            trimmedName,
            renderedSchedules.map((s) => s.id),
          )
        : target;
    const result = stageScheduleUpsert({
      id,
      name: trimmedName,
      weekdays,
      startTime: startParsed as string,
      endTime: endParsed as string,
      enabled,
      domains: selectedDomains,
    });
    if (result.ok) {
      // Announce BEFORE closing so VoiceOver speaks the outcome as the sheet
      // unmounts (the gate's onVerified ordering precedent).
      AccessibilityInfo.announceForAccessibility(STAGED_ANNOUNCE);
      onClose();
    }
    // A not-ok result (defensive — the Save gate mirrors the store's
    // validation, so this is unreachable from the UI) falls through WITHOUT
    // closing: the sheet stays open with its draft intact.
  };

  const title = editing != null ? TITLE_EDIT : TITLE_ADD;

  return (
    <View style={styles.scrim} accessibilityLabel="Schedule editor overlay">
      {/* No `accessibilityRole` on the panel container (the PasswordGate
          lesson: `alert` would re-announce the whole panel on every state
          change). The inline errors below carry their own `alert` roles. */}
      <View style={styles.panel} accessibilityLabel={title}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={CANCEL_LABEL}
            style={({ pressed }) => [
              styles.cancelButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.cancelText}>{CANCEL_LABEL}</Text>
          </Pressable>
        </View>

        {/* Live summary — updates on every keystroke/toggle (the spec's live
            summary row). Renders even while the draft is incomplete. */}
        <Text style={styles.summary} accessibilityLabel="Schedule summary">
          {draftSummary}
        </Text>

        {/* Name */}
        <TextInput
          ref={nameRef}
          value={name}
          onChangeText={(v) => {
            setNameTouched(true);
            setName(v);
          }}
          placeholder="e.g. Focus mornings"
          accessibilityLabel={NAME_LABEL}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          maxLength={200}
          style={styles.input}
        />
        {nameTouched && trimmedName === '' ? (
          <Text style={styles.error} accessibilityRole="alert">
            {NAME_ERROR}
          </Text>
        ) : null}

        {/* Weekday chips (0 = Monday). Pressable + checkbox role + checked
            state, per the spec's Always. */}
        <View style={styles.chipRow}>
          {ALL_WEEKDAYS.map((day) => {
            const checked = weekdays.includes(day);
            return (
              <Pressable
                key={day}
                onPress={() => toggleWeekday(day)}
                focusable
                enableFocusRing
                accessibilityRole="checkbox"
                accessibilityLabel={WEEKDAY_CHIPS[day]}
                accessibilityState={{ checked }}
                style={[
                  styles.chip,
                  checked && styles.chipChecked,
                ]}
              >
                <Text
                  style={[styles.chipLabel, checked && styles.chipLabelChecked]}
                >
                  {WEEKDAY_CHIPS[day]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {weekdaysTouched && weekdays.length === 0 ? (
          <Text style={styles.error} accessibilityRole="alert">
            {WEEKDAYS_ERROR}
          </Text>
        ) : null}

        {/* Start / end time — validated HH:mm TEXT entry (the spec's library
            pin: no picker dependency on macOS). */}
        <View style={styles.timeRow}>
          <TextInput
            value={startTimeRaw}
            onChangeText={(v) => {
              setStartTouched(true);
              setStartTimeRaw(v);
            }}
            placeholder="09:00"
            accessibilityLabel={START_LABEL}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            maxLength={5}
            style={styles.timeInput}
          />
          <Text style={styles.timeDash}>–</Text>
          <TextInput
            value={endTimeRaw}
            onChangeText={(v) => {
              setEndTouched(true);
              setEndTimeRaw(v);
            }}
            placeholder="17:00"
            accessibilityLabel={END_LABEL}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            maxLength={5}
            style={styles.timeInput}
          />
        </View>
        {startTouched && startParsed == null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {START_TIME_ERROR}
          </Text>
        ) : null}
        {endTouched && endParsed == null ? (
          <Text style={styles.error} accessibilityRole="alert">
            {END_TIME_ERROR}
          </Text>
        ) : null}
        {startParsed != null && endParsed != null && !windowValid ? (
          // End <= start is its own error (a valid-looking but empty window),
          // shown once both times parse. `endTouched` is implied: endParsed
          // can only be non-null from the user's typed text.
          <Text style={styles.error} accessibilityRole="alert">
            {WINDOW_ERROR}
          </Text>
        ) : null}

        {/* Domain multi-select: committed ∪ the schedule's own (orphaned)
            domains, committed order first. */}
        <Text style={styles.sectionLabel}>Domains</Text>
        {domainOptions.length === 0 ? (
          // Empty blocklist (and no orphaned memberships): the spec's short
          // note + Save stays disabled (selectedDomains is empty).
          <Text style={styles.note}>{EMPTY_DOMAINS_NOTE}</Text>
        ) : (
          // The list scrolls (5-2 review patch): with a long blocklist the
          // rows must never push the Save button off-window — the panel is
          // capped and the list is the bounded, scrollable region.
          <ScrollView style={styles.domainList} focusable>
            {domainOptions.map((hostname) => {
              const checked = selectedDomains.includes(hostname);
              return (
                <Pressable
                  key={hostname}
                  onPress={() => toggleDomain(hostname)}
                  focusable
                  enableFocusRing
                  accessibilityRole="checkbox"
                  accessibilityLabel={hostname}
                  accessibilityState={{ checked }}
                  style={styles.domainRow}
                >
                  <Text style={styles.domainLabel}>{hostname}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        {domainsTouched && selectedDomains.length === 0 && domainOptions.length > 0 ? (
          <Text style={styles.error} accessibilityRole="alert">
            {DOMAINS_ERROR}
          </Text>
        ) : null}

        {/* Save: disabled while any field is invalid (the store re-validates
            and rejects an invalid draft without staging — this button gate is
            the UX mirror of that fail-safe). */}
        <Pressable
          onPress={handleSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel={SAVE_LABEL}
          accessibilityState={{ disabled: !canSave }}
          style={({ pressed }) => [
            styles.save,
            { backgroundColor: tokens.primary },
            pressed && styles.pressed,
            !canSave && styles.disabled,
          ]}
        >
          <Text style={styles.saveLabel}>{SAVE_LABEL}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The scrim+panel pair is the PasswordGate sheet pattern verbatim.
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panel: {
    backgroundColor: tokens.monoBg,
    borderRadius: tokens.rounded.lg,
    width: '80%',
    maxWidth: 520,
    // Cap the panel (the HostsViewer `maxHeight: '80%'` precedent): a long
    // blocklist must not push the Save button below the window edge.
    maxHeight: '80%',
    padding: tokens.spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  title: {
    ...tokens.typography.title,
    color: tokens.monoFg,
  },
  cancelButton: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  cancelText: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  summary: {
    ...tokens.typography.label,
    opacity: 0.7,
    marginBottom: tokens.spacing.md,
  },
  input: {
    ...tokens.typography.body,
    color: tokens.monoFg,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
    marginBottom: tokens.spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.xs,
    marginVertical: tokens.spacing.xs,
  },
  chip: {
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    borderColor: tokens.primary,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  chipChecked: {
    backgroundColor: tokens.primary,
  },
  chipLabel: {
    ...tokens.typography.label,
    color: tokens.primary,
  },
  chipLabelChecked: {
    color: tokens.primaryForeground,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    marginVertical: tokens.spacing.xs,
  },
  timeInput: {
    flex: 1,
    ...tokens.typography.body,
    color: tokens.monoFg,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  timeDash: {
    ...tokens.typography.body,
    color: tokens.monoFg,
  },
  sectionLabel: {
    ...tokens.typography.label,
    marginTop: tokens.spacing.sm,
    marginBottom: tokens.spacing.xs,
  },
  domainList: {
    // Bounded scroll region for the multi-select (pairs with the panel cap).
    maxHeight: 220,
    marginBottom: tokens.spacing.xs,
  },
  domainRow: {
    paddingVertical: tokens.spacing.xs,
  },
  domainLabel: {
    ...tokens.typography.body,
    color: tokens.monoFg,
  },
  note: {
    ...tokens.typography.body,
    opacity: 0.7,
    marginBottom: tokens.spacing.xs,
  },
  error: {
    ...tokens.typography.body,
    color: tokens.destructive,
    marginBottom: tokens.spacing.xs,
  },
  save: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: tokens.spacing.md,
  },
  saveLabel: {
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