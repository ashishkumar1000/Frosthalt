/**
 * scheduleSummary — the plain-English summary line for a schedule (Story 5.1).
 *
 * A PURE, TOTAL formatter: it never throws and never normalises/validates
 * times — it derives a human-readable summary from the stored `Schedule`
 * shape. Malformed input (a hand-edited `config.json` schedule whose fields
 * are missing or of the wrong type — `readConfig` shape-gates the `schedules`
 * ARRAY only, not its elements) renders fail-safe rather than crashing the
 * Schedule surface:
 *   - a missing/`null` schedule renders `''`;
 *   - non-array weekdays, unknown weekday indices, and non-integer weekday
 *     values are DROPPED (never crash, never invent a day);
 *   - missing/non-string times render raw (empty string for a missing time),
 *     never a thrown error.
 *
 * Weekday convention (Story 1-4's frozen schema): `0 = Monday … 6 = Sunday`.
 * Times are local `HH:mm` 24-hour strings, passed through verbatim.
 *
 * Grammar (the spec's frozen examples, `–` = en dash):
 *   - all 7 weekdays  -> `Every day, 09:00–17:00`
 *   - contiguous run  -> `Every Mon–Fri, 09:00–17:00`
 *   - single day      -> `Every Monday, 09:00–17:00` (full name)
 *   - mixed           -> `Every Mon, Wed–Thu, Sat, 09:00–17:00`
 *   - empty weekdays  -> `09:00–17:00` (time only)
 *
 * Canonical weekday order is Mon→Sun regardless of stored order, and
 * duplicates are de-duplicated. Runs are LINEAR (no Sunday→Monday wrap): a
 * `[6, 0]` schedule renders as two isolated days (`Every Sun, Mon, …`), which
 * matches the frozen grammar's Mon–Fri example and keeps the formatter
 * deterministic.
 */

import type { Schedule, Weekday } from '../config/types';

/** Full weekday names, indexed by the stored `Weekday` value (0 = Monday). */
const FULL_DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Abbreviated weekday names, indexed by the stored `Weekday` value. */
const ABBREV_DAY_NAMES = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

/** The en dash that joins weekday runs and start/end times (spec grammar). */
const EN_DASH = '–';

/**
 * The valid `Weekday` values as a Set, so an unknown index (a hand-edited
 * `7`, a float, a string, a negative) is dropped rather than indexing
 * `undefined` out of the name tables.
 */
const VALID_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

/**
 * Normalise the stored weekday list to the canonical Mon→Sun order with
 * duplicates removed and unknown values dropped. Returns `[]` for anything
 * that is not an array (the fail-safe branch for a malformed element).
 */
function normaliseWeekdays(weekdays: unknown): Weekday[] {
  if (!Array.isArray(weekdays)) {
    return [];
  }
  const seen = new Set<number>();
  for (const raw of weekdays) {
    if (typeof raw === 'number' && Number.isInteger(raw) && VALID_WEEKDAYS.has(raw)) {
      seen.add(raw);
    }
  }
  // Canonical Mon→Sun order: sort the deduped set ascending (0 = Monday).
  return [...seen].sort((a, b) => a - b) as Weekday[];
}

/**
 * Build the weekday part of the summary (`day` / `Mon–Fri` / `Monday` /
 * `Mon, Wed–Thu, Sat`) from the already-normalised weekday list. Returns `''`
 * for an empty list (the time-only branch).
 */
function weekdayPart(weekdays: Weekday[]): string {
  if (weekdays.length === 0) {
    return '';
  }
  // All 7 -> the single-word "day" form (`Every day`).
  if (weekdays.length === 7) {
    return 'day';
  }
  // Group the canonical list into contiguous runs (linear — no Sun→Mon wrap).
  const runs: Weekday[][] = [];
  let current: Weekday[] = [weekdays[0]];
  for (let i = 1; i < weekdays.length; i++) {
    if (weekdays[i] === weekdays[i - 1] + 1) {
      current.push(weekdays[i]);
    } else {
      runs.push(current);
      current = [weekdays[i]];
    }
  }
  runs.push(current);

  const parts = runs.map((run) => {
    if (run.length >= 2) {
      // Contiguous run: `Mon–Fri` (abbreviated at both ends).
      return `${ABBREV_DAY_NAMES[run[0]]}${EN_DASH}${ABBREV_DAY_NAMES[run[run.length - 1]]}`;
    }
    // Isolated single day. The FULL name is used only when the whole schedule
    // is that one day (`Every Monday, …` — the frozen grammar's single-day
    // rule); inside a mixed list an isolated day renders abbreviated
    // (`Every Mon, Wed–Thu, Sat, …`), matching the frozen mixed example.
    if (weekdays.length === 1) {
      return FULL_DAY_NAMES[run[0]];
    }
    return ABBREV_DAY_NAMES[run[0]];
  });
  return parts.join(', ');
}

/**
 * Format a schedule's plain-English summary. TOTAL: never throws on a
 * malformed schedule (missing/non-string times render raw; unknown weekday
 * indices are dropped; a `null`/`undefined` schedule renders `''`).
 */
export function formatScheduleSummary(schedule: Schedule): string {
  if (schedule == null || typeof schedule !== 'object') {
    return '';
  }
  const weekdays = normaliseWeekdays(schedule.weekdays);
  // Times pass through verbatim (`HH:mm` per the schema; no parsing, no
  // reformatting — the formatter is deliberately not a validator). A missing
  // or non-string time renders as the empty string rather than throwing.
  const start = typeof schedule.startTime === 'string' ? schedule.startTime : '';
  const end = typeof schedule.endTime === 'string' ? schedule.endTime : '';
  const timePart = `${start}${EN_DASH}${end}`;
  const days = weekdayPart(weekdays);
  if (days === '') {
    // Empty (or fully malformed) weekdays -> time only: `09:00–17:00`.
    return timePart;
  }
  return `Every ${days}, ${timePart}`;
}