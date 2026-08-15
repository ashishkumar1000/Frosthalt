/**
 * The full AR-15 config shape (Story 1.4, AC 2).
 *
 * This is the canonical `config.json` schema, camelCase. It is the revocable
 * source of truth (AD-5): domain intent lives here; the `/etc/hosts` managed
 * section is DERIVED enforcement state recomputed on Apply, never persisted
 * here.
 *
 * Story 1.4 only PERSISTS this shape (read/write via ConfigStore) — no domain
 * logic, no normalisation, no validation. Hostname normalisation/validation is
 * Story 2.2; the effective-blocklist computation is the 1.6 domain layer.
 */

/** A single blocked domain. `hostname` is the primary key. */
export interface Domain {
  /** Normalised lowercase apex hostname (PK). Story 2.2 owns normalisation. */
  hostname: string;
  /** When true, the domain is always in the effective blocklist (FR-3). */
  alwaysOn: boolean;
}

/** Weekday index: 0 = Monday .. 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A named weekly recurring block window (FR-11). */
export interface Schedule {
  /** Stable slug id (primary key). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Which weekdays the schedule is active. 0 = Mon .. 6 = Sun. */
  weekdays: Weekday[];
  /** Local-time start, `HH:mm` (24-hour). */
  startTime: string;
  /** Local-time end, `HH:mm` (24-hour). */
  endTime: string;
  /** Enable toggle (block-affecting per AD-6 — staged-then-Apply). */
  enabled: boolean;
}

/** App-level settings (non-block-affecting; commits directly per AD-6). */
export interface Settings {
  /** Off until the MenuBar TurboModule is wired in Epic 6. */
  menuBarEnabled: boolean;
}

/** A running focus session persisted as an absolute epoch (AD-7). */
export interface ActiveTimer {
  /** Absolute end time in epoch milliseconds (not a relative remaining). */
  endEpochMs: number;
  /** Hostnames selected for this session. */
  selectedDomains: string[];
}

/**
 * The top-level config object persisted as `config.json`.
 *
 * `passwordHash` is a salt-free SHA-256 hash (AD-9), Epic 3. `activeTimer` is
 * `null` when no session is running.
 */
export interface Config {
  passwordHash?: string;
  domains: Domain[];
  schedules: Schedule[];
  settings: Settings;
  activeTimer?: ActiveTimer | null;
}

/**
 * The config returned when the file is missing, corrupt, empty, or unreadable
 * (AC 3 — resilient read). Every field is the safe empty/default value.
 *
 * Returned BY REFERENCE from `readConfig`, so it is deep-frozen to make a
 * caller that does `readConfig().domains.push(...)` a no-op rather than a
 * silent corruption of every future return. The arrays and the `settings`
 * object are frozen; `activeTimer: null` and the unset `passwordHash` need no
 * freezing (primitives / absent).
 */
export const DEFAULT_CONFIG: Config = deepFreezeConfig({
  domains: [],
  schedules: [],
  settings: {
    menuBarEnabled: false,
  },
  activeTimer: null,
  // `passwordHash` intentionally unset — no password set until Epic 3.
});

/**
 * Freezes a `Config` and its mutable nested members (the `domains` and
 * `schedules` arrays and the `settings` object). Domain/schedule elements are
 * not frozen here — DEFAULT_CONFIG has none, and a config read from disk is
 * never frozen (callers may stage-edit it). This helper exists solely to
 * protect the shared DEFAULT_CONFIG singleton from mutation poisoning.
 */
function deepFreezeConfig(config: Config): Config {
  Object.freeze(config);
  Object.freeze(config.domains);
  Object.freeze(config.schedules);
  Object.freeze(config.settings);
  return config;
}
