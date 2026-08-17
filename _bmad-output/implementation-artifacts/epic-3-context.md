# Epic 3 Context: Security & Discipline Gate

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Let the user set a self-discipline password that gates the escape / high-stakes actions — end-early a running timer, Panic (remove all blocks), and change password — so a stray click cannot disable blocking on impulse. The gate is honestly a speed bump, not tamper-proof security: a determined admin can still `sudo vim /etc/hosts` (accepted for v1). Single-item removal (a domain, a schedule) stays a confirm-alert; adding blocks, starting a timer, and enabling a schedule stay exempt — friction lives on the escape, not on building protection. This epic builds the password gate mechanism once (hash, gate sheet, throttle); Epic 4's end-early reuses it.

## Stories

- Story 3.1: Set password (salt-free SHA-256)
- Story 3.2: Password gate sheet (reusable)
- Story 3.3: Danger Zone section and Change password
- Story 3.4: Panic unblock (password-gated)

## Requirements & Constraints

- The password is stored as a salt-free SHA-256 hash in `config.json` (`passwordHash`); plaintext is never persisted. The gate re-hashes the entry and compares. This is sufficient for a self-discipline tool; stronger lock models (random text, grace windows, accountability-partner) are explicitly Phase 2.
- Gate scope is narrow and escapes-only: end-early a running timer, Panic, and change-password. Single-item removal / schedule-disable / always-on-toggle-OFF are confirm-alerts (their ACs live in Epics 2 and 5). Adding blocks, starting a timer, and enabling a schedule are fully exempt — making protection stricter is always friction-free.
- The gate is the *second* of two distinct gates and must never be conflated with the first: the OS admin prompt (`osascript`) fires on every Apply that writes `/etc/hosts` (system auth, non-negotiable); the app password is Frosthalt's self-discipline gate. Panic still triggers an OS admin prompt because it clears the managed section via the Apply pipeline.
- Panic removes all blocks immediately by clearing the managed `/etc/hosts` section through the existing serialized Apply pipeline (admin prompt → write → flush). Config is preserved (domains, schedules, settings stay); only the hosts section is cleared. There is no undo by design; a toast offers a "Re-enable your blocklist" path back to Blocklist.
- Change password first verifies the current password via the gate sheet, then accepts a new one with retype confirmation, then updates `passwordHash`.
- A wrong gate entry clears the field and shows a neutral "That didn't match. N tries left." (no leakage of which part failed). After 5 wrong attempts a throttle engages with a visible wait.
- All native methods return `{ ok, error?, data? }`. A denied admin prompt during Panic surfaces the standard toast "Couldn't update /etc/hosts. No changes made." and clears nothing.
- Panic must never fire on a stray click (password required); a wrong password does not clear anything.

## Technical Decisions

- Password hash: salt-free SHA-256 in `config.json` under the `passwordHash` key (added to the config shape on top of Epic 2). No salt, no KDF — intentional for a self-discipline tool.
- Gate mechanism is built once in Story 3.2 as a reusable component callable by any gated action; Story 3.3 (change-password) and Story 3.4 (Panic) call it, and Epic 4 Story 4.6 (end-early) reuses it. Do not stub or fork the gate per caller.
- Reuse the Epic 1 serialized Apply pipeline for Panic — no new privileged code in this epic. Panic commits a "clear effective blocklist" staged edit and runs Apply; the domain layer remains the sole owner of effective-blocklist computation and the sole caller of `ShellRunner.writeHosts`.
- Reuse the Epic 2 config store for `passwordHash` — no new native module.
- Dependency direction is unchanged: UI → domain (Zustand) → adapters → ports. No `child_process`/`fs`/`os` imports in `src/`.

## UX & Interaction Patterns

- Password gate sheet: re-enter password; field uses `secureTextEntry` (NSSecureTextField) with spellcheck/autocapitalise off, a Show/Hide toggle, and paste + password-manager support. On wrong entry the field clears and shows tries-left; on throttle, a visible wait. `Esc` cancels the gate sheet and aborts the action.
- Danger Zone: a visually distinct section in Settings grouping destructive actions (Panic, Change password). Buttons use `colors.destructive`. No destructive button is ever the window's default (never pulses). `Esc` cancels any open destructive action. VoiceOver announces the Danger Zone as a distinct region; destructive buttons are clearly labelled.
- Set-password field: confirm-entry (retype) with minimum length; mismatched entries rejected inline; same `secureTextEntry` + Show/Hide + paste support as the gate sheet.
- VoiceOver: password field a11y (Show/Hide, paste, secureTextEntry, spellcheck off); destructive actions never default + `Esc` cancels; tabular numerals not relevant here.

## Cross-Story Dependencies

- Depends on Epic 1: Panic clears the managed hosts section via the serialized Apply pipeline (commit → writeHosts → flush, one admin prompt).
- Depends on Epic 2: `passwordHash` is added to the existing `config.json` shape and persisted via the existing ConfigStore.
- Feeds Epic 4: Story 4.6 (end-early a running timer) reuses the reusable gate sheet from Story 3.2 — build it once here, do not stub it.
- Standalone with respect to Epic 5: schedule enable/disable and single-schedule removal stay confirm-alerts (no password gate); only Panic clears schedules' enforcement in one shot, via the same Apply path.