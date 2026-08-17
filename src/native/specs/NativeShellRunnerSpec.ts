/**
 * TurboModule TS spec for NativeShellRunner (Story 1.5).
 *
 * This file is BOTH the codegen input and the JS-side contract. App-level
 * codegen (see `codegenConfig` in package.json: name `FrosthaltSpecs`,
 * type `modules`, jsSrcsDir `src/native/specs`) reads this spec and generates
 * the native `<NativeShellRunnerSpecSpec>` protocol header that the Obj-C++
 * glue in `macos/Frosthalt-macOS/NativeShellRunner.mm` conforms to.
 *
 * ShellRunner is the ONLY module in the app that elevates (AD-3). It owns the
 * privileged write to `/etc/hosts` + the hosts-line contract enforcement. It
 * also owns the UNPRIVILEGED read of the managed section (`readHostsSection`,
 * added in Story 1.7 — `/etc/hosts` is world-readable, so no `osascript`). The
 * two methods here are `writeHosts(lines)` (privileged, async — runs exactly one
 * `osascript ... with administrator privileges` per call, batching backup ->
 * full managed-section rewrite -> restore owner/mode -> DNS flush, off the main
 * thread, resolving a JS Promise) and `readHostsSection()` (unprivileged,
 * synchronous — mirrors `ConfigStore.readConfig`'s sync read pattern; a tiny
 * world-readable file, microseconds) (AD-3 / AD-4 / NFR-8).
 *
 * The `lines` argument is the ALREADY-NORMALISED hosts payload — apex + `www.`
 * on `0.0.0.0` + `::`, lowercase (AD-4). Producing those lines from a domain
 * list is Story 1.6's `normaliseDomain` + effective-blocklist computation; this
 * module does NOT do that. It DOES validate each line against the strict
 * hosts-line regex on the native side BEFORE any elevation (defence-in-depth,
 * layer 1 — see ShellRunner.swift), so a malformed line resolves
 * `{ ok: false, error: "invalid-lines" }` with no admin prompt and `/etc/hosts`
 * untouched.
 *
 * Every native method returns the uniform `{ ok, error? }` envelope over JSI
 * (Consistency Conventions / Error shape). The Promise ALWAYS resolves, never
 * rejects — errors ride inside the envelope (consistent with ConfigStore's
 * never-throw, AC: "the Promise always resolves, never rejects").
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Uniform result envelope for `writeHosts`.
 *
 * - `ok` is always present.
 * - `error` is present only when `ok === false`:
 *   - `"invalid-lines"` — a line failed the hosts-line regex; NO admin prompt
 *     fired and `/etc/hosts` is untouched (defence-in-depth layer 1).
 *   - `"admin-denied"` — the user cancelled the OS admin prompt; the batched
 *     script never ran so `/etc/hosts` is unchanged.
 *   - `"<detail>"` — any other OS error (backup/splice/chown failure); the
 *     backup + atomic-rewrite path leaves `/etc/hosts` unchanged.
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility:
 * codegen treats an exported object type alias as a value struct and emits the
 * matching native record/protocol. Note this is a Promise-resolved shape, not
 * a synchronous return — codegen maps `Promise<WriteResult>` to an async
 * TurboModule method with explicit resolve/reject blocks (see
 * NativeShellRunner.mm).
 */
export type WriteResult = {
  ok: boolean;
  error?: string;
};

/**
 * Uniform result envelope for `readHostsSection` (Story 1.7).
 *
 * `readHostsSection` is SYNCHRONOUS and UNPRIVILEGED (no `osascript` —
 * `/etc/hosts` is world-readable `0644`), mirroring `ConfigStore.readConfig`'s
 * sync read pattern. It extracts the body lines of the managed
 * `# BEGIN FROSTHALT` ... `# END FROSTHALT` section (excluding the marker lines
 * themselves) without elevating.
 *
 * - `ok` is always present.
 * - `section`:
 *   - `string[]` — markers found, body lines captured (the lines strictly
 *     between the begin and end markers, in file order). Compared opaquely
 *     (array equality) by the JS `computeDrift` comparator — the JS side NEVER
 *     parses markers.
 *   - `null` — no markers found (the managed section is absent). Distinct from
 *     an empty body: an absent section has NO markers; a present-but-empty
 *     section has markers with zero lines between them.
 *   - Absent on `ok === false` (the field is only meaningful when `ok === true`).
 * - `error` is present only when `ok === false`:
 *   - `"hosts-unreadable"` — `/etc/hosts` itself could not be read.
 *   - `"markers-mismatch"` — the managed-section markers are corrupt (unpaired
 *     or duplicated, or end-before-begin). Refused before any comparison so a
 *     corrupt hosts is never silently treated as an in-sync empty body.
 *
 * Declared as a `type` alias (not an interface) for codegen compatibility, same
 * as `WriteResult`. Codegen maps a sync object return type to an `NSDictionary *`
 * TurboModule method (see NativeShellRunner.mm's `readHostsSection`). `section`
 * is `string[] | null`: the native side returns an `NSArray` of `NSString`s for
 * the present case and `NSNull()` for the absent case (bridging `null` over JSI).
 */
export type ReadSectionResult = {
  ok: boolean;
  section?: string[] | null;
  error?: string;
};

export interface Spec extends TurboModule {
  /**
   * Rewrites the managed `# BEGIN FROSTHALT` ... `# END FROSTHALT` section of
   * `/etc/hosts` with the given lines, using exactly one
   * `osascript ... with administrator privileges` call that batches:
   *
   *   1. `cp /etc/hosts /etc/hosts.fh.bak`            (backup)
   *   2. full-section rewrite (splice the markers + `lines`; preserve
   *      everything outside; never incremental)
   *   3. `chown root:wheel` + `chmod 644`             (restore owner/mode)
   *   4. `dscacheutil -flushcache` + `killall -HUP mDNSResponder` (DNS flush)
   *
   * Threading: the privileged call runs off the main thread; the JS Promise
   * resolves on completion; the UI never blocks (NFR-8).
   *
   * Validation: each line is validated against the strict hosts-line regex
   * `^(0\.0\.0\.0|::)\s+[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` (after trim +
   * lowercase) BEFORE any elevation. A failure resolves
   * `{ ok: false, error: "invalid-lines" }` with no prompt and `/etc/hosts`
   * untouched. Validated lines reach the privileged script only via a quoted
   * heredoc (`<<'FROSTHALT'`) inside a temp shell script whose mktemp path is
   * the sole thing in the `osascript` command string — never string-interpolated
   * user content (defence-in-depth layer 2, NFR-5).
   *
   * Empty `lines` (`[]`) writes the markers with no domain lines between them
   * -> unblocks all. Resolves `{ ok: true }`.
   */
  writeHosts(lines: string[]): Promise<WriteResult>;

  /**
   * Reads the managed `# BEGIN FROSTHALT` ... `# END FROSTHALT` section of
   * `/etc/hosts` UNPRIVILEGED + SYNCHRONOUSLY (Story 1.7).
   *
   * `/etc/hosts` is world-readable (`0644`), so this needs NO `osascript`
   * elevation — it is a plain `String(contentsOfFile: "/etc/hosts")` read on
   * the calling JSI thread, exactly mirroring `ConfigStore.readConfig`'s sync
   * read pattern (a tiny file, microseconds). No `backgroundQueue`.
   *
   * Extraction reuses the same unprivileged read + the same marker regexes that
   * the privileged `writeHosts` pre-scan uses (`ShellRunner.swift`'s
   * `markerCounts` + `beginMarkerRegex`/`endMarkerRegex`) — the marker format's
   * single source of truth stays native. The JS side NEVER parses markers: this
   * method returns the body lines (between the markers) opaquely, and the JS
   * `computeDrift` comparator does array equality.
   *
   * Returns a `ReadSectionResult` synchronously (codegen maps a sync object
   * return to an `NSDictionary *` method, not a resolve/reject-block async
   * method):
   *   - `{ ok: true, section: [...lines] }`  markers found, body captured
   *     (excluding the marker lines, in file order)
   *   - `{ ok: true, section: null }`        no markers (managed section absent)
   *   - `{ ok: false, error: "hosts-unreadable" }` /etc/hosts itself unreadable
   *   - `{ ok: false, error: "markers-mismatch" }` markers corrupt (unpaired /
   *     duplicated / end-before-begin) — refused before any comparison so a
   *     corrupt hosts is never silently treated as an in-sync empty body
   *
   * The marker-mismatch contract is identical to `writeHosts`'s pre-scan: the
   * only accepted states are zero markers (absent) or exactly one clean pair;
   * everything else is `markers-mismatch`.
   */
  readHostsSection(): ReadSectionResult;
}

/**
 * JS-side handle to the native module. `getEnforcing` throws if the module is
 * not registered in the native binary — that is a build/link failure, not a
 * runtime user error, and is the right thing to surface loudly.
 */
export default TurboModuleRegistry.getEnforcing<Spec>('NativeShellRunner');