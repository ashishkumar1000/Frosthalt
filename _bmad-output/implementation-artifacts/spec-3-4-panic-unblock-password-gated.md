---
title: 'Panic unblock (password-gated)'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
baseline_commit: '0a530e5'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3-2 built the reusable gate and 3-3 wired Change password through it, but the Danger Zone's most destructive action — Panic, which clears all blocked hosts at once — still has no surface. Without it, a user who wants to immediately unblock everything must leave the app and `sudo vim /etc/hosts`, bypassing the self-discipline tool; the impulse-control gate the epic was built for has no release valve.

**Approach:** Add a `Panic` button to the Danger Zone in Settings (next to Change password, only when a password is set). The button calls `requirePassword(() => setConfirmOpen(true))` — the same 3-2 gate 3-3 uses. On verify, the gate closes and an inline destructive confirm prompt appears ("Clear all blocks? This cannot be undone."). On confirm, the component stages `domains: []` and calls the existing `apply()` — which routes through the shared `enqueue` queue → `writeConfig` → `writeHosts([])` (markers-only section → all blocks cleared in one admin prompt). On success, surface a toast with a "Re-enable your blocklist" link that navigates to Blocklist; on failure, surface the standard "Couldn't update /etc/hosts. No changes made." copy. Zero new store actions, zero new gate code, zero new port operations.

## Boundaries & Constraints

**Always:**
- Reuse 3-2's `requirePassword(action)` as the single gate entry point (mirrors 3-3's change-password flow). Reuse 3-1's `apply()` (store.ts:335) to drive the serialized Apply pipeline. Reuse 1-5's `writeHosts(lines)` (already accepts `[]` → markers-only section per apply.ts:79-85). No new store action, no new port op, no new gate component.
- Gate-first flow per epic: button → `requirePassword(() => setConfirmOpen(true))` → gate verifies password → on verify, gate closes + inline confirm opens → on confirm, stage empty + `apply()`. The gated action is a UI state flip, NEVER a re-entrant `requirePassword` call (avoids deferred E1/B3 double-open — deferred-work.md L203-206).
- Panic renders ONLY inside the existing Danger Zone `View` in `Settings.tsx:46-51`, which is already restricted to `hasPassword`. No Settings.tsx logic change other than mounting `<Panic/>`. When no password is set, Settings shows `SetPassword` (unchanged 3-1 surface); the Danger Zone + Panic never appear.
- Confirm prompt is inline (under the Panic trigger), not a separate Shell-hosted sheet — mirrors 3-3's choice for Change password. Cancel button always available.
- Style: outlined destructive trigger (border + text in `tokens.destructive`, mirroring `ChangePassword.tsx:399-408`); confirm prompt uses `tokens.destructive` text; no destructive button is ever the window default (never pulses); Panic trigger is not the default focused element when Danger Zone mounts.
- After successful Apply, surface a toast with copy "All blocks cleared." + a "Re-enable your blocklist" `Pressable` link that navigates to Blocklist (reuse the existing Shell `selectRow(0)` navigation; Blocklist row is the first in `SURFACE_NAMES`).
- On Apply failure (`writeHosts` returns `{ok: false, error}`), show the standard copy "Couldn't update /etc/hosts. No changes made." and leave `staged: []` in place (mirroring 3-3's `SAVE_FAILED_MSG` handling at `ChangePassword.tsx:308-315`). The user can retry; nothing was committed.
- VoiceOver: Panic trigger has a clear accessible label including the consequence ("Clear all blocked hosts — requires password"); Danger Zone is already announced (header + labelled container from 3-3); confirm prompt uses `accessibilityRole="alert"` for the destructive copy.
- Reuse the shared `enqueue` queue (store.ts:586) for any panic-induced write. The `apply()` call already goes through it; do not bypass.

**Ask First:**
- Whether the post-success toast should auto-dismiss after N seconds or persist until the user taps to navigate (the gate is meant to feel weighty; persistence argues for slower auto-dismiss or manual). Proposed: 8s auto-dismiss with the link always tappable; defer persistent-toast-without-dismiss to a future UX pass.
- Whether the confirm prompt should require typing the word "clear" (Discord-style friction) or rely on a single Confirm button. Proposed: single Confirm button with a Cancel sibling; defer typing-required friction to a Phase 2 self-discipline model.
- Whether the "Re-enable your blocklist" link should re-mount Blocklist only, or actually re-stage the prior domains (no — Phase 2). Proposed: navigation-only (the user re-adds domains themselves; the Blocklist surface already supports add).

**Never:**
- Build a separate Shell-hosted confirmation sheet (3-3's inline pattern is canonical; a sheet would duplicate Escape/Shell wiring).
- Build a sidebar/status-header panic affordance (1-3 fixed the sidebar to 4 rows; StatusHeader is always-visible per surface and would clash).
- Add a `clearEffectiveBlocklist` store action; the existing apply pipeline + `staged = []` already clears the managed hosts section.
- Add a `panic` action to the store, or persist a `panicConfirmed` / `confirmOpen` UI flag to `config.json` / `Config` / `types.ts` (UI state is component-local).
- Bypass the gate when a password is set. The gate is the entire point of this story for v1 — no "skip for tests" escape in production paths.
- Persist any panic-related UI state to disk. `confirmOpen`, `clearing`, `errorMsg` are component-local.
- Make the Panic trigger or the Confirm button the window default (never pulses).
- Clear blocks directly via a `writeHosts([])` call outside the Apply queue. All panic writes must go through `enqueue` → `runApply` so the admin prompt fires once and writes are serialized.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| No password set | `passwordHash == null \|\| ''` | Danger Zone + Panic absent; only `SetPassword` shows (parent branch handles) | N/A |
| Render trigger | password set; Settings open | "Clear all blocked hosts" destructive outlined button visible in Danger Zone | N/A |
| Open gate | trigger pressed | Gate sheet opens (current-pw verify); confirm NOT yet visible | N/A |
| Gate Esc | gate open; Esc pressed | Gate closes; confirm does NOT open; no clear | N/A |
| Gate verified | correct current pw | Gate closes; inline confirm appears ("Clear all blocks? This cannot be undone.") | N/A |
| Gate wrong / throttle | incorrect pw 5x | Tries-left then 30s throttle per 3-2; confirm never opens | N/A |
| Cancel confirm | confirm open; Cancel pressed | Confirm closes; `staged` unchanged; no apply | N/A |
| Confirm, apply ok | confirm tapped; writeConfig ok; writeHosts ok | `committed.domains === []`; status count drops to 0; toast "All blocks cleared." + "Re-enable your blocklist" link appears; confirm closes | N/A |
| Confirm, writeConfig fails | writeConfig returns error | Confirm stays open; error copy "Couldn't update /etc/hosts. No changes made."; `staged: []` retained (retryable) | show inline error; do not navigate |
| Confirm, writeHosts fails (admin deny) | admin prompt denied | Confirm stays open; same error copy; `staged: []` retained; nothing persisted | show inline error |
| Confirm, double-press | clearing in flight | Confirm button disabled while `clearing=true`; second tap is a no-op | N/A |
| Toast link tap | toast visible | Navigate to Blocklist surface (existing `selectRow(0)`) | N/A |
| Race with concurrent Apply | another Apply in flight | Shared `enqueue` serializes — Panic runs after prior write; `committed` re-read inside apply ensures latest snapshot | N/A |
</frozen-after-approval>

## Code Map

- `src/components/Panic.tsx` (NEW) — self-contained destructive clear flow. State: `confirmOpen`, `clearing`, `error`. Trigger: outlined destructive `Pressable` mirroring `ChangePassword.tsx:198-221,399-408` (border + text in `tokens.destructive`, label "Clear all blocked hosts"). `onPress` → `useDomainStore.getState().requirePassword(() => setConfirmOpen(true))` (3-3's gate-first pattern at `ChangePassword.tsx:119-122`). Confirm (when `confirmOpen`): inline prompt under the trigger with `accessibilityRole="alert"` text "Clear all blocks? This cannot be undone." + two `Pressable`s — Cancel (closes, no apply) + Confirm (calls `handleClear`). `handleClear`: sets `clearing=true`, calls `useDomainStore.setState({ staged: [] })` then `useDomainStore.getState().apply()`; on `.then(result)` with `result.ok === true`, dismiss confirm + raise success toast; on `result.ok === false` or `.catch`, show inline error copy + keep confirm open + `clearing=false`. Styles mirror `ChangePassword.tsx` tokens (typography `body`/`title`, `rounded.md`, `spacing.md/lg`).
- `src/components/Settings.tsx` (EDIT) — inside the existing `dangerZone` `View` (`Settings.tsx:46-51`), mount `<Panic/>` immediately after `<ChangePassword/>` (between current lines 50 and 51). Add `marginTop: tokens.spacing.md` to the new `<Panic/>` wrapper for sibling separation. No other Settings.tsx change.
- `src/components/Shell.tsx` (EDIT — review patch P18) — single hosted `<PasswordGate onVerified={runGateAction} onClose={closeGate}/>` (`Shell.tsx:258-260`); `runGateAction` (`Shell.tsx:208-219`) reads `gateAction` at call time; `closeGate` runs in `finally`. EDIT threads `onNavigateBlocklist={() => selectRow(BLOCKLIST_SURFACE_INDEX)}` into `<Settings/>`. Justified by the spec's own Code Map note: "If post-success toast ... need Shell-level plumbing". No new Shell state; Settings is the seam. Uses the named `BLOCKLIST_SURFACE_INDEX` constant exported from `surfaces.tsx` (review patch P6), and the navigation handler guards against `gateOpen === true` (a surface swap mid-gate is unsafe — the gate's `onVerified` reads `gateAction` at call time and expects unchanged shell state).
- `src/components/ChangePassword.tsx` (READ-ONLY) — pattern to mirror for gate-first trigger (L119-122), destructive outlined button style (L198-221, L399-408), save-failure copy handling (L308-315).
- `src/components/PasswordGate.tsx` (READ-ONLY) — reusable gate sheet; Panic only calls `requirePassword`, never mounts `<PasswordGate>` itself.
- `src/domain/store.ts` (READ-ONLY) — `requirePassword` (L486), `apply` (L335-380), `staged` state (L228), `enqueue` (L586). No edit. The Panic action is `setState({ staged: [] })` + `apply()` — both already exist.
- `src/domain/apply.ts` (READ-ONLY) — `runApply` (L53-86): `writeConfig({...committed, domains: staged})` → `effectiveHostsLines(nextConfig)` → `writeHosts(lines)`. Empty `lines` already writes markers-only (per apply.ts:79-85 comment). No edit.
- `src/domain/effectiveBlocklist.ts` (READ-ONLY) — `effectiveBlocklist({...committed, domains: []}).length === 0` → status count drops to 0 for free (`StatusHeader.tsx:54`).
- `src/hosts/shellRunner.ts` (READ-ONLY) — `writeHosts(lines)` accepts any `string[]`. No new port op.
- `src/theme/tokens.ts` (READ-ONLY) — `destructive` (L92), `typography`, `rounded`, `spacing`. Already imported by ChangePassword; Panic reuses the same pattern.
- `__tests__/Panic.test.tsx` (NEW) — mirror `ChangePassword.test.tsx` harness (jest.mock both native specs, react-test-renderer + `ReactTestRenderer.act`, `seedState` + real-action capture, prop-based tree queries). Cover: trigger renders only when `hasPassword` (parent-gated); trigger → `gateOpen` true; gate Esc aborts (no `staged` change); gate verify correct → confirm opens; Cancel confirm → no `staged` change; Confirm + `writeHosts` ok → `committed.domains === []` + confirm closes + success toast appears; Confirm + `writeHosts` `{ok:false}` → error copy + `staged` retained + confirm stays open; double-press Confirm while `clearing` is a no-op (button disabled); "Re-enable your blocklist" link taps call `selectRow(0)`.
- `__tests__/Settings.test.tsx` (EDIT) — add an assertion that the Panic trigger renders inside the Danger Zone when `hasPassword` (alongside the existing `<ChangePassword/>` assertion at L124-159); absent when no password. Lock the surface change.
- `__tests__/store.test.ts` (READ-ONLY — no new tests) — already covers `apply` + `enqueue`; Panic's store interaction is `setState({ staged: [] })` + `apply()` which is already tested.

## Tasks & Acceptance

**Execution:**
- [ ] `src/components/Panic.tsx` -- create the self-contained password-gated clear flow: outlined destructive trigger calling `requirePassword(() => setConfirmOpen(true))`, inline destructive confirm ("Clear all blocks? This cannot be undone.") with Cancel + Confirm buttons, `handleClear` setting `staged: []` then calling `apply()`, inline error copy on apply failure, success toast with "Re-enable your blocklist" navigation link on success; reuses 3-1 `apply` + 3-2 gate with zero new store code, zero new port op.
- [ ] `src/components/Settings.tsx` -- mount `<Panic/>` as a sibling of `<ChangePassword/>` inside the existing `dangerZone` `View` (between current lines 50 and 51); add sibling spacing via `marginTop: tokens.spacing.md` on the wrapper -- the Danger Zone is extensible for the next gated action.
- [ ] `__tests__/Panic.test.tsx` -- cover trigger→gate-open, gate-Esc-aborts, gate-verify→confirm-open, Cancel-noop, Confirm-success (committed empty + toast), Confirm-failure (error copy + staged retained), double-press noop, Re-enable-link navigates to Blocklist -- prove the end-to-end panic flow per the matrix.
- [ ] `__tests__/Settings.test.tsx` -- extend the Danger Zone assertions to include the Panic trigger alongside the existing `<ChangePassword/>` assertion (when `hasPassword`); keep the no-password branch pinned -- lock the Settings surface change.

**Acceptance Criteria:**
- Given a password is set, when the user opens Settings, then the Danger Zone contains a destructive "Clear all blocked hosts" button next to "Change password"; given no password is set, then the Danger Zone (and Panic) is absent.
- Given the trigger is pressed, when the gate sheet opens, then the inline confirm is NOT yet visible.
- Given the gate is open, when the user presses Esc, then the gate closes, the confirm does NOT open, and no clear occurs.
- Given correct current-password entry, when the gate verifies, then the gate closes and the inline confirm appears with "Clear all blocks? This cannot be undone." + Cancel + Confirm.
- Given the confirm is open, when the user presses Cancel, then the confirm closes and `staged` is unchanged.
- Given the confirm is open, when the user presses Confirm and `apply()` succeeds, then `committed.domains === []`, the confirm closes, and a success toast with a "Re-enable your blocklist" link appears.
- Given the confirm is open, when the user presses Confirm and `apply()` fails (writeConfig error OR `writeHosts` `{ok:false}` admin-deny), then the confirm stays open with the inline error "Couldn't update /etc/hosts. No changes made.", `staged: []` is retained, and `committed.domains` is unchanged.
- Given a clear is in flight, when the user double-taps Confirm, then the second tap is a no-op (button disabled while `clearing=true`).
- Given the success toast is visible, when the user taps "Re-enable your blocklist", then Blocklist surface becomes active.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. -->

## Design Notes

- **Why a separate Confirm step after the gate:** the gate verifies password (authorization), but Panic is irreversible and high-stakes — a single mis-tap of "Clear all blocked hosts" must not clear 50 entries. The inline confirm is the friction layer that catches that one extra tap. It mirrors 3-3's two-step pattern (gate verifies → inline form opens) but with a destructive confirm instead of a form. This keeps the gate single-responsibility (auth) and the action single-responsibility (destructive UX).
- **Why `setState({ staged: [] })` + `apply()`, not a new store action:** the existing Apply pipeline already writes `domains: staged` → `writeHosts(effectiveHostsLines(nextConfig))`. With `staged = []`, `effectiveHostsLines` returns `[]`, and `writeHosts([])` writes the markers-only managed section per `apply.ts:79-85`. The admin prompt fires once (one `writeHosts` call), the queue serializes against any concurrent Apply, and `committed` re-reads at run time. A new `clearEffectiveBlocklist` action would be a parallel path that bypasses the queue and re-implements error handling — both already exist.
- **Why inline confirm, not a sheet:** Change password set the precedent (3-3 Design Notes: "Inline form, not a sheet"). Panic's confirm is even shorter than Change password's form (no fields, just two buttons), so a sheet would be over-engineering and duplicate Shell/overlay wiring. Component-local state is correct here.
- **Why no Sidebar/StatusHeader Panic:** 1-3 fixed the sidebar to exactly four rows (Blocklist/Timer/Schedule/Settings) from `SURFACE_NAMES`; adding Panic there would break ⌘1-⌘4 navigation. StatusHeader is always-visible across surfaces; Panic only makes sense in Settings (where authorization + consequence belong together). The epic context explicitly says "Gate scope is narrow and escapes-only" — Panic stays in the dangerous-actions surface.
- **Why toast with link, not a banner or modal:** the user's intent is "I cleared my blocks; now what?" A toast with a tappable link is the lightest-weight affordance; render it component-local inside the Danger Zone `View` for v1 (no Shell-level toast infra).

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors (pnpm wrapper is sandbox-broken; use `node_modules/.bin/tsc`).
- `node_modules/.bin/jest --watchman=false __tests__/Panic.test.tsx __tests__/Settings.test.tsx` -- expected: new + updated tests green.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions.

**Manual checks:**
- App builds + launches (usual pnpm macos path); with a password set, Settings → Danger Zone shows "Change password" + "Clear all blocked hosts". Click Panic → gate sheet verifies current password → correct entry opens the inline confirm → Confirm triggers a real admin prompt → on allow, `/etc/hosts` managed section clears (verified via Hosts viewer or `effectiveBlocklist(committed).length === 0` in StatusHeader); on deny, error copy shown, nothing cleared. No-password case still shows `SetPassword` only (no Danger Zone).
- Concurrent stress: with a password set, while Blocklist is staging domain adds, click Panic and Confirm → Apply serializes (Panic runs after staged adds commit or fails behind them); no race-induced partial clear.

## Suggested Review Order

**Design entry point**

- Panic's gate-first trigger + UI state flip — read this first to grasp the design.
  [`Panic.tsx:167`](../../src/components/Panic.tsx#L167)

- Stale-resolve guard via token-ref — protects Cancel-then-late-apply and unmount races.
  [`Panic.tsx:141`](../../src/components/Panic.tsx#L141)

**Core flow**

- Inline destructive confirm (Cancel stays enabled even mid-apply).
  [`Panic.tsx:194`](../../src/components/Panic.tsx#L194)

- `handleClear` — stages empty + drives existing `apply()`; no new store action.
  [`Panic.tsx:215`](../../src/components/Panic.tsx#L215)

- Success toast + "Re-enable your blocklist" link with `accessibilityLiveRegion="polite"`.
  [`Panic.tsx:295`](../../src/components/Panic.tsx#L295)

**Surface wiring**

- Panic mounts as sibling of ChangePassword inside Danger Zone, sibling spacing via `style` prop.
  [`Settings.tsx:78`](../../src/components/Settings.tsx#L78)

- Shell threads `onNavigateBlocklist` using the named `BLOCKLIST_SURFACE_INDEX` constant.
  [`Shell.tsx:266`](../../src/components/Settings.tsx#L266) and constant at [`surfaces.tsx:38`](../../src/components/surfaces.tsx#L38)

- Gate-open guard on the navigation callback — surface swap mid-gate is unsafe.
  [`Shell.tsx:267`](../../src/components/Shell.tsx#L267)

**Tests**

- Full panic I/O matrix coverage — 14 tests across trigger → gate → confirm → apply → toast.
  [`Panic.test.tsx:1`](../../__tests__/Panic.test.tsx#L1)

- Shell-level end-to-end navigation wiring (Re-enable → Blocklist surface).
  [`Shell.test.tsx:1`](../../__tests__/Shell.test.tsx#L1)

- Settings assertions: Panic inside Danger Zone + absent when no password.
  [`Settings.test.tsx:144`](../../__tests__/Settings.test.tsx#L144)
