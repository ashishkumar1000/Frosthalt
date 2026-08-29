/**
 * StatusHeader — the persistent status bar above the content (Story 1.3).
 *
 * Always visible across all four surfaces. Renders the `StatusBadge`
 * followed by the live effectively-blocked domain count (Story 2.5) and —
 * since Story 4.4 — either the live countdown or the static "no active
 * timer" placeholder:
 *
 *   - No session (`committed.activeTimer == null`, or a malformed end time
 *     normalised away): the unchanged Epic-2 form — `Free` badge · count ·
 *     "no active timer" · View hosts.
 *   - Session live (`committed.activeTimer.endEpochMs` finite): `Blocked`
 *     badge (UX-DR3) · count · a tabular `mm:ss` countdown · a 16×16 mini
 *     `CountdownRing` · View hosts. Both countdown values come from the
 *     SCOPED `useTimerStore` slice (`src/domain/timerStore.ts`) via the
 *     selector-scoped `selectRemainingMs` / `selectProgress` subscriptions —
 *     a per-second tick re-renders ONLY this header subtree; the Shell, the
 *     Blocklist / Settings / Schedule surfaces and the Sidebar never touch
 *     the slice.
 *
 * This header OWNS the slice lifecycle (Story 4.4): it is the one component
 * mounted on every surface for the app's whole life, so its
 * `start(endEpochMs)` on a live session / `stop()` on cleanup keeps the
 * driver alive across surface navigation (the 4.3 slice refcount lets the
 * Timer surface co-subscribe; 6.2's menu bar will be the third). The slice
 * is started only by a LIVE `activeEndEpochMs` — with no session the header
 * never calls `start` (refcount 0 when the Timer surface is unmounted).
 *
 * The countdown derives ONLY from the slice — the same `useLayoutEffect`
 * start/stop lifecycle pattern Timer.tsx uses. Since Story 5.4 TWO drivers
 * can run: the refcount-shared timer slice's `setInterval(1000)` (only while
 * a session is live) plus the header's unconditional clock slice driver
 * below. `activeEndEpochMs` normalisation mirrors Timer.tsx
 * exactly (`!= null && Number.isFinite`) so the header, the Timer surface
 * and the slice can never disagree about whether a session is live.
 *
 * The count is the EFFECTIVE blocked count — `effectiveBlocklist(committed,
 * now).length` — the domains actually enforced in `/etc/hosts` right now
 * (Story 2.3's pure helper; Story 5.3 added the active-schedule contribution,
 * so the count now follows schedule windows too). `now` comes from the SCOPED
 * `useClockStore` slice (Story 5.4) — the header is its ALWAYS-MOUNTED
 * subscriber — so the count live-updates when a schedule window opens or
 * closes while the app runs, not only on Apply success. `committed` updates
 * only on Apply success, so a staged edit still does not move the count until
 * Applied; a window boundary does. Badge and count are derived from the SAME
 * inputs (committed + the same clock-mirror `now`), so they never disagree
 * with each other — reconciling the disk payload to them is the transition
 * trigger's job, not theirs.
 *
 * The badge is the Story 5.4 ramp derivation — the pure
 * `computeBadgeState(committed, now)` (`badgeState.ts`): `free` with no live
 * session/window, `blocked` while a session or an active schedule enforces,
 * `amber` when the earliest active schedule ends within
 * `SCHEDULE_ENDING_SOON_MS` (10 min) and its boundary would actually shrink
 * the blocklist. The clock slice's `nowMs` drives it, so the badge ramps
 * free→amber→blocked live across boundaries with no Apply in between (amber
 * is schedule-scoped — a timer-only session never ambers, the 4-4 defer).
 *
 * This header also OWNS the CLOCK slice lifecycle (Story 5.4): an
 * unconditional `useClockStore.start()` on mount / `stop()` on cleanup keeps
 * the per-second clock driver alive for the app's whole life — the trigger
 * that reconciles `/etc/hosts` across schedule boundaries lives in
 * `store.ts` (the module-level `useClockStore` subscription) and only needs
 * the ticks this lifecycle keeps flowing.
 *
 * Both numerals use `fontVariant: ['tabular-nums']` (the proven
 * `tokens.typography.countdown` pattern, `tokens.ts:120`) so digit width is
 * fixed and the header does not jitter as the values change (9 -> 10).
 *
 * VoiceOver on-change announce: a `useEffect` keyed on `count` calls
 * `AccessibilityInfo.announceForAccessibility` when the count changes, SKIPPING
 * the initial mount via a `useRef(true)` first-run guard. The app launches on
 * surface 0 = Blocklist, whose mount-announce (`Blocklist.tsx`) already speaks
 * the list on entry; a second announce on launch would double up. Since
 * Story 5.4 the count changes on Apply success AND on a schedule window
 * boundary crossing (the clock tick recomputes the effective blocklist), so
 * the announce fires after an Apply commits AND when a live boundary moves
 * the blocklist — both are real blocklist changes a VoiceOver user should
 * hear.
 *
 * The header deliberately announces NOTHING on countdown ticks or minute
 * rollovers (UX-DR17): the Timer surface owns the mount + per-minute
 * announces while it is mounted, and a header-side announce would double up
 * there and be noisy everywhere else. The `mm:ss` numeral is a passive
 * readout that VoiceOver reads on focus via its
 * `accessibilityLabel="Time remaining mm:ss"` — the label EMBEDS the live
 * value (an `accessibilityLabel` REPLACES the text content, so a static
 * label would never speak the time), but there is no live region, so it is
 * read only on focus — never announced per tick. `accessibilityLiveRegion`
 * is Android-only and a no-op on macOS, so it is skipped here (established
 * in 4.3). Expiry is NOT handled by the header — an expired session holds
 * `Blocked · 00:00` exactly like the Timer surface does (Story 4.5 owns
 * clearing `activeTimer`; 4.7 owns launch re-arm).
 *
 * Relaunch quirk (known 4.7 deferral, not handled here): a session RESUMED
 * from persisted config at launch captures the slice's `totalMs` as
 * `endEpochMs - Date.now()` (remaining only), so the mini ring starts FULL
 * for an already half-elapsed session after a relaunch — only the numeral is
 * wall-clock-accurate in that case. Story 4.7's launch re-arm owns a fuller
 * treatment.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { tokens } from '../theme/tokens';
import { CountdownRing } from './CountdownRing';
import { StatusBadge } from './StatusBadge';
import { useDomainStore } from '../domain/store';
import { effectiveBlocklist } from '../domain/effectiveBlocklist';
import { computeBadgeState } from '../domain/badgeState';
import { useClockStore } from '../domain/clockStore';
import {
  useTimerStore,
  selectRemainingMs,
  selectProgress,
  formatMmSs,
} from '../domain/timerStore';

export interface StatusHeaderProps {
  /**
   * Called when the user clicks the "View hosts" link — opens the read-only
   * hosts viewer overlay (Story 2.6). The Shell owns the `viewerOpen` state.
   */
  onViewHosts: () => void;
}

export function StatusHeader({ onViewHosts }: StatusHeaderProps): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  // The clock slice (Story 5.4): the per-second wall-clock mirror. Subscribing
  // here makes the count and the badge LIVE — a schedule window opening or
  // closing re-renders this header subtree on the next tick without any
  // `committed` change (before 5.4 both only moved on Apply success).
  const nowMs = useClockStore((s) => s.nowMs);
  // Memoized on `[committed, nowMs]` (Story 5.4): `effectiveBlocklist` walks +
  // dedupes the domain list, and its schedule contribution is time-dependent —
  // the injected `now` (derived from the clock slice's mirror, never a fresh
  // `Date.now()` here) makes the count follow a window opening or closing
  // while the app runs. The per-second tick re-renders this header subtree
  // anyway during a live session, so the memo's job is only to keep the
  // derivation out of unrelated renders; a boundary tick recomputes it.
  const count = useMemo(
    () => effectiveBlocklist(committed, new Date(nowMs)).length,
    [committed, nowMs],
  );
  const countLabel = `${count} ${count === 1 ? 'domain' : 'domains'}`;
  // The badge ramp (Story 5.4): pure `computeBadgeState` from the same
  // committed + clock-mirror `now` the count uses, so badge and count never
  // disagree with each other (reconciling the disk to them is the transition
  // trigger's job). Memoized on the same pair as `count`.
  const badge = useMemo(
    () => computeBadgeState(committed, new Date(nowMs)),
    [committed, nowMs],
  );

  // The scoped countdown slice. TWO numeric selectors (remaining for the
  // numeral, progress for the ring) — both change EVERY tick during a live
  // session, so this header subtree re-renders once per second by design;
  // the scoping keeps every OTHER tree (Shell / Blocklist / Settings /
  // Schedule / Sidebar) out of the tick entirely.
  const remainingMs = useTimerStore(selectRemainingMs);
  const progress = useTimerStore(selectProgress);

  // Defensive normalisation (mirrors Timer.tsx exactly): `readConfig`
  // validates config.json top-level only, so a malformed
  // `activeTimer.endEpochMs` (non-numeric) must NOT put the header into the
  // live branch — the gate and the slice lifecycle both key on the
  // normalised value so the header, the Timer surface and the slice can
  // never disagree about whether a session is live.
  const rawEndEpochMs = committed.activeTimer?.endEpochMs ?? null;
  const activeEndEpochMs =
    rawEndEpochMs != null && Number.isFinite(rawEndEpochMs)
      ? rawEndEpochMs
      : null;
  const hasActiveTimer = committed.activeTimer != null && activeEndEpochMs != null;

  // ----- Slice lifecycle (Story 4.4) -----
  // The header is the slice's ALWAYS-MOUNTED subscriber: `start(endEpochMs)`
  // when a session is mirrored, `stop()` on cleanup. The slice's internal
  // refcount makes this safe for co-subscribers (the Timer surface 4.3, the
  // menu bar 6.2) — unmounting the Timer surface mid-session drops the
  // refcount to 1 and the header keeps counting. Keyed on the mirrored
  // `endEpochMs` so a superseding session re-arms the driver, and a cleared
  // `activeTimer` releases the header's refcount slot.
  // useLayoutEffect (the 4.3 pattern): a plain useEffect runs AFTER first
  // paint, so every live mount would flash 00:00 / an empty ring for one
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

  // ----- Clock slice lifecycle (Story 5.4) -----
  // An UNCONDITIONAL start on mount / stop on cleanup: the clock driver must
  // run for the app's whole life (StatusHeader never unmounts, so the
  // refcount never drops to zero in the running app) — its ticks feed BOTH
  // the live count/badge re-renders above and the store-level transition
  // trigger that reconciles /etc/hosts across a window boundary. The same
  // useLayoutEffect phase as the timer slice above: the slice is current
  // before first paint.
  useLayoutEffect(() => {
    useClockStore.getState().start();
    return () => {
      useClockStore.getState().stop();
    };
  }, []);

  // On-change VoiceOver announce (skip the initial mount). The app launches on
  // surface 0 = Blocklist, whose mount-announce (`Blocklist.tsx`) already
  // speaks the list on entry; a second announce on launch would double up.
  // Since Story 5.4 the count changes on Apply success AND on a schedule
  // window boundary tick (a live boundary moving the effective blocklist is a
  // real change a VoiceOver user should hear), so this fires after an Apply
  // commits AND when a boundary crosses. The `useRef(true)` first-run guard
  // skips the initial mount; every subsequent count change announces.
  // Countdown ticks do NOT change `count`, so they never announce from here.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    AccessibilityInfo.announceForAccessibility(
      `${count} ${count === 1 ? 'domain' : 'domains'} blocked`,
    );
  }, [count]);

  return (
    <View style={styles.container}>
      <StatusBadge status={badge} />
      <Text style={styles.separator}>·</Text>
      <Text style={styles.count}>{countLabel}</Text>
      {hasActiveTimer ? (
        <>
          <Text style={styles.separator}>·</Text>
          <Text
            style={styles.numeral}
            // The label EMBEDS the live value: an accessibilityLabel REPLACES
            // the text content for VoiceOver, so a static "Time remaining"
            // would never speak the time. No live region, so it is read only
            // on focus — the label changing per tick announces nothing.
            accessibilityLabel={`Time remaining ${formatMmSs(remainingMs)}`}
          >
            {formatMmSs(remainingMs)}
          </Text>
          <Text style={styles.separator}>·</Text>
          {/* 16×16 mini ring (UX-DR5): `status-blocked` track + `primary`
              remaining arc — the same colours as the Timer surface's 64×64
              ring. The ring is a11y-hidden internally (CountdownRing); the
              numeral carries the announce. */}
          <CountdownRing
            size={16}
            strokeWidth={1.5}
            trackColor={tokens.status.blocked}
            remainingColor={tokens.primary}
            progress={progress}
          />
        </>
      ) : (
        <>
          <Text style={styles.separator}>·</Text>
          <Text style={styles.text}>no active timer</Text>
        </>
      )}
      <Text style={styles.separator}>·</Text>
      <Pressable
        onPress={onViewHosts}
        accessibilityRole="button"
        accessibilityLabel="View hosts"
      >
        <Text style={styles.link}>View hosts</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    // DESIGN.md: compact bar pinned above the content area. Pad with the
    // 8pt-grid spacing scale; a single `md` (16px) horizontal pad keeps the
    // header aligned with the content column.
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  text: {
    ...tokens.typography.label,
  },
  count: {
    ...tokens.typography.label,
    // Tabular figures so the digit width is fixed and the header does not
    // jitter as the count changes (9 -> 10). Reuses the proven
    // `tokens.typography.countdown` pattern (`tokens.ts:120`).
    fontVariant: ['tabular-nums'],
  },
  numeral: {
    ...tokens.typography.label,
    // Tabular figures so the countdown digit width is fixed and the mm:ss
    // never jitters as it ticks (Story 4.4; same pattern as `.count`).
    fontVariant: ['tabular-nums'],
  },
  separator: {
    ...tokens.typography.label,
  },
  link: {
    ...tokens.typography.label,
    color: tokens.primary,
  },
});