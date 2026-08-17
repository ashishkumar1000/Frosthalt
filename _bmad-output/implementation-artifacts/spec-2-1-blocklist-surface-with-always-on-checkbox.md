---
title: 'Blocklist surface with always-on checkbox'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9e38d48990f370320f5b6343e3f48a6061dc1a72'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-staged-then-apply-serialized-pipeline-proven-on-one-domain.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-sidebar-navigation-and-status-header-shell.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 1 built the trusted staged-then-Apply pipeline and drift detection, but surface 0 (Blocklist) is still a placeholder — users cannot see their committed domains or toggle always-on. The only way to add/toggle a domain today was the deleted temp probe.

**Approach:** Add the permanent Blocklist surface (renders committed domains as rows with an always-on checkbox) and a `stageAlwaysOnToggle` store action that flips `alwaysOn` in the staged draft. Toggling stages optimistically; the existing 1.6 `apply()` commits config + hosts. `effectiveBlocklist` already honours `alwaysOn` (1.6), so toggle → Apply → `/etc/hosts` works end-to-end with no new privileged code.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way: `UI → domain (Zustand) → adapters → ports`. Blocklist reads `committed`/`staged` and calls `stageAlwaysOnToggle` / `apply` / `cancelStaged` only. No `child_process`/`fs`/`os` in `src/`.
- The alwaysOn toggle is a STAGED edit (optimistic UI on `staged ?? committed.domains`); `apply()` (the existing 1.6 serialized pipeline) is the ONLY path that commits `config.json` + writes `/etc/hosts`. No auto-Apply on toggle.
- `stageAlwaysOnToggle` produces a NEW `staged` array reference (spread) — preserves the apply-queue's mid-run-edit detection (`store.ts:131-133`). Clean-revert: if the resulting draft equals `committed.domains` (same hostnames + alwaysOn, order), set `staged = null` so a net-no-op toggle fires no redundant admin prompt — mirroring `stageDomainAdd`'s no-redundant-Apply principle (`store.ts:92-98`).
- Rows render `domain.hostname` directly (already the normalised apex in config; no re-normalisation at display).
- The checkbox is a macOS checkbox (`accessibilityRole="checkbox"`, `accessibilityState={{ checked }}`), not an iOS switch.

**Ask First:**
- Any change to the staged-edits buffer shape (`Domain[] | null` full draft) or the apply-queue serialization.
- Adding a pulse animation to the Apply button (the `ApplyButton` primitive has no animation; a pulse is extra machinery — defer to 2-3 unless approved here).

**Never:**
- No add-domain field, no live-normalisation preview (Story 2-2).
- No remove button / confirm-alert (Story 2-4).
- No domain count in the status header or Shell announce (Story 2-5 — leave `Shell.tsx` hardcoded `"0 domains"` announce and `StatusHeader` alone).
- No hosts viewer / drift banner (Story 2-6 — drift detection exists from 1.7 but is not surfaced here).
- No new privileged code (no new ShellRunner/ConfigStore methods); reuse 1.6 `apply()`, 1.4 ConfigStore, 1.5 ShellRunner.
- No auto-Apply on toggle; no background re-add. No schedules/activeTimer contribution (Epic 4/5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Committed domains render | `committed.domains` non-empty | rows `[checkbox] hostname`; checkbox checked iff `alwaysOn` | N/A |
| Toggle on → staged | click an unchecked checkbox | `staged` = draft with that domain `alwaysOn:true`; checkbox shows checked; Apply enabled | N/A |
| Toggle off → staged | click a checked checkbox | `staged` = draft with `alwaysOn:false`; checkbox unchecked; Apply enabled | N/A |
| Toggle twice → clean | toggle a domain off then on (net = committed) | `staged` reverts to `null`; Apply disables (no redundant prompt) | N/A |
| Toggle unknown hostname | `hostname` not in the draft | `{ok:false, error:'not-found'}`; `staged` unchanged | N/A |
| Apply committed | `staged` non-null, click Apply | `apply()` commits config + writes hosts; `staged` cleared | denied: `staged` retained (1.6); drift may show (1.7) |
| Empty state | `committed.domains` empty + `staged` null | "No domains yet. Add one to start blocking." text only (no Add button — 2-2) | N/A |

</frozen-after-approval>

## Code Map

- `src/components/Blocklist.tsx` -- NEW. Surface 0: renders `(staged ?? committed.domains)` as `DomainRow`s + `ApplyButton` (Apply, disabled when `running || staged == null`) + Cancel-staged ghost button + empty-state text; wires `stageAlwaysOnToggle` / `apply` / `cancelStaged`. Reads `useDomainStore`. The permanent blocklist surface.
- `src/components/DomainRow.tsx` -- NEW. A single row: `Checkbox` + hostname `Text`, focusable, Tab order checkbox→domain. Reused by 2-4 (remove button slot).
- `src/components/Checkbox.tsx` -- NEW. macOS checkbox primitive (Pressable + tick glyph), `accessibilityRole="checkbox"`, `accessibilityState={{ checked }}`, visible focus ring. Reused by 2-2/2-4.
- `src/domain/store.ts` -- EDIT. Add `stageAlwaysOnToggle(hostname: string): WriteResult` — builds on `staged ?? committed.domains`, flips the matching domain's `alwaysOn`, new array ref, clean-revert to `null` when the draft equals `committed.domains`, `{ok:false,error:'not-found'}` for an unknown hostname. Precedent: `stageDomainAdd` (`store.ts:84-101`).
- `src/components/Shell.tsx` -- EDIT. Branch the surface render (`Shell.tsx` ~`:94`) so `surface === 0 ? <Blocklist/> : <SurfacePlaceholder surface={surface}/>`.
- `__tests__/store.test.ts` -- EDIT. `stageAlwaysOnToggle` tests: on/off, builds-on-clean, new array ref, clean-revert (toggle twice → `null`), unknown hostname → `not-found`. Mock seam `store.test.ts:21-35`.
- `__tests__/Blocklist.test.tsx` -- NEW. `react-test-renderer`; render committed rows, checkbox checked-state, toggle calls `stageAlwaysOnToggle`, Apply disabled when no `staged`, empty state. Mock native specs (`store.test.ts:21-35` pattern) + `useDomainStore.setState`.
- Reuse (read-only): `src/components/ApplyButton.tsx:21` (button primitive, `{label,onPress,disabled?}`), `src/components/SidebarRow.tsx:26` (focusable-Pressable-row precedent), `src/components/surfaces.tsx` (`SURFACE_NAMES`/`SurfaceIndex`), `src/theme/tokens.ts:85` (colors/typography/spacing/rounded), `src/domain/effectiveBlocklist.ts:33` (already honours `alwaysOn`), `src/config/types.ts:15` (`Domain`).

## Tasks & Acceptance

**Execution:**
- [x] `src/components/Checkbox.tsx` -- NEW macOS checkbox primitive (a11y role/state, focus ring) -- reusable for 2-2/2-4.
- [x] `src/components/DomainRow.tsx` -- NEW row (Checkbox + hostname, focusable, Tab order) -- the blocklist row unit.
- [x] `src/components/Blocklist.tsx` -- NEW surface 0 (rows + Apply + Cancel + empty state) -- the permanent blocklist surface.
- [x] `src/domain/store.ts` -- add `stageAlwaysOnToggle` (clean-aware, new ref, clean-revert, not-found) -- the toggle mutation.
- [x] `src/components/Shell.tsx` -- branch surface 0 → `<Blocklist/>` -- wire the surface in.
- [x] `__tests__/store.test.ts` -- `stageAlwaysOnToggle` tests -- prove the mutation.
- [x] `__tests__/Blocklist.test.tsx` -- render/toggle/apply-disabled/empty-state tests -- prove the surface.

**Acceptance Criteria:**
- Given `pnpm test`, when the suite runs, then `store` (`stageAlwaysOnToggle`) + `Blocklist` suites pass with the specs mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given the running app on surface 0 with committed domains, then rows render `[checkbox] hostname` with the checkbox checked iff `alwaysOn`.
- Given an unchecked domain, when the user clicks its checkbox then Apply (one admin prompt), then `config.json` + `/etc/hosts` reflect the toggle (the domain's 4 lines appear/disappear per `alwaysOn`).
- Given a domain toggled off then on (net = committed), then `staged` reverts to `null` and Apply disables (no redundant prompt).
- Given `committed.domains` is empty, then the empty-state text shows (no Add button).
- Given the blocklist surface, then Tab order is checkbox→domain per row, checkboxes expose `accessibilityRole="checkbox"` + checked state, and VoiceOver announces "Blocklist, N domains, M always-on" on entry.
- Given any domain-layer code, then it imports ShellRunner/ConfigStore only via the ports and never `child_process`/`fs`/`os`.

## Design Notes

- **Apply is in 2-1 (scope note — confirm at CHECKPOINT 1):** `effectiveBlocklist` already filters by `alwaysOn` (`effectiveBlocklist.ts:33-36`, from 1.6) and `runApply` already writes config + hosts (1.6). So 2-1's toggle, once Applied, changes the hosts write end-to-end with no new privileged code. A toggle with no Apply button would be a dead feature, so Apply is included here. This overlaps 2-3's "Apply integration"; 2-3's remaining scope (the "N changes staged" pulse/hint, effective-state display) should be revisited at 2-3 planning.
- **Why clean-revert on toggle:** a toggle that nets to committed would otherwise leave `staged` = committed-equivalent, and Apply would fire an admin prompt to write an identical `/etc/hosts`. Clearing `staged` to `null` when the draft equals `committed.domains` mirrors `stageDomainAdd`'s no-redundant-Apply principle.
- **Why render `staged ?? committed.domains`:** the toggle is optimistic — the user sees the pending toggle immediately; Apply commits; Cancel reverts. Same staged-then-Apply model as 1.6.
- **Why a `Checkbox` primitive:** reused by 2-2/2-4 and keeps the `accessibilityRole`/`accessibilityState` contract in one place.
- **Golden example — committed `[{example.com,true},{test.com,false}]`:** surface 0 shows two rows; `example.com` checked, `test.com` unchecked. Toggle `test.com` on → `staged = [{example.com,true},{test.com,true}]`, Apply enabled. Apply → `config.json` updated, `/etc/hosts` now blocks `test.com` (4 lines added). Toggle `test.com` off again → `staged` reverts to `null` (equals committed), Apply disables.

## Verification

**Commands:**
- `pnpm typecheck` (`tsc --noEmit`) -- expected: exit 0.
- `pnpm test --watchman=false -- store Blocklist` -- expected: the two suites pass.

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds.
- On surface 0: committed domains render with alwaysOn checkboxes; toggle one + Apply (admin prompt) → `/etc/hosts` reflects the toggle; toggle twice → Apply disables. **Back up `/etc/hosts` before, restore after.**

## Suggested Review Order

**The Blocklist surface (entry point)**

- The rendered list is the optimistic draft, else committed — the whole staged-then-Apply model in one line.
  [`Blocklist.tsx:50`](../../src/components/Blocklist.tsx#L50)

- Empty state gates on committed-empty AND no staged draft (a staged draft renders its rows even on empty committed).
  [`Blocklist.tsx:53`](../../src/components/Blocklist.tsx#L53)

- Mount announce speaks "Blocklist, N domains, M always-on" on entry (AC; Shell's announce stays hardcoded per the frozen Never clause).
  [`Blocklist.tsx:60`](../../src/components/Blocklist.tsx#L60)

- Rows render staged-then-committed domains; each checkbox disabled while an Apply runs.
  [`Blocklist.tsx:79`](../../src/components/Blocklist.tsx#L79)

- Apply disabled when running or clean; Cancel only when a staged draft exists.
  [`Blocklist.tsx:89`](../../src/components/Blocklist.tsx#L89)

**The toggle mutation — staged, clean-revert**

- `stageAlwaysOnToggle` builds on `staged ?? committed`, flips the match, new array ref, clean-reverts to null.
  [`store.ts:123`](../../src/domain/store.ts#L123)

- Clean-revert: if the post-toggle draft equals committed, `staged → null` (no redundant admin prompt).
  [`store.ts:146`](../../src/domain/store.ts#L146)

- `draftEqualsCommitted`: hostname + alwaysOn equality, order-sensitive (correct for `Domain`'s two fields today).
  [`store.ts:282`](../../src/domain/store.ts#L282)

**Row + checkbox primitives — the a11y contract**

- Checkbox: macOS checkbox role + checked/disabled state + focus ring; reused by 2.2/2.4.
  [`Checkbox.tsx:50`](../../src/components/Checkbox.tsx#L50)

- DomainRow: checkbox first so Tab order is checkbox→domain; hostname is its own focusable stop.
  [`DomainRow.tsx:44`](../../src/components/DomainRow.tsx#L44)

**Shell wiring**

- Surface 0 renders `<Blocklist/>` instead of the placeholder — the one-line integration.
  [`Shell.tsx:95`](../../src/components/Shell.tsx#L95)

**Peripherals — tests**

- `stageAlwaysOnToggle`: on/off, builds-on-draft, new ref, clean-revert, not-found.
  [`store.test.ts:153`](../../__tests__/store.test.ts#L153)

- Blocklist surface: render, toggle wiring, Apply/Cancel gating, empty state, mount announce, Tab order, disabled-while-running.
  [`Blocklist.test.tsx:160`](../../__tests__/Blocklist.test.tsx#L160)

- Shell→Blocklist integration: surface-0 content renders + navigate-away-and-back remount (pins the Shell.tsx wiring).
  [`Shell.test.tsx:350`](../../__tests__/Shell.test.tsx#L350)