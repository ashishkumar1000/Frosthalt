/**
 * Effective blocklist computation (Story 1.6 / Epic 1).
 *
 * The effective blocklist is the set of hostnames currently enforced in the
 * managed `/etc/hosts` section. Per the epic's revocable source-of-truth model
 * it is DERIVED from `config.json` on every Apply — `config.json` is canonical
 * intent, the hosts section is derived enforcement.
 *
 * Epic 1 contribution: `domains.filter(alwaysOn)` — only the always-on
 * domains. Active-timer (Epic 4) and active-schedule (Epic 5) contributions
 * are reserved for later epics and contribute nothing yet; this function is
 * structured so they slot in as additional steps without changing the call
 * sites.
 *
 * The hostnames are normalised (defensively — a well-formed config already
 * stores normalised apexes per `types.ts`, but a corrupt or hand-edited
 * `config.json` could hold a `www.`-prefixed or upper-case value) and deduped
 * by apex, preserving first-seen order.
 */

import type { Config } from '../config/types';
import { normaliseDomain } from './normalise';

/**
 * Returns the normalised, deduped list of apex hostnames currently in the
 * effective blocklist for `config`. Epic 1: always-on domains only.
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

  // Epic 4 (activeTimer) and Epic 5 (active schedules) contributions land
  // here in later epics — appended to `out` with the same normalise + dedupe
  // discipline. Intentionally empty for 1.6.

  return out;
}