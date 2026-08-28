/**
 * Effective blocklist computation (Story 1.6 / Epic 1, Epic 4, Epic 5).
 *
 * The effective blocklist is the set of hostnames currently enforced in the
 * managed `/etc/hosts` section. Per the epic's revocable source-of-truth model
 * it is DERIVED from `config.json` on every Apply — `config.json` is canonical
 * intent, the hosts section is derived enforcement.
 *
 * Epic 1 contribution: `domains.filter(alwaysOn)` — only the always-on
 * domains.
 * Epic 4 contribution (Story 4.2): `activeTimer?.selectedDomains` — the
 * domains the running focus session blocks in addition to always-on. Walked
 * after the always-on loop with the same `normaliseDomain` + apex dedupe so
 * an apex that's both `alwaysOn:true` AND in the timer selection is written
 * ONCE (the dedupe is the single source of truth for "is this apex in the
 * effective blocklist"). When `activeTimer` is null (no session running) the
 * contribution is empty.
 * Epic 5 contribution (Story 5.3): every ENABLED schedule whose weekly window
 * contains `now` (evaluated by `isScheduleActive`) contributes its domains,
 * walked LAST — after the timer — with the same normalise + dedupe discipline,
 * so an apex that is always-on AND timer-selected AND scheduled writes once.
 * Out-of-window or disabled schedules contribute nothing. The payload is only
 * recomputed on the existing hosts-write paths (Apply, timer start/expire/
 * end-early, restore, drift check); Story 5.4's ticker owns live transitions
 * across a window boundary — this function never ticks and never writes.
 *
 * The hostnames are normalised (defensively — a well-formed config already
 * stores normalised apexes per `types.ts`, but a corrupt or hand-edited
 * `config.json` could hold a `www.`-prefixed or upper-case value) and deduped
 * by apex, preserving first-seen order.
 */

import type { Config } from '../config/types';
import { normaliseDomain, toHostsLines } from './normalise';
import { isScheduleActive } from './scheduleEval';

/**
 * Returns the normalised, deduped list of apex hostnames currently in the
 * effective blocklist for `config`. Epic 1: always-on domains. Epic 4: also
 * `activeTimer?.selectedDomains`. Epic 5 (Story 5.3): also the domains of
 * every enabled schedule whose weekly window contains `now`.
 *
 * `now` is an injected `Date` (defaulted to the current time so every
 * existing call site keeps working unchanged); tests pin it for
 * determinism. The default is evaluated per call — the payload is only ever
 * recomputed on the existing hosts-write paths.
 */
export function effectiveBlocklist(config: Config, now: Date = new Date()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Epic 1: always-on domains.
  for (const d of config.domains) {
    if (!d || !d.alwaysOn) {
      continue;
    }
    const apex = normaliseDomain(d.hostname);
    if (apex == null) {
      // A corrupt config entry (not a usable hostname) is skipped rather than
      // crashing the pipeline. The native hosts-line regex is the final
      // authority, but filtering here keeps the derived payload clean.
      continue;
    }
    if (seen.has(apex)) {
      continue;
    }
    seen.add(apex);
    out.push(apex);
  }

  // Epic 4 (Story 4.2): running focus session domains. Walked AFTER the
  // always-on loop with the same `normaliseDomain` + `seen`-dedupe discipline
  // so an apex that's both always-on AND timer-selected lands ONCE in `out`.
  // When `activeTimer == null` (no session) this loop contributes nothing.
  if (config.activeTimer && Array.isArray(config.activeTimer.selectedDomains)) {
    for (const hostname of config.activeTimer.selectedDomains) {
      const apex = normaliseDomain(hostname);
      if (apex == null) {
        // Defensive: a hand-edited or corrupt config could hold a non-
        // hostname in `selectedDomains`. Skipped rather than crashing the
        // pipeline — same posture as the always-on loop above.
        continue;
      }
      if (seen.has(apex)) {
        continue;
      }
      seen.add(apex);
      out.push(apex);
    }
  }

  // Epic 5 (Story 5.3): active-schedule domains. Walked LAST — after the
  // always-on loop and the timer walk — with the same `normaliseDomain` +
  // `seen`-dedupe discipline so an apex that is always-on AND timer-selected
  // AND scheduled still lands ONCE in `out` (first-seen order wins: the
  // always-on/timer position). Each schedule is gated by the pure window
  // evaluator `isScheduleActive(schedule, now)`: disabled, out-of-window,
  // degenerate-window, or malformed schedules contribute nothing, and a
  // junk (non-hostname) domain inside an ACTIVE schedule is skipped rather
  // than crashing the pipeline — the same posture as the loops above.
  if (Array.isArray(config.schedules)) {
    for (const schedule of config.schedules) {
      if (!isScheduleActive(schedule, now)) {
        continue;
      }
      const domains = (schedule as { domains?: unknown }).domains;
      if (!Array.isArray(domains)) {
        continue;
      }
      for (const hostname of domains) {
        const apex = normaliseDomain(hostname);
        if (apex == null) {
          continue;
        }
        if (seen.has(apex)) {
          continue;
        }
        seen.add(apex);
        out.push(apex);
      }
    }
  }

  return out;
}

/**
 * The full managed-section hosts payload derived from `config`: every apex in
 * the effective blocklist expanded via `toHostsLines` (apex + `www.` on
 * `0.0.0.0` + `::`, in effective-blocklist order). This is exactly the line set
 * that `writeHosts` writes and that `computeDrift` compares the read section's
 * body against (Story 1.7).
 *
 * DRY helper reused by `runApply`, `computeDrift`, and `restoreSection` so the
 * three never drift on how the expected lines are produced. `now` threads
 * through to `effectiveBlocklist` (default = current time) — with Story 5.3
 * the expected lines therefore include active-schedule domains, and every
 * hosts-write path inherits that contribution with no changes of its own.
 * Pure — a thin `effectiveBlocklist(config, now).flatMap(toHostsLines)`.
 */
export function effectiveHostsLines(config: Config, now: Date = new Date()): string[] {
  return effectiveBlocklist(config, now).flatMap(toHostsLines);
}