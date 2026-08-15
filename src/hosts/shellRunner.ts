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
import type { WriteResult } from '../native/specs/NativeShellRunnerSpec';

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

// Re-export the envelope type so the 1.6 domain layer imports it from the port,
// not from the spec — keeps the port as the sole import surface (AD-5).
export type { WriteResult };