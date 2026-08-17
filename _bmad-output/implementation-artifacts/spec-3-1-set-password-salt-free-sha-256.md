---
title: 'Set password (salt-free SHA-256)'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '1b1c535d8b0a4757d2b21b5a956e0d4815f5600e'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Frosthalt has no self-discipline password yet, so any escape action (end-early, Panic, change-password) can fire on a stray click. Epic 3 builds the gate; this story delivers the first half — the ability to *set* a password and persist it hashed — plus the Settings surface that hosts it (currently a placeholder).

**Approach:** Add a pure-JS salt-free SHA-256 (FIPS 180-4) and a `hashPassword` helper. Add a `setPassword` store action that writes `passwordHash` into `config.json` via the existing ConfigStore (no new native module). Introduce a minimal Settings screen with a set-password form (entry + retype, min length, inline errors, `secureTextEntry` + Show/Hide + paste). Plaintext is never persisted. The reusable gate sheet, throttle, Danger Zone, change-password, and Panic are later stories.

## Boundaries & Constraints

**Always:**
- Hash with salt-free SHA-256 (pure-JS `src/config/sha256.ts`, FIPS 180-4); persist only the 64-char hex digest as `passwordHash`. No salt, no KDF (AD-9, by design).
- Keep all hashing/validation in the JS layer. ConfigStore native is a dumb string-file adapter — never push hashing or `passwordHash` validation into native, and never tighten `readConfig`'s resilience validators to require `passwordHash` (would break missing/pre-Epic-3 configs).
- Dependency direction: UI → domain (Zustand) → adapter → port. No `child_process`/`fs`/`os` imports in `src/`. No back-import from `configStore.ts` into the store.
- `setPassword` is non-block-affecting (AD-6): commit directly to config, do NOT go through the staged-Apply pipeline, do NOT touch `/etc/hosts`.
- Sequence the password write through the existing serialized queue (or guard on `applyStatus === 'idle'`) so a direct `writeConfig` can never race/clobber an in-flight Apply's `writeConfig`. Build the full next `Config` (`{...committed, passwordHash}`) before writing — `writeConfig` serializes the whole config.
- `passwordHash` stays absent on `DEFAULT_CONFIG` (`undefined` = "no password set yet"). Do not add `passwordHash: ''`.
- Password fields: `secureTextEntry`, `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`, `autoComplete="off"`; paste allowed; Show/Hide toggle; VoiceOver labels on the field and the toggle. No password field is ever the window default.
- All native results use the `{ ok, error?, data? }` envelope. Verify SHA-256 against NIST FIPS 180-4 known-answer vectors in a unit test, including at least one non-ASCII input to lock the UTF-8 path.

**Ask First:**
- Any change to the on-disk config path or the ConfigStore native API (`readConfig`/`writeConfig`).
- Adding any new runtime dependency (we chose none — pure-JS SHA-256).

**Never:**
- Build the reusable gate sheet, throttle, Danger Zone section, change-password, or Panic (Stories 3-2/3-3/3-4).
- Gate any existing action (domain remove, always-on toggle, Apply) on the password in this story.
- Store, log, or retain the plaintext password beyond the field lifecycle.
- Roll a non-SHA-256 scheme.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Set first password (happy) | `passwordHash` unset; entry = confirm, len ≥ min | `passwordHash = sha256(entry)` persisted; `committed.passwordHash` set; fields cleared; UI → "Password set" | N/A |
| Mismatched entries | "abc123" then "abc124" | Inline "Passwords don't match"; submit disabled; nothing written | N/A |
| Too short | "ab" (< min) | Inline length error; submit disabled; nothing written | N/A |
| Empty / blank | "" in either field | Submit disabled (clean gate); no error spam | N/A |
| Password already set | `passwordHash` present | Set-password form hidden; neutral "Password set" state (change-password is 3-3) | N/A |
| `writeConfig` fails | ConfigStore returns `{ok:false}` | Surface "Couldn't save password. No changes made."; `committed.passwordHash` unchanged | Plaintext not persisted; state unchanged |
| Submit during in-flight Apply | Apply running | Write sequenced behind the queue; no clobber of Apply's `writeConfig` | N/A |

</frozen-after-approval>

## Code Map

- `src/config/types.ts:58,62,86` — `passwordHash?: string` already declared; `DEFAULT_CONFIG` intentionally omits it. READ-ONLY: keep it absent (do not add `''`).
- `src/config/configStore.ts:36,100` — `readConfig` / `writeConfig` (full-config serialization); the only persistence path. READ-ONLY: do not add `passwordHash` validation here.
- `src/domain/store.ts:103,137,355-371` — `useDomainStore`, `committed`, serialized `enqueue` queue. Add the `setPassword` action here.
- `src/domain/apply.ts:64` — existing `writeConfig` caller (Apply). READ-ONLY: sequence against it, do not modify.
- `src/config/sha256.ts` (NEW) — pure-JS SHA-256, FIPS 180-4, hex digest. Encode input as UTF-8 bytes; if Hermes lacks `TextEncoder`, include a minimal UTF-8 encoder in-file.
- `src/config/password.ts` (NEW) — `hashPassword(pw): string` (= `sha256(pw)`) and `PASSWORD_MIN_LENGTH` constant.
- `__tests__/sha256.test.ts` (NEW) — NIST FIPS 180-4 known-answer vectors (empty, `"abc"`, `"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"`, one non-ASCII input).
- `src/components/Settings.tsx` (NEW) — Settings screen shell mirroring `Blocklist` container/title; branches on `committed.passwordHash` (form vs "Password set").
- `src/components/SetPassword.tsx` (NEW) — entry + confirm `secureTextEntry` fields, Show/Hide each, live length/match validation, disabled-until-clean submit, calls `useDomainStore.setPassword`.
- `src/components/Shell.tsx:189-202` — add `else if (surface === 3) <Settings/>` replacing the placeholder.
- `src/components/surfaces.tsx:21-26,37` — surface registry (Settings = index 3) and placeholder text to drop.
- `src/components/Blocklist.tsx:155-218,222-232` — container/title pattern to mirror for Settings.
- `src/components/AddDomain.tsx:84-95,130-160,178-194` — inline-error (`accessibilityRole="alert"` + `tokens.destructive`), live preview, disable-until-clean, field-disable-input attrs to mirror for `SetPassword`.
- `src/theme/tokens.ts:49,91-116` — `destructive` (systemRedColor), spacing/typography/rounded tokens.
- `macos/Frosthalt-macOS/ConfigStore.swift`, `NativeConfigStore.mm` — native ConfigStore. READ-ONLY: do not modify.
- `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md:120,134-138,162` — AD-6 (non-block-affecting direct commit), AD-9 (salt-free SHA-256), `{ok,error?,data?}` envelope.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/sha256.ts` -- add pure-JS SHA-256 (FIPS 180-4) returning a hex digest, with UTF-8 byte encoding of the input -- the hash mechanism for `passwordHash`; no dep, no native (AD-9, epic-3-context "no new native module").
- [x] `__tests__/sha256.test.ts` -- assert NIST FIPS 180-4 known-answer vectors plus one non-ASCII input -- prove the impl is correct and the UTF-8 path works, not just self-consistent.
- [x] `src/config/password.ts` -- add `hashPassword(pw)` and `PASSWORD_MIN_LENGTH` (e.g. 6) -- single-purpose hashing + the one validation constant reused by 3-3 later.
- [x] `src/domain/store.ts` -- add `setPassword(pw): {ok, error?}` that builds `{...committed, passwordHash: hashPassword(pw)}`, sequences the `writeConfig` through the existing serialized queue (guard on `applyStatus === 'idle'` or enqueue a write-only job), and on ok sets `committed` / on fail returns error and leaves state unchanged -- non-block-affecting direct config commit, race-safe vs Apply (AD-6).
- [x] `src/components/SetPassword.tsx` -- two `secureTextEntry` fields (entry + confirm) with Show/Hide toggles, live length + match validation mirroring `AddDomain`'s inline-error pattern, disabled-until-clean submit, calls `useDomainStore.setPassword` and clears fields on success -- the set-password UX (retype, min length, inline errors, a11y).
- [x] `src/components/Settings.tsx` -- new screen mirroring `Blocklist`'s container/title; render `SetPassword` when `committed.passwordHash` is unset, else a neutral "Password set" state -- introduces the Settings surface to host set-password.
- [x] `src/components/Shell.tsx` -- add `else if (surface === 3) <Settings/>` at the render branch -- wire the Settings screen into the shell.
- [x] `src/components/surfaces.tsx` -- drop the Settings placeholder text (screen now real) -- keep the surface registry intact.

**Acceptance Criteria:**
- Given no password is set, when the user opens Settings, then a set-password form (entry + confirm) is shown.
- Given valid matching entries of length ≥ `PASSWORD_MIN_LENGTH`, when the user submits, then `passwordHash` = `sha256(entry)` is persisted in `config.json` and the plaintext appears nowhere in the file.
- Given mismatched or too-short entries, when the user attempts to submit, then submit is disabled and an inline error is shown; no write occurs.
- Given a password is already set, when the user opens Settings, then a neutral "Password set" state is shown and no change-password UI is present in this story.
- Given an Apply is in-flight, when the user sets a password, then the password write is sequenced so it does not clobber the Apply's `writeConfig`.
- Given the SHA-256 implementation, when run against NIST FIPS 180-4 vectors, then the unit test passes.
- Given a `writeConfig` failure, when the user submits, then "Couldn't save password. No changes made." is surfaced and `committed.passwordHash` stays unchanged.
- Given the password fields, then they use `secureTextEntry`, disable autocapitalise/autocorrect/spellcheck/autocomplete, allow paste, and expose Show/Hide + VoiceOver labels.

## Design Notes

- **UTF-8 on Hermes:** SHA-256 operates on bytes; the input string must be UTF-8 encoded. Hermes may not expose `TextEncoder`. If absent, add a ~30-line UTF-8 encoder in `sha256.ts` and lock it with the non-ASCII test vector (compute the expected digest against a trusted reference such as Node `crypto` in a scratch script — do not ship the scratch script).
- **Race-safety:** `writeConfig` is atomic-rename (no corruption), but a direct `setPassword` write interleaved with an Apply `writeConfig` can lose data (the later rename wins). Reuse the existing serialized queue so the two never overlap; a write-only job (no `writeHosts`) is fine.
- **State sentinel:** `passwordHash === undefined` is the clean "no password set yet" signal — the form vs. "Password set" branch keys off it. Do not conflate `''` with unset.
- **Scope honesty:** This story introduces a *minimal* Settings shell (title + set-password). Story 3-3 will add the Danger Zone section and change-password; expect that screen to grow. Keep the shell layout simple and mirroring `Blocklist` so 3-3 can extend it without rework.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors (pnpm wrapper is sandbox-broken; use `node_modules/.bin/tsc`).
- `node_modules/.bin/jest --watchman=false __tests__/sha256.test.ts` -- expected: all NIST FIPS 180-4 vectors pass.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions.
- macOS app build/launch (usual pnpm macos path) -- expected: app launches; Settings surface shows the set-password form when no password is set.

**Manual checks:**
- Set a password; open `~/Library/Application Support/Frosthalt/config.json` — `passwordHash` is a 64-char hex string, no plaintext present.
- Quit and relaunch; Settings shows "Password set" (persisted hash read back).
- Enter mismatched / too-short entries — submit disabled, inline error shown, nothing written.
- Trigger an Apply (add/remove a domain) and immediately set a password — no clobber; both writes land intact (inspect config.json).
## Suggested Review Order

**Domain action (the design intent — start here)**

- Non-block-affecting direct config commit, race-safe via the shared queue; re-reads committed at run time.
  [`store.ts:366`](../../src/domain/store.ts#L366)

**Hashing layer (pure-JS, no native)**

- FIPS 180-4 SHA-256 entry point; UTF-8 encodes input, returns 64-char hex.
  [`sha256.ts:33`](../../src/config/sha256.ts#L33)
- In-file UTF-8 fallback's astral-plane (surrogate-pair) branch — the path Hermes would break.
  [`sha256.ts:80`](../../src/config/sha256.ts#L80)
- Single-purpose hashPassword + the one min-length constant reused by 3-3.
  [`password.ts:36`](../../src/config/password.ts#L36)

**Set-password UX**

- Positive submit gate: entry ≥ min AND confirm filled AND equal — blocks set-without-confirm.
  [`SetPassword.tsx:103`](../../src/components/SetPassword.tsx#L103)
- Submit handler: trims, calls setPassword, clears on ok, .catch so "Saving…" can't stick.
  [`SetPassword.tsx:110`](../../src/components/SetPassword.tsx#L110)
- Clears the stale save-error when the user edits a field after a failure.
  [`SetPassword.tsx:151`](../../src/components/SetPassword.tsx#L151)

**Settings surface + wiring**

- Branches on the passwordHash sentinel (undefined = unset) — form vs neutral "Password set".
  [`Settings.tsx:28`](../../src/components/Settings.tsx#L28)
- Shell routes surface 3 to the real Settings screen.
  [`Shell.tsx:197`](../../src/components/Shell.tsx#L197)
- Placeholder copy dropped (registry intact); surface 3 never renders the placeholder.
  [`surfaces.tsx:42`](../../src/components/surfaces.tsx#L42)

**Tests (peripherals)**

- Astral-plane emoji vector locks the fallback surrogate-pair branch.
  [`sha256.test.ts:78`](../../__tests__/sha256.test.ts#L78)
- Keyboard-submit (onSubmitEditing) path verified, mirroring AddDomain's convention.
  [`SetPassword.test.tsx:441`](../../__tests__/SetPassword.test.tsx#L441)
- Back-to-back setPassword serializes; second write carries the latest hash.
  [`store.test.ts:1381`](../../__tests__/store.test.ts#L1381)
- Staged (un-Applied) domain changes are NOT silently persisted by the password write.
  [`store.test.ts:1408`](../../__tests__/store.test.ts#L1408)
