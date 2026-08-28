---
title: 'Schedule surface with enable toggle and summary (Story 5.1)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: '9baa2cc'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Schedule surface (⌘3) is a placeholder — there is no way to see the schedules in `config.json`, toggle one on/off, or tell at a glance what it does. The `Schedule` schema has existed since 1-4 (`types.ts:26-39`, `Config.schedules`), and schedule enable-toggle is block-affecting per AD-6, so it must ride the staged-then-Apply pipeline — but the staged buffer is domains-only (`DomainState.staged`, store.ts:124).

**Approach:** Build the Schedule surface: rows `[enable-checkbox] name · plain-English summary · [edit] [delete]`, summary derived live by a new pure formatter, empty state per the AC, and the Apply/Cancel controls following the Blocklist pattern. Extend the store with a parallel `stagedSchedules` buffer and `stageScheduleEnabledToggle(id)` mirroring `stageAlwaysOnToggle` (new array ref + clean-revert), and widen the Apply path so one `writeConfig` carries both `domains` and `schedules`. Add/edit/delete controls are present but announce-only placeholders — the editor is 5.2, the confirm is 5.5.

## Boundaries & Constraints

**Always:**
- Rows render from `stagedSchedules ?? committed.schedules` (optimistic, Blocklist precedent). Summary derives live from the rendered state, never from a stale copy.
- `stageScheduleEnabledToggle(id)` mirrors `stageAlwaysOnToggle` exactly (store.ts:498-526): base = `get().stagedSchedules ?? get().committed.schedules`, flipped copy is a NEW array reference, clean-revert to `null` when the result equals `committed.schedules` (compare by `id` + all fields), synchronous `WriteResult` return, `{ok:false, error:'not-found'}` for an unknown id. No port calls, no gate, no toast.
- The enable control is a macOS checkbox (`Checkbox.tsx` reuse, `accessibilityRole="checkbox"`), never a switch.
- Apply: `runApply` gains `stagedSchedules` in its input; ONE `writeConfig` carries `domains` AND `schedules` (config → hosts order unchanged — hosts payload from `effectiveHostsLines(nextConfig)`; content is unchanged until 5.3's effectiveBlocklist reservation is filled, and that is fine — the write is idempotent and keeps 5.3 from ever touching the apply contract). `apply()` snapshots both buffers, advances `committed` per field, clears each buffer only if still identical (mid-run-edit guard, duplicated per field). Schedule Apply button gates on `stagedSchedules != null`; domain staged edits and schedule staged edits have SEPARATE Apply/Cancel controls on their own surfaces.
- New `cancelStagedSchedules()` clears only the schedule buffer — the domain buffer is untouched and vice versa.
- The formatter is a pure helper in `src/domain/` and is TOTAL: it never throws on a malformed schedule (missing/non-string times render raw; unknown weekday indices are dropped). Canonical order Mon→Sun, de-duplicated. Summary grammar: all 7 weekdays → `Every day, 09:00–17:00`; contiguous run → `Every Mon–Fri, 09:00–17:00`; single day → full name `Every Monday, 09:00–17:00`; mixed → `Every Mon, Wed–Thu, Sat, 09:00–17:00`; empty weekdays → time only `09:00–17:00`. Times pass through as `HH:mm` joined by `–` (en dash).
- Empty state shows exactly: "No schedules yet. Add one to block on a recurring weekly window." with a primary "Add…" button.
- Tab order within a row is enable → name → edit → delete (mount order, DomainRow discipline); VoiceOver announces each schedule's name AND summary on the row, and a mount announce on surface entry.
- Edit/delete/Add buttons are announce-only placeholders (4.3 `END_EARLY_PLACEHOLDER_TOAST` precedent: `AccessibilityInfo.announceForAccessibility` + a small placeholder toast), each labelled for its future owner in a comment.

**Ask First:**
- Any reorder of `runApply`'s config→hosts order (apply.ts:12-16 says Ask First).
- Replacing the two-buffer design with a unified staged-config draft object (a bigger schema change touching Blocklist; keep only if the two-buffer shape proves unworkable).
- Any real editor sheet, confirm alert, or gate on enable/add (5.2/5.5 own them).

**Never:**
- No changes to `effectiveBlocklist.ts` (the 5.3 reservation comment stays), no schedule-window evaluation, no live transitions, no `launchd`, no new dependencies, no `SurfaceIndex`/`SURFACE_NAMES` changes (fixed 4-tuple), no password gate anywhere on this surface, no deletion or mutation of `Schedule`'s type shape, no direct `committed`/hosts writes bypassing the queue.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Rows render | `committed.schedules` non-empty, nothing staged | Each row: `[checkbox] name · summary · [edit] [delete]`; mount VoiceOver announce lists the surface | N/A |
| Enable toggle | press checkbox on row i | Staged array flips `enabled` for that id (new ref); Apply button pulses with "N changes staged"; clean-revert when toggled back to committed | N/A |
| Schedule Apply | `stagedSchedules` non-null | ONE config write carrying both fields, then hosts write; `committed.schedules` advances; buffer cleared; `lastResult` set | Deny/throw: staged retained, `applyStatus: 'idle'`, failure toast |
| Toggle back to committed | flip `enabled` back before Apply | `stagedSchedules` → null (clean-revert); Apply disabled again | N/A |
| Cancel (Schedule) | staged schedules exist | Only schedule buffer cleared; Blocklist staged edits untouched | N/A |
| Cross-surface independence | domain edit staged AND schedule edit staged | Two buffers; each surface's Apply/Cancel touches only its own; ONE Apply call commits both fields to config | N/A |
| Empty state | no schedules | AC copy + primary Add… placeholder button | N/A |
| Malformed schedule element | hand-edited config (missing fields, bad weekdays) | No crash; row renders; summary total (never throws) | Fail-safe |

</frozen-after-approval>

## Code Map

- `src/components/Blocklist.tsx:74-98,127-146,160-180` — THE PRECEDENT: store reads, `staged ?? committed` render, `stagedChangeCount` hint, mount announce, empty state, Apply/Cancel controls row. Mirror its shape.
- `src/components/DomainRow.tsx:57-118` — row pattern: hover `Pressable` (`focusable={false}`) wrapping Checkbox → label → revealed remove button; Tab order by mount order.
- `src/components/Checkbox.tsx:42-60`, `ApplyButton.tsx` — reuse as-is (macOS checkbox, pulse/busy props).
- `src/domain/store.ts:124,449` — `DomainState.staged: Domain[] | null` + init: the schema this story extends. `:498-526` `stageAlwaysOnToggle` (the toggle template); `:560` `cancelStaged`; `:562-607` `apply()` (snapshot → enqueue → runApply → per-field clear); `:96` `HOSTS_FAILURE_TOAST`.
- `src/domain/apply.ts:12-16,32-41,53-86` — `runApply` contract (domains-only today; config→hosts order is Ask First).
- `src/domain/stagedChangeCount.ts:29-59` — domain-shaped count helper; schedules need their own (identity = `id`, field-level diff).
- `src/components/Shell.tsx:279-320` — surface ternary: add `surface === 2 ? <Schedule/>` before the placeholder. `:52-61,169-224` — ⌘3 already routes (Shell.test.tsx:395).
- `src/components/surfaces.tsx:41-56` — `EMPTY_STATE_TEXT[2]` must be replaced with the AC copy.
- `src/config/types.ts:22-39,64` — `Schedule`, `Weekday`, `Config.schedules` (frozen under `DEFAULT_CONFIG`, types.ts:79-102 — build new arrays, never mutate).
- `src/config/configStore.ts:71-81` — schedules shape-gate (array-level only; elements unvalidated → normalise defensively).
- Tests: `__tests__/Blocklist.test.tsx` (helpers `extractText` :53, checkbox-by-contract lookup :76-80, staged/toggle/empty/tab-order/announce tests :179-474, staged-hint :629-670), `__tests__/store.test.ts` (mock factories :21-40, `flushMicrotasks` :59, toggle+apply matrices :197-441/:693-955), `__tests__/Shell.test.tsx:292,395`.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/scheduleSummary.ts` (NEW) — pure `formatScheduleSummary(schedule: Schedule): string` implementing the frozen grammar; total function, canonical weekday ordering.
- [x] `src/domain/stagedScheduleChangeCount.ts` (NEW) — count of schedules whose `id` exists in one list but not the other, or whose fields differ; singular/plural handled by the caller.
- [x] `src/domain/store.ts` — `stagedSchedules: Schedule[] | null` on the store state; `stageScheduleEnabledToggle(id)`; `cancelStagedSchedules()`; extend `apply()` + `runApply` input so one config write carries both buffers.
- [x] `src/domain/apply.ts` — `ApplyInput` gains `stagedSchedules`; `writeConfig` spreads both fields.
- [x] `src/components/Schedule.tsx` (NEW) + `src/components/ScheduleRow.tsx` (NEW) — the surface: rows, summaries, enable checkboxes, placeholder Add/edit/delete, empty state, Apply/Cancel + "N changes staged" hint, mount announce.
- [x] `src/components/Shell.tsx` + `src/components/surfaces.tsx` — wire `surface === 2`; replace `EMPTY_STATE_TEXT[2]` with the AC copy.
- [x] `__tests__/scheduleSummary.test.ts`, `__tests__/stagedScheduleChangeCount.test.ts` (NEW); `__tests__/Schedule.test.tsx` (NEW) — rows/toggle/empty/announce/Tab order/staged hint per the Blocklist test idioms; `__tests__/store.test.ts` — toggle (new-ref, clean-revert, not-found), apply (both-fields commit, per-field mid-run guard, deny retains staged), cancel isolation.

**Acceptance Criteria:**
- Given schedules exist in config, when the Schedule surface opens (⌘3), then each row shows `[enable-checkbox] name · summary · [edit] [delete]` with the summary derived live from state, and Tab order is enable → name → edit → delete.
- Given a row's checkbox is pressed, when Apply is pressed on the Schedule surface, then ONE config write carries the toggled schedules (and any staged domains), hosts are rewritten via the existing pipeline, and the change survives a relaunch.
- Given the toggle is pressed and un-pressed with no other edit, when state is inspected, then `stagedSchedules` is null (clean-revert) and Apply is disabled.
- Given no schedules exist, when the surface opens, then the empty state and primary "Add…" placeholder render.
- Given staged schedule edits, when Blocklist's staged edits also exist, then each surface's Apply/Cancel affects only its own buffer while one Apply commits both fields.
- Given a VoiceOver user, when the surface renders, then each schedule and its summary are announced.

## Spec Change Log

- **08-28 (step-04 review patches, `review_loop_iteration: 0` — no loopback):** 3 hunters returned 29 unique findings; 10 patched, 1 deferred, 18 rejected.
  - **BH-1 (high, patched):** the frozen matrix's "failure toast" on Apply deny/throw was unimplemented — `apply()` set only `lastResult`, which nothing consumed. `apply()`'s failure branch now raises the standard `HOSTS_FAILURE_TOAST` error toast (store-level, so a denied Blocklist Apply gets the same feedback; the epic context's "admin-denied shows the standard toast" row). Pinned in `store.test.ts` (deny + config-fail).
  - **VG-1 (high, patched):** no test covered a domains-only Apply with NON-empty `committed.schedules` — the regression `schedules: stagedSchedules ?? []` wiped schedules on disk while passing every test. Added pins in `apply.test.ts` + `store.test.ts` asserting the clean schedule slice carries non-empty committed schedules verbatim into the written config.
  - **BH-5 (med, patched):** the epic context pins the Schedule Apply as Return-bound; `Shell.tsx`'s bare Return now also fires `apply()` on surface 2 when `stagedSchedules != null` (gated with the same viewer/gate guards; no add-field guard — surface 2 has no field). Shell tests added for both directions.
  - **EC-4/BH-9 (med, patched):** unified schedule equality — `scheduleDraftEqualsCommitted` (store.ts) now reuses the exported `scheduleValueKey` from `stagedScheduleChangeCount.ts`, and the key is `JSON.stringify`-encoded (injective on values) instead of a `|`/`,` join, so separator-bearing names can never alias across field boundaries. One canonical equality definition for both the hint counter and the clean-revert.
  - **BH-2 (med, patched):** Blocklist reverse-isolation test — a dirty schedule buffer alone does not enable Blocklist Apply or show its hint.
  - **BH-17 (med, patched):** toggle→hint integration test (press checkbox → "1 change staged" + Cancel appear + Apply enables).
  - **BH-3 (med, patched):** the surface test titled "unknown id surfaces not-found" actually pressed a known row — retitled to pin what it tests (the row forwards `schedule.id` as the toggle key); not-found stays unit-pinned in `store.test.ts`.
  - **BH-15 (low, patched):** checkbox `accessibilityLabel` is now state-neutral `Enable {name}` (VoiceOver speaks the state from `accessibilityState`); label assertions updated.
  - **BH-19 (low, patched):** removed the hard-coded `accessibilityState={{ disabled: false }}` from the Add placeholder.
  - **BH-18 (low, patched):** ⌘3 Shell test now also covers a populated config (rows + live summary render); plus the Shell global reset now clears `stagedSchedules` (leak hygiene the new buffer needed).
  - **Deferred (1):** `Shell.selectRow`'s nav announce says "N domains" on the Schedule surface (wrong count noun; pre-existing pattern) → deferred-work.md.
  - **Rejected (18):** duplicate-id/malformed-element class (hand-edited input; 5.2's editor owns id generation; formatter + rows degrade gracefully), value-equal non-null buffer (unreachable via UI — rows disable while `applyStatus === 'running'`; parity with the pre-existing domain-buffer hole), not-found-via-UI, placeholder-timer cleanup (verified present), `PressableGhost` duplication (deliberate, cosmetic), ⌘N dead key (5.2 owns), mid-run cancel (direct-call-only, parity), VoiceOver auto-announces checkbox state, one-Apply-commits-both (frozen matrix mandate), en-dash fail-safe (pinned by test), row grammar = content order, double announce (pre-existing Blocklist-consistent). No `intent_gap` / `bad_spec` → `review_loop_iteration` stays 0.

## Design Notes

- **Why a parallel `stagedSchedules` buffer, not widening `staged`:** `staged` is `Domain[]` in three store actions, `apply.ts`, and every Blocklist test; a discriminated draft would touch all of them. Two sibling buffers mirror the repo's sibling-action idiom (4.6 `endEarly` vs `expireTimer`) and give each surface its own clean-revert. The ONE shared `apply()` keeps the single serialized write path the architecture demands.
- **Why Apply writes hosts even though the payload is unchanged until 5.3:** it keeps the apply contract shape-stable (config+hosts, never config-only for block-affecting mutations) so 5.3 fills the reservation without touching `runApply`. An idempotent identical hosts write is harmless; the admin prompt per Apply is already the accepted UX.
- **Formatter golden examples:** `Mon–Fri 9–17` → `Every Mon–Fri, 09:00–17:00`; `[0,3]` → `Every Monday, Thu, …` style mixed run; `[0..6]` → `Every day, 09:00–17:00`; `[]` → `09:00–17:00`.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/Schedule.test.tsx __tests__/scheduleSummary.test.ts __tests__/stagedScheduleChangeCount.test.ts __tests__/store.test.ts __tests__/Blocklist.test.tsx __tests__/Shell.test.tsx` — new + affected suites green.
- `node_modules/.bin/jest --watchman=false` — full suite green, no regressions. **Actual result (08-28, post-review): 31 suites / 637 tests / 3 snapshots, all pass; tsc clean.** (Pre-review: 628 tests.)

**Manual checks:**
- ⌘3 opens the surface; toggling a schedule shows "1 change staged", Apply commits it, relaunch shows the persisted state; empty state renders on a fresh config.

## Suggested Review Order

**The parallel staged-schedules buffer (the design's core)**

- The buffer's state shape — a parallel `stagedSchedules` sibling, not a widening of `staged`
  [`store.ts:134`](../../src/domain/store.ts#L134)

- `stageScheduleEnabledToggle` — the exact `stageAlwaysOnToggle` mirror: new ref, clean-revert, `not-found`
  [`store.ts:601`](../../src/domain/store.ts#L601)

- `apply()` — both buffers snapshotted, ONE write carries both, per-field mid-run reference guards
  [`store.ts:634`](../../src/domain/store.ts#L634)

- `cancelStagedSchedules` clears only the schedule buffer (cross-surface isolation)
  [`store.ts:598`](../../src/domain/store.ts#L598)

**The single write contract (apply pipeline)**

- `ApplyInput` gains required `stagedSchedules`; a clean slice leaves its committed field untouched
  [`apply.ts:80`](../../src/domain/apply.ts#L80)

- Config→hosts order unchanged; hosts payload still `effectiveHostsLines(nextConfig)` (5.3's reservation)
  [`apply.ts:95`](../../src/domain/apply.ts#L95)

- The VG-1 pin: domains-only Apply preserves NON-EMPTY committed.schedules verbatim
  [`apply.test.ts:352`](../../__tests__/apply.test.ts#L352)

**The surface (UI)**

- Rows render `stagedSchedules ?? committed.schedules`; hint + Apply/Cancel gating on the schedule buffer only
  [`Schedule.tsx:83`](../../src/components/Schedule.tsx#L83)

- Empty state — the AC copy + primary Add… placeholder (5.2 owns the real editor)
  [`Schedule.tsx:55`](../../src/components/Schedule.tsx#L55)

- Row: checkbox first (Tab order enable → name → edit → delete), state-neutral label, hover-revealed controls
  [`ScheduleRow.tsx:92`](../../src/components/ScheduleRow.tsx#L92)

- Return-bound Apply extended to surface 2 (the BH-5 patch); viewer/gate guards preserved
  [`Shell.tsx:230`](../../src/components/Shell.tsx#L230)

- Surface ternary wires ⌘3 to the real component
  [`Shell.tsx:308`](../../src/components/Shell.tsx#L308)

**Pure helpers**

- The frozen summary grammar — total formatter, canonical Mon→Sun, en dash
  [`scheduleSummary.ts:134`](../../src/domain/scheduleSummary.ts#L134)

- Order-agnostic per-id diff; JSON-encoded value key shared with the store's clean-revert
  [`stagedScheduleChangeCount.ts:41`](../../src/domain/stagedScheduleChangeCount.ts#L41)

**BH-1 patch: the Apply failure toast**

- `apply()`'s deny/throw branch raises the standard error toast (previously silent)
  [`store.ts:707`](../../src/domain/store.ts#L707)

**Store tests**

- Toggle family, clean-revert, apply matrices, deny retains both drafts + toast
  [`store.test.ts:3205`](../../__tests__/store.test.ts#L3205)

**Surface + cross-surface tests**

- Rows, optimistic toggle, hint, mount announce, Tab order, placeholders
  [`Schedule.test.tsx:191`](../../__tests__/Schedule.test.tsx#L191)

- Reverse isolation: a schedule draft alone never enables Blocklist's Apply (BH-2)
  [`Blocklist.test.tsx:682`](../../__tests__/Blocklist.test.tsx#L682)

- ⌘3 with populated config renders rows; Return-on-surface-2 both directions
  [`Shell.test.tsx:426`](../../__tests__/Shell.test.tsx#L426)