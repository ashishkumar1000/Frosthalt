---
title: 'Schedule editor sheet (Story 5.2)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: 'a7620d8'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Schedule Add/Edit are announce-only placeholders (5.1), and the frozen `Schedule` schema (1-4) has no `domains` field even though FR-11 and 5.3's AC require "the schedule's domains".

**Approach:** Build the editor sheet (scrim+panel, the `PasswordGate`/`HostsViewer` pattern): name, weekday chips (Mon–Sun, 0=Mon), start/end time entry, domain multi-select, live summary. Save stages ONE `Schedule` via new `stageScheduleUpsert` (staged-then-Apply; FR-15-exempt — no gate); Cancel/Esc discards. Extend `Schedule` with `domains: string[]` (5.3 consumes it). Library pin: NO new dependency — time entry is validated `HH:mm` text inputs (`@react-native-community/datetimepicker` has no macOS support; react-native-macos 0.81 ships no picker). Delete stays a placeholder (5.5).

## Boundaries & Constraints

**Always:**
- Editor is Shell-hosted: `scheduleEditorTarget: 'new' | string | null` in Shell.tsx, mounted after the overlays, before the toast (`HostsViewer` precedent). `Schedule` gets `onAddSchedule`/`onEditSchedule` props; row edit + empty-state Add… invoke them.
- ⌘N on surface 2 opens the ADD editor (no-op while already open; other surfaces keep the existing focus behaviour). A bare-Escape branch closes the editor (gate branch stays first); bare Return is gated with `!editorOpen` alongside `!viewerOpen && !gateOpen`.
- `stageScheduleUpsert(schedule): WriteResult` mirrors `stageDomainAdd` + `stageScheduleEnabledToggle`: invalid input → `{ok:false, error:'invalid-schedule'}` (empty name, 0 weekdays, 0 domains, unparseable time, end ≤ start); builds on `stagedSchedules ?? committed.schedules`; replaces the same-`id` schedule in place, else appends; new array reference when it mutates; clean-revert to `null` when the result equals `committed.schedules` (order-agnostic, via `scheduleValueKey`). No ports, no gate, no toast.
- The sheet is a scratchpad: NOTHING stages until Save. Save builds the final `Schedule` (existing id when editing; `nextScheduleId(name, existingIds)` when adding), calls `stageScheduleUpsert`, closes, and announces "Schedule staged. Apply to save."
- `Schedule.domains: string[]` holds normalised hostnames; every read defends with `Array.isArray` (missing → `[]`) — configStore validates the schedules ARRAY only. `scheduleValueKey` MUST include domains, or a domain-only edit can never clean-revert.
- `normaliseTime(raw)` in `src/domain/normalise.ts` — pure, total (`HH:mm | null`): trim, `H:mm`/`HH:mm`, hour ≤ 23, minute ≤ 59, zero-pads. The editor calls it live in render (the `AddDomain.tsx` precedent) and the store re-runs it — single source of truth.
- Same-day windows only: end strictly after start (zero-padded `HH:mm` compares lexically = chronologically).
- Weekday chips and domain rows are `Pressable` + `accessibilityRole="checkbox"` + `accessibilityState={{checked}}`; Save is disabled with per-field inline errors while invalid; the summary line renders live via `formatScheduleSummary` on the in-progress draft (time-only at 0 weekdays — never throws).
- Domain list = `committed.domains` UNION the edited schedule's own domains (deduped, committed order first), so an orphaned domain (removed from the blocklist, still scheduled) stays visible and keeps membership — the timer precedent: a schedule's set is independent of the blocklist.
- Empty blocklist → short note in the domain section, Save disabled. Editing pre-fills from the rendered (staged ?? committed) schedule; a net-identical Save triggers clean-revert, not a redundant admin prompt.

**Ask First:**
- Any change to the frozen `Schedule` fields other than adding `domains`.
- Any native picker or new dependency for time entry (renegotiate the pin).
- Any delete/confirm UI (5.5) or gate on add/edit (FR-15 exempts both).

**Never:**
- No changes to `effectiveBlocklist.ts` or any window evaluation (5.3's reservation stays), no `scheduleEval`, no live transitions (5.4), no delete confirm (5.5), no password gate on this sheet, no direct config/hosts commits, no `SurfaceIndex` changes, no overnight windows.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Open add | ⌘N on surface 2 or Add… | Sheet opens, empty draft, name focused | N/A |
| Open edit | edit on row i | Pre-filled from rendered state | N/A |
| Live summary | any field changes | Summary updates live; time-only at 0 weekdays | N/A |
| Save valid | all fields valid | ONE `stageScheduleUpsert`; sheet closes; rows show staged draft + hint; announce | N/A |
| Save invalid | empty name / 0 weekdays / 0 domains / bad time / end ≤ start | Save disabled; inline error names the field | Fail-safe |
| Cancel / Esc | sheet open | Closes; `stagedSchedules` untouched | N/A |
| Net-identical edit | revert every field before Save | Clean-revert → `stagedSchedules` null | N/A |
| id collision | generated id exists | `nextScheduleId` uniquifies `-2`, `-3`, … | N/A |
| Orphaned domains | schedule references removed domains | Shown + selected via union list; membership retained | Fail-safe |
| Empty blocklist | `committed.domains` [] | Note renders; Save disabled | N/A |
| ⌘N while open | editor open | No-op | N/A |
| Return while open | bare Return | NOT an Apply (gated in Shell) | N/A |

</frozen-after-approval>

## Code Map

- `src/components/PasswordGate.tsx:176-181,278-295` + `src/components/HostsViewer.tsx:94-95,157-178` — the sheet pattern: scrim (absolute, inset 0, rgba .4) + panel (`monoBg`, rounded.lg, maxWidth); plain View, NO accessibilityRole; `onClose` prop; no animation. PasswordGate autofocus :111-113.
- `src/components/Shell.tsx` — `viewerOpen` :91; Esc branches :181-194 (gate first); ⌘N :199-202; Return gate :224-234; sheet mounts :343-348 (toast :349+); `KEY_DOWN_EVENTS` :54-63.
- `src/components/Schedule.tsx` — placeholder copy :58-68, handlers :125-131, empty-state Add… :156-169, row wiring :174-183. `src/components/ScheduleRow.tsx` — props :33-56, edit Pressable :125-138.
- `src/domain/store.ts` — `stageScheduleEnabledToggle` :601-632 (build-on-draft + new-ref + clean-revert template); `stageDomainAdd` :501-533; `cancelStagedSchedules` :599; `scheduleDraftEqualsCommitted` :1425-1438; `apply()` :634-710 (unchanged).
- `src/domain/normalise.ts:59-96` — `normaliseDomain` contract that `normaliseTime` mirrors.
- `src/domain/scheduleSummary.ts` — weekday names 0=Mon :36-55; `formatScheduleSummary` :134-151 (total) — the live summary reuses it.
- `src/domain/stagedScheduleChangeCount.ts:41-52` — `scheduleValueKey` (JSON key): EXTEND with domains.
- `src/config/types.ts:22-39` — `Schedule` interface (0=Mon); add `domains: string[]`. `DEFAULT_CONFIG.schedules: []` :81 frozen.
- `src/config/configStore.ts:66-82` — read gate is array-level only; elements unvalidated.
- `src/components/AddDomain.tsx:65-87` — live-normalisation-in-render + UI duplicate gate precedent.
- Tests: `__tests__/Schedule.test.tsx` — `extractText` :60-74, `findButtonByLabel` :95-106, `findCheckboxes` :81-88, fixtures :123-139, `seedState` :142-188; placeholder tests :549,571,590 (Add/Edit retire; Delete stays); `__tests__/store.test.ts` schedule section ~:3416-3677.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/types.ts` — add `domains: string[]` to `Schedule` (docblock: normalised hostnames, independent of the blocklist once scheduled; reads defend).
- [x] `src/domain/normalise.ts` — pure total `normaliseTime(raw): 'HH:mm' | null`.
- [x] `src/domain/scheduleId.ts` (NEW) — `nextScheduleId(name, existingIds)`: slugify (lowercase, non-alnum → `-`, collapse/trim; empty → `'schedule'`), uniquify `-2`, `-3`, …
- [x] `src/domain/stagedScheduleChangeCount.ts` — extend `scheduleValueKey` with the defensively-normalised domains.
- [x] `src/domain/store.ts` — `stageScheduleUpsert` per Always; docblock states validation + upsert + clean-revert.
- [x] `src/components/ScheduleEditor.tsx` (NEW) — scrim+panel, name field, 7 weekday chips, validated start/end fields, union domain checkbox list, live summary, inline errors, Save/Cancel.
- [x] `src/components/Schedule.tsx` + `ScheduleRow.tsx` — Add/Edit become props (Delete placeholder untouched); remove Add/Edit placeholder copy + toast paths.
- [x] `src/components/Shell.tsx` — `scheduleEditorTarget`, ⌘N-on-surface-2 branch, Escape branch, `!editorOpen` Return gate, conditional `<ScheduleEditor/>` mount.
- [x] Tests — `__tests__/normalise.test.ts` + `__tests__/scheduleId.test.ts` (NEW); `store.test.ts` upsert family (replace-in-place, append, invalid envelopes, clean-revert incl. domain-only, mid-run new-ref); `__tests__/ScheduleEditor.test.tsx` (NEW — open modes, live summary, Save gating, Save→store call, Esc/Cancel no-stage, union list, empty blocklist); `Schedule.test.tsx` rewire; `Shell.test.tsx` — ⌘N opens on surface 2 (not while open), Esc closes, Return-while-open does not Apply.

**Acceptance Criteria:**
- Given the Schedule surface, when the user presses ⌘N or Add…, then the sheet opens with an empty draft and focused name field; edit on a row opens it pre-filled.
- Given the user edits any field, then the summary updates live and invalid fields show inline errors with Save disabled.
- Given a valid draft, when Save is pressed, then ONE `stageScheduleUpsert` stages the schedule, the sheet closes, the row shows the staged draft with the hint, and the existing Apply pipeline persists it — no password prompt for add or edit.
- Given Esc/Cancel, when the sheet closes, then nothing is staged.
- Given a domain removed from the blocklist but scheduled, when the editor opens, then it appears selected and its membership survives Save.

## Spec Change Log

- **08-28 (step-04 review patches, `review_loop_iteration: 0` — no loopback):** 3 hunters returned 30 unique findings; 15 patched, 2 deferred, 13 rejected.
  - **VG-1 (high, patched):** the Shell glue turning a row Edit press into `scheduleEditorTarget` was never exercised — a regression making Edit open the ADD sheet (which stages a duplicate `-2` schedule on Save) kept every test green. Shell E2E tests added: row `Edit <name>` opens the EDIT sheet pre-filled; empty-state `Add…` opens the ADD sheet.
  - **BH-1/EC-9 (med, patched):** `scheduleValueKey` canonicalised missing vs empty `domains` differently (`null` vs `[]`), so a toggle clean-revert failed for a hand-edited `domains: []` schedule (phantom "1 change staged" + redundant admin prompt). Missing arrays now canonicalise to `[]` (weekdays too); pinned both directions in store + helper tests.
  - **VG-2/EC-2/BH-6 (med, patched):** the editor's prefill did not coerce, so a hand-edited `weekdays: [7]` config passed the editor gate, the store rejected, and Save died silently. Prefill now mirrors the store exactly (weekdays filtered to 0–6, domains through `normaliseDomain`, junk dropped) — what is shown is exactly what the store will accept. Unknown-id → ADD-sheet fallback now test-pinned.
  - **EC-3 (med, patched):** the editor's `enabled === true` resolved a MISSING field to `false` while the store defaults `true` — a pre-5.2 schedule would stage disabled silently. Editor now uses the store's coercion (`typeof … === 'boolean' ? … : true`).
  - **BH-4 (med, patched):** ⌘N could open the editor sheet while the password gate or hosts viewer was open (mounting it above the gate, breaking modal layering). The surface-2 branch now gates on `!gateOpen && !viewerOpen` (the Return branch's precedent); the branch comment reworded to claim only what the code does.
  - **BH-7 (med, patched):** the frozen matrix row says the inline error NAMES the field; one shared time error covered both inputs. Split into `START_TIME_ERROR` / `END_TIME_ERROR`, each under its own field's condition.
  - **BH-9 (med, patched):** the panel had no `maxHeight` and the domain list was unscrollable — a long blocklist pushed Save off-window. Panel capped at `'80%'` (HostsViewer precedent), domain list in a bounded `ScrollView`.
  - **BH-5 (low, patched):** empty-state Add… now `disabled={running}` like every row control during an in-flight Apply.
  - **BH-18 (low, patched):** `<ScheduleEditor key={scheduleEditorTarget}/>` — remount-per-target is now structural, not incidental.
  - **EC-4/BH-10-deps (low, patched):** `domainOptions`' memo deps omitted `editingDomains` (stale union when `stagedSchedules` changes mid-session); deps completed, eslint-disable dropped. The union DEFINITION itself (committed ∪ the schedule's own, not the staged domain buffer) is the frozen spec's — unchanged.
  - **BH-19 (low, patched):** broken mid-phrase docstring line repaired.
  - **BH-3 comment fix (low, patched):** the Esc-branch comment claimed "no other key branch is even considered" — only Escape returns early (⌘1–⌘4 nav under overlays is the pre-existing gate/viewer parity); reworded.
  - **Deferred (2):** schedule domain membership invisible outside the editor (row summary shows days+times only — changing the frozen 5-1 grammar is a product decision); legacy unpadded `HH:mm` in committed config never normalised on read (hard requirement noted for 5.3's window evaluation) → deferred-work.md.
  - **Rejected (13):** non-ASCII slugify (frozen slugify contract; ids are internal PKs), `Schedule.domains` typed required (the spec mandates the required type AND defensive reads), ⌘-nav under overlays (pre-existing gate/viewer parity; comment fixed instead), unknown-id "ghost under the unknown id" (mischaracterised — the add path derives the id from the name, never the target; fallback test-pinned instead), stale-draft base-selection (unreachable — drafts are always full copies of committed, which only advances by committing a draft), 200-char name cap absent store-side (UI affordance), duplicate display names (unspec'd, cosmetic), no announce on open/close (sheet-pattern parity; the spec pins the announce only for Save), domains absent from `formatScheduleSummary` (frozen 5-1 grammar — deferred), store not-ok feedback (unreachable once prefill mirrors the store; sheet stays open with the draft intact), ⌘N-on-other-surfaces focus under scrim (documented no-op focus, parity), `ScheduleEditor` autofocus untestable in node env (documented caveat, pre-existing), read-time domains migration (deferred entry covers the data concern). No `intent_gap` / `bad_spec` → `review_loop_iteration` stays 0.

## Design Notes

- **Shell-hosted open state:** the sheet pattern is Shell-owned + `onClose`, and ⌘N/Esc/Return live in Shell's key handler — component-local state would need a reverse channel. `'new' | string | null` covers add vs edit.
- **Why a scratchpad:** staging half-built drafts would put a garbage schedule into the optimistically-rendered buffer and the Apply commit. Only a valid Save touches the store — the staged buffer stays all-or-nothing.
- **Golden examples:** "Focus mornings" → id `focus-mornings` (collision → `focus-mornings-2`); `9:5` → `09:05`; start `09:00` end `09:00` → invalid; 0 weekdays → summary `09:00–17:00`, Save disabled.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — no type errors.
- `node_modules/.bin/jest --watchman=false` — full suite green, no regressions. **Actual result (08-28, step-03): 33 suites / 708 tests / 3 snapshots, all pass; tsc clean. Post-review (08-28): 33 suites / 719 tests / 3 snapshots, all pass; tsc clean.**

**Matrix Test Audit (08-28, step-03):** all 12 frozen matrix rows covered by passing tests — Open add (`Shell.test ⌘N opens the ADD schedule editor`, `ScheduleEditor.test target "new"…`, `Schedule.test Add… calls onAddSchedule`); Open edit (`ScheduleEditor.test a schedule id renders the EDIT sheet pre-filled`, `Schedule.test Edit calls onEditSchedule`); Live summary (`ScheduleEditor.test summary updates live, time-only at 0 weekdays`); Save valid (`ScheduleEditor.test Save stages ONE schedule…announces and closes`, `store.test APPENDS/REPLACES`); Save invalid (`ScheduleEditor.test Save stays disabled / inline error names the field / end ≤ start`, `store.test invalid envelopes ×7`); Cancel/Esc (`ScheduleEditor.test Cancel closes WITHOUT staging`, `Shell.test bare Escape closes…without staging`); Net-identical edit (`store.test clean-reverts to null on a NET-IDENTICAL edit`); id collision (`ScheduleEditor.test collision → -2`, `scheduleId.test ×10`); Orphaned domains (`ScheduleEditor.test union list + orphaned domain keeps membership`, `…empty blocklist still lists orphaned domains`); Empty blocklist (`ScheduleEditor.test note renders, Save disabled`); ⌘N while open (`Shell.test ⌘N while the editor is open is a no-op`); Return while open (`Shell.test bare Return does NOT fire apply() while the editor is open`). No expectations edited to match code.

**Manual checks:**
- ⌘N / Add… opens the sheet; add → Apply persists to `config.json` and survives relaunch; Esc discards; an orphaned-domain edit retains membership.

## Suggested Review Order

**The scratchpad contract (the design's core)**

- Save is the ONLY staging point: builds the final Schedule, derives the id, announces, closes
  [`ScheduleEditor.tsx:248`](../../src/components/ScheduleEditor.tsx#L248)

- Prefill coerces EXACTLY like the store (post-review VG-2): what is shown is what Save will accept
  [`ScheduleEditor.tsx:128`](../../src/components/ScheduleEditor.tsx#L128)

- `enabled` uses the store's coercion — a MISSING field means true on both sides (post-review EC-3)
  [`ScheduleEditor.tsx:160`](../../src/components/ScheduleEditor.tsx#L160)

**The store: one upsert action for add + edit**

- `stageScheduleUpsert` — validate/normalise first (fail-safe), upsert on the draft, clean-revert
  [`store.ts:657`](../../src/domain/store.ts#L657)

- Signature on the store interface — one synchronous `WriteResult`, no ports/gate/toast
  [`store.ts:221`](../../src/domain/store.ts#L221)

**Canonical equality (the clean-revert backbone)**

- `scheduleValueKey` — domains INSIDE the key, missing arrays canonicalised to `[]` (post-review BH-1)
  [`stagedScheduleChangeCount.ts:53`](../../src/domain/stagedScheduleChangeCount.ts#L53)

- The domain-only clean-revert pin: a domain-only edit round-trips to a null buffer
  [`store.test.ts:3947`](../../__tests__/store.test.ts#L3947)

**Pure helpers**

- `normaliseTime` — pure, total, zero-pads; editor renders it live, store re-runs it on Save
  [`normalise.ts:117`](../../src/domain/normalise.ts#L117)

- `nextScheduleId` — slugify + `-2`/`-3` uniquify against every existing id
  [`scheduleId.ts:37`](../../src/domain/scheduleId.ts#L37)

**The sheet UI**

- Union domain list (committed ∪ the schedule's own) — orphaned domains stay visible and selected
  [`ScheduleEditor.tsx:201`](../../src/components/ScheduleEditor.tsx#L201)

- Per-field time errors — each names its own field (post-review BH-7, the frozen matrix row)
  [`ScheduleEditor.tsx:90`](../../src/components/ScheduleEditor.tsx#L90)

- Bounded panel + scrollable domain list — a long blocklist can't push Save off-window (post-review BH-9)
  [`ScheduleEditor.tsx:434`](../../src/components/ScheduleEditor.tsx#L434)

**Shell wiring (keyboard + entry points)**

- ⌘N branch: surface-2 editor-open gated on `!gateOpen && !viewerOpen` (post-review BH-4); no-op while open
  [`Shell.tsx:236`](../../src/components/Shell.tsx#L236)

- The VG-1 guard: row `Edit <name>` opens the EDIT sheet pre-filled through the REAL Shell path
  [`Shell.test.tsx:2427`](../../__tests__/Shell.test.tsx#L2427)

- Mount: `key={scheduleEditorTarget}` — remount-per-target is structural (post-review BH-18)
  [`Shell.tsx:410`](../../src/components/Shell.tsx#L410)

- The glue under test: row Edit → target id, Add… → `'new'`
  [`Shell.tsx:364`](../../src/components/Shell.tsx#L364)

**Schema + peripherals**

- The headline schema change: `Schedule.domains: string[]` — every read defends with `Array.isArray`
  [`types.ts:49`](../../src/config/types.ts#L49)

- Empty-state Add… disabled while an Apply is in flight, matching the row controls (post-review BH-5)
  [`Schedule.tsx:171`](../../src/components/Schedule.tsx#L171)

- Hand-edited-config tests: `weekdays: [7]` gates Save, junk domains dropped from prefill, unknown id → ADD
  [`ScheduleEditor.test.tsx:624`](../../__tests__/ScheduleEditor.test.tsx#L624)

- ⌘N family: opens ADD, no-op while open, Esc discards, Return-while-open never Applies
  [`Shell.test.tsx:2292`](../../__tests__/Shell.test.tsx#L2292)