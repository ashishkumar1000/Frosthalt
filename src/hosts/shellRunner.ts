/**
 * Stateless typed JS port over the NativeShellRunner TurboModule (Story 1.5).
 *
 * This is the ONLY surface the 1.6 domain layer (and nothing else) should call
 * for the privileged `/etc/hosts` write (AD-5 — the domain is the sole caller
 * of `ShellRunner.writeHosts`; AD-3 — ShellRunner is the only module that
 * elevates). The native module owns the osascript batch + hosts-line contract
 * enforcement; this port is a thin typed pass-through that is the stable import
 * surface + the Jest mock seam (mock the spec default export, not this file).
 *
 * Strictly stateless: no effective-blocklist computation, no Apply pipeline, no
 * serialization/queue, no Zustand — all of that is Story 1.6. 1.5 is the native
 * write capability + this thin port only.
 *
 * No `child_process`/`fs`/`os` imports (AD-1) — shell/file I/O is native-only.
 */

import NativeShellRunner from '../native/specs/NativeShellRunnerSpec';
import type { WriteResult, ReadSectionResult } from '../native/specs/NativeShellRunnerSpec';

/**
 * Rewrites the managed `# BEGIN/END FROSTHALT` section of `/etc/hosts` with the
 * given lines via one privileged `osascript` batch (backup -> full-section
 * rewrite -> restore owner/mode -> DNS flush), off the main thread.
 *
 * Pass-through: the `lines` argument is forwarded verbatim to the native
 * module, and the native `{ ok, error? }` envelope is returned. The Promise
 * ALWAYS resolves, never rejects — errors ride inside the envelope
 * (`ok:false` + `error`), consistent with ConfigStore's never-throw contract.
 *
 * If the native call itself throws (a wiring/JSI failure, not a normal outcome
 * — the native impl resolves rather than rejects), that is reported as
 * `{ ok: false, error }` rather than re-thrown, so a caller awaiting this port
 * never sees an unhandled rejection.
 *
 * Envelope guard: the native contract is a uniform `{ ok, error? }` object. A
 * native regression that resolves `null`/`undefined`/a non-envelope would make
 * a caller's `result.ok` access throw — so a malformed return is coerced to
 * `{ ok: false, error: "bad-envelope" }` (parallel to ConfigStore's null-guard
 * before `.ok`/`.data`). A valid envelope is returned as-is.
 *
 * `lines` MUST already be normalised (apex + `www.` on `0.0.0.0` + `::`,
 * lowercase) — producing them from a domain list is 1.6's `normaliseDomain`.
 * The native side re-validates each line against the strict hosts-line regex
 * before any elevation, so a malformed line resolves
 * `{ ok: false, error: "invalid-lines" }` with no admin prompt.
 */
export async function writeHosts(
  lines: string[],
): Promise<WriteResult> {
  let result: unknown;
  try {
    result = await NativeShellRunner.writeHosts(lines);
  } catch (e) {
    // The native contract is "always resolve, never reject" — a throw here is a
    // wiring/JSI failure, not a normal result. Surface it as { ok:false, error }
    // so the caller never sees an unhandled rejection (parallel to
    // ConfigStore's writeConfig catch).
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Shape-guard the envelope BEFORE handing it back, so a malformed native
  // return (null/undefined/non-object/missing boolean `ok`) never crashes a
  // caller reading `.ok` (parallel to ConfigStore's `result == null` guard).
  if (
    result == null ||
    typeof result !== 'object' ||
    typeof (result as { ok?: unknown }).ok !== 'boolean'
  ) {
    return { ok: false, error: 'bad-envelope' };
  }
  return result as WriteResult;
}

/**
 * Reads the managed `# BEGIN/END FROSTHALT` section of `/etc/hosts`
 * UNPRIVILEGED + SYNCHRONOUSLY (Story 1.7).
 *
 * `/etc/hosts` is world-readable (`0644`), so this needs NO `osascript` — it is
 * a plain sync read on the calling JSI thread, mirroring `ConfigStore.readConfig`'s
 * sync read pattern (a tiny file, microseconds). No `backgroundQueue`.
 *
 * Pass-through: the native `ReadSectionResult` envelope is returned. The native
 * side returns the body lines between the markers (excluding the markers) as an
 * opaque `string[]`, `null` when the section is absent, or an `ok:false` error
 * (`hosts-unreadable` / `markers-mismatch`). The JS comparator (`computeDrift`)
 * treats the body lines opaquely (array equality) — it NEVER parses markers.
 *
 * If the native call itself throws (a wiring/JSI failure — not a normal outcome),
 * it is reported as `{ ok: false, error }` rather than re-thrown, so a caller
 * never sees an unhandled exception (parallel to `readConfig`'s catch).
 *
 * Envelope guard: the native contract is a uniform `{ ok, section?, error? }`
 * object. A malformed return (null/undefined/non-object/missing boolean `ok`,
 * or a `section` that is neither null nor a string array when `ok:true`) is
 * coerced to `{ ok: false, error: "bad-envelope" }` so a caller reading `.ok` /
 * `.section` never crashes on a native regression (parallel to `writeHosts`'s
 * shape-guard, extended for the `section` field).
 */
export function readHostsSection(): ReadSectionResult {
  let result: unknown;
  try {
    result = NativeShellRunner.readHostsSection();
  } catch (e) {
    // The native contract is "never throw" — a throw here is a wiring/JSI
    // failure, not a normal result. Surface it as { ok:false, error } so the
    // caller never sees an unhandled exception (parallel to readConfig's catch).
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Shape-guard the envelope BEFORE handing it back, so a malformed native
  // return (null/undefined/non-object/missing boolean `ok`) never crashes a
  // caller reading `.ok` (parallel to writeHosts's `bad-envelope` guard).
  if (
    result == null ||
    typeof result !== 'object' ||
    typeof (result as { ok?: unknown }).ok !== 'boolean'
  ) {
    return { ok: false, error: 'bad-envelope' };
  }

  const env = result as ReadSectionResult;

  // When ok:true, `section` MUST be null (absent) or a string[] (present body).
  // A non-array, non-null `section` — including `undefined` (a missing key) —
  // (or an array with non-string elements) is a native regression — coerce to
  // bad-envelope so the comparator's array equality never crashes on a
  // non-string element (extended shape-guard for the read path; writeHosts has
  // no `section` field). The strict `!== null` check (not loose `!= null`)
  // ensures `undefined` is coerced, not silently forwarded as "absent".
  if (env.ok) {
    if (env.section !== null) {
      if (!Array.isArray(env.section)) {
        return { ok: false, error: 'bad-envelope' };
      }
      for (const el of env.section) {
        if (typeof el !== 'string') {
          return { ok: false, error: 'bad-envelope' };
        }
      }
    }
  }

  return env;
}

// Re-export the envelope types so the 1.6/1.7 domain layer imports them from the
// port, not from the spec — keeps the port as the sole import surface (AD-5).
export type { WriteResult, ReadSectionResult };