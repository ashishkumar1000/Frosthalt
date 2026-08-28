/**
 * Drift comparator — the sole owner of "is the managed /etc/hosts section in
 * sync with committed config?" (Story 1.7).
 *
 * Ports & adapters, one-way: the domain is the sole owner of drift comparison
 * and the sole caller of `readHostsSection` + `writeHosts` (via the store). This
 * comparator is PURE — it takes the committed `Config` and the opaque
 * `ReadSectionResult` from the unprivileged `readHostsSection` port and returns
 * a `DriftResult`. It NEVER parses markers (the body lines are treated
 * opaquely — array equality against `effectiveHostsLines(committed)`), and it
 * imports NO `child_process`/`fs`/`os` (AD-1).
 *
 * Reasons (spec I/O Matrix):
 *   - `in-sync`  — the section body == `effectiveHostsLines(committed)`
 *                  (order-sensitive), OR empty committed + absent section
 *                  (nothing to enforce).
 *   - `missing`  — the section is absent (no markers) but committed has alwaysOn
 *                  domains to enforce.
 *   - `corrupt`  — `readHostsSection` returned `{ ok:false }` (hosts-unreadable
 *                  or markers-mismatch). Refused before any comparison so a
 *                  corrupt hosts is never silently treated as in-sync.
 *   - `mismatch` — the section is present (markers found) but its body !=
 *                  expected (a hand-edit deleted/added/reordered lines).
 *
 * The comparison is ORDER-SENSITIVE: the managed section's body is written in
 * effective-blocklist order by `writeHosts`, so a reordering is a real drift.
 * Empty committed + absent section = `in-sync` (nothing to enforce) — this
 * avoids a noisy "Restore?" prompt on a fresh install with no domains.
 *
 * Story 5.3 (schedules in the expectation): the expected lines are recomputed
 * at call time, so an in-window schedule's domains are part of `expected`.
 * KNOWN + ACCEPTED at a window boundary: between a window opening/closing and
 * the next hosts write, the on-disk section lags the recomputed expectation,
 * so this comparator can report drift for schedule-only differences. The
 * check runs only on HostsViewer mount, and Restore writes the correctly
 * recomputed lines; Story 5.4's ticker closes the gap live. No special-case
 * here — the boundary report is the honest comparison.
 */

import type { Config } from '../config/types';
import { effectiveHostsLines } from './effectiveBlocklist';
import type { ReadSectionResult } from '../hosts/shellRunner';

/** The drift reason vocabulary (spec Boundaries: Reasons). */
export type DriftReason = 'in-sync' | 'missing' | 'corrupt' | 'mismatch';

/**
 * The drift comparison result. `drift` is the boolean flag the UI gates on
 * (warning banner); `reason` is the human/programmatic detail the UI shows.
 */
export interface DriftResult {
  /** True when the managed section does NOT match committed intent. */
  drift: boolean;
  /** Why. `in-sync` is the only reason with `drift === false`. */
  reason: DriftReason;
}

/**
 * Compare the committed `Config` to the read `ReadSectionResult` and return the
 * drift result. Pure — no I/O, no store mutation.
 *
 *   - `read.ok === false`             -> `{ drift:true, reason:"corrupt" }`
 *   - `read.section === null` (absent):
 *       - `effectiveHostsLines(committed).length === 0` -> `in-sync`
 *       - otherwise                                     -> `missing`
 *   - `read.section` present: order-sensitive array equality vs
 *     `effectiveHostsLines(committed)`:
 *       - equal    -> `in-sync`
 *       - not equal -> `mismatch`
 */
export function computeDrift(
  committed: Config,
  read: ReadSectionResult,
): DriftResult {
  // Corrupt first: a native read failure (hosts-unreadable / markers-mismatch)
  // is never silently treated as an in-sync empty body. Refused before any
  // comparison so the user is told the hosts is corrupt, not "all good".
  if (!read.ok) {
    return { drift: true, reason: 'corrupt' };
  }

  const expected = effectiveHostsLines(committed);

  // Absent section (no markers).
  if (read.section == null) {
    // Empty committed + absent = in-sync (nothing to enforce). This avoids a
    // noisy "Restore?" prompt on a fresh install with no domains.
    if (expected.length === 0) {
      return { drift: false, reason: 'in-sync' };
    }
    // Committed has alwaysOn domains but the section is absent = missing.
    return { drift: true, reason: 'missing' };
  }

  // Present section: order-sensitive body equality. A length mismatch or any
  // differing line (including reordering) is a mismatch — the managed section
  // is written in effective-blocklist order, so order matters.
  const body = read.section;
  if (body.length !== expected.length) {
    return { drift: true, reason: 'mismatch' };
  }
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== expected[i]) {
      return { drift: true, reason: 'mismatch' };
    }
  }
  return { drift: false, reason: 'in-sync' };
}