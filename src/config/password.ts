/**
 * `hashPassword` + `PASSWORD_MIN_LENGTH` — the single-purpose hashing helper
 * and the one validation constant reused by Story 3-3 (change-password) later
 * (Story 3.1).
 *
 * Salt-free SHA-256 by design (AD-9, epic-3-context): this is a self-
 * discipline speed bump, not tamper-proof security — a determined admin can
 * still `sudo vim /etc/hosts`. The hash is stored as `passwordHash` in
 * `config.json` (64-char hex digest); plaintext is never persisted.
 *
 * Hashing/validation stays in the JS layer: ConfigStore native is a dumb
 * string-file adapter and never sees hashing or `passwordHash` validation
 * (the spec's Never clause — pushing either into native would tighten
 * `readConfig`'s resilience validators and break missing/pre-Epic-3 configs).
 */

import { sha256 } from './sha256';

/**
 * Minimum password length. Enforced by the UI (`SetPassword`) via live
 * inline validation; the store's `setPassword` does NOT re-enforce length —
 * the UI gate is the clean-input contract that disables submit until the
 * entry is long enough + matches the confirm field. Single source of truth
 * so Story 3-3's change-password form reuses the same constant.
 */
export const PASSWORD_MIN_LENGTH = 6;

/**
 * Hash a plaintext password with salt-free SHA-256. Returns the 64-char
 * lowercase hex digest, which is what `setPassword` persists as
 * `committed.passwordHash` in `config.json`.
 *
 * The plaintext is used only inside this call — never logged, never stored,
 * never retained beyond the field lifecycle (the spec's Never clause).
 */
export function hashPassword(pw: string): string {
  return sha256(pw);
}