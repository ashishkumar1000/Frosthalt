---
title: 'Danger Zone section and Change password'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f09944ba06f61745014df5b6605bc92f485724dd'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 3-1 set a password and 3-2 built a reusable gate, but no gated action exists yet — the user cannot change their password, and Settings has no surface for sensitive operations.

**Approach:** Add a visually distinct "Danger Zone" section to Settings (shown only when a password is set) whose first occupant is Change password: a destructive-styled button calls `requirePassword(() => setChangeOpen(true))`; the gate verifies the current password; on verify the gate closes and an inline New+Confirm form (mirroring `SetPassword`) opens; submitting calls the existing `setPassword(newPw)` to overwrite the hash. No new store action, no new gate code, no Shell change.

## Boundaries & Constraints

**Always:**
- Reuse 3-2's `requirePassword(action)` as the single gate entry point and 3-1's `setPassword(pw)` as the hash-write. No new store action, no `changePassword` action, no re-verify of the current password inside the form (the gate already verified). No direct `writeConfig`/`writeHosts`/`apply.ts` change.
- Flow is gate-first per epic: button → gate verifies current password → on verify, form opens for New+Confirm → submit writes the new hash. The gated action is a UI state flip (`() => setChangeOpen(true)`), NEVER a re-entrant `requirePassword` call (avoids deferred E1/B3 double-open — deferred-work.md L203-206).
- Danger Zone renders ONLY when `hasPassword` (reuse Settings.tsx:28 sentinel `passwordHash != null && passwordHash !== ''`). When no password is set, Settings shows `SetPassword` (unchanged 3-1 surface); the Danger Zone and change-password button never appear.
- Change-password form mirrors `SetPassword.tsx` field/a11y/validation exactly: `secureTextEntry` + Show/Hide per field, `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`, `autoComplete="off"`, `editable={!saving}`, `maxLength={1024}`, `onSubmitEditing={submit}`, `accessibilityRole="alert"` on errors. Validation: `newTrimmed.length >= PASSWORD_MIN_LENGTH` AND `newTrimmed === confirmTrimmed` (reuse `PASSWORD_MIN_LENGTH` from `password.ts`). Positive submit gate (mirror SetPassword.tsx:103-108).
- Danger Zone is visually distinct: header in `tokens.destructive`; the "Change password" button uses `tokens.destructive` (the token's documented purpose at tokens.ts:49 names Change password). No destructive button is ever the window default (never pulses); VoiceOver announces the Danger Zone as a distinct region (header `accessibilityRole="header"` + a labelled container — RN 0.81 has no `region`/`group` role).
- `setPassword(newPw)` routes through the shared `enqueue` queue and re-reads `committed` at run time (store.ts:467-473) — a concurrent Apply can't be clobbered. On ok, `committed.passwordHash` updates → Settings re-renders. On failure, `committed` is unchanged and the form shows a save error.

**Ask First:**
- Whether Esc should cancel the open change-password form (the form is inline, not Shell-hosted, so Esc wiring would need a Shell change or a local handler). Proposed: rely on the form's Cancel button for 3-3; defer Esc-to-cancel-form (the gate — the dangerous authorization step — is already Esc-handled by 3-2).

**Never:**
- Build Panic (that's 3-4 — Danger Zone is extensible for it, but 3-3 ships only Change password).
- Re-verify the current password inside the form (gate already did) or add a `changePassword` store action.
- Add scrim-click-to-dismiss to the gate (deferred B14, deferred-work.md L208-210).
- Persist the `changeOpen` UI toggle to `config.json`/`Config`/`types.ts` — it is component-local state.
- Make the change-password button or form submit the window default.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Open gate | password set; click "Change password" | Gate sheet opens (current-pw verify) | N/A |
| Gate verified | correct current password | Gate closes; New+Confirm form opens | N/A |
| Esc during gate | gate open | Gate closes; form does NOT open; no change | N/A |
| New too short | newTrimmed.length < PASSWORD_MIN_LENGTH | "Too short" inline error; submit disabled | N/A |
| New ≠ confirm | newTrimmed !== confirmTrimmed | "Passwords don't match" inline error; submit disabled | N/A |
| Valid submit, write ok | valid form; writeConfig ok | `committed.passwordHash` updates; form closes; success message | N/A |
| Valid submit, write fails | valid form; writeConfig fails | Form stays open; save-error shown; `committed` unchanged | status='error' (mirror SetPassword) |
| Cancel form | form open; click Cancel | Form closes; no change; no submit | N/A |

</frozen-after-approval>

## Code Map

- `src/components/ChangePassword.tsx` (NEW) — self-contained change-password flow. State: `changeOpen`, `entry`/`confirm` + per-field show/hide (mirror SetPassword.tsx:53-70), `saving`, `status`. Trigger: destructive "Change password" `Pressable` → `useDomainStore.getState().requirePassword(() => setChangeOpen(true))`. Form (when `changeOpen`): two `secureTextEntry` fields (New + Confirm) mirroring SetPassword.tsx:175-229 a11y + Show/Hide; validation mirroring :77-86; submit gate mirroring :103-108; `handleSubmit` calls `setPassword(newTrimmed).then(...)` mirroring :110-145; Cancel button → `setChangeOpen(false)` + clear fields. Errors use `accessibilityRole="alert"` + `tokens.destructive`.
- `src/components/Settings.tsx` (EDIT) — `hasPassword` branch (L33-37): keep a "Password set" status line; add a Danger Zone section (destructive header `accessibilityRole="header"` + labelled container + `tokens.spacing.lg` top separation) rendering `<ChangePassword/>`. No-password branch unchanged (`<SetPassword/>`). Add styles: `sectionHeader` (`...tokens.typography.title, color: tokens.destructive`), `dangerZone` (container, `marginTop: tokens.spacing.lg`).
- `src/domain/store.ts` (READ-ONLY) — reuse `requirePassword` (L486-498), `setPassword` (L439-482), gate state. No edit.
- `src/components/PasswordGate.tsx`, `src/components/Shell.tsx` (READ-ONLY) — gate already wired (Shell.tsx:208-219 `runGateAction`, :143-146 Esc, :258-260 render). No edit.
- `src/config/password.ts` (READ-ONLY) — reuse `PASSWORD_MIN_LENGTH` (L26); `hashPassword` reached via `setPassword`.
- `src/theme/tokens.ts` (READ-ONLY) — `destructive` (L50/L92), `spacing`, `typography`, `rounded`.
- `__tests__/ChangePassword.test.tsx` (NEW) — mirror SetPassword.test.tsx harness (react-test-renderer, native mocks, `seedState` + real-action capture, `findField`, `extractText`). Cover: trigger renders + a11y; click trigger → `gateOpen` true (password set); gate verify correct → form opens; New too short / mismatch → error + submit disabled; valid submit + writeConfig ok → `committed.passwordHash` updates + form closes; writeConfig fail → error; Cancel → form closes.
- `__tests__/Settings.test.tsx` (EDIT) — flip the L119-135 assertions: Danger Zone header + "Change password" now appear when `hasPassword`; absent when no password. No regression on the no-password `SetPassword` branch.

## Tasks & Acceptance

**Execution:**
- [x] `src/components/ChangePassword.tsx` -- create the self-contained change-password flow: destructive trigger calling `requirePassword(() => setChangeOpen(true))`, conditional New+Confirm form mirroring SetPassword's fields/a11y/validation/submit-gate, `handleSubmit` calling `setPassword(newTrimmed)`, Cancel button -- the first real gate caller; reuses 3-1 `setPassword` + 3-2 gate with zero new store code.
- [x] `src/components/Settings.tsx` -- add the Danger Zone section (destructive header + labelled container) under the `hasPassword` branch and render `<ChangePassword/>` -- the sensitive-actions surface; extensible for Panic (3-4).
- [x] `__tests__/ChangePassword.test.tsx` -- cover trigger→gate-open, verify→form-open, validation (too short/mismatch), submit success + failure, Cancel, Esc-during-gate, a11y -- prove the end-to-end change-password flow per the matrix.
- [x] `__tests__/Settings.test.tsx` -- flip the absent-assertions to present (Danger Zone + Change password appear when `hasPassword`); keep the no-password branch pinned -- lock the Settings surface change.

**Acceptance Criteria:**
- Given a password is set, when the user opens Settings, then a Danger Zone section with a "Change password" button is visible; given no password is set, when the user opens Settings, then the Danger Zone section is absent and `SetPassword` shows.
- Given a password is set, when the user clicks "Change password", then the gate sheet opens to verify the current password; the form is NOT yet visible.
- Given the gate is open, when the user presses Esc, then the gate closes, the form does NOT open, and no password change occurs.
- Given correct current-password entry, when the gate verifies, then the gate closes and the New+Confirm form opens.
- Given a new password below `PASSWORD_MIN_LENGTH` or not matching its confirmation, when the user attempts to submit, then the submit is disabled and an inline error shows.
- Given a valid New+Confirm, when the user submits and the write succeeds, then `committed.passwordHash` updates to the new hash, the form closes, and a success state shows.
- Given a valid submit, when the write fails, then the form stays open with a save error and `committed.passwordHash` is unchanged.

## Design Notes

- **Reuse `setPassword`, not a new `changePassword`:** the gate already verifies the current password, so the form's submit only needs to write the new hash — which is exactly `setPassword(newPw)` (store.ts:439-482): `enqueue` + run-time `committed` re-read + `{ ...committed, passwordHash: hashPassword(pw) }` + `writeConfig`. A separate `changePassword` action would duplicate this with no added safety. The component is user-facing "Change password"; internally it calls the `setPassword` primitive.
- **Gate-first flow:** the gated action is `() => setChangeOpen(true)` — a UI state flip, not a `requirePassword` re-entry. This sidesteps the deferred E1/B3 double-open (deferred-work.md L203-206): the action never calls `requirePassword` again, so it cannot displace its own `gateAction`. The Shell `runGateAction` (Shell.tsx:208-219) runs the flip, then `closeGate` runs in `finally` — the form opens after the gate closes.
- **Inline form, not a sheet:** the change form renders inline under the Danger Zone (mirroring `SetPassword` being inline), so 3-3 needs no new Shell-hosted overlay. The gate→inline-form transition (overlay closes, form appears below) is acceptable; a second Shell-hosted sheet for the form is a deferred UX consideration. Esc-to-cancel-the-form is deferred (see Ask First); the Cancel button is the cancel path, and the dangerous authorization (the gate) is already Esc-handled.
- **Danger Zone extensibility:** the section is a header + container in Settings; 3-4 adds `<Panic/>` as a sibling to `<ChangePassword/>`. No abstraction needed yet.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors (pnpm wrapper is sandbox-broken; use `node_modules/.bin/tsc`).
- `node_modules/.bin/jest --watchman=false __tests__/ChangePassword.test.tsx __tests__/Settings.test.tsx` -- expected: new + updated tests green.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions.

**Manual checks:**
- App builds + launches (usual pnpm macos path); with a password set, Settings shows the Danger Zone + "Change password"; click it → gate sheet verifies current password → correct entry opens the New+Confirm form → submit changes the password (re-launch; old password verifies in the gate, new password works). No-password case still shows `SetPassword` only.