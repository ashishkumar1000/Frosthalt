---
title: 'Read-only hosts viewer with drift warning (verbatim managed section + Restore offer + Esc-closable overlay)'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '3f46157'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-drift-detection-and-user-initiated-restore-section.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-5-domain-count-in-the-status-header.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-sidebar-navigation-and-status-header-shell.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Frosthalt writes a managed `# BEGIN/END FROSTHALT` section to `/etc/hosts` but the user can never see what is actually there. Story 1.7 built drift detection (`computeDrift`) and a `restoreSection()` store action, but shipped no permanent UI — the temp `RestoreProbe` was deleted after acceptance — so the user cannot view the section, cannot see a drift warning, and cannot trigger Restore.

**Approach:** Add a read-only hosts viewer as an Esc-closable overlay mounted at the Shell root, opened from a new "View hosts" link in `StatusHeader`. It shows the exact managed section verbatim (mono tokens, SF Mono, scrollable, no edit affordances). On drift it shows a warning banner branched on `drift.reason` with an admin-gated "Restore section" offer (reusing 1.7's `restoreSection`). A new `lastReadSection` store field surfaces the section lines that `checkDrift` already reads but discards, so the viewer renders the real on-disk body — not the expected/computed lines.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way: the viewer reads ONLY `useDomainStore` — `drift`, `lastReadSection`, `checkDrift`, `restoreSection`, `applyStatus`. It MUST NOT import `shellRunner.ts`/`readHostsSection` (the `AD-5` rule: the domain is the sole caller of the hosts ports).
- Verbatim, not computed: the body renders `lastReadSection` (the actual on-disk `string[]` between the markers), NEVER `effectiveHostsLines(committed)` (the expected/intended lines — rendering those would always look in-sync and hide drift).
- Read-only by construction: the body is `Text` inside a `ScrollView` — no `TextInput`, no edit affordance for the section content. "Restore section" is a repair action through a store action, not a content edit.
- Fresh read on open: the viewer calls `checkDrift()` on mount (the hosts file may have drifted since the last check), populating both `drift` and `lastReadSection`.
- Drift banner branches on `drift.reason` (`drift.ts:36`): `missing`/`mismatch` → "Managed section not found — your hosts file may have been edited outside Frosthalt." + a "Restore section" `ApplyButton` bound to `restoreSection` (busy when `applyStatus === 'running'`); `corrupt` → the SAME banner headline + a guidance sentence ("The managed section is corrupt and can't be auto-repaired. Edit /etc/hosts manually, then reopen this viewer.") and NO Restore button (1.7's known gap: `writeHosts` pre-scan refuses malformed markers, so Restore cannot repair `corrupt`).
- The viewer is an overlay, NOT a 5th sidebar surface — `SurfaceIndex = 0|1|2|3` / `SURFACE_NAMES` are a baked 4-tuple (⌘1–⌘4); adding a surface would break the sidebar nav contract. Shell owns a `viewerOpen` boolean.
- Esc closes the viewer: add `{ key: 'Escape' }` to `KEY_DOWN_EVENTS` (`Shell.tsx:41-49`) and an `onKeyDown` branch before the Return→Apply branch that closes when `viewerOpen`. While open, Return must NOT fire Apply (gate the Return→Apply branch with `&& !viewerOpen`, mirroring how the native alert inert-ifies the Shell's Return gate).
- Entry point: a "View hosts" `Pressable` appended to `StatusHeader` (after "no active timer"), `accessibilityRole="button"`, calling an `onViewHosts` prop from Shell.
- Restore = one macOS admin prompt (osascript via `writeHosts`), NOT an in-app password (Epic 3). No in-app confirm-alert before Restore — the OS admin prompt is the gate (1.7's `RestoreProbe` precedent went straight to `restoreSection`).

**Ask First:**
- The AC names the entry as "from Settings or the status-header 'View hosts' link." No Settings surface exists today (surface 3 is a `SurfacePlaceholder`, `surfaces.tsx:37`). 2.6 builds ONLY the StatusHeader link (which satisfies the AC's "or"). If the human wants a "View hosts file" row in Settings now, that requires building a minimal Settings surface — say so before implementing, since a future Settings story would own its structure.

**Never:**
- No new privileged code / ports: no new `readHostsSection`/`writeHosts` call site. The only domain change is adding the `lastReadSection` state field populated inside the EXISTING `checkDrift`/`restoreSection` (which already call `readHostsSection`).
- No rendering `effectiveHostsLines`/`effectiveBlocklist` as the section body (that is the expected set, not the verbatim on-disk section).
- No auto-re-add / no automatic Restore on drift — Restore is strictly user-initiated (1.7's Never clause).
- No "Restore section" button on `corrupt` (unrepairable — guidance only).
- No new sidebar surface / no change to `SURFACE_NAMES`/`SurfaceIndex`/⌘1–⌘4.
- No badge / "no active timer" / count change (2.5 owns those; the viewer is additive).
- No password gate (Epic 3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Section intact | `drift` in-sync, `lastReadSection` = [lines] | Body shows the exact lines verbatim in `mono`/`monoBg`/`monoFg` `ScrollView`; no banner | N/A |
| Drift — missing | `drift.reason='missing'`, `lastReadSection`=null | Banner "Managed section not found…" + "Restore section" button; body empty-state | N/A |
| Drift — mismatch | `drift.reason='mismatch'`, `lastReadSection`=[actual lines] | Banner + Restore; body shows the actual (drifted) lines verbatim | N/A |
| Drift — corrupt | `drift.reason='corrupt'` | Banner + corrupt guidance; NO Restore button | N/A |
| Empty committed, no markers | committed empty, read section null, `drift` in-sync | Body empty-state; no banner | N/A |
| Restore success | user presses Restore → admin prompt → `writeHosts` ok | `restoreSection` re-checks → `drift` in-sync, `lastReadSection` updates → banner clears, body shows lines | admin-denied → `drift` remains, banner stays, button re-enables |
| Open viewer | click "View hosts" | viewer mounts → `checkDrift()` → fresh `drift` + `lastReadSection` | N/A |
| Esc / Return while open | viewer open | Esc closes; Return does NOT fire Apply | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts` -- EDIT. Add `lastReadSection: string[] | null` to `DomainState` (after `drift`, `:80`); init `null` (`:131`). Populate in `checkDrift` (`:285` → `set({ drift: result, lastReadSection: read.section ?? null })`) and on Restore success (`:312` → add `lastReadSection: read.section ?? null` to the existing success `set`). No new port call — `readHostsSection` is already invoked at `:283` and `:310`. Not new privileged code.
- `src/components/HostsViewer.tsx` -- NEW. The overlay: reads `drift`/`lastReadSection`/`checkDrift`/`restoreSection`/`applyStatus` from `useDomainStore`; props `{ onClose }`. `useEffect` on mount calls `checkDrift()`. Renders an absolute-positioned scrim + panel: title, banner (when `drift?.drift`, branched on `reason`, `accessibilityRole="alert"`, `statusFill('amber')` / `tokens.destructive` for corrupt), body `ScrollView` (focusable, `tokens.monoBg`) with `Text` lines in `tokens.typography.mono` + `tokens.monoFg`, close button (`accessibilityLabel="Close"`). Restore via `<ApplyButton label="Restore section" onPress={restoreSection} busy={applyStatus==='running'} disabled={applyStatus==='running'} />` (reuse `ApplyButton.tsx:38-53`); hide on `corrupt`. Empty-state line when `lastReadSection` null/empty.
- `src/components/Shell.tsx` -- EDIT. Add `const [viewerOpen, setViewerOpen] = useState(false)`. Pass `onViewHosts={() => setViewerOpen(true)}` to `<StatusHeader/>` (`:158`). Render `{viewerOpen && <HostsViewer onClose={() => setViewerOpen(false)} />}` as a sibling after `<View style={styles.body}>` (`:173`). Add `{ key: 'Escape' }` to `KEY_DOWN_EVENTS` (`:41-49`). In `onKeyDown`, add before the Return branch (`:132`): `if (!metaKey && key === 'Escape' && viewerOpen) { setViewerOpen(false); return; }`; gate the Return→Apply branch (`:132`) with `&& !viewerOpen`.
- `src/components/StatusHeader.tsx` -- EDIT. Add prop `{ onViewHosts }: { onViewHosts: () => void }`. After "no active timer" (`:66`) add `<Text style={styles.separator}>·</Text>` + a `Pressable` (`accessibilityRole="button"`, `accessibilityLabel="View hosts"`, `onPress={onViewHosts}`) wrapping `<Text style={styles.link}>View hosts</Text>`; add `styles.link` (`tokens.typography.label`, `color: tokens.primary`).
- `src/domain/drift.ts` -- REUSE. `DriftResult.reason` (`:36`, `:42-47`) drives the banner branch. No edit.
- `src/hosts/shellRunner.ts` -- REFERENCE only (NOT imported by the viewer). `readHostsSection()` (`:103`) returns `ReadSectionResult.section` — already called by the store.
- `src/components/ApplyButton.tsx` -- REUSE. Restore button primitive (`:38-53`).
- `src/theme/tokens.ts` -- REFERENCE. `monoBg` (`:94`), `monoFg` (`:95`), `typography.mono` (`:122-127`), `statusFill('amber')` (`:141-143`), `destructive` (`:92`), `primary`/`primaryForeground`. No new tokens.
- `__tests__/HostsViewer.test.tsx` -- NEW. Mirror `Blocklist.test.tsx` structure: TurboModule mocks (`:27-41`), `extractText` (`:59-74`), `findButtonByLabel` (`:98-109`), `seedState` extended with `drift` + `lastReadSection` (`:128-151`, `drift:null` at `:148`), `afterEach` (`:157-164`), `announceForAccessibility` (`:52-57`). Assert: in-sync renders verbatim lines + no banner; missing → banner + Restore (press → `restoreSection` spy called); mismatch → banner + Restore + actual lines; corrupt → guidance, NO Restore; empty in-sync → empty-state; Restore busy disables button; `onClose` close button; `checkDrift` called on mount; banner has `accessibilityRole="alert"`.
- `__tests__/Shell.test.tsx` -- EDIT. Assert "View hosts" link renders + `onPress` opens the viewer (viewer title appears in `extractText`); `KEY_DOWN_EVENTS` `toEqual` (`:771-781`) includes `{ key: 'Escape' }`; Escape closes the viewer (open via link, fire `Escape` via `findKeyDownContainer` `:179-189`, viewer disappears); Return→Apply inert while viewer open (`apply` not called). Use the `seedState`-style `useDomainStore.setState` in `act` (`:560-570`) + `mockClear` announce.
- `__tests__/store.test.ts` -- EDIT. Extend the `checkDrift`/`restoreSection` tests (`:928-1230`) to assert `lastReadSection` is set to the read `section` lines on `checkDrift` and on Restore success (null on denied). Reuse the `readHostsSection` mock (`:944-952`).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/store.ts` -- add `lastReadSection` state, populate in `checkDrift` + Restore success -- surfaces the verbatim on-disk section the viewer renders.
- [x] `src/components/HostsViewer.tsx` -- new overlay: verbatim mono `ScrollView` body, drift banner branched on `reason`, Restore via `ApplyButton` (hidden on `corrupt`), `checkDrift` on mount, `onClose` -- the read-only viewer.
- [x] `src/components/Shell.tsx` -- `viewerOpen` state, render the overlay, `Escape` in `KEY_DOWN_EVENTS` + `onKeyDown` close branch, gate Return→Apply with `!viewerOpen`, pass `onViewHosts` to `StatusHeader` -- open/close + keyboard.
- [x] `src/components/StatusHeader.tsx` -- add `onViewHosts` prop + "View hosts" `Pressable` link -- the entry point.
- [x] `__tests__/HostsViewer.test.tsx` -- new: banner-by-reason, Restore wiring, corrupt-hides-Restore, verbatim body, empty-state, busy, close, mount-`checkDrift`.
- [x] `__tests__/Shell.test.tsx` -- extend: View-hosts link opens viewer, `Escape` in `KEY_DOWN_EVENTS` + closes, Return inert while open.
- [x] `__tests__/store.test.ts` -- extend: `lastReadSection` set by `checkDrift` + Restore success.

**Acceptance Criteria:**
- Given the managed section exists and is intact, when the viewer opens, then it shows the exact `# BEGIN/END FROSTHALT` body verbatim in `monoBg`/`monoFg` SF Mono, scrollable, with no edit affordances (read-only by construction).
- Given drift is detected, then a warning banner reads "Managed section not found — your hosts file may have been edited outside Frosthalt."; given `reason` is `missing`/`mismatch`, then an admin-gated "Restore section" offer is shown; given `corrupt`, then guidance is shown and NO Restore offer.
- Given the user opens the viewer (from the StatusHeader "View hosts" link), then `checkDrift()` runs on mount so the banner + body reflect the current `/etc/hosts`.
- Given the user presses "Restore section" and grants the macOS admin prompt, then `restoreSection()` rewrites hosts, re-checks drift → in-sync, the banner clears, and the body shows the restored lines; given admin-denied, then the banner stays and the button re-enables.
- Given the viewer is open, then `Esc` closes it and `Return` does not fire Apply; given the viewer is open, then `Tab`/arrow keys scroll the body (focusable `ScrollView`).
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0; given `pnpm test` (HostsViewer + Shell + store suites), then the new + extended assertions pass.

## Spec Change Log

<!-- Empty until the first bad_spec loopback. -->

## Design Notes

- **Why a store field, not a direct port call:** the viewer must render the actual on-disk section, but `AD-5` makes the domain the sole caller of `readHostsSection`. `checkDrift` already reads it (`store.ts:283`) and throws the `section` away — `lastReadSection` simply preserves what is already fetched. No new port call, no new privileged code.
- **Why verbatim, not `effectiveHostsLines`:** `effectiveHostsLines(committed)` (`effectiveBlocklist.ts:69`) is the INTENDED set (what Apply writes). On drift it differs from the on-disk reality; rendering it would always look in-sync and hide the very drift the viewer exists to expose. `lastReadSection` is the truth.
- **Why an overlay, not a surface:** `SurfaceIndex`/`SURFACE_NAMES` are a fixed 4-tuple driving the sidebar + ⌘1–⌘4 + nav announce; a 5th surface breaks the contract. An Esc-closable overlay at the Shell root keeps the 4-surface nav intact and gives the viewer a window-level Esc/Return intercept (same ownership pattern as `surface`/`addFieldFocused`).
- **Why no in-app confirm before Restore:** Restore's one osascript admin prompt IS the confirmation; an `Alert.alert` before it would double-prompt. 1.7's `RestoreProbe` went straight to `restoreSection`.
- **Why `corrupt` hides Restore:** `writeHosts` pre-scans and refuses malformed markers (`spec-1-7:105`), so Restore cannot repair `corrupt`. Guidance + the user manually editing `/etc/hosts` + reopening (which re-runs `checkDrift`) is the repair path.
- **Golden example:** committed `[example.com true, social.com true]`, `/etc/hosts` section holds those 4+4 lines in order → viewer shows them verbatim, no banner. A stray edit deletes the section → reopen → `drift.reason='missing'` → banner + "Restore section"; press it → admin prompt → ok → banner clears, body shows the 8 lines. The section gets a malformed marker → `reason='corrupt'` → banner + corrupt guidance, no Restore button.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: exit 0. (The `pnpm` wrapper is sandbox-broken here; `pnpm typecheck` is the canonical human-facing command.)
- `node_modules/.bin/jest --watchman=false -- HostsViewer Shell store` -- expected: the three suites pass. (`pnpm test` is the canonical command.)

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds. Click "View hosts" in the status header → the managed section appears verbatim in SF Mono on the dark mono background, scrollable, Esc closes. Edit `/etc/hosts` to delete the `# BEGIN/END FROSTHALT` block, reopen → banner + "Restore section"; grant the admin prompt → section restored, banner clears. Damage a marker → corrupt guidance, no Restore button. While open, Return does not trigger Apply; Tab scrolls.

## Suggested Review Order

A focused, click-through review path from the load-bearing decision to the regression net.

**Read-only verbatim viewer (the core)**

- The overlay component — reads only `useDomainStore`, no port import (AD-5).
  [`HostsViewer.tsx:64`](../../src/components/HostsViewer.tsx#L64)

- The load-bearing decision: body = `lastReadSection`, never `effectiveHostsLines`.
  [`HostsViewer.tsx:90`](../../src/components/HostsViewer.tsx#L90)

- Banner branches on `reason`; `corrupt` hides Restore and shows guidance.
  [`HostsViewer.tsx:114`](../../src/components/HostsViewer.tsx#L114)

- Fresh read on open — `checkDrift()` runs on mount so the body reflects current `/etc/hosts`.
  [`HostsViewer.tsx:75`](../../src/components/HostsViewer.tsx#L75)

**Store field for the verbatim body**

- `lastReadSection` preserved inside the existing `checkDrift` — no new port call.
  [`store.ts:302`](../../src/domain/store.ts#L302)

- Restore success re-reads and updates `lastReadSection` + `drift` so the banner clears.
  [`store.ts:335`](../../src/domain/store.ts#L335)

**Overlay lifecycle + keyboard**

- `viewerOpen` — an overlay, not a 5th sidebar surface (keeps `SurfaceIndex` a 4-tuple).
  [`Shell.tsx:80`](../../src/components/Shell.tsx#L80)

- Bare Escape closes, placed before the Return→Apply branch.
  [`Shell.tsx:133`](../../src/components/Shell.tsx#L133)

- Return→Apply gated with `&& !viewerOpen` while the overlay is open.
  [`Shell.tsx:158`](../../src/components/Shell.tsx#L158)

- Overlay rendered as a Shell sibling; `onViewHosts` wired to `StatusHeader`.
  [`Shell.tsx:200`](../../src/components/Shell.tsx#L200)

**Entry point link**

- "View hosts" `Pressable` appended to the status header.
  [`StatusHeader.tsx:82`](../../src/components/StatusHeader.tsx#L82)

**Tests**

- Viewer: banner-by-reason, verbatim body, corrupt-hides-Restore, mount `checkDrift`.
  [`HostsViewer.test.tsx:201`](../../__tests__/HostsViewer.test.tsx#L201)

- Shell: View-hosts opens viewer, Escape closes, Return inert while open.
  [`Shell.test.tsx:1227`](../../__tests__/Shell.test.tsx#L1227)

- Store: `lastReadSection` set by `checkDrift` + Restore success (null on denied).
  [`store.test.ts:966`](../../__tests__/store.test.ts#L966)

### Verification (re-run)

- `node_modules/.bin/tsc --noEmit` -- exit 0.
- `node_modules/.bin/jest --watchman=false -- HostsViewer Shell store` -- 5 suites, 144 tests pass.
- `pnpm typecheck` / `pnpm test` are the canonical human-facing commands (the `pnpm` wrapper is sandbox-broken here; the direct binaries above are the equivalent).