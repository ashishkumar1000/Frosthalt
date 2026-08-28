/**
 * stagedScheduleChangeCount — the number of net staged schedule changes vs
 * committed (Story 5.1).
 *
 * A pure per-`id` diff helper, the schedule-shaped sibling of
 * `stagedChangeCount.ts` (domains, Story 2.3). It counts schedules whose `id`
 * exists in one list but not the other (added / removed) plus schedules that
 * exist in both but differ in ANY field (`name`, `weekdays`, `startTime`,
 * `endTime`, `enabled`). Identity is `id` (the Schedule PK, Story 1-4's
 * schema); a field-level diff is required because the Schedule surface's
 * staged edits are toggles and later editor saves (5.2), which change fields
 * without changing the id.
 *
 * Order-agnostic (a `Map` is used), mirroring the domain helper's discipline
 * and `draftEqualsCommitted` (`store.ts`): a reordered-but-value-equal pair
 * yields 0, and `stageScheduleEnabledToggle`'s clean-revert clears
 * `stagedSchedules` to `null` on a net-zero toggle — so the invariant
 * `stagedSchedules != null ⟹ count >= 1` holds for the "N changes staged"
 * hint. `weekdays` compares as a SET (order-agnostic), the other fields
 * compare exactly.
 *
 * Singular/plural grammar is the CALLER's job (the hint string lives in the
 * Schedule surface, mirroring Blocklist). No store import — pass the two
 * arrays in.
 */

import type { Schedule } from '../config/types';

/**
 * A canonical per-schedule value key: every field EXCEPT `id` (identity),
 * with `weekdays` canonicalised to a sorted, de-duplicated list so a
 * reordered-but-equal weekday set compares equal. Used for the O(1) field
 * comparison across the two lists.
 *
 * The key is `JSON.stringify`d (not a `|`/`,` join) so a schedule whose
 * `name` itself contains a separator ("a|b" vs "a" + "b") can never produce
 * colliding keys (5-1 review EC-4/BH-9). Exported because
 * `scheduleDraftEqualsCommitted` (store.ts) reuses it for the clean-revert
 * comparison — one canonical key definition, two consumers, no drift.
 */
export function scheduleValueKey(schedule: Schedule): string {
  const weekdays = Array.isArray(schedule.weekdays)
    ? [...new Set(schedule.weekdays)].sort((a, b) => a - b)
    : null;
  return JSON.stringify([
    String(schedule.name ?? ''),
    weekdays,
    String(schedule.startTime ?? ''),
    String(schedule.endTime ?? ''),
    String(schedule.enabled ?? ''),
  ]);
}

/**
 * Count the net staged schedule changes (added + removed + field-changed)
 * between two `Schedule[]` drafts, diffed by `id`. Order-agnostic: a
 * reordered-but-value-equal pair yields 0.
 */
export function stagedScheduleChangeCount(
  staged: Schedule[],
  committed: Schedule[],
): number {
  // Index committed by id -> its value key, so each staged schedule compares
  // in O(1) regardless of list order.
  const committedById = new Map<string, string>();
  for (const s of committed) {
    committedById.set(s.id, scheduleValueKey(s));
  }

  let count = 0;
  const seen = new Set<string>();
  for (const s of staged) {
    seen.add(s.id);
    const committedKey = committedById.get(s.id);
    if (committedKey === undefined) {
      // In staged, not in committed -> added.
      count += 1;
    } else if (committedKey !== scheduleValueKey(s)) {
      // In both, at least one field differs -> changed.
      count += 1;
    }
    // Otherwise value-equal -> no change.
  }
  // Schedules in committed but not in staged -> removed.
  for (const id of committedById.keys()) {
    if (!seen.has(id)) {
      count += 1;
    }
  }
  return count;
}