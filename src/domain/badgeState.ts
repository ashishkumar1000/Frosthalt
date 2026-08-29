/**
 * The status-badge ramp derivation (Story 5.4 / Epic 5).
 *
 * A PURE domain helper that decides which status the header badge shows:
 * `'free'` (no enforcement session or window is live), `'blocked'`, or
 * `'amber'` — the "ending soon" ramp (UX-DR15: the badge alone signals it,
 * NO alert/toast fires for the ramp).
 *
 * Amber is SCHEDULE-SCOPED only (the Story 4-4 defer stands): it requires an
 * active schedule whose end is within `SCHEDULE_ENDING_SOON_MS` AND whose end
 * instant would actually SHRINK the blocklist (strictly smaller — a boundary
 * covered by always-on / the timer / another active schedule never ambers).
 * A timer-only session never ambers, no matter how close its expiry.
 *
 * The badge's `blocked` means "a live enforcement session exists": a running
 * focus session (finite `activeTimer.endEpochMs`) OR an active schedule
 * window. This keeps the Epic-2 header semantics intact — an always-on-only
 * config with no live session still shows `free`.
 *
 * Dependency direction: domain -> domain only. This module imports nothing
 * from the UI (`StatusBadge`/`tokens.ts` keep their own `StatusKey`, which
 * this union is structurally identical to) and never calls `Date.now()` —
 * `now` is always injected (only the clock slice reads the wall clock, once
 * per tick).
 */

import type { Config } from '../config/types';
import { effectiveBlocklist } from './effectiveBlocklist';
import { isScheduleActive } from './scheduleEval';
import { normaliseTime } from './normalise';

/** How close to an active schedule's end the "ending soon" ramp begins. */
export const SCHEDULE_ENDING_SOON_MS = 10 * 60 * 1000;

/** The badge states the header can show. Structurally the UI's `StatusKey` subset. */
export type BadgeState = 'free' | 'amber' | 'blocked';

/**
 * The badge label words — the SINGLE SOURCE for both renderers of the badge
 * (the in-window `StatusBadge` pill and the Story 6.2 menu-bar mirror), so
 * the two surfaces can never show different words for the same state.
 * Domain-owned on purpose: UI imports domain, never the reverse.
 */
export const badgeStateLabels: Record<BadgeState, string> = {
  free: 'Free',
  amber: 'Blocking',
  blocked: 'Blocked',
};

/**
 * Derive the header badge status for `committed` at the injected `now`.
 *
 * - `free`    — no live timer session and no active schedule window.
 * - `blocked` — a live session (timer or schedule), with no qualifying
 *               "ending soon" boundary.
 * - `amber`   — blocked AND the earliest active schedule's end is within
 *               `SCHEDULE_ENDING_SOON_MS` AND the blocklist evaluated AT that
 *               end instant is strictly smaller than at `now`.
 *
 * TOTAL and PURE: never throws (a malformed `schedules` array or junk
 * schedule elements are simply inactive — the 5.3 evaluator contract; any
 * unexpected failure still returns the over-blocking `'blocked'`), never
 * reads the wall clock, never mutates its inputs.
 */
export function computeBadgeState(committed: Config, now: Date): BadgeState {
  try {
    const schedules: unknown[] = Array.isArray(committed.schedules)
      ? committed.schedules
      : [];
    const timerLive =
      committed.activeTimer != null &&
      Number.isFinite(committed.activeTimer.endEpochMs);
    let anyActiveSchedule = false;

    // Earliest end (minutes-of-day) across the ACTIVE schedules. For an
    // active schedule the end is always later today (half-open window:
    // nowMinutes < endMinutes), so the end instant is always in the future.
    let earliestEndMinutes: number | null = null;
    for (const schedule of schedules) {
      if (!isScheduleActive(schedule, now)) {
        continue;
      }
      anyActiveSchedule = true;
      // Unparseable ends already evaluate inactive in `isScheduleActive`, so
      // this parse succeeds for every schedule that reaches here — but the
      // defensive null check keeps the helper total.
      const end = normaliseTime((schedule as { endTime?: unknown }).endTime);
      if (end == null) {
        continue;
      }
      const endMinutes = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
      if (earliestEndMinutes == null || endMinutes < earliestEndMinutes) {
        earliestEndMinutes = endMinutes;
      }
    }

    // Free = no live enforcement session of any kind. The always-on-only
    // Epic-2 semantics are preserved: the badge tracks live sessions/windows,
    // not the static always-on set.
    if (!timerLive && !anyActiveSchedule) {
      return 'free';
    }

    if (earliestEndMinutes != null) {
      // The end instant: today at the schedule's endTime, seconds/ms zeroed.
      // Strictly after `now` by construction, so `remaining` is positive —
      // the >= 0 check is defensive only.
      const endMs = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        Math.floor(earliestEndMinutes / 60),
        earliestEndMinutes % 60,
        0,
        0,
      ).getTime();
      const remaining = endMs - now.getTime();
      if (remaining >= 0 && remaining <= SCHEDULE_ENDING_SOON_MS) {
        // The shrink check: amber only when the blocklist at the boundary is
        // STRICTLY smaller — never amber for a boundary that changes nothing.
        const atEnd = effectiveBlocklist(committed, new Date(endMs));
        const atNow = effectiveBlocklist(committed, now);
        if (atEnd.length < atNow.length) {
          return 'amber';
        }
      }
    }

    return 'blocked';
  } catch {
    // Never throws. Fail-safe direction is over-blocking: show the blocking
    // badge rather than a false "Free" while something may be enforced.
    return 'blocked';
  }
}