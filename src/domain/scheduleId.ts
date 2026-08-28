/**
 * Schedule-id generation (Story 5.2).
 *
 * `Schedule.id` is the primary key and must be a stable slug. When the user
 * adds a NEW schedule, the editor derives the id from the (trimmed) name via
 * `nextScheduleId` — slugified, then uniquified against every existing id so
 * an upsert never silently overwrites an unrelated schedule.
 *
 * PURE and TOTAL: no throws, no state, no I/O. Uniquification is the
 * `nextDomainId`-style `-2`, `-3`, … suffix ladder; an unused slug is returned
 * verbatim (no suffix), so the first "Focus mornings" gets `focus-mornings`
 * and a collision gets `focus-mornings-2`.
 */

/**
 * Slugify `raw`: lowercase, collapse every run of non-alphanumeric characters
 * into a single `-`, trim leading/trailing `-`. An input that slugifies to
 * nothing (empty, all punctuation, all whitespace) becomes `'schedule'` so the
 * id is never empty — the store's `stageScheduleUpsert` rejects empty names,
 * but the id must stay well-formed regardless of call order.
 */
function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'schedule' : slug;
}

/**
 * Derive a unique schedule id for `name`.
 *
 * Slugifies the name and returns it as-is when `existingIds` does not already
 * contain it; otherwise appends `-2`, `-3`, … until free. `existingIds` is
 * read-only and order-irrelevant (membership only).
 */
export function nextScheduleId(name: string, existingIds: readonly string[]): string {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  const taken = new Set(existingIds);
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}