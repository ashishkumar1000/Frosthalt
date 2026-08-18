---
title: 'Timer surface with duration presets and domain selection'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9a69fd4c7d8ff3cf5650c9d66cf3312326747dd4'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/Frosthalt-PRD.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Frosthalt-2026-08-13/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Frosthalt-2026-08-13/EXPERIENCE.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Frosthalt-2026-08-13/mockups/timer.html'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Today the Timer surface (sidebar row 2 / `⌘2`) renders a placeholder string. There is no way to pick a focus-session duration, no way to pick which blocklist domains a session covers, and no way to start one. The user can edit their blocklist (Epic 2) and set a password (Epic 3), but cannot actually run a session — so all of Epic 4's downstream stories (countdown ring, countdown in the status header, auto-unblock on expiry, end-early, re-arm on launch) have no first source.

**Approach:** Build the Timer surface as a thin UI shell for state that lives in the store. Two new store actions — `setDurationPreset` / `setCustomDurationMinutes` / `setSelectedDomain` (Free-state mutation surface) and `stageStartTimer` (staged-then-Apply entry point that carries the duration + selection into the Apply pipeline) — and one pure helper for normalising minute inputs. Wire the Timer surface in the Shell at surface index 1 replacing the placeholder. Start a session through Apply so the Epic 1 admin-prompt pattern is reused verbatim. Do NOT yet introduce the `activeTimer` config-key write — that lands in Story 4.2. Story 4.1 stops at "the surface lets the user pick + press Start; Start stages a one-shot Apply that adds the chosen domains to the effective blocklist" using the EXISTING `stageAlwaysOnToggle` + Apply path (chosen domains become temporarily `alwaysOn` from the start of the staged Apply through its commit). The cleaner `activeTimer`-as-epoch work is 4.2's job; this story proves the UI + wiring on top of the existing pipeline so 4.2 can swap the engine without UI rework.

> **Scope honesty:** Bending the "staged timer is a fresh entity" ideal against the constraint "do not introduce new persistence in 4.1" — 4.1 will use the Epic 2 stage-then-Apply as the engine, treating Start as "stage each selected domain's `alwaysOn: true` toggle if not already, then Apply". The user's visible model is still "I picked a duration and domains and pressed Start" — the store mechanics stay hidden. Story 4.2 then replaces the engine with the `activeTimer` epoch write so End-early / Expiry / Re-arm can be implemented cleanly without rewriting the surface.

## Boundaries & Constraints

**Always:**
- Render the Free-state (no active timer) Timer surface in Shell at surface index 1 — drop the placeholder string from `EMPTY_STATE_TEXT[1]`. Surface title is `"Timer"` (unchanged `SURFACE_NAMES[1]`).
- Show three duration presets (25 / 45 / 60 min) + a numeric custom-minutes input. Selection is exclusive — choosing one disables the others.
- Render one macOS checkbox row per domain from `committed.domains` (NOT staged-draft — the Timer picker reads the BLOCKLIST list, never the optimistic staged overlay, so picking happens against the canonical source of truth).
- Pre-check the checkbox set from the user's last session: read `committed.activeTimer?.selectedDomains` if present (the persisted-previous-session set will become available after 4.2 lights up, but reading it now is the right hook), falling back to "all domains selected" on first run.
- Start is `ApplyButton` (primary fill, `pulse` while pre-conditions are met, `busy` while a run is in flight) — the codebase's existing default-button primitive (mirrors Blocklist).
- Start's `disabled`: true when (a) duration is invalid (≤ 0 min OR > 24 h), (b) zero domains selected, OR (c) `applyStatus === 'running'`. Pre-conditions are computed locally; the button is disabled in all three cases.
- `Return` / `Enter` fires Start when focus is on the Start button (ApplyButton already binds `Return` through its `Pressable`); the Shell does NOT need a new `keydown` branch in this story — the existing `⌘1`–`⌘4` nav + the Blocklist-only `Return → Apply` branch stay untouched (Start is itself an Apply, the Blocklist branch does not fire when surface 1 is active).
- Empty blocklist state: render "Add some domains on Blocklist first." with a primary "Open Blocklist" `Pressable` that calls `selectRow(0)` (the existing `Shell` row-ref focus path is reachable by injecting a navigation callback into `<Timer/>`, mirroring the `<Settings onNavigateBlocklist />` pattern).
- Picker state is LOCAL component state (duration, custom minutes string, lastSelection). Nothing in 4.1 lands in `committed` or `staged`. Pre-checked domains and the pre-selected duration mirror `committed.activeTimer` (treated as nullable / undefined on first run) — read-only, not writable from this story.
- VoiceOver: surface mount announces "Timer, free" — on the `Free`-only path (a running-timer announce lives in 4.4). Preset chips carry `accessibilityRole="button"` and `accessibilityState={{ selected }}`. The custom-minutes input is `accessibilityLabel="Custom duration in minutes"` with `keyboardType="number-pad"`. Checkbox rows announce "Selected: twitter.com" / "Not selected: youtube.com".
- A unit test asserts the pre-check fallback (no persisted selection → all checked) and Start-precondition gates (invalid duration, zero selected, apply-running).

**Ask First:**
- Adding a new runtime dependency (none planned — pure UI on the existing store + tokens).
- Changing `Config.activeTimer`'s shape.
- Routing Start through `requirePassword` (Start is friction-free per OQ-1; this story does NOT gate it).

**Never:**
- Build the countdown ring (4.3), the status-header countdown (4.4), auto-unblock on expiry (4.5), end-early (4.6), or re-arm on launch (4.7).
- Persist an `activeTimer` (4.2).
- Make the Timer surface respond when an `activeTimer` is already running — Story 4.1 strictly handles the Free path. The running-timer UI is owned by 4.3. (Defensive: Timer can render a minimal "Timer running on another surface" placeholder if `committed.activeTimer` is non-null at mount, so 4.1 + 4.3 are forward-compatible.)
- Modify the Blocklist surface, Hosts viewer, Settings, PasswordGate, StatusHeader, or Sidebar in this story.
- Use raw hex tokens — every colour goes through `tokens.*`.
- Import `child_process` / `fs` / `os` in `src/` (AD-11 / AR-13).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Free + N≥1 domains, no prior selection | mount with `committed.domains.length >= 1`, no `committed.activeTimer.selectedDomains` | Duration defaults to "25 min"; all N domains pre-checked | N/A |
| Free + persisted `activeTimer.selectedDomains` | mount with `committed.activeTimer.selectedDomains = [a,b]` | Only those domains pre-checked; duration default = "25 min" if `activeTimer` shape lacks a duration slot (4.2 will widen) | N/A |
| Free + zero domains | mount with `committed.domains.length === 0` | Surface renders empty-state with "Open Blocklist" `Pressable`; presets + checkbox list hidden; Start absent | "Open Blocklist" calls `selectRow(0)`; Esc does nothing (no surface to close) |
| Free + invalid custom minutes | typed "0" or "-1" or empty | Start disabled; inline note: "Enter minutes (1–1440)."; chip selection cleared, custom kept (visual feedback) | N/A |
| Free + valid custom minutes | typed "30" | "30" treated as 30 min; custom visually selected (border + fill); presets deselected | N/A |
| Free + preset clicked | click "45 min" | Custom cleared; "45 min" visually selected; Start enabled iff ≥1 domain selected | N/A |
| Free + toggle a domain checkbox | uncheck a row | Selection count updates live ("3 of 6 selected"); Start disabled when count → 0 | N/A |
| Free + Start pressed | valid duration + ≥1 selected, applyStatus idle | For each unchecked already-`alwaysOn=false` domain in selection: `stageAlwaysOnToggle` flips it on. Apply runs. `applyStatus` flips to `'running'` → ApplyButton label "Starting…" + disabled + busy. On ok: Toast "Started blocking N domains." + blocklist reflects new always-on set | On apply `{ok:false}`: toast "Couldn't start the block. No changes made."; staged draft retained for retry |
| Free + Start pressed with overlap | some selected already-`alwaysOn=true` | Only the still-`alwaysOn=false` subset is staged; Apply writes the union. No-clobber (clean-revert in `stageAlwaysOnToggle`) | N/A |
| Free + Start pressed during in-flight Apply | applyStatus === 'running' | Start disabled; ApplyButton `busy` true; click is a no-op | N/A |
| Free + Esc | keypress | Shell-level handler ignores (Timer does not own Esc — no destructive confirm open in 4.1) | N/A |
| Mount with running `activeTimer` (forward-compat with 4.2) | `committed.activeTimer != null` | Render a minimal defensive placeholder: "Timer running. Switch to Blocklist to see the countdown." + Open Blocklist button (similar to zero-domains empty state). Avoids 4.3 reaching a Timer that someone might already be on. | N/A |

</frozen-after-approval>

## Code Map

- `src/components/Shell.tsx:249-273` — the surface-branch switch (currently Blocklist / Settings / placeholder). Add `surface === 1` → `<Timer ... />` branch mirroring the Settings one. Surface 2 (Schedule) stays placeholder.
- `src/components/surfaces.tsx:42,44-47` — drop the Timer placeholder string (`EMPTY_STATE_TEXT[1]` → `''`) so the placeholder is no longer rendered for surface 1; preserve the registry (`SURFACE_NAMES`, the Settings empty-state still uses the presentational slot). Mirror the Settings comment (`// Surface N is a real screen as of Story X.Y — placeholder absent so it never renders`).
- `src/domain/store.ts:84-222` (`DomainState` interface) + `src/domain/store.ts:224-575` (store body) — READ-ONLY on existing actions; this story REUSES `stageAlwaysOnToggle` + `apply` + `cancelStaged` as the Start engine. Zero new persistent state in this story.
- `src/domain/store.ts:84-105` — reads to add (typed): `committed.domains`, `committed.activeTimer?.selectedDomains`, `applyStatus`. No new actions.
- `src/components/Timer.tsx` (NEW) — the Timer surface for the Free path. Renders preset chips, custom-minutes input, checkbox list, Start `ApplyButton`, empty state. Local component state owns picker selections; store reads come via selector hooks.
- `src/components/TimerEmptyState.tsx` (NEW, inside `Timer.tsx` or sibling) — the zero-domains / running-timer empty-state copy + "Open Blocklist" CTA, reusing the Blocklist-row-style primary button.
- `src/components/TimerDurationPicker.tsx` (NEW, inside `Timer.tsx` or sibling) — three preset chips + a number-pad custom-minutes input. Pure presentational: parent owns `value` (one of `'25' | '45' | '60' | 'custom:<n>'`) and `onChange`.
- `src/components/TimerDomainList.tsx` (NEW, inside `Timer.tsx` or sibling) — list of `{hostname}` rows each with a `<Checkbox>` and the existing `<Text>` label; reads `committed.domains` from the store at the call site, accepts `selected: Set<string>` + `onToggle(hostname)`.
- `src/config/duration.ts` (NEW) — pure helpers: `parseDurationMinutes(input: string): { ok: true; minutes: number } | { ok: false; reason: string }` (accepts positive integers in `[1, 1440]`; rejects `''`, `'0'`, negative, non-integer, `>1440`) and `formatDurationLabel(minutes: number): string` (e.g. `"30 min"`).
- `__tests__/duration.test.ts` (NEW) — table-driven: every I/O matrix row for `parseDurationMinutes` + `formatDurationLabel`, including the `0`, negative, non-integer, oversized boundary.
- `__tests__/Timer.test.tsx` (NEW) — Timer surface tests: empty-blocklist empty state renders the CTA + wires `onOpenBlocklist`, surface mount announce in `AccessibilityInfo.announceForAccessibility`, pre-check fallback (no `activeTimer.selectedDomains` → all checked), pre-check from persisted selection, Start preconditions (invalid duration, zero selected, apply-running → disabled), preset selection clears custom + vice versa, toggling a domain live-updates the count, Start path stages always-on flips + fires `apply` (mock the store so the test asserts the staged-call sequence, not the native write).
- `src/components/Blocklist.tsx:155-218,222-232` — container/title/`ApplyButton`/Cancel/Cancel-staged patterns to MIRROR for the Timer surface.
- `src/components/DomainRow.tsx` — the Blocklist per-row pattern; do NOT reuse this component directly (its row layout includes a Trash button + always-on mutation flow the Timer doesn't need). Mirror the row structure instead.
- `src/components/Checkbox.tsx:24-91` — the macOS checkbox primitive to reuse for the TimerDomainList rows (`accessibilityLabel` shaped like `"Selected: twitter.com"` when checked, `"Select: twitter.com"` when unchecked).
- `src/components/ApplyButton.tsx:38-160` — the default-button primitive to reuse. The "Starting…" label swap mirrors `Blocklist`'s `'Applying…'` convention.
- `src/components/Settings.tsx` — `onNavigateBlocklist` prop pattern (Settings receives a navigation callback to nav from Panic toast back to Blocklist) — mirror for Timer's `onOpenBlocklist`.
- `src/config/types.ts:48-67` — `ActiveTimer` / `Config.activeTimer?: ActiveTimer | null` (already declared, used as a nullable read source for pre-check fallback). READ-ONLY in this story.
- `src/theme/tokens.ts:84-131` — `tokens.primary`, `tokens.destructive`, `tokens.typography.title/body/countdown`, `tokens.spacing.*`, `tokens.rounded.*`. The color name source of truth.
- `_bmad-output/planning-artifacts/ux-designs/.../EXPERIENCE.md` — UX-DR5 (countdown ring, NOT built in 4.1 — 4.3), UX-DR9 (Apply button — reused as Start), UX-DR15 (Timer Free state pre-checked + Start), UX-DR16 (keyboard nav — `⌘2` already navigates via Shell branch), UX-DR17 (VoiceOver surface announce).
- `_bmad-output/planning-artifacts/ux-designs/.../mockups/timer.html` — visual reference for the Free layout: preset chips with `selected` primary fill, checkbox rows, Start as primary.

## Tasks & Acceptance

**Execution:**
- [ ] `src/config/duration.ts` -- pure helpers `parseDurationMinutes(input: string)` (accepts positive int in `[1, 1440]`, else `{ ok: false, reason }`) + `formatDurationLabel(minutes: number)` ("30 min") -- the one-time, unit-testable boundary between the custom input and Start's `disabled` gate.
- [ ] `__tests__/duration.test.ts` -- table-driven boundary matrix: `'30' → 30`, `'' → invalid`, `'0' → invalid`, `'-1' → invalid`, `'30.5' → invalid`, `'1441' → invalid`, `'1440' → 1440`, `'1' → 1`, plus `formatDurationLabel` for every preset + custom cases -- locks the validator ahead of UI consumers.
- [ ] `src/components/Timer.tsx` -- Free-state surface: title `"Timer"` + `<TimerDurationPicker/>` + `<TimerDomainList/>` + empty-state OR `<ApplyButton/>` Start; mount announce "Timer, free"; reads `committed.domains` + `committed.activeTimer?.selectedDomains` for pre-check; local state owns picker selections; Start calls a memoised handler that stages flips + fires `apply`; defensive running-timer empty state when `committed.activeTimer != null` -- the new surface at surface index 1.
- [ ] `src/components/TimerDurationPicker.tsx` -- three preset `Pressable`s (chips styled with `tokens.primary` selected fill) + `<TextInput keyboardType="number-pad" accessibilityLabel="Custom duration in minutes">`, exclusive selection (preset ↔ custom), accepts `value: { kind: 'preset' | 'custom'; minutes: number }` + `onChange` -- visual + a11y for the duration section.
- [ ] `src/components/TimerDomainList.tsx` -- `<Checkbox>` per `committed.domains` row with hostname label + accessible labels `"Select: <host>"` / `"Selected: <host>"`, accepts `selected: Set<string>` + `onToggle(hostname)` -- the pick list.
- [ ] `src/components/Timer.test.tsx` -- mount announce fires "Timer, free"; empty-blocklist empty state shows "Open Blocklist" CTA + `onOpenBlocklist` propagates; pre-check fallback on first run sets all; pre-check from persisted `activeTimer.selectedDomains`; toggle updates count live; Start preconditions disabled in three states; preset selection clears custom + vice versa; Start success stages always-on flips + fires `apply`; Start failure (admin-denied mock) keeps staged draft -- proves the surface + wiring + boundary.
- [ ] `src/components/Shell.tsx` -- add `surface === 1` branch rendering `<Timer onOpenBlocklist={() => selectRow(0)} />` (mirrors Settings' `onNavigateBlocklist` pattern); gate on `committed.activeTimer == null` so 4.3 can replace the no-active-timer branch later without touching Shell -- wires the surface into the sidebar.
- [ ] `src/components/surfaces.tsx` -- drop `EMPTY_STATE_TEXT[1]` string (already `''` for Settings, mirror the comment shape so the placeholder path is never rendered for surface 1) -- the registry stays intact, the placeholder never renders.

**Acceptance Criteria:**
- Given I open the Timer surface (`⌘2`) with at least one domain in my blocklist, when the surface renders, then duration presets 25 / 45 / 60 min are shown plus a numeric custom-minutes input, and my domains are listed with one macOS checkbox each, with the domains from `committed.activeTimer?.selectedDomains` pre-checked (or all-checked on first run, when no `activeTimer` selection is recorded).
- Given a valid duration and ≥1 selected domain, when I press `Return` on the Start button (the view's default button), then Stage flips any non-`alwaysOn` selected domains, Apply runs through the shared serialized queue, and the admin prompt writes the new managed section (re-using Epic 1's Apply).
- Given `applyStatus === 'running'`, when the surface re-renders, then Start is disabled with `busy: true` and label "Starting…".
- Given an invalid custom minutes input ("0", "-1", empty, non-integer, > 1440), when I look at Start, then Start is disabled and an inline message reads "Enter minutes (1–1440).".
- Given zero selected domains, when I look at Start, then Start is disabled with a "N of M selected" hint below the list.
- Given an empty blocklist, when the Timer surface mounts, then the empty-state copy + "Open Blocklist" CTA renders; presets + checkbox list + Start are hidden; clicking "Open Blocklist" navigates to Blocklist (`⌘1` equivalent) without touching state.
- Given a running `activeTimer` in `committed`, when the Timer surface mounts (defensive — 4.3 owns the running UI), then a minimal running-timer placeholder renders with an "Open Blocklist" CTA.
- Given a Start success, when Apply commits, then a toast "Started blocking N domains." shows; on `{ok:false}`, the toast reads "Couldn't start the block. No changes made." and the staged draft remains.
- Given the duration picker, when I switch between a preset and the custom input, then exactly one is selected (chips deselect on custom input change; preset click clears custom).
- Given VoiceOver focus on a domain checkbox, when the row is checked, then it announces "Selected: twitter.com"; unchecked announces "Select: twitter.com". Preset chips announce as "25 min, selected" / "25 min, not selected".
- Given the custom-minutes input, then `keyboardType` is `number-pad`, `accessibilityLabel` is "Custom duration in minutes", and a non-integer / empty / oversized value never enables Start.
- Given a unit test for `parseDurationMinutes`, then the boundary matrix (`''`, `'0'`, `'-1'`, `'30.5'`, `'1441'`, `'1440'`, `'1'`, `'30'`) all assert the expected `{ ok }` + reason.
- Given a Surface-mount `AccessibilityInfo.announceForAccessibility`, when the Timer surface first mounts (Free path), then it speaks "Timer, free".

## Design Notes

- **No `activeTimer` write in 4.1.** Start stages per-domain `alwaysOn` flips into the EXISTING staged-then-Apply pipeline. The store mechanics stay hidden from the surface. End-early (4.6), auto-unblock on expiry (4.5), and re-arm on launch (4.7) all need `activeTimer` to express intent precisely — Story 4.2 swaps the engine: the surface picks duration + domains, presses Start, and the store's new `stageStartTimer` action stages an `activeTimer` write + the always-on intent (or just the `activeTimer` write) and lets Apply commit. The surface DOES NOT change between 4.1 and 4.2.
- **Pre-check fallback.** `committed.activeTimer?.selectedDomains` is the persisted-previous-session set (4.2 will populate it). 4.1 reads it and pre-checks; when absent (`activeTimer == null` OR `selectedDomains` undefined), pre-check ALL — that's the first-run default, and it gives the user a one-click "start a session on everything" until they customise.
- **Picking reads `committed.domains`, not `staged`.** The user is picking against the canonical blocklist ("here is what I want to focus on") — staged edits (`alwaysOn` toggle / remove) are an orthogonal intent and should not leak into the picker. If the user has a staged remove for `twitter.com`, the Timer still offers it: timer selection is about focus, not about the apply-pending state.
- **Defensive running-timer placeholder.** 4.3 will render the full Blocked UI (countdown ring + "End early" button). 4.1 cannot show that without 4.3's wiring; we render a minimal placeholder so the user landing on Timer mid-session gets a graceful "see Blocklist for the countdown" message rather than the Free-state Start-trying-to-restart-the-session path. Tests assert the placeholder renders only when `committed.activeTimer != null` at mount.
- **No Shell-level `keydown` for Start.** ApplyButton is a `Pressable` carrying its native button role, so `Return` reaches it through the standard focus path when it has keyboard focus. The Shell's existing `Return → Apply` branch fires only on `surface === 0` (Blocklist) — Timer is on surface 1, so the branch does not fire. No Shell-level handler change is required.
- **What 4.1 deliberately leaves for 4.2.** Persisting `activeTimer` to config.json; the live countdown; the running-state UI on the Timer surface; the status-header countdown; the expiry auto-unblock; the password-gated End-early; re-arm on launch. The story's job is the Free-state surface + Start staging.
- **VoiceOver announce single-fire on mount.** The existing Blocklist.tsx:127-136 pattern uses a `useEffect(..., [])` for the mount announce. Mirror it — Timer announces "Timer, free" on mount only; the running-state announce (4.4) will be a separate mount lifecycle.
- **Tabular numerals on the Start disabled-reason row.** The "N of M selected" text uses `fontVariant: ['tabular-nums']` so the digit width is fixed as the user toggles (mirrors StatusHeader's `tokens.typography.countdown` pattern).
- **A11y tokens: destructive button placement.** The Timer Free path has NO destructive button (Start is primary), so the `colors.destructive` token is unused in 4.1. End-early (4.6) wires it; this story does not touch the danger surface.
- **Pre-check uses the persisted selection set's hostnames verbatim.** No re-normalisation. The Timer picker renders `d.hostname` straight, matching `stageAlwaysOnToggle`'s raw compare. A pre-check that points at a hostname still present in `committed.domains` matches; one that points at a long-removed hostname is just dropped from pre-check (the user can re-add via Blocklist) — no error UI in this story.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors. (pnpm wrapper is sandbox-broken; use `node_modules/.bin/tsc`.)
- `node_modules/.bin/jest --watchman=false __tests__/duration.test.ts __tests__/Timer.test.tsx` -- expected: all boundary cases + surface + Start staging tests pass.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite stays green (no regressions to existing 411 tests).
- macOS app build/launch (usual pnpm macos path) -- expected: `⌘2` opens the new Timer surface; presets + custom input + checkbox list render; Start Stages + Applies (one admin prompt); empty-blocklist empty state renders "Open Blocklist".

**Manual checks:**
- Open Timer with at least one domain in the blocklist — preset "25 min" selected, all domains pre-checked.
- Type "30" in the custom input — Start enables; "30 min" replaces the preset selection visually.
- Type "0" — Start disabled; inline "Enter minutes (1–1440)." shows.
- Uncheck every domain — Start disabled; the hint reads "0 of M selected".
- Click Start with valid inputs — one admin prompt fires; on success the Blocklist surface shows the new `alwaysOn` rows; on cancel a "Couldn't start the block. No changes made." toast shows and the Blocklist state is unchanged.
- Empty the blocklist entirely, open Timer — the empty-state copy + "Open Blocklist" CTA render; clicking it navigates to Blocklist.
- With Tab order through the surface — `duration (preset 25) → duration (preset 45) → duration (preset 60) → custom input → domain 1 → domain 2 → … → Start`; focus rings visible.

## Suggested Review Order

**Store wiring (the design intent — start here)**

- Reuses `stageAlwaysOnToggle` + `apply` as Start's engine; no new persistent state.
  Store reads: `committed.domains`, `committed.activeTimer?.selectedDomains`, `applyStatus`.
  [`store.ts:116`](../../src/domain/store.ts#L116)
  [`store.ts:271`](../../src/domain/store.ts#L271)

**Duration validator (pure, unit-tested)**

- Boundary `[1, 1440]` minutes; rejects empty / zero / negative / non-integer / oversized.
  [`duration.ts:52`](../../src/config/duration.ts#L52)
- Real `formatDurationLabel` contract: sub-hour → `m min`, exact hour → `h h`, hour-plus → `h h m m`.
  [`duration.ts:84`](../../src/config/duration.ts#L84)
- Boundary matrix locked in unit tests ahead of UI consumers.
  [`duration.test.ts:1`](../../__tests__/duration.test.ts#L1)

**Picker (presentational)**

- Preset chips + custom input; `formatDurationLabel` drives chip labels; `parseDurationMinutes` drives validity.
  [`TimerDurationPicker.tsx:72`](../../src/components/TimerDurationPicker.tsx#L72)
  [`TimerDurationPicker.tsx:37`](../../src/components/TimerDurationPicker.tsx#L37)
- One row per hostname; Checkbox + focusable Text wrap mirrors Blocklist's row layout.
  [`TimerDomainList.tsx:36`](../../src/components/TimerDomainList.tsx#L36)

**Surface + wiring**

- Defensive running-timer placeholder when `committed.activeTimer != null` (forward-compat with 4.3).
  [`Timer.tsx:290`](../../src/components/Timer.tsx#L290)
- Empty-blocklist empty state with Open Blocklist CTA calls `onOpenBlocklist`.
  [`Timer.tsx:313`](../../src/components/Timer.tsx#L313)
- Free-state renders picker + list + Start; `handleStart` stages per-domain alwaysOn flips + one apply.
  [`Timer.tsx:250`](../../src/components/Timer.tsx#L250)
- Pre-check fallback: persisted selection filtered against current `committed.domains`; falls back to all-checked.
  [`Timer.tsx:128`](../../src/components/Timer.tsx#L128)
- Mount announce "Timer, free" via `useEffect(..., [])`; mirrors Blocklist's pattern.
  [`Timer.tsx:213`](../../src/components/Timer.tsx#L213)
- Shell routes surface index 1 to `<Timer>` via the `onOpenBlocklist` callback (mirrors Settings' pattern).
  [`Shell.tsx:250`](../../src/components/Shell.tsx#L250)
  [`Shell.tsx:258`](../../src/components/Shell.tsx#L258)
- Placeholder copy for surface 1 dropped; registry intact; surface 1 never renders the placeholder.
  [`surfaces.tsx:48`](../../src/components/surfaces.tsx#L48)

**Tests (peripherals)**

- Mount announce "Timer, free" verified once.
  [`Timer.test.tsx:225`](../../__tests__/Timer.test.tsx#L225)
- Pre-check fallback asserted: no `activeTimer` → all-checked; persisted selection → that subset only.
  [`Timer.test.tsx:314`](../../__tests__/Timer.test.tsx#L314)
  [`Timer.test.tsx:340`](../../__tests__/Timer.test.tsx#L340)
- Start preconditions in three states: invalid duration / zero selected / apply-running.
  [`Timer.test.tsx:446`](../../__tests__/Timer.test.tsx#L446)
  [`Timer.test.tsx:471`](../../__tests__/Timer.test.tsx#L471)
  [`Timer.test.tsx:496`](../../__tests__/Timer.test.tsx#L496)
- Start success stages always-on flips + fires `apply`; toast count is the staged subset, not the full selection.
  [`Timer.test.tsx:518`](../../__tests__/Timer.test.tsx#L518)
- Start failure retains staged draft + announces deny toast.
  [`Timer.test.tsx:567`](../../__tests__/Timer.test.tsx#L567)
- Shell navigation tests updated for the new surface (placeholder copy gone; Free-state copy present).
  [`Shell.test.tsx:282`](../../__tests__/Shell.test.tsx#L282)
  [`Shell.test.tsx:323`](../../__tests__/Shell.test.tsx#L323)
  [`Shell.test.tsx:901`](../../__tests__/Shell.test.tsx#L901)
  [`Shell.test.tsx:1114`](../../__tests__/Shell.test.tsx#L1114)
  [`Shell.test.tsx:1214`](../../__tests__/Shell.test.tsx#L1214)
