/**
 * Effective blocklist computation (Story 1.6 / Epic 1, Epic 4).
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
 * Epic 5 (active schedules) contribution is reserved and contributes nothing
 * yet; this function is structured so it slots in as a third step without
 * changing the call sites.
 *
 * The hostnames are normalised (defensively — a well-formed config already
 * stores normalised apexes per `types.ts`, but a corrupt or hand-edited
 * `config.json` could hold a `www.`-prefixed or upper-case value) and deduped
 * by apex, preserving first-seen order.
 */

import type { Config } from '../config/types';
import { normaliseDomain, toHostsLines } from './normalise';

/**
 * Returns the normalised, deduped list of apex hostnames currently in the
 * effective blocklist for `config`. Epic 1: always-on domains. Epic 4: also
 * `activeTimer?.selectedDomains`. Epic 5 (later): also active-schedule
 * domains.
 */
export function effectiveBlocklist(config: Config): string[] {
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

  // Epic 5 (active schedules) contribution lands here in a later epic —
  // appended to `out` with the same normalise + dedupe discipline.

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
 * three never drift on how the expected lines are produced. Pure — a thin
 * `effectiveBlocklist(config).flatMap(toHostsLines)`.
 */
export function effectiveHostsLines(config: Config): string[] {
  return effectiveBlocklist(config).flatMap(toHostsLines);
}