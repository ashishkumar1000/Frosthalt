---
title: 'ShellRunner TurboModule and hosts-file contract'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 1
baseline_commit: '56ee6eeff0a73ba5b60292f346edfa3d94966764'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Frosthalt-2026-08-13/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no privileged path to `/etc/hosts` yet — every later epic (the Apply pipeline, drift/Restore) needs one module that elevates exactly once per Apply to rewrite the managed `# BEGIN/END FROSTHALT` section, and Hermes has no shell at runtime so elevation must go through a native adapter.

**Approach:** Build the privileged `ShellRunner` TurboModule — a TS spec → codegen → Obj-C++ + Swift adapter whose single `writeHosts(lines)` method runs one `osascript … with administrator privileges` that batches backup → full-section rewrite → restore owner/mode → DNS flush, off the main thread, resolving a JS Promise. Plus the hosts-line contract (format + strict validation + quoted-heredoc insertion) and a thin typed JS port that is the sole import surface for the 1.6 domain layer. No effective-blocklist computation, no Apply pipeline, no UI (those land in 1.6).

## Boundaries & Constraints

**Always:**
- Exactly one `osascript -e 'do shell script "…" with administrator privileges'` per `writeHosts` call, batching in strict order: `cp /etc/hosts /etc/hosts.fh.bak` → full-section rewrite of `# BEGIN FROSTHALT`…`# END FROSTHALT` (preserve everything outside; never incremental) → `chown root:wheel` + `chmod 644` → `dscacheutil -flushcache` + `killall -HUP mDNSResponder`.
- Block targets are `0.0.0.0` (IPv4) + `::` (IPv6) — never `127.0.0.1`/`::1`. Each domain emits apex + `www.` = 4 lines, lowercase. (This is the *contract*; producing lines from a domain list is 1.6's `normaliseDomain`.)
- Injection safety, two layers: (1) every line is validated against the strict hosts-line regex `^(0\.0\.0\.0|::)\s+[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` (after trim + lowercase) BEFORE any elevation — a failure resolves `{ok:false, error:"invalid-lines"}` with no prompt and `/etc/hosts` untouched; (2) the validated lines reach root only via a **data-only** temp file (`LINES_FILE`, app-written mode `0600`) that `awk` reads and prints — never executes or sources; the `osascript … with administrator privileges` command string is a **static** script body (backup → splice → `chown`/`chmod` → flush) containing no user content, only the system-generated `LINES_FILE` path, and it is carried base64-encoded so no AppleScript string quoting is needed. No user-writable file is ever executed as root, so a same-user attacker who swaps `LINES_FILE` can at worst inject a hosts *line* (bounded, data-only), never root *code*.
- The privileged call runs off the main thread (`dispatch_async` to a background queue); the JS Promise resolves on completion; the UI never blocks.
- Every method returns the `{ok, error?}` envelope over JSI; the Promise always resolves, never rejects — errors ride inside the envelope (consistent with ConfigStore's never-throw).
- AD-1: no `child_process`/`fs`/`os` imports anywhere in `src/` — shell/file I/O is native-only. AD-2: no legacy `RCT_EXPORT_MODULE` *bridge* module — the `.mm` conforms to the codegen TurboModule spec.

**Ask First:**
- Any deviation from the single-osascript batched order above, or any design that introduces a second admin prompt per `writeHosts`.

**Never:**
- No effective-blocklist computation, no `normaliseDomain`, no Apply pipeline, no serialization/queue, no Zustand, no Apply-button wiring, no toast — all 1.6. 1.5 is the native write capability + TS spec + thin port only.
- No `readHostsSection`/`restoreSection` — those land in 1.7 (drift / Restore section). 1.5 is write-only.
- No incremental `/etc/hosts` edits — always full-section rewrite.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path (one domain) | `writeHosts(["0.0.0.0 example.com",":: example.com","0.0.0.0 www.example.com",":: www.example.com"])` | One admin prompt; managed section rewritten with the 4 lines; outside preserved; `root:wheel`+`0644`; DNS flushed; resolves `{ok:true}` | N/A |
| No existing section | first write, no `# BEGIN/END FROSTHALT` markers yet | Section appended; existing hosts content preserved; resolves `{ok:true}` | N/A |
| Empty blocklist | `writeHosts([])` | Section written with markers only (no domain lines) → unblocks all; resolves `{ok:true}` | N/A |
| Invalid lines | a line like `"0.0.0.0 ; rm -rf /"` or `"127.0.0.1 x"` | Resolves `{ok:false, error:"invalid-lines"}` | No elevation; `/etc/hosts` untouched |
| Admin denied | user cancels the admin prompt | Resolves `{ok:false, error:"admin-denied"}` | `/etc/hosts` unchanged (script never ran) |
| Hard OS error | backup/splice/chown failure | Resolves `{ok:false, error:"<detail>"}` | `/etc/hosts` unchanged via backup + atomic rewrite |

</frozen-after-approval>

## Code Map

- `src/native/specs/NativeShellRunnerSpec.ts` -- NEW. TS spec (codegen input + JS contract): `type WriteResult = { ok: boolean; error?: string }`, `interface Spec extends TurboModule { writeHosts(lines: string[]): Promise<WriteResult> }`, `export default TurboModuleRegistry.getEnforcing<Spec>('NativeShellRunner')`. Write-only — `readHostsSection`/`restoreSection` deferred to 1.7. Template: `src/native/specs/NativeConfigStoreSpec.ts:37-65`.
- `src/hosts/shellRunner.ts` -- NEW. Thin typed port: `writeHosts(lines: string[]): Promise<WriteResult>` pass-through to the spec default export. Stable import surface + Jest mock seam for the 1.6 domain layer (which is the SOLE allowed caller — AD-5). Parallel: `src/config/configStore.ts:36`.
- `macos/Frosthalt-macOS/NativeShellRunner.mm` -- NEW. Obj-C++ TurboModule glue: `RCT_EXPORT_MODULE(NativeShellRunner)`, class `NativeShellRunnerModule : NativeShellRunnerSpecSpecBase <NativeShellRunnerSpecSpec>`, `getTurboModule:` → `std::make_shared<facebook::react::NativeShellRunnerSpecSpecJSI>(params)`, delegates `writeHosts:resolve:reject:` to Swift via `#import "Frosthalt-Swift.h"`. Template: `macos/Frosthalt-macOS/NativeConfigStore.mm:30-97`. AD-2.
- `macos/Frosthalt-macOS/ShellRunner.swift` -- NEW. `@objc(NativeShellRunner) final class ShellRunner: NSObject`. `writeHosts(_ lines: [String], resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)`: validate each line against the hosts-line regex → on failure resolve `{ok:false, error:"invalid-lines"}` (no elevation); pre-scan `/etc/hosts` markers (tolerant match) and on an unpaired/duplicated managed section resolve `{ok:false, error:"markers-mismatch"}` (no elevation, no silent truncation); else write the validated lines to a **data-only** `LINES_FILE` (mode `0600`) and dispatch the privileged call to a background `dispatch_queue`, where `runOsaScript` runs ONE `osascript … with administrator privileges` whose command string is a **base64-encoded static body** (backup → awk full-section splice reading `LINES_FILE` → `chown root:wheel`+`chmod 644` → DNS flush) — no user-writable file is executed as root. Resolve `{ok:true}` on success, `{ok:false, error:"admin-denied"}` on user-cancel (exact AppleScript error code `-128`, not substring), `{ok:false, error:"<detail>"}` (single-line) on other errors. Always resolve, never reject. Template: `macos/Frosthalt-macOS/ConfigStore.swift:27-83`.
- `macos/Frosthalt-macOS/AppDelegate.mm` -- EDIT. Add an `else if (strcmp(name, "NativeShellRunner") == 0)` branch to `getModuleProvider:` (L76-83) returning `NSClassFromString(@"NativeShellRunnerModule") ? [NSClassFromString(@"NativeShellRunnerModule") new] : nil`. This is the registration hook that makes `TurboModuleRegistry.getEnforcing('NativeShellRunner')` resolve — without it the module is invisible (verified on 1.4).
- `macos/Frosthalt.xcodeproj/project.pbxproj` -- EDIT (Xcode, manual). Add `NativeShellRunner.mm` + `ShellRunner.swift` to PBXGroup `Frosthalt-macOS` (L70-86) + the `PBXSourcesBuildPhase` (L329-346). `pod install` does NOT add app-target files — manual Xcode step.
- `__tests__/shellRunner.test.ts` -- NEW. `jest.mock('../native/specs/NativeShellRunnerSpec', …)`; assert the port passes `lines` through and forwards the envelope (ok / invalid-lines / admin-denied). Establishes the 1.6 mock seam. Template: `__tests__/configStore.test.ts:21`.
- `package.json:14-18` -- REUSE, unchanged. The existing `codegenConfig` (name `FrosthaltSpecs`, jsSrcsDir `src/native/specs`) auto-discovers the new spec on next codegen; no change needed.

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeShellRunnerSpec.ts` -- author the TurboModule TS spec (`writeHosts(lines): Promise<WriteResult>`, `getEnforcing('NativeShellRunner')`) -- codegen input + JS contract.
- [x] `src/hosts/shellRunner.ts` -- thin typed port (pass-through + 1.6 mock seam).
- [x] `macos/Frosthalt-macOS/ShellRunner.swift` -- Swift impl: hosts-line regex validation, data-only `LINES_FILE` (0600) + base64-carried static splice body (backup→rewrite→chown/chmod→flush, no user-writable file executed as root), pre-elevation marker scan, off-main-thread dispatch, exact `-128` admin-denied detection, always-resolve `{ok,error?}` envelope.
- [x] `macos/Frosthalt-macOS/NativeShellRunner.mm` -- Obj-C++ glue (template from `NativeConfigStore.mm`): `getTurboModule:` + `RCT_EXPORT_MODULE(NativeShellRunner)` + Swift delegate.
- [x] `macos/Frosthalt-macOS/AppDelegate.mm` -- add the `NativeShellRunner` branch to `getModuleProvider:`.
- [x] `__tests__/shellRunner.test.ts` -- mock the spec, assert port pass-through + envelope forwarding.
- [x] `macos/Frosthalt.xcodeproj/project.pbxproj` -- add the `.mm`/`.swift` to the macOS target in Xcode -- **manual Xcode step, outside the node sandbox**; required to compile/link.

**Acceptance Criteria:**
- Given a clean checkout, when `cd macos && pod install` then `pnpm macos` run, then the app builds — codegen generates the `NativeShellRunner` spec header and the Swift/Obj-C++ compile and link (after the new files are added to the target in Xcode).
- Given a valid 4-line set for one domain, when `writeHosts(lines)` is called, then exactly one admin prompt fires and the `# BEGIN/END FROSTHALT` section in `/etc/hosts` contains apex + `www.` on `0.0.0.0` + `::`, everything outside is preserved, `root:wheel` + `0644` restored, DNS flushed, and the Promise resolves `{ok:true}`.
- Given a line that fails the hosts-line regex, when `writeHosts` is called, then NO admin prompt fires and the Promise resolves `{ok:false, error:"invalid-lines"}` with `/etc/hosts` untouched.
- Given the user cancels the admin prompt, when `writeHosts` is called, then the Promise resolves `{ok:false, error:"admin-denied"}` and `/etc/hosts` is unchanged.
- Given any `writeHosts` call, then it runs off the main thread and the UI does not block on it.
- Given the 1.6 domain layer, then ShellRunner is reachable only via the `src/hosts/shellRunner` port and the native module is the sole elevation point in the app (AD-3/AD-5).

## Spec Change Log

- 2026-08-16 (review loop 1): Revised the injection-safety design (frozen "Always" bullet 2 + Code Map + Design Notes) after Step-4 review found a privilege-escalation. The original design put the validated lines in a quoted heredoc inside a temp shell script whose path was the sole `osascript` argument — meaning root executed a user-writable file, and the swap window included the entire admin-password typing time (seconds) → arbitrary root code execution by any same-user process. New design: the validated lines live in a data-only `LINES_FILE` (app-written, `0600`) that `awk` reads/prints, never executes; the `do shell script … with administrator privileges` string is a base64-encoded **static** body (no user content, only the system-generated `LINES_FILE` path) so no user-writable file is ever run as root — a `LINES_FILE` swap is bounded to a hosts *line*, never root *code*. Approved by human. Implementation re-applied with 13 folded patches (marker-robust awk + no-prompt `markers-mismatch` guard, stdout drain, exact `-128` cancel detection, non-string element guard, port envelope guard + test, `nil`→`invalid-lines`, single-line error detail, bg-queue build, UUID temp path, unused-`reject` comment); re-verified.

## Design Notes

- **Why `writeHosts(lines)`, not `writeHosts(domains)`:** parallel to ConfigStore being a dumb string adapter (AD-11). The domain layer (1.6) owns `normaliseDomain` + effective-blocklist + apex+www/`0.0.0.0`+`::` line production; ShellRunner owns the privileged write + the hosts-line contract enforcement. This keeps the privileged module isolated and lets the port be Jest-tested by mocking the spec.
- **Defence-in-depth injection safety:** layer 1 — the hosts-line regex `^(0\.0\.0\.0|::)\s+[a-z0-9]([a-z0-9.-]*[a-z0-9])?$` (trim + lowercase first) rejects anything that isn't a `target hostname` pair, so `"; rm -rf /"` never reaches the data file; layer 2 — the app writes the validated lines directly to a data-only `LINES_FILE` (mode `0600`, no shell involvement), and the `do shell script … with administrator privileges` command string is a **base64-encoded static** body that only references `LINES_FILE`'s system-generated path — the file is `awk`-read and printed, never executed or sourced by root. No user-writable file is run as root, so even a hypothetical regex escape or a `LINES_FILE` swap is bounded to a hosts *line*, never root *code*. (The original design ran a user-writable temp script as root — a local priv-esc found in Step-4 review; revised in review loop 1.) The hostname-level normalisation regex (apex + `www.`, lowercase) is 1.6's `normaliseDomain`, a separate concern.
- **Golden example — one domain `example.com`:** lines = `["0.0.0.0 example.com", ":: example.com", "0.0.0.0 www.example.com", ":: www.example.com"]`; managed section:
  ```
  # BEGIN FROSTHALT
  0.0.0.0 example.com
  :: example.com
  0.0.0.0 www.example.com
  :: www.example.com
  # END FROSTHALT
  ```
- **Admin-denied detection:** `osascript` cancellation surfaces as an `NSError` (e.g. `errAEEventNotHandled` / `-128`); map that to `error:"admin-denied"`, other errors to `error:"<detail>"`. The denied case never runs the batched script, so `/etc/hosts` is untouched by construction.
- **Port placement:** `src/hosts/shellRunner.ts` (adapter) is deliberately separate from the 1.6 `src/domain/` (Apply pipeline) — ports & adapters keeps the privileged adapter out of the domain hub.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: exit 0 (spec + port typecheck against react-native-macos types via the tsconfig `paths` alias).
- `pnpm test --watchman=false -- shellRunner` -- expected: the `shellRunner` suite passes (port pass-through + envelope forwarding with the spec mocked).

**Manual checks (native — run outside the node sandbox):**
- `cd macos && pod install` then `pnpm macos` -- expected: build succeeds; codegen generates the `NativeShellRunner` spec header; `ShellRunner.swift` + `NativeShellRunner.mm` compile and link (after the files are added to the target in Xcode).
- On a running app (or a one-line JS driver): `writeHosts(["0.0.0.0 example.com",":: example.com","0.0.0.0 www.example.com",":: www.example.com"])` → approve the prompt → `# BEGIN/END FROSTHALT` appears in `/etc/hosts` with the 4 lines, outside content preserved, `ls -l /etc/hosts` shows `root:wheel` `-rw-r--r--`; deny the prompt → `{ok:false, error:"admin-denied"}`, `/etc/hosts` unchanged; pass a bad line (`"0.0.0.0 ; rm -rf /"`) → no prompt, `{ok:false, error:"invalid-lines"}`, `/etc/hosts` unchanged. **Back up `/etc/hosts` yourself before testing and restore it after.**

## Suggested Review Order

Read top-down by concern — the privileged path first, then the injection-safety layers, then the glue, then the JS surface, then tests. Links are relative to this spec's directory; Cmd/Ctrl-click a path to open it at the line.

1. [../../macos/Frosthalt-macOS/ShellRunner.swift:159](../../macos/Frosthalt-macOS/ShellRunner.swift) — entry point: validate each line, scan markers, write LINES_FILE, dispatch the privileged call.
2. [../../macos/Frosthalt-macOS/ShellRunner.swift:71](../../macos/Frosthalt-macOS/ShellRunner.swift) — layer 1: strict hosts-line regex rejects non-`target host` input before any elevation.
3. [../../macos/Frosthalt-macOS/ShellRunner.swift:97](../../macos/Frosthalt-macOS/ShellRunner.swift) — pre-elevation marker scan; tolerant regex kept in sync with the awk splice.
4. [../../macos/Frosthalt-macOS/ShellRunner.swift:250](../../macos/Frosthalt-macOS/ShellRunner.swift) — data-only LINES_FILE written 0600 in one step; awk prints, never executes.
5. [../../macos/Frosthalt-macOS/ShellRunner.swift:301](../../macos/Frosthalt-macOS/ShellRunner.swift) — static base64 body: backup, awk full-section splice, chown/chmod, flush — no user content.
6. [../../macos/Frosthalt-macOS/ShellRunner.swift:374](../../macos/Frosthalt-macOS/ShellRunner.swift) — single osascript run; exact `(-128)` admin-denied; single-line error detail.
7. [../../macos/Frosthalt-macOS/NativeShellRunner.mm:56](../../macos/Frosthalt-macOS/NativeShellRunner.mm) — JSI glue: `getTurboModule:`; nil/non-string input guarded to `invalid-lines` (L95-104).
8. [../../macos/Frosthalt-macOS/AppDelegate.mm:81](../../macos/Frosthalt-macOS/AppDelegate.mm) — `getModuleProvider:` branch that makes the module visible to JS.
9. [../../src/native/specs/NativeShellRunnerSpec.ts:56](../../src/native/specs/NativeShellRunnerSpec.ts) — TS spec: `WriteResult` envelope + `writeHosts` signature; the codegen input.
10. [../../src/hosts/shellRunner.ts:48](../../src/hosts/shellRunner.ts) — typed port: pass-through + `bad-envelope` shape guard; sole 1.6 import surface.
11. [../../__tests__/shellRunner.test.ts:56](../../__tests__/shellRunner.test.ts) — port tests: pass-through, envelope forwarding, `bad-envelope` coercion.
12. [../../macos/Frosthalt.xcodeproj/project.pbxproj:19](../../macos/Frosthalt.xcodeproj/project.pbxproj) — Xcode target membership for the new `.swift`/`.mm` (manual step).
13. [../../macos/Frosthalt-macOS-Bridging-Header.h:9](../../macos/Frosthalt-macOS-Bridging-Header.h) — bridging header lets Swift name the RCT promise block types.

> **Note on status:** the spec frontmatter stays `in-review` (not `done`) and the sprint entry is `review` — the two native acceptance criteria (codegen compile + live `/etc/hosts` write) are still pending the manual `pod install && pnpm macos` build. Flip to `done` once that build + the live write checks pass.