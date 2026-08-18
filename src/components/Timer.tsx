/**
 * Timer — the Timer surface (surface 1, Story 4.1).
 *
 * The Free-state surface: title + duration picker + domain-pick list +
 * Start button. Picker state is component-local (`useState` for duration
 * selection, custom minute text, and the selected hostname `Set`); nothing
 * in 4.1 lands in `committed` or `staged`. The Start handler stages
 * per-domain `alwaysOn` flips into the EXISTING staged-then-Apply pipeline
 * (reusing `stageAlwaysOnToggle` + `apply`), then fires one osascript admin
 * prompt through the shared serialized queue (AD-10).
 *
 * Pre-check fallback (epic-4-context):
 *   - Persisted selection (committed.activeTimer?.selectedDomains) — used
 *     when present (4.2 will populate it; reading it now is the right hook).
 *   - First-run default — when no persisted selection exists, every domain
 *     is pre-checked, giving the user a one-click "start a session on
 *     everything".
 *
 * Defensive running-timer placeholder: when committed.activeTimer is non-
 * null at mount, render a minimal "see Blocklist for the countdown"
 * placeholder with an Open Blocklist CTA. 4.3 owns the full Blocked UI;
 * this story stays forward-compatible by NOT trying to render the Blocked
 * UI. The placeholder uses the same shape as the empty-blocklist empty
 * state so the user lands somewhere safe either way.
 *
 * Empty-blocklist empty state: "Add some domains on Blocklist first." +
 * an "Open Blocklist" CTA that calls `onOpenBlocklist` (the Shell threads
 * `selectRow(0)` here). Presets + checkbox list + Start are hidden.
 *
 * VoiceOver: surface mount announces "Timer, free" — single-fire on mount
 * via `useEffect(..., [])`, matching the Blocklist mount announce pattern
 * (Blocklist.tsx:127-136).
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import { tokens } from '../theme/tokens';
import { ApplyButton } from './ApplyButton';
import {
  TimerDurationPicker,
  PRESET_MINUTES,
  type DurationPickerValue,
} from './TimerDurationPicker';
import { TimerDomainList } from './TimerDomainList';
import {
  parseDurationMinutes,
  DURATION_MIN_MINUTES,
  DURATION_MAX_MINUTES,
} from '../config/duration';

// ----- Empty-state copy -----

/** Empty blocklist: render the "go add domains first" prompt + CTA. */
const EMPTY_BLOCKLIST_TEXT = 'Add some domains on Blocklist first.';
const OPEN_BLOCKLIST_LABEL = 'Open Blocklist';

/** Defensive: committed.activeTimer is set (a session is running). */
const RUNNING_PLACEHOLDER_TEXT =
  'Timer running. Switch to Blocklist to see the countdown.';

/** Inline error when the custom input is invalid (covers all reject reasons). */
const INVALID_CUSTOM_TEXT = `Enter minutes (${DURATION_MIN_MINUTES}–${DURATION_MAX_MINUTES}).`;

/** Start-button in-flight label (mirrors Blocklist's "Applying…"). */
const STARTING_LABEL = 'Starting…';

/** Success toast on Apply commit (toast is also a UX-DR15 surface cue). */
const START_SUCCESS_TOAST = (n: number): string =>
  `Started blocking ${n} ${n === 1 ? 'domain' : 'domains'}.`;
/** Apply-denied toast (spec's I/O matrix row). */
const START_DENIED_TOAST = "Couldn't start the block. No changes made.";

/** Default duration picked when no persisted selection is available. */
const DEFAULT_PRESET_MINUTES = PRESET_MINUTES[0]; // 25

export interface TimerProps {
  /**
   * Navigate to the Blocklist surface (row 0). Threaded from the Shell so
   * the zero-domains / running-timer empty-state "Open Blocklist" CTA
   * navigates without duplicating surface state in the store. Mirrors the
   * `<Settings onNavigateBlocklist />` pattern (Shell.tsx:267).
   */
  onOpenBlocklist: () => void;
}

export function Timer({ onOpenBlocklist }: TimerProps): React.ReactElement {
  // ----- Store reads -----
  const committed = useDomainStore((s) => s.committed);
  const applyStatus = useDomainStore((s) => s.applyStatus);
  const stageAlwaysOnToggle = useDomainStore((s) => s.stageAlwaysOnToggle);
  const apply = useDomainStore((s) => s.apply);

  // ----- Derived gating -----
  const hasActiveTimer = committed.activeTimer != null;
  // The pick list always reads `committed.domains` (per spec: "renders
  // against the canonical blocklist, never the staged overlay"). A staged
  // draft from a prior Blocklist toggle does NOT leak into the picker —
  // timer selection is about focus intent, not apply-pending state.
  const isEmpty = committed.domains.length === 0;
  const running = applyStatus === 'running';

  // ----- Picker state (component-local) -----
  // Default duration: 25 min (the first preset). The persisted-selection
  // path owns the DOMAINS, not the duration; 4.2 will widen
  // `activeTimer` to carry a duration slot. Mirrors the spec's "duration
  // default = '25 min' if `activeTimer` shape lacks a duration slot" note.
  const [duration, setDuration] = useState<DurationPickerValue>({
    kind: 'preset',
    minutes: DEFAULT_PRESET_MINUTES,
  });
  // The raw custom-minute input string. Owned here so a preset click can
  // CLEAR the custom text (spec: "preset click clears custom"), and so the
  // input's text survives across re-renders. `undefined` is reserved for
  // future use; the picker always renders with a string.
  const [customRaw, setCustomRaw] = useState<string>('');
  // The selected hostname set. Initial value derives from the pre-check
  // fallback (persisted activeTimer?.selectedDomains, else all-checked) but
  // is a one-shot initialization — user toggles mutate `selected` directly
  // without re-deriving from the store (the store does not track this set;
  // it lives only as a UI choice for THIS Start).
  const initialSelection = useMemo<Set<string>>(() => {
    const persisted = committed.activeTimer?.selectedDomains;
    const currentHostnames = new Set(
      committed.domains.map((d) => d.hostname),
    );
    if (persisted && persisted.length > 0) {
      // Drop hostnames that are no longer in `committed.domains` — a long-
      // removed domain must not land in the pre-checked set.
      const filtered = persisted.filter((h) => currentHostnames.has(h));
      if (filtered.length > 0) {
        return new Set(filtered);
      }
    }
    return new Set(committed.domains.map((d) => d.hostname));
    // One-shot on mount; the user mutates `selected` directly thereafter.
    // Filter applied once at mount; runtime domain-list changes do not
    // retroactively shrink `selected` — the user can always uncheck the
    // stale entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [selected, setSelected] = useState<Set<string>>(initialSelection);

  // Mount-once filter: drop any stale hostnames from `selected` that have
  // been removed from `committed.domains` since the initial mount. Kept
  // off `committed.domains` deps to avoid the re-render loop; runs once.
  useEffect(() => {
    setSelected((prev) => {
      const currentHostnames = new Set(
        useDomainStore.getState().committed.domains.map((d) => d.hostname),
      );
      const next = new Set<string>();
      for (const h of prev) {
        if (currentHostnames.has(h)) {
          next.add(h);
        }
      }
      // Avoid a new Set reference when nothing changed — keeps React's
      // bailout happy for the common case (no hostnames dropped).
      if (next.size === prev.size) {
        return prev;
      }
      return next;
    });
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Duration validity (custom-input path) -----
  // Preset selections are always valid (the chip set is fixed). Custom
  // selections are valid iff `parseDurationMinutes(customRaw).ok`.
  const customParse =
    duration.kind === 'custom' ? parseDurationMinutes(customRaw) : null;
  const durationValid =
    duration.kind === 'preset' ||
    (customParse != null && customParse.ok === true);
  const showCustomError =
    duration.kind === 'custom' &&
    customRaw.trim() !== '' &&
    (customParse == null || customParse.ok === false);

  // ----- Start gating -----
  const selectedCount = selected.size;
  const totalCount = committed.domains.length;
  const canStart =
    !isEmpty &&
    !hasActiveTimer &&
    durationValid &&
    selectedCount > 0 &&
    !running;

  // ----- Mount announce: "Timer, free" -----
  // Single-fire on mount, matching Blocklist's announce pattern. Story 4.1
  // owns the Free-state announce only; 4.4 owns the running-state announce.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility('Timer, free');
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Handlers -----
  const handleToggleDomain = (hostname: string) => {
    // Optimistic local flip — the spec calls for live updates ("3 of 6
    // selected"); the store does not track this set, so the toggle stays
    // local until Start.
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hostname)) {
        next.delete(hostname);
      } else {
        next.add(hostname);
      }
      return next;
    });
  };

  const handlePresetSelect = (minutes: number) => {
    setDuration({ kind: 'preset', minutes });
    // Preset click clears custom (spec's "preset ↔ custom exclusive").
    setCustomRaw('');
  };

  const handleCustomChange = (text: string) => {
    // Strip non-digits defensively — `parseDurationMinutes` would reject
    // them, but keeping the field digits-only avoids a transient
    // invalid-reason flicker while the user types.
    const digitsOnly = text.replace(/[^\d]/g, '');
    setCustomRaw(digitsOnly);
    // Switching to custom: kind flips; minutes is parsed by `customParse`.
    setDuration({ kind: 'custom', minutes: NaN });
  };

  const handleCustomFocus = () => {
    if (duration.kind !== 'custom') {
      setDuration({ kind: 'custom', minutes: NaN });
    }
  };

  // The Start handler: stage per-domain `alwaysOn: true` flips for each
  // selected domain that is not yet alwaysOn, then fire `apply()`. The
  // Stage-then-Apply pipeline (Epic 1.6) writes both config.json and
  // /etc/hosts through the shared serialized queue — exactly one admin
  // prompt for the entire Start sequence.
  const handleStart = () => {
    // Re-read `applyStatus` at handler-call time so a same-tick race (e.g.
    // a Start tap while the previous run is just settling) cannot fire a
    // second concurrent Apply. The render-time `canStart` check covers the
    // common case; this guard catches the call-time edge.
    const liveApplyStatus = useDomainStore.getState().applyStatus;
    if (!canStart || liveApplyStatus === 'running') {
      return;
    }
    // Stage flips. We iterate in `committed.domains` order so the staged
    // draft's sequence is predictable across Start invocations.
    let stagedCount = 0;
    for (const d of committed.domains) {
      if (selected.has(d.hostname) && !d.alwaysOn) {
        stageAlwaysOnToggle(d.hostname);
        stagedCount += 1;
      }
    }
    void apply()
      .then((result) => {
        if (result.ok) {
          // Toast via announceForAccessibility — there is no toast primitive
          // in 4.1 (Epic 5 owns it); the announcement is the in-window cue.
          AccessibilityInfo.announceForAccessibility(
            START_SUCCESS_TOAST(stagedCount),
          );
        } else {
          AccessibilityInfo.announceForAccessibility(START_DENIED_TOAST);
        }
      })
      .catch((err: unknown) => {
        // Defensive: `runApply` never rejects, but the toast-primitive is
        // deferred to Epic 5 (spec); keep the cue announce-only.
        AccessibilityInfo.announceForAccessibility(
          'Could not start block: ' + String(err),
        );
      });
  };

  // ----- Defensive: running-timer placeholder (forward-compat with 4.3) -----
  if (hasActiveTimer) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Timer</Text>
        <Text style={styles.body}>{RUNNING_PLACEHOLDER_TEXT}</Text>
        <Pressable
          onPress={onOpenBlocklist}
          focusable
          enableFocusRing
          accessibilityRole="button"
          accessibilityLabel={OPEN_BLOCKLIST_LABEL}
          style={({ pressed }) => [
            styles.cta,
            pressed && styles.ctaPressed,
          ]}
        >
          <Text style={styles.ctaLabel}>{OPEN_BLOCKLIST_LABEL}</Text>
        </Pressable>
      </View>
    );
  }

  // ----- Empty-blocklist empty state -----
  if (isEmpty) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Timer</Text>
        <Text style={styles.body}>{EMPTY_BLOCKLIST_TEXT}</Text>
        <Pressable
          onPress={onOpenBlocklist}
          focusable
          enableFocusRing
          accessibilityRole="button"
          accessibilityLabel={OPEN_BLOCKLIST_LABEL}
          style={({ pressed }) => [
            styles.cta,
            pressed && styles.ctaPressed,
          ]}
        >
          <Text style={styles.ctaLabel}>{OPEN_BLOCKLIST_LABEL}</Text>
        </Pressable>
      </View>
    );
  }

  // ----- Free-state surface -----
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Timer</Text>
      <TimerDurationPicker
        value={duration}
        customRaw={customRaw}
        onPresetSelect={handlePresetSelect}
        onCustomChange={handleCustomChange}
        onCustomFocus={handleCustomFocus}
      />
      {showCustomError ? (
        <Text style={styles.errorText}>{INVALID_CUSTOM_TEXT}</Text>
      ) : null}
      <Text style={styles.sectionTitle}>Domains in this session</Text>
      <TimerDomainList
        hostnames={committed.domains.map((d) => d.hostname)}
        selected={selected}
        onToggle={handleToggleDomain}
        disabled={running}
      />
      <Text style={styles.selectionHint}>
        {selectedCount} of {totalCount} selected
      </Text>
      <View style={styles.controls}>
        <ApplyButton
          label={running ? STARTING_LABEL : 'Start'}
          onPress={handleStart}
          disabled={!canStart}
          pulse={canStart && !running}
          busy={running}
        />
      </View>
      <Text style={styles.hint}>
        Start blocks the chosen domains for the chosen duration. End early
        needs your password.
      </Text>
    </View>
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
  sectionTitle: {
    ...tokens.typography.label,
    marginTop: tokens.spacing.md,
    marginBottom: tokens.spacing.xs,
  },
  errorText: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
  selectionHint: {
    ...tokens.typography.body,
    // Tabular-nums so the digits stay the same width as the user toggles
    // ("3 of 6" → "4 of 6" does not jitter). Mirrors StatusHeader's
    // countdown token (typography.countdown).
    fontVariant: ['tabular-nums'],
    marginTop: tokens.spacing.xs,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginTop: tokens.spacing.md,
  },
  hint: {
    ...tokens.typography.body,
    marginTop: tokens.spacing.sm,
    opacity: 0.7,
  },
  cta: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
    backgroundColor: tokens.primary,
    alignSelf: 'flex-start',
  },
  ctaPressed: {
    opacity: 0.85,
  },
  ctaLabel: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
});