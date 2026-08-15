/**
 * Stateless typed JS port over the NativeConfigStore TurboModule (Story 1.4).
 *
 * This is the ONLY surface application code should call for config I/O. It owns
 * JSON parse/serialize and the missing/corrupt -> empty resilience rule (AC 3);
 * the native module is a dumb string-file adapter (AD-11) and knows no shape.
 *
 * Strictly stateless: no in-memory mirror, no subscribers, no staged-edits
 * buffer — those are the Zustand domain layer in Story 1.6. This port is in 1.4
 * (not 1.6) precisely so AC 3 resilience is implemented and Jest-verifiable
 * here by mocking the native spec.
 *
 * No `child_process`/`fs`/`os` imports (AD-1) — file I/O is native-only.
 */

import NativeConfigStore from '../native/specs/NativeConfigStoreSpec';
import { Config, DEFAULT_CONFIG } from './types';

/**
 * Reads and parses `config.json`. NEVER throws (AC 3).
 *
 * - native call throws -> `DEFAULT_CONFIG`
 * - native returns `null`/`undefined` (malformed envelope) -> `DEFAULT_CONFIG`
 * - native `{ ok: false, error }` -> `DEFAULT_CONFIG`
 * - native `{ ok: true, data: null }` (file missing) -> `DEFAULT_CONFIG`
 * - native `{ ok: true, data: "<json>" }` then `JSON.parse` throws (corrupt or
 *   empty file) -> `DEFAULT_CONFIG`
 * - parsed JSON is valid but not a Config object (`null`, `42`, `"hi"`, `[]`,
 *   `{}`) -> `DEFAULT_CONFIG`
 * - otherwise -> the parsed `Config`
 *
 * `data == null` is a loose-equality check on purpose: it covers both
 * `undefined` (field absent) and `null` (native explicitly returned null for a
 * missing file), matching the I/O Matrix "missing file" row.
 */
export function readConfig(): Config {
  let result;
  try {
    result = NativeConfigStore.readConfig();
  } catch {
    // Native call itself threw (module wiring failure / JSI error). Resilience
    // rule: never crash the app over config I/O — fall back to defaults.
    return DEFAULT_CONFIG;
  }

  // The native contract is `{ ok, error?, data? }`, but a misbehaving native
  // impl could return `null`/`undefined`. Guard the envelope BEFORE accessing
  // `.ok`/`.data` so a malformed return never throws (AC 3 — never throws).
  if (result == null) {
    return DEFAULT_CONFIG;
  }

  try {
    if (!result.ok || result.data == null) {
      return DEFAULT_CONFIG;
    }

    const parsed: unknown = JSON.parse(result.data);
    // Valid JSON is not necessarily a Config: `null`, `42`, `"hi"`, `[]`, or
    // `{}` all parse cleanly but are not a usable Config. A caller doing
    // `cfg.domains.push(...)` on such a return would crash. Reject anything
    // that is not a plain object, AND any object missing the three required
    // top-level keys in their expected types (domains/schedules arrays,
    // settings object). This is AC 3 corrupt->empty resilience, not domain
    // validation — element shapes (hostname format etc.) are Story 2.2.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return DEFAULT_CONFIG;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      !Array.isArray(obj.domains) ||
      !Array.isArray(obj.schedules) ||
      typeof obj.settings !== 'object' ||
      obj.settings === null
    ) {
      return DEFAULT_CONFIG;
    }
    return parsed as Config;
  } catch {
    // Corrupt or empty file — treat as empty (AC 3), do not crash.
    return DEFAULT_CONFIG;
  }
}

/**
 * Serializes and writes `config` atomically. HONEST about the outcome.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on an IO error
 * (the native adapter writes to a temp file then renames, so a failed write
 * leaves the existing `config.json` unchanged). The caller (the 1.6 Apply
 * pipeline) decides how to surface `error`.
 *
 * If the native call itself throws (wiring failure), that is reported as
 * `{ ok: false, error }` rather than re-thrown — the port never throws.
 */
export function writeConfig(config: Config): { ok: boolean; error?: string } {
  let serialized: string;
  try {
    serialized = JSON.stringify(config);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const result = NativeConfigStore.writeConfig(serialized);
    return { ok: result.ok, error: result.error };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
