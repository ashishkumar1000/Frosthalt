/**
 * stagedChangeCount — the number of net staged changes vs committed (Story 2.3).
 *
 * A pure per-hostname diff helper, a sibling to the module-private
 * `draftEqualsCommitted` (`store.ts:282`). It counts added + removed + toggled
 * domains, diffed by `(hostname, alwaysOn)`:
 *   - added    — in `staged`, not in `committed` (+1)
 *   - removed  — in `committed`, not in `staged` (+1)
 *   - toggled  — in both, but `alwaysOn` differs        (+1)
 *
 * A naive length-diff (`staged.length - committed.length`) is WRONG: a toggle
 * changes no length (1 change), and `stageAlwaysOnToggle`'s clean-revert
 * (`store.ts:146-149`) clears `staged` to `null` on a net-zero off-then-on, so a
 * value-equal staged-vs-committed (which never reaches this helper in practice
 * — clean-revert prevents it — but the helper must still report 0 for it)
 * yields 0. The diff-by-hostname discipline matches `draftEqualsCommitted`.
 *
 * The hint ("N changes staged") consumes this count; the helper is EXPORTED
 * (the UI consumes it). No store import — pass the two arrays in.
 */

import type { Domain } from '../config/types';

/**
 * Count the net staged changes (added + removed + toggled) between two
 * `Domain[]` drafts, diffed by hostname. Order-agnostic (a `Map` is used), so
 * a reordered-but-value-equal pair still yields 0.
 */
export function stagedChangeCount(
  staged: Domain[],
  committed: Domain[],
): number {
  // Index committed by hostname so each staged domain can be compared in O(1).
  const committedByHost = new Map<string, boolean>();
  for (const d of committed) {
    committedByHost.set(d.hostname, d.alwaysOn);
  }

  let count = 0;
  const seen = new Set<string>();
  for (const d of staged) {
    seen.add(d.hostname);
    const committedAlwaysOn = committedByHost.get(d.hostname);
    if (committedAlwaysOn === undefined) {
      // In staged, not in committed -> added.
      count += 1;
    } else if (committedAlwaysOn !== d.alwaysOn) {
      // In both, alwaysOn differs -> toggled.
      count += 1;
    }
    // Otherwise value-equal -> no change.
  }
  // Domains in committed but not in staged -> removed.
  for (const hostname of committedByHost.keys()) {
    if (!seen.has(hostname)) {
      count += 1;
    }
  }
  return count;
}