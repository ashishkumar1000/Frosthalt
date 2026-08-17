---
title: 'Drift detection and user-initiated Restore section'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '885e02caa8fa5d07bf961ba3e78fbd6f6f830343'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-shellrunner-turbomodule-and-hosts-file-contract.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-staged-then-apply-serialized-pipeline-proven-on-one-domain.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** ShellRunner (1.5) writes the managed `/etc/hosts` section and the Apply pipeline (1.6) commits config + writes hosts, but nothing reads `/etc/hosts` back. If someone hand-edits or deletes the managed section — or a denied Apply left `config.json` ahead of `/etc/hosts` — blocking silently breaks and the user has no way to notice or fix it.

**Approach:** Add an unprivileged `readHostsSection` port to ShellRunner (reading `/etc/hosts` is world-readable — no admin prompt), a domain drift comparator that compares the read section's body lines to the expected lines from committed config (`effectiveBlocklist` + `toHostsLines`), and a user-initiated Restore section action that re-runs the privileged `writeHosts` path (one admin prompt) to rewrite the section from committed config. No automatic re-add — drift is checked on demand and reconciled only when the user clicks Restore. Proven via a temp driver (deleted after acceptance, mirroring 1.5/1.6); the permanent drift-warning UI is 2.6.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way: `UI → domain (Zustand) → adapters → ports`. `readHostsSection` is a new ShellRunner port method (UNPRIVILEGED read; no osascript). The domain is the sole owner of drift comparison and the sole caller of `readHostsSection` and `writeHosts`. No `child_process`/`fs`/`os` in `src/`.
- `readHostsSection` is unprivileged and synchronous (mirrors `ConfigStore.readConfig`'s sync pattern — `/etc/hosts` is world-readable and tiny). Returns `ReadSectionResult { ok: boolean; section: string[] | null; error?: string }`: `ok+section=lines` = markers found, body lines captured (excluding the marker lines); `ok+section=null` = no markers (absent); `ok=false` with `error:"hosts-unreadable" | "markers-mismatch"` = corrupt.
- Drift = the managed section's body lines != expected body lines, where `expected = effectiveHostsLines(committed) = effectiveBlocklist(committed).flatMap(toHostsLines)`. Reasons: `in-sync` | `missing` (absent + committed has alwaysOn domains) | `corrupt` (unreadable / markers-mismatch) | `mismatch` (present but wrong lines, order-sensitive). Empty committed + absent section = `in-sync` (nothing to enforce).
- Restore section re-runs the privileged `writeHosts` path with `effectiveHostsLines(committed)` — ONE admin prompt — through the store's serialized Apply queue (never concurrent with an Apply; two prompts never fire at once). On denied, drift remains and the warning stays. No automatic re-add loop.
- Restore writes HOSTS only (config.json is canonical intent and unchanged by drift); it does not re-write config.

**Ask First:**
- Making drift detection a background timer/daemon, or auto-restoring on detection (the epic forbids it; any auto-reconcile is Ask First).
- Any change to the managed-section marker format or the marker regexes (kept in sync between Swift `markerCounts` + the awk splice).

**Never:**
- No background daemon, no integrity re-add loop, no auto-Restore on drift detection.
- No `child_process`/`fs`/`os` in `src/` (`readHostsSection` lives native; the JS port is a thin wrapper).
- No permanent drift-warning UI in this story — the read-only hosts viewer + drift banner is 2.6. 1.7 proves via a temp driver deleted after acceptance.
- No parsing of marker lines on the JS side — markers live native (Swift regexes); the JS comparator treats the read body lines opaquely (array equality).
- No schedules/activeTimer contribution to the effective blocklist yet (Epic 4/5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy in-sync | section body == effectiveHostsLines(committed) | drift:false, reason:in-sync | N/A |
| Section missing | no markers + committed has alwaysOn domains | drift:true, reason:missing | Restore re-adds |
| Section corrupt | markers unpaired/duplicated OR /etc/hosts unreadable | drift:true, reason:corrupt | Restore rewrites |
| Section mismatch | markers present, body != expected (hand-edited) | drift:true, reason:mismatch | Restore rewrites |
| Empty committed + absent | no domains, no markers | drift:false, reason:in-sync (nothing to enforce) | N/A |
| Restore approved | user clicks Restore, approves prompt | writeHosts(effectiveHostsLines(committed)); section rewritten; drift→in-sync | N/A |
| Restore denied | user clicks Restore, cancels prompt | {ok:false,error:"admin-denied"}; /etc/hosts unchanged; drift remains; warning stays | retry re-attempts writeHosts idempotently |
| Restore concurrent with Apply | Apply in flight, user clicks Restore | Restore queues behind Apply (shared queue); one prompt at a time | N/A |

</frozen-after-approval>

## Code Map

- `src/native/specs/NativeShellRunnerSpec.ts` -- EDIT. Add `ReadSectionResult` type alias + `readHostsSection(): ReadSectionResult` (sync) to the `Spec` interface (currently write-only at :61-89; the :12-14 deferral note is resolved by this story). `WriteResult` type at :56-59.
- `src/hosts/shellRunner.ts` -- EDIT. Add `readHostsSection()` port — a thin sync pass-through + envelope shape-guard mirroring `writeHosts` (:48-76), sync like `configStore.readConfig`. Re-export `ReadSectionResult` from the port (the :80 re-export pattern). The write-only constraint is lifted.
- `macos/Frosthalt-macOS/NativeShellRunner.mm` -- EDIT. Add Obj-C glue `- (NSDictionary *)readHostsSection { return [self.swiftImpl readHostsSection]; }` (sync, mirroring `NativeConfigStore.mm:81` `readConfig`). `getTurboModule:` (:56-60) supplies the JSI binding for the new method.
- `macos/Frosthalt-macOS/ShellRunner.swift` -- EDIT. Add `readHostsSection()` returning NSDictionary: reuse the unprivileged `String(contentsOfFile: "/etc/hosts")` read from `markerCounts` (:112-128) + `beginMarkerRegex`/`endMarkerRegex` (:97-104) to extract the body lines between the first begin and the matching end. `ok+section=lines`; `ok+section=null` (absent, via NSNull); `ok=false` `error:"hosts-unreadable"` (file unreadable) | `"markers-mismatch"` (unpaired/duplicated markers). No `osascript`, no `backgroundQueue`.
- `src/domain/effectiveBlocklist.ts` -- EDIT. Add exported `effectiveHostsLines(config: Config): string[]` = `effectiveBlocklist(config).flatMap(toHostsLines)` (DRY helper reused by `runApply`, `computeDrift`, `restoreSection`). `effectiveBlocklist` at :28-55.
- `src/domain/drift.ts` -- NEW. `DriftReason` type + `DriftResult` interface + `computeDrift(committed: Config, read: ReadSectionResult): DriftResult` — the comparator (in-sync/missing/corrupt/mismatch; empty-committed+absent=in-sync; order-sensitive body equality). Pure, unit-tested. Imports `effectiveHostsLines` + the `ReadSectionResult` type.
- `src/domain/apply.ts` -- EDIT. Replace the inline lines-build (:75-80) with `effectiveHostsLines(nextConfig)` (reuse the new helper). Behaviour unchanged.
- `src/domain/store.ts` -- EDIT. Add state `drift: DriftResult | null` (null = unchecked) and actions `checkDrift(): DriftResult` (sync: `readHostsSection()` → `computeDrift(committed, read)` → `set drift`; returns the result) and `restoreSection(): Promise<WriteResult>` (async: enqueue `writeHosts(effectiveHostsLines(committed))` via the shared serialized queue :137-153; one admin prompt; on success re-check drift → in-sync, on denied drift remains). State shape :45-53.
- `__tests__/shellRunner.test.ts` -- EDIT. Extend the mock factory (:27-35) with `readHostsSection: jest.fn()` (sync `mockReturnValue`); add envelope shape-guard + absent (`section:null`) + corrupt (`error`) assertions mirroring the `writeHosts` shape-guard tests.
- `__tests__/drift.test.ts` -- NEW. `computeDrift` golden: in-sync (body==expected), missing (absent + domains), corrupt (`ok:false`), mismatch (present + wrong), empty-committed+absent=in-sync, order-sensitivity.
- `__tests__/store.test.ts` -- EDIT. Add `checkDrift` (mock `readHostsSection` → `drift` set) + `restoreSection` (enqueued `writeHosts` with `effectiveHostsLines(committed)`; denied retains drift; serialized behind an Apply) tests. Mock seam :42-50.
- `src/components/RestoreProbe.tsx` -- NEW TEMP. Drift status (reason + warning banner) + "Re-check" button + "Restore section" button (wired to `store.restoreSection`, reusing `ApplyButton`) + lastResult line. Branched into `Shell.tsx` surface 0 on macOS only (`Platform` gate + lazy `require`, mirroring 1.6 `ApplyProbe`). Deleted after acceptance.
- `src/components/Shell.tsx:88-95` -- EDIT (temp). Branch surface 0 → `<RestoreProbe/>` on macOS only; reverted after acceptance.
- Reuse (read-only): `src/config/configStore.ts:36` (`readConfig` — sync read precedent), `src/config/types.ts:15` (`Config`/`Domain`/`DEFAULT_CONFIG`, deep-frozen), `src/domain/normalise.ts:114` (`toHostsLines` — 4-line payload), `src/components/ApplyButton.tsx:21` (the Apply button primitive the probe reuses).

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeShellRunnerSpec.ts` -- add `ReadSectionResult` type + `readHostsSection()` to `Spec` -- codegen contract for the unprivileged read.
- [x] `src/hosts/shellRunner.ts` -- add `readHostsSection` port (sync, shape-guard) + re-export `ReadSectionResult` -- the JS read port.
- [x] `macos/Frosthalt-macOS/NativeShellRunner.mm` + `macos/Frosthalt-macOS/ShellRunner.swift` -- add `readHostsSection` (sync NSDictionary; reuse `markerCounts` read + marker regexes) -- native unprivileged section extraction.
- [x] `src/domain/effectiveBlocklist.ts` -- add `effectiveHostsLines(config)` helper -- DRY expected-lines computation.
- [x] `src/domain/drift.ts` -- `computeDrift` comparator -- drift flag + reason from committed vs read section.
- [x] `src/domain/apply.ts` -- use `effectiveHostsLines` (replace inline build) -- DRY, behaviour unchanged.
- [x] `src/domain/store.ts` -- add `drift` state + `checkDrift` + `restoreSection` (shared queue) -- the domain hub for drift.
- [x] `__tests__/{shellRunner,drift,store}.test.ts` -- unit tests for the read port, comparator, and store drift/restore -- pipeline logic proven in JS.
- [x] `src/components/RestoreProbe.tsx` + `src/components/Shell.tsx` -- temp driver wired to the store -- live drift/Restore proof vehicle; deleted/reverted after acceptance.

**Acceptance Criteria:**
- Given `pnpm test`, when the suite runs, then `shellRunner` (readHostsSection), `drift`, and `store` (checkDrift/restoreSection) suites pass with the spec mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given the running app with the temp RestoreProbe, when committed has a domain and `/etc/hosts` managed section matches the effective blocklist, then Re-check shows in-sync (no warning).
- Given the managed section is missing or hand-edited (body != effective blocklist), when the user clicks Re-check, then a drift warning shows (reason missing/corrupt/mismatch).
- Given drift is shown, when the user clicks Restore section and approves the prompt, then `/etc/hosts` managed section is rewritten to match the effective blocklist (`root:wheel` `0644`, DNS flushed) and drift clears to in-sync.
- Given drift is shown, when the user clicks Restore and cancels the prompt, then `{ok:false,error:"admin-denied"}`, `/etc/hosts` unchanged, drift remains, warning stays (no auto-re-add).
- Given an Apply is in flight, when the user clicks Restore, then Restore queues behind the Apply and runs one-at-a-time (never two prompts concurrently).
- Given any domain-layer code, then it imports ShellRunner only via the ports (`readHostsSection` + `writeHosts`) and never `child_process`/`fs`/`os`.

## Design Notes

- **Why `readHostsSection` is unprivileged + sync:** `/etc/hosts` is world-readable (`0644`), so no `osascript` elevation is needed — unlike `writeHosts`. `ConfigStore.readConfig` already reads a file sync on the JS thread; `readHostsSection` mirrors that (a tiny file, microseconds). No `backgroundQueue`.
- **Why Restore writes hosts only (not config):** `config.json` is canonical intent and is unchanged by drift — drift is a hosts-side problem. A denied Apply already wrote config before the failed `writeHosts`, so config is correct; Restore reconciles hosts to the already-correct config. (This is exactly the denied-Apply drift 1.6 deferred to 1.7.)
- **Why empty-committed + absent = in-sync:** enforcement must match intent. Empty intent (no domains) = "nothing blocked"; an absent section also blocks nothing → matches → no drift. This avoids a noisy "Restore?" prompt on a fresh install with no domains.
- **Why Restore shares the Apply queue:** two concurrent `writeHosts` race on `/etc/hosts.fh.bak` + `/etc/hosts.new` (deferred-work spec-1-5). Routing Restore through the same serialized queue (`store.ts:137-153`) guarantees one osascript prompt at a time.
- **Markers stay native-only:** there is no JS marker parser. `readHostsSection` returns the body lines (between markers) opaquely; the JS comparator does array equality, never marker parsing. The marker regexes (`ShellRunner.swift:97-104`) + awk splice (`:320,326`) remain the single source of truth for marker format.
- **Golden example — committed `[{example.com,true}]`:** `effectiveHostsLines` = `[0.0.0.0 example.com, :: example.com, 0.0.0.0 www.example.com, :: www.example.com]`. If `readHostsSection` returns those 4 lines → `computeDrift` = in-sync. If it returns `null` → missing. If it returns `[0.0.0.0 example.com, :: example.com]` (someone deleted the www lines) → mismatch.
- **Known gap — Restore cannot repair a `corrupt` section:** the I/O matrix lists "Section corrupt → Restore rewrites", but `writeHosts`'s pre-scan refuses a malformed-marker `/etc/hosts` (returns `markers-mismatch`, no prompt, no write) — a safety guard so a corrupt hosts file is never silently truncated. So `restoreSection` reconciles `missing`/`mismatch` drift (clean marker pair, absent/wrong body) but cannot repair a `corrupt` section (unpaired/duplicated markers). A corrupt section needs a manual `/etc/hosts` fix (remove the stray markers) before Restore can write. Accepted as a limitation for 1.7; the permanent drift UI (2-6) will surface the `corrupt` reason with guidance rather than offering a silent rewrite.

## Verification

**Commands:**
- `pnpm typecheck` -- expected: exit 0.
- `pnpm test --watchman=false -- shellRunner drift store` -- expected: the three suites pass.

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds.
- On the running app (temp RestoreProbe): with a committed domain + matching `/etc/hosts` → Re-check shows in-sync. Manually delete or edit the managed section (`sudo`) → Re-check shows drift. Restore + approve → `/etc/hosts` rewritten, drift clears. Restore + cancel → drift remains. **Back up `/etc/hosts` before and restore after.** Then delete `RestoreProbe` + revert `Shell`.

## Suggested Review Order

**Drift comparison — the core new logic**

- Pure comparator defining drift (in-sync/missing/corrupt/mismatch) — read first.
  [`drift.ts:62`](../../src/domain/drift.ts#L62)

- Empty committed + absent section = in-sync; no noisy prompt on fresh install.
  [`drift.ts:79`](../../src/domain/drift.ts#L79)

- Order-sensitive body equality; a reordering is real drift, not in-sync.
  [`drift.ts:89`](../../src/domain/drift.ts#L89)

**The unprivileged read port**

- Unprivileged sync read of the managed section; no admin prompt (mirrors readConfig).
  [`shellRunner.ts:103`](../../src/hosts/shellRunner.ts#L103)

- Shape-guard: `section` must be null or string[]; `undefined`/non-string → bad-envelope.
  [`shellRunner.ts:137`](../../src/hosts/shellRunner.ts#L137)

- Codegen contract: `ReadSectionResult` type + sync `readHostsSection()`.
  [`NativeShellRunnerSpec.ts:160`](../../src/native/specs/NativeShellRunnerSpec.ts#L160)

**Restore (privileged, serialized)**

- Restore re-reads committed at run time, not call time — closes the stale-snapshot race.
  [`store.ts:178`](../../src/domain/store.ts#L178)

- Routed through the shared serialized Apply queue; one admin prompt at a time.
  [`store.ts:176`](../../src/domain/store.ts#L176)

- Sync `checkDrift`: read → compare → set drift; no prompt.
  [`store.ts:152`](../../src/domain/store.ts#L152)

- DRY expected-lines helper shared by runApply, computeDrift, restoreSection.
  [`effectiveBlocklist.ts:70`](../../src/domain/effectiveBlocklist.ts#L70)

- runApply reuses the shared helper; behaviour unchanged.
  [`apply.ts:77`](../../src/domain/apply.ts#L77)

**Native (unverified until `pnpm macos`)**

- Swift extraction reusing the `markerCounts` read + marker regexes; no osascript.
  [`ShellRunner.swift:167`](../../macos/Frosthalt-macOS/ShellRunner.swift#L167)

- Obj-C sync glue mirroring `NativeConfigStore`'s `readConfig`.
  [`NativeShellRunner.mm:115`](../../macos/Frosthalt-macOS/NativeShellRunner.mm#L115)

**Temp driver + tests (peripherals)**

- Temp RestoreProbe branched into Shell surface 0, macOS-only; gated out of Jest.
  [`Shell.tsx:36`](../../src/components/Shell.tsx#L36)

- RestoreProbe: Re-check + Restore buttons + drift banner; deleted after acceptance.
  [`RestoreProbe.tsx:38`](../../src/components/RestoreProbe.tsx#L38)

- computeDrift golden: in-sync/missing/corrupt/mismatch/order/empty-committed.
  [`drift.test.ts:39`](../../__tests__/drift.test.ts#L39)

- readHostsSection port forwarding + envelope shape-guard coercion.
  [`shellRunner.test.ts:266`](../../__tests__/shellRunner.test.ts#L266)

- checkDrift + restoreSection store tests incl. run-time-committed serialization.
  [`store.test.ts:430`](../../__tests__/store.test.ts#L430)