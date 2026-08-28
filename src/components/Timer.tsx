/**
 * Timer — the Timer surface (surface 1; Story 4.1 picker, 4.2 engine swap,
 * 4.3 live countdown).
 *
 * The Free-state surface: title + duration picker + domain-pick list +
 * Start button. Picker state is component-local (`useState` for duration
 * selection, custom minute text, and the selected hostname `Set`); nothing
 * lands in `committed` or `staged`.
 *
 * Story 4.2 engine: the Start handler is a SINGLE `stageStartTimer({durationMs,
 * selected})` call to the store. The engine writes
 * `activeTimer:{endEpochMs,selectedDomains}` to `config.json` THEN
 * `writeHosts(effectiveHostsLines(nextConfig))` through the shared
 * serialized queue — exactly one admin prompt. `endEpochMs` is computed
 * inside the enqueue (run time), so the user gets the full `durationMs`
 * even after a queue wait. Hosts-deny leaves `committed.activeTimer` null
 * (retry-safe).
 *
 * Story 4.3 Blocked path: when `committed.activeTimer != null` the surface
 * replaces the old defensive placeholder with the live countdown — the
 * "FOCUS SESSION" label, a 64×64 `CountdownRing` + tabular `mm:ss` numeral,
 * "Locked until HH:mm", a password-gated `End early` button, and the hint
 * line. The countdown value comes from the SCOPED `useTimerStore` slice
 * (`src/domain/timerStore.ts`) via the selector-scoped
 * `selectRemainingMs` subscription — unrelated surfaces never re-render on
 * a tick. Since 4.4 this surface is a CO-SUBSCRIBER, not the lifecycle
 * owner: the status header (always mounted on every surface) owns the slice
 * lifecycle, so the driver keeps counting after this surface unmounts.
 *
 * End early (Story 4.6): the button is gate-first via `requirePassword` —
 * the same Epic 3 gate Panic and Change-password use, accessed lazily via
 * `useDomainStore.getState()` (NOT a subscribed selector). The verified
 * action body is a single `endEarly()` call — the store's serialized mirror
 * of `expireTimer` that writes config + hosts and raises the Shell-level
 * toast. No gate code lives here and no hosts/config write happens here
 * (the store owns both); with no password set the gate short-circuits and
 * `endEarly()` runs immediately (the Panic pattern).
 *
 * Pre-check fallback (epic-4-context):
 *   - Persisted selection (committed.activeTimer?.selectedDomains) — used
 *     when present.
 *   - First-run default — when no persisted selection exists, every domain
 *     is pre-checked, giving the user a one-click "start a session on
 *     everything".
 *
 * Empty-blocklist empty state: "Add some domains on Blocklist first." +
 * an "Open Blocklist" CTA that calls `onOpenBlocklist` (the Shell threads
 * `selectRow(0)` here). Presets + checkbox list + Start are hidden.
 *
 * VoiceOver: the surface-mount announce is keyed on `hasActiveTimer` —
 * "Timer running, N minutes M seconds remaining" on Blocked entry, "Timer,
 * free" on the Free path (single-fire per transition; the per-minute
 * rollover gets an explicit announce AND rides the numeral's
 * `accessibilityLiveRegion="polite"` — the live region is Android-only, so
 * the announce is the macOS VoiceOver path, UX-DR17).
 */

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import {
  useTimerStore,
  selectRemainingMs,
  selectProgress,
  formatMmSs,
} from '../domain/timerStore';
import { tokens } from '../theme/tokens';
import { ApplyButton } from './ApplyButton';
import { CountdownRing } from './CountdownRing';
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

// ----- Blocked-state copy (Story 4.3) -----

/** Small uppercase status label above the hybrid countdown. */
const FOCUS_SESSION_LABEL = 'FOCUS SESSION';
/** Subtitle under the countdown row (local time, deterministic). */
const lockedUntilLabel = (endEpochMs: number): string =>
  `Locked until ${new Date(endEpochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
/** Destructive escape button (password-gated; the store's `endEarly` is the actual end). */
const END_EARLY_LABEL = 'End early';
/**
 * Hint line under the End-early button. The password clause is conditional
 * on `requirePassword`'s actual behaviour: with no password set the gate
 * short-circuits and the action runs immediately, so "needs your password"
 * would be a lie on a password-less install.
 */
const endEarlyHint = (endEpochMs: number, hasPassword: boolean): string =>
  `${hasPassword ? 'End early needs your password. ' : ''}Timer ends automatically at ${new Date(
    endEpochMs,
  ).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}.`;

/** Inline error when the custom input is invalid (covers all reject reasons). */
const INVALID_CUSTOM_TEXT = `Enter minutes (${DURATION_MIN_MINUTES}–${DURATION_MAX_MINUTES}).`;

/** Start-button in-flight label (mirrors Blocklist's "Applying…"). */
const STARTING_LABEL = 'Starting…';

/**
 * Success toast on Start commit (toast is also a UX-DR15 surface cue). The
 * `n` is the user-visible selection count (the domains the session covers)
 * — the toast frames Start as a timed session, not a permanent block. The
 * pre-4.2 copy read "Started blocking N domains." which reflected 4.1's
 * per-domain `alwaysOn` engine; the 4.2 engine is time-bounded, so the copy
 * follows.
 */
const START_SUCCESS_TOAST = (n: number): string =>
  `Focus session started. ${n} ${n === 1 ? 'domain' : 'domains'} blocked.`;
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

/**
 * The ring's progress + the mm:ss numeral now come from the SHARED slice
 * exports (`selectProgress` / `formatMmSs`, `timerStore.ts`) — Story 4.4
 * moved the local math there so the Timer surface, the status header and the
 * menu bar (6.2) all derive from ONE source and can never desync. DURING A
 * LIVE SESSION both derived numbers change every tick, so the Blocked
 * subtree re-renders once per second — that is by design (the numeral and
 * the ring arc must move). What the SCOPING buys is isolation: the
 * Blocklist / Settings / Schedule / Sidebar trees never touch this store, so
 * a tick re-renders ONLY this surface's Blocked path (and the 4.4 header).
 */
export function Timer({ onOpenBlocklist }: TimerProps): React.ReactElement {
  // ----- Store reads -----
  const committed = useDomainStore((s) => s.committed);
  const applyStatus = useDomainStore((s) => s.applyStatus);
  const stageStartTimer = useDomainStore((s) => s.stageStartTimer);
  // The scoped countdown slice. TWO numeric selectors (remaining for the
  // numeral, progress for the ring) — both change EVERY tick during a live
  // session, so the Blocked subtree re-renders once per second by design;
  // the scoping keeps every OTHER surface (Blocklist / Settings / Schedule /
  // Sidebar / Shell) out of the tick entirely (spec's per-tick isolation).
  const remainingMs = useTimerStore(selectRemainingMs);
  const progress = useTimerStore(selectProgress);

  // ----- Derived gating -----
  // Defensive normalisation (review step-04): `readConfig` validates
  // config.json top-level only, so a malformed `activeTimer.endEpochMs`
  // (non-numeric) must NOT put the surface into Blocked — gate, announce and
  // slice lifecycle all key on the normalised value so they agree.
  const rawEndEpochMs = committed.activeTimer?.endEpochMs ?? null;
  const activeEndEpochMs =
    rawEndEpochMs != null && Number.isFinite(rawEndEpochMs)
      ? rawEndEpochMs
      : null;
  const hasActiveTimer = committed.activeTimer != null && activeEndEpochMs != null;

  // ----- Countdown derivation (mm:ss + locked-until) -----
  // The numeral is the shared slice formatter (zero-padded, tabular numerals
  // via the style token — the digit width never jitters). `remainingSec` is
  // kept for the per-minute rollover announce bucket below.
  const remainingSec = Math.floor(remainingMs / 1000);
  const countdownText = formatMmSs(remainingMs);
  const lockedUntil =
    activeEndEpochMs != null ? lockedUntilLabel(activeEndEpochMs) : null;
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

  // ----- Slice lifecycle (Story 4.3; co-subscriber since 4.4) -----
  // The Timer surface acquires a subscriber slot: `start(endEpochMs)` when a
  // session is mirrored, `stop()` on cleanup. The slice's internal refcount
  // makes this safe for co-subscribers (the 4.4 status header — the
  // always-mounted lifecycle OWNER — and 6.2's menu bar): unmounting this
  // surface drops the refcount (2 -> 1) and the header keeps counting; the
  // slice parks only when the LAST subscriber leaves. Keyed on the
  // mirrored `endEpochMs` so a superseding session re-arms the driver.
  // useLayoutEffect (review step-04): a plain useEffect runs AFTER first
  // paint, so every Blocked mount would flash 00:00 / an empty ring for one
  // frame before the first `start()` updates the slice. Starting in the
  // layout phase sets the slice state before paint.
  useLayoutEffect(() => {
    if (activeEndEpochMs == null) {
      return;
    }
    useTimerStore.getState().start(activeEndEpochMs);
    return () => {
      useTimerStore.getState().stop();
    };
  }, [activeEndEpochMs]);

  // ----- Per-minute rollover announce (UX-DR17) -----
  // `accessibilityLiveRegion` is Android-only and a no-op on macOS, so the
  // minute boundary gets an EXPLICIT announce here: "4 minutes remaining".
  // Keyed on the minute value (not `remainingSec`) so it fires once per
  // minute, not per tick; a ref guard skips the first run so it never
  // doubles the mount announce. Silent at 0 (expiry is 4.5's story) and only
  // while the Blocked path is actually visible.
  const minutesRemaining = Math.floor(remainingSec / 60);
  const didMountRef = useRef(false);
  useEffect(() => {
    if (activeEndEpochMs == null) {
      return;
    }
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (minutesRemaining > 0) {
      AccessibilityInfo.announceForAccessibility(
        `${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'} remaining`,
      );
    }
  }, [minutesRemaining, activeEndEpochMs]);

  // ----- Mount announce: running vs free -----
  // Keyed on `hasActiveTimer` — single-fire per transition (not per tick).
  // Blocked entry speaks "Timer running, N minutes M seconds remaining";
  // the Free path keeps 4.1's "Timer, free". Subsequent ticks do NOT
  // re-announce — the numeral's accessibilityLiveRegion="polite" carries
  // the per-minute rollover (UX-DR17).
  useEffect(() => {
    if (hasActiveTimer) {
      const end = useDomainStore.getState().committed.activeTimer?.endEpochMs;
      const remainingSec = Math.max(
        0,
        Math.floor(((end ?? Date.now()) - Date.now()) / 1000),
      );
      const minutes = Math.floor(remainingSec / 60);
      const seconds = remainingSec % 60;
      AccessibilityInfo.announceForAccessibility(
        `Timer running, ${minutes} minute${minutes === 1 ? '' : 's'} ` +
          `${seconds} second${seconds === 1 ? '' : 's'} remaining`,
      );
    } else {
      AccessibilityInfo.announceForAccessibility('Timer, free');
    }
    // Keyed on the hasActiveTimer transition only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveTimer]);

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

  // The Start handler: the engine swap from 4.1's per-domain `alwaysOn`
  // flips to 4.2's single `stageStartTimer({durationMs, selected})` call.
  // The store action handles `writeConfig` (carrying the new `activeTimer`)
  // BEFORE `writeHosts(effectiveHostsLines(nextConfig))` through the shared
  // serialized queue — exactly one admin prompt for the entire Start
  // sequence. The selected set is the user-visible session selection
  // (size = the toast's "N domains" count, which reflects the user's
  // choice, NOT a staged-derivation subset).
  const handleStart = () => {
    // Re-read `applyStatus` at handler-call time so a same-tick race (e.g.
    // a Start tap while the previous run is just settling) cannot fire a
    // second concurrent `stageStartTimer`. The render-time `canStart` check
    // covers the common case; this guard catches the call-time edge.
    const liveApplyStatus = useDomainStore.getState().applyStatus;
    if (!canStart || liveApplyStatus === 'running') {
      return;
    }
    // The duration in ms for the timed session. Presets already carry a
    // minute count (`duration.minutes`); custom carries the parsed minute
    // count. Either way, `durationMs = minutes * 60_000` for the
    // `endEpochMs = Date.now() + durationMs` computation the store does
    // INSIDE the enqueue (so the user gets the full durationMs even after a
    // queue wait). `canStart` gates Start on `durationValid`, which requires
    // `customParse.ok === true` for the `custom` path — narrowing lets TS see
    // `minutes` is reachable on both paths.
    let minutes: number;
    if (duration.kind === 'preset') {
      minutes = duration.minutes;
    } else {
      // customParse is guaranteed non-null + ok when `duration.kind === 'custom'`
      // AND `canStart` is true (the precondition the liveApplyStatus guard
      // above enforces). Narrow defensively for TS.
      const parsed = customParse;
      if (parsed == null || parsed.ok !== true) {
        return;
      }
      minutes = parsed.minutes;
    }
    void stageStartTimer({
      durationMs: minutes * 60_000,
      selected,
    })
      .then((result) => {
        if (result.ok) {
          // Toast via announceForAccessibility — there is no toast primitive
          // in 4.1/4.2 (Epic 5 owns it); the announcement is the in-window
          // cue. The count is the user's selection count, not a
          // staged-subset: the 4.2 engine writes the FULL selection as
          // `activeTimer.selectedDomains`, so "N domains" is the user's
          // visible choice.
          AccessibilityInfo.announceForAccessibility(
            START_SUCCESS_TOAST(selected.size),
          );
        } else {
          AccessibilityInfo.announceForAccessibility(START_DENIED_TOAST);
        }
      })
      .catch((err: unknown) => {
        // Defensive: the store's queue never rejects, but the toast-primitive
        // is deferred to Epic 5 (spec); keep the cue announce-only.
        AccessibilityInfo.announceForAccessibility(
          'Could not start block: ' + String(err),
        );
      });
  };

  // ----- End early (Story 4.6) -----
  // Gate-first via the shared Epic 3 gate (the Panic pattern): lazy access
  // (mirrors Panic.tsx / ChangePassword.tsx) — call `requirePassword` via
  // `useDomainStore.getState()`, NOT a subscribed selector — so the Shell's
  // single <PasswordGate> opens when a password is set; with none set the
  // gate short-circuits and the action body runs immediately. The verified
  // body is a single `endEarly()` call: the store's serialized mirror of
  // `expireTimer` writes config + hosts and raises the Shell-level toast
  // ("Session ended. N domains unblocked." / the hosts-failure copy), so
  // there is NO announce here — the Shell's toast effect carries the cue.
  // The promise never rejects (the enqueue body is fully guarded), but the
  // fire-and-forget keeps a bare defensive `.catch` like Panic's.
  const handleEndEarly = () => {
    // Apply-queue backpressure: while an end-early job is already in flight
    // (e.g. waiting at an unanswered admin prompt), a second press would
    // queue a duplicate config write + admin prompt + failure toast. The
    // deny path leaves `activeTimer` intact, so the button is still rendered
    // and pressable — gate the re-entry here instead.
    if (useDomainStore.getState().applyStatus === 'running') {
      return;
    }
    useDomainStore.getState().requirePassword(() => {
      void useDomainStore.getState().endEarly().catch(() => {});
    });
  };

  // ----- Blocked path: the live countdown (Story 4.3) -----
  // The ONLY path a running session sees — the picker / presets / checkboxes
  // / Start are all hidden (spec Never clause). Layout (top to bottom):
  // small uppercase "FOCUS SESSION" label → flex-row with the 64×64 ring on
  // the left and the tabular mm:ss numeral on the right → "Locked until
  // HH:mm" subtitle → destructive outlined End early → hint line. NOT
  // centred — left-aligned per the UX spine (UX-DR15).
  if (hasActiveTimer && activeEndEpochMs != null) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Timer</Text>
        <Text style={styles.statusLabel}>{FOCUS_SESSION_LABEL}</Text>
        <View style={styles.countdownRow}>
          <CountdownRing
            size={64}
            strokeWidth={4}
            trackColor={tokens.status.blocked}
            remainingColor={tokens.primary}
            progress={progress}
          />
          <Text
            style={styles.numeral}
            accessibilityLabel="Time remaining"
            // Per-minute rollover cue (UX-DR17); per-second ticks are silent.
            accessibilityLiveRegion="polite"
          >
            {countdownText}
          </Text>
        </View>
        <Text style={styles.subtitle}>{lockedUntil}</Text>
        <Pressable
          onPress={handleEndEarly}
          focusable
          enableFocusRing
          accessibilityRole="button"
          accessibilityLabel={END_EARLY_LABEL}
          style={({ pressed }) => [
            styles.endEarly,
            pressed && styles.endEarlyPressed,
          ]}
        >
          <Text style={styles.endEarlyLabel}>{END_EARLY_LABEL}</Text>
        </Pressable>
        <Text style={styles.hint}>
          {endEarlyHint(activeEndEpochMs, committed.passwordHash != null)}
        </Text>
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
  // ----- Blocked path (Story 4.3) -----
  // Small uppercase status label. `tokens.typography.label` carries NO
  // letterSpacing, so the letter-spaced premium treatment is a LOCAL style
  // here (tokens stay untouched); opacity gives the secondary-colour read
  // without a new token.
  statusLabel: {
    ...tokens.typography.label,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    opacity: 0.7,
    marginBottom: tokens.spacing.sm,
  },
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginBottom: tokens.spacing.xs,
  },
  numeral: {
    ...tokens.typography.countdown,
  },
  subtitle: {
    ...tokens.typography.body,
    opacity: 0.7,
    marginBottom: tokens.spacing.md,
  },
  // Outlined DESTRUCTIVE — never primary-filled, never the surface default.
  // A plain Pressable carries no Return binding; the Shell's Return→Apply
  // branch fires only on surface 0, so Return does nothing here (UX-DR16:
  // the destructive choice is deliberate, reached via Tab).
  endEarly: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    borderColor: tokens.destructive,
    alignSelf: 'flex-start',
    marginBottom: tokens.spacing.sm,
  },
  endEarlyPressed: {
    opacity: 0.85,
  },
  endEarlyLabel: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
});