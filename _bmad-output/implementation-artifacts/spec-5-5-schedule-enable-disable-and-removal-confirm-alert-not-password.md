---
title: 'Schedule enable/disable and removal (confirm-alert, not password) (Story 5.5)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: a49c4ef6f8f7b6e1c616bba1c2d55a983a4452f1
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Disabling a schedule is a one-click lift of recurring blocking, and delete is an announce-only placeholder ("Removing schedules is coming soon." toast, Schedule.tsx:113-144) — the epic requires a confirm alert for both (they are config edits, not escapes, so NO password gate), while adding and re-enabling stay friction-free.

**Approach:** Add `stageScheduleRemove(id)` (the `stageDomainRemove` mirror: staged filter + clean-revert). Replace the delete placeholder in `Schedule.tsx` with a native `Alert.alert` confirm (the 2-4 pattern verbatim), and route the enable checkbox through the same confirm ONLY when the press would disable the row as rendered; enabling dispatches directly. Esc/Cancel never stages.

## Boundaries & Constraints

**Always:**
- Confirm gates the STAGING, never the commit: `Alert.alert(title, message, [{text:'Cancel', style:'cancel'}, {text:'<verb>', style:'destructive', onPress: () => stage…}])` — exactly the Blocklist.tsx:107-120 shape. Cancel is the safe Esc target (no `onPress`, not `isPreferred`).
- Disable confirm: when the row's RENDERED schedule (`stagedSchedules ?? committed.schedules`) has `enabled === true`, pressing the checkbox opens the confirm first; only confirm calls `stageScheduleEnabledToggle(id)`. When rendered `enabled === false` (enabling), dispatch directly — NO confirm (AC exemption).
- `stageScheduleRemove(id: string): WriteResult` mirrors `stageDomainRemove` (store.ts:640-669): base = `stagedSchedules ?? committed.schedules`; not-found → `{ok:false, error:'not-found'}`; `next = base.filter(s => s.id !== id)` (NEW array ref); clean-revert to `null` via `scheduleDraftEqualsCommitted`. No port calls, no gate, no toast.
- Removal is counted by the existing `stagedScheduleChangeCount` (ids-in-committed-not-in-staged) — hint/pulse work unchanged.
- Delete/disable controls stay `disabled={running}` (no staging during Apply); the native alert captures keyboard focus so Shell Return→Apply is inert while it is open.
- Alert copy states the staged effect plainly: title `Delete ${name}?` / `Disable ${name}?`; message names the Apply step ("…This takes effect when you Apply."), mirroring 2-4's microcopy.
- After Apply, the hosts section recomputes via the existing `effectiveHostsLines(nextConfig)` (5-3's schedule contribution) — removing an active schedule shrinks the payload at Apply time, unless domains stay covered.

**Ask First:**
- Any confirm on add or re-enable (frozen exempt).
- Any change to `Shell.tsx` / `KEY_DOWN_EVENTS` (the native alert needs none).
- Any non-native confirm (custom sheet/modal) or password gate.

**Never:**
- No password gate (Epic 3 scope is escapes-only), no immediate commit (staged-only), no `applyStatus`/queue changes, no new ports, no editor changes (5-2 owns), no read-time schedule normalisation (deferred family), no Shell changes, no changes to `stageScheduleEnabledToggle`'s store contract.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete a committed schedule | click row Delete | `Alert.alert('Delete <name>?', …, [Cancel, Delete-destructive])`; Delete → `stageScheduleRemove(id)` → row vanishes, "1 change staged", Apply pulses | N/A |
| Cancel delete (Esc/Cancel) | alert open | no staging; row stays; buffers unchanged | N/A |
| Uncheck enabled schedule | rendered `enabled === true`, press checkbox | confirm alert; confirm → `stageScheduleEnabledToggle(id)` stages the disable; checkbox flips only then | N/A |
| Check disabled schedule | rendered `enabled === false` | NO alert; direct `stageScheduleEnabledToggle(id)` | N/A |
| Remove a staged addition (clean-revert) | schedule added via editor, then deleted | `stagedSchedules` clean-reverts to `null`; no hint; Apply disabled | N/A |
| Staged-disable then re-check | staged-disabled row, press checkbox | enabling is exempt → direct toggle → clean-revert if net-zero | N/A |
| Remove during Apply | `applyStatus === 'running'` | delete/checkbox disabled → no alert | N/A |
| Remove unknown id | `stageScheduleRemove('ghost')` (not via UI) | `{ok:false, error:'not-found'}`, buffer unchanged | defensive |
| Remove an ACTIVE schedule + Apply | its window is active at Apply time | hosts payload drops its domains (unless covered by always-on/timer/another schedule) | existing deny/throw posture |
| Alert open + bare Return | `stagedSchedules != null` | native alert holds focus → Shell Return→Apply inert | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts:152,161,640-669,673-706` — EDIT. Add `stageScheduleRemove` to `DomainState` (interface near :225) + implementation mirroring `stageDomainRemove` with `scheduleDraftEqualsCommitted` for the clean-revert. `stageDomainRemove` is the template; `stageScheduleEnabledToggle` (:675-706) is the sibling.
- `src/components/Schedule.tsx:75-141,144,196-205,230-236` — EDIT. Replace `handleDelete` + `DELETE_PLACEHOLDER_TEXT` + the placeholder-toast machinery (`placeholderToast`, `placeholderTimerRef`, `showPlaceholder`, render block) with `handleDelete(id, name)` → `Alert.alert` (Blocklist.tsx:100-120 shape); add `handleToggleEnabled(schedule)` with the disable-confirm branch; subscribe `stageScheduleRemove`. Verify the placeholder toast has no other consumer (Add/Edit are real since 5-2) — if so, delete the machinery wholesale.
- `src/components/ScheduleRow.tsx:34-57,93-103,140-157` — EDIT (small). The delete `Pressable` is already real (destructive tint, a11y label); update the 5-5 placeholder comment (:140-143); widen `onToggleEnabled` to pass the schedule (or add the name lookup) so the surface can branch — keep Tab order enable → name → edit → delete.
- `src/components/Blocklist.tsx:100-120,155` — READ-ONLY. The confirm-alert pattern to mirror verbatim.
- `src/domain/stagedScheduleChangeCount.ts:75,100-105` — READ-ONLY. Removal already counted.
- `src/components/Shell.tsx` — UNCHANGED. Native alert handles Esc + focus capture (2-4 precedent).
- Tests: `__tests__/Blocklist.test.tsx:831-960` — the Alert-spy idiom (`jest.spyOn(Alert, 'alert')`, invoke button `onPress`); mirror test names. `__tests__/Schedule.test.tsx:212-662` — REPLACE the delete-placeholder test (:611); toggle tests (:281-330) gain the confirm branch. `__tests__/store.test.ts` — `stageDomainRemove` family is the mirror for the new action's tests. `__tests__/stagedScheduleChangeCount.test.ts` — removal-counting already pinned.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/store.ts` -- add `stageScheduleRemove(id)` (filter + clean-revert + not-found, the `stageDomainRemove` mirror) -- staged removal.
- [x] `src/components/Schedule.tsx` -- delete-confirm `Alert.alert` replacing the placeholder toast; enable-checkbox confirm-on-disable branch; subscribe `stageScheduleRemove` -- the confirm gate.
- [x] `src/components/ScheduleRow.tsx` -- pass what the surface needs for the disable branch; placeholder-comment cleanup -- the trigger wiring.
- [x] `__tests__/store.test.ts` -- `stageScheduleRemove`: remove committed (count 1, new ref), not-found, clean-revert of a staged addition, multi-edit draft, remove-active-schedule + Apply payload pin (lines drop).
- [x] `__tests__/Schedule.test.tsx` -- replace the placeholder test with: delete alert shape + confirm stages + cancel/Esc no-stage; disable-confirm on uncheck; enable-direct (no alert); disabled-while-running; checkbox does not flip before confirm.

**Acceptance Criteria:**
- Given `node_modules/.bin/tsc --noEmit` and the full jest suite (native specs mocked), then both pass.
- Given an enabled schedule, when the user unchecks it or clicks Delete, then a native confirm alert (not a password gate) appears; Esc/Cancel leaves every buffer untouched.
- Given confirm, then the change is staged (row vanishes / checkbox flips), "N changes staged" shows, Apply pulses; Apply commits to config and the hosts payload recomputes (an active schedule's domains lift unless covered).
- Given a disabled schedule, when the user checks it, then it stages directly with no alert; given ⌘N/Add, then no confirm (5-2 path untouched).
- Given the only staged change is a newly added schedule, when the user deletes it, then `stagedSchedules` clean-reverts to null (no hint, Apply disabled).

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Do not modify or delete existing entries. -->

- **08-29 (step-04 review patches, `review_loop_iteration: 0` — no loopback):** 3 hunters returned 22 raw findings (Blind Hunter 14, Edge Case Hunter 6, Verification Gap 2); after claim-by-claim verification and dedup, 6 patched, 1 deferred, 15 rejected. Post-patch verification: tsc clean; **36 suites / 822 tests / 3 snapshots** green (+3 over step-03's 819).
  - **P1 (med, patched):** the disable-confirm alert's SHAPE was never asserted (only its staging side-effects) — a copy regression or `isPreferred: true` on the destructive Disable button would ship undetected while the sibling delete alert was fully pinned. New shape test mirrors the delete one (title, message text, Cancel/cancel + Disable/destructive, `isPreferred` falsy); the blind `buttons[1].onPress()` invocations now assert the button's `text` first, and the test helper types `style` as RN's `AlertButtonStyle` union.
  - **P2 (med, patched):** stale docblocks contradicted the new flow — `Schedule.tsx`'s header "calls ONLY stageScheduleEnabledToggle…" list and "Optimistic toggle… shows immediately" paragraph, the `:100-102` re-render-immediately comment, and `ScheduleRow`'s "(the optimistic staging toggle)" phrase. All corrected (a disable now waits for the confirm).
  - **P3 (med, patched):** the Design Note's mixed-state direction (unchecking a STAGED-ENABLED newly-added row IS a disable and confirms) had no test — only the opposite direction was pinned. New test stages an editor addition, unchecks, asserts the alert fires and nothing flips before the confirm.
  - **P4 (med, patched):** the delete recovery path (confirm Delete → row vanishes → Cancel-staged restores the row, clears the hint, disables Apply) had no surface test. Added.
  - **P5 (low, patched):** the confirm-Delete test asserted `disabled === false` but not `pulse === true` — the AC's "Apply pulses" is now fully pinned.
  - **P6 (low, patched):** the interface JSDoc and impl comment for `stageScheduleRemove` duplicated the same rationale verbatim; impl comment trimmed to point at the interface doc, and the confusing "(referenced by NAME above)" phrase reworded.
  - **Test-env fixes (test-only, required by P3/P4):** (a) a zustand `jest.spyOn` on a store action bleeds via `set`-spread into later tests' state objects — `mockRestore()` leaves dead no-op wrappers; the suite now captures the real action and re-seeds it after restore. (b) `jest.mock('react-native/Libraries/ReactNative/RendererProxy')` overriding only `findNodeHandle` → `null` — the jest env's react 19.1.4 vs RN 0.81.2's bundled renderer shim (expects 19.1.0) throws at `AnimatedProps` connect when a pulsing ApplyButton re-renders; `null` is exactly RN's own `NODE_ENV=test` fallback. No production behaviour changed.
  - **Deferred → deferred-work.md:** the clean-revert-mid-Apply interaction (a staging action reverting its buffer to null while an Apply holds a non-null snapshot lets the run commit the snapshot over the reverted state) — direct-call-only (rows disable while `running`), and the identical latent shape pre-exists in `stageDomainRemove` (2-4) and `stageScheduleEnabledToggle` (5-1); a family-level fix.
  - **Rejected after verification (notable):** ignored `WriteResult` in the alert `onPress` (defensive-only — the native alert is modal and rows disable while running, so `not-found` is unreachable via the UI; exact 2-4 parity where `Blocklist` ignores it too); stale-schedule-between-alert-and-confirm (same modal analysis — nothing can mutate the draft while the sheet is open); duplicate-id filter drop (hand-edited-config class, 5-1's rejected malformed family; 5-2's `nextScheduleId` uniquifies); VoiceOver silence after a confirmed delete (2-4's Blocklist removal is equally silent — parity; the hint's lack of a live region is 5-1's pre-existing shape); mid-run e2e removal test (UI-unreachable, reference-identity pin is the testable contract); plural-hint-by-removal surface test (composition of the store-level count pin and the existing plural grammar test); `onDismiss`/`cancelable` testing (we never pass a callback — a native dismiss is a no-op by construction, Esc covered by the manual native check); test-helper TypeError-before-alert (deterministic — every test fires the alert first). No `intent_gap` / `bad_spec` → `review_loop_iteration` stays 0.

## Design Notes

- **Why native `Alert.alert`:** the 2-4 decision, unchanged — free Esc + focus capture (Shell Return-gate inert), macOS-native, zero modal infra. Trade-off: not themeable; accepted for a system confirm.
- **Why the confirm branches on the RENDERED state:** the row shows `stagedSchedules ?? committed.schedules`; a staged-disabled row that is re-checked is "enabling" (exempt), and a staged-enabled (newly added) row that is unchecked IS a disable (confirm) — using the rendered `schedule.enabled` keeps the exemption semantics correct in both mixed states.
- **Why `stageScheduleRemove` has clean-revert:** deleting a schedule that exists only in the staged buffer (added via the editor, not yet Applied) must return to net-zero (`stagedSchedules` null, no pulsing Apply) — the exact 2-4 remove-a-staged-addition case.
- **Golden example** — committed enabled schedule "Work". Uncheck → "Disable Work?" alert → Disable → checkbox flips off, "1 change staged", Apply pulses → Apply → config + hosts updated. Delete → "Delete Work?" → Delete → row vanishes, hint/Apply as above. Either alert + Esc → nothing staged.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors. **Actual (08-29, step-03): clean.**
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions; record actual counts. **Actual (08-29, post-review): 36 suites / 822 tests / 3 snapshots, all passing** (store suite 165 → 172; Schedule.test.tsx placeholder test replaced + toggle family reworked around the Alert spy; +16 tests over 5-4's 806 — 13 at step-03, +3 review patches P1/P3/P4).

**Matrix Test Audit (2026-08-29, step-03):** all 10 frozen matrix rows covered by passing tests in the green run above — Delete a committed schedule (`Schedule.test.tsx:672` alert shape + `:702` confirm stages/row vanishes/hint); Cancel delete (`:732` — no staging, buffers untouched); Uncheck enabled (`:311` confirm-only staging incl. checkbox-does-not-flip-before-confirm, `:355` by-id, `:378` hint integration); Check disabled (`:766` direct, no alert); Remove a staged addition clean-revert (`store.test.ts:4103`); Staged-disable then re-check (`:790` direct — rendered-state branch); Remove during Apply (`:816` both controls disabled); Remove unknown id (`store.test.ts:4150` clean + `:4162` with draft); Remove an ACTIVE schedule + Apply (`store.test.ts:4176` — payload pin, fake timers); Alert open + bare Return (native-sheet focus capture — NOT Jest-testable, the 2-4 precedent posture: verified via the unchanged `Shell.tsx` diff + the manual native check below). All ran and passed; no expectations were edited to match code.

**Manual checks:**
- `pnpm macos` — uncheck an enabled schedule → native alert; Esc cancels; Disable stages + Apply persists; check a disabled schedule → no alert; Delete → alert → row vanishes; Apply → `config.json` reflects it. Back up `/etc/hosts` before, restore after.

## Suggested Review Order

**The staged removal (store)**

- `stageScheduleRemove` — the `stageDomainRemove` mirror: filter, new ref, clean-revert, not-found.
  [`store.ts:729`](../../src/domain/store.ts#L729)

- The removal family: remove committed (count 1), multi-edit draft, clean-revert of an editor addition, new ref, not-found ×2, and the active-schedule + Apply payload pin.
  [`store.test.ts:4036`](../../__tests__/store.test.ts#L4036)

**The confirm gates (surface)**

- Delete: native `Alert.alert` → `stageScheduleRemove`; the 2-4 shape verbatim.
  [`Schedule.tsx:133`](../../src/components/Schedule.tsx#L133)

- Enable toggle: confirm only when the RENDERED `enabled === true`; enabling goes direct (AC exemption).
  [`Schedule.tsx:156`](../../src/components/Schedule.tsx#L156)

- The row forwards the whole rendered schedule + id/name; Tab order untouched.
  [`ScheduleRow.tsx:97`](../../src/components/ScheduleRow.tsx#L97)

**The review-hardened tests**

- The disable-alert shape pin (P1): title/message/buttons/isPreferred.
  [`Schedule.test.tsx:379`](../../__tests__/Schedule.test.tsx#L379)

- The mixed-state pin (P3): unchecking a staged-enabled addition confirms.
  [`Schedule.test.tsx:922`](../../__tests__/Schedule.test.tsx#L922)

- The recovery path (P4): confirm Delete → Cancel-staged restores the row.
  [`Schedule.test.tsx:804`](../../__tests__/Schedule.test.tsx#L804)

- The test-env shims (zustand spy re-seed + RendererProxy `findNodeHandle` → `null`) with the root-cause comments.
  [`Schedule.test.tsx:98`](../../__tests__/Schedule.test.tsx#L98)