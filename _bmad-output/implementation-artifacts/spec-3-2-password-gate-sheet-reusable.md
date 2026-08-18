---
title: 'Password gate sheet (reusable)'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c1d247f229b977c3505b1d0fc4a151679c314543'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Escape actions (change-password, Panic, end-early) can fire on a stray click. 3-1 let the user *set* a password; this story builds the gate that *checks* it — once, reusable by every gated action (3-3, 3-4, Epic 4's 4-6 call it; do not fork per caller).

**Approach:** A Shell-hosted `PasswordGate` sheet (scrim+panel mirroring `HostsViewer`) with one `secureTextEntry` field + Show/Hide (mirroring `SetPassword`). A store `requirePassword(action)` API opens the sheet when a password is set — or runs `action` immediately when none is set — and `verifyPassword(pw)` re-hashes the entry and compares to `committed.passwordHash`. Wrong entries clear the field and show "That didn't match. N tries left."; after 5 wrong a throttle shows a visible countdown. Esc cancels and aborts the action without firing it.

## Boundaries & Constraints

**Always:**
- Reuse `hashPassword`/`sha256` from 3-1 — never re-implement hashing. Verify is pure JS: read `committed.passwordHash`, compare `hashPassword(entry)`. No `writeConfig`, no `writeHosts`, no new native module, no `apply.ts` change.
- Build the gate ONCE: a reusable component + a single store API (`requirePassword(action)`). Callers pass an action; the store shows the sheet when a password is set, or short-circuits (runs `action` immediately) when none is. Do not stub or fork the gate per caller.
- Throttle state (`gateAttempts`, `gateThrottleUntil`) is runtime store state — NOT persisted to `config.json`, NOT added to `Config`/`types.ts`. It survives close/reopen within a session (Esc does not reset the counter) but resets on relaunch.
- When no password is set (`committed.passwordHash` unset), `requirePassword(action)` runs `action()` immediately — the gate is a no-op, never an empty sheet.
- Password field: `secureTextEntry`, `autoCapitalize="none"`, `autoCorrect={false}`, `spellCheck={false}`, `autoComplete="off"`, paste allowed, Show/Hide toggle with VoiceOver labels, `maxLength`. The gate sheet is never the window default; Esc cancels.
- Wrong-entry message is neutral: "That didn't match. N tries left." — no leakage of which part failed. On throttle, a visible countdown; field + submit disabled until it elapses, then attempts reset to 0.
- `verifyPassword` returns `{ ok: boolean, triesLeft?: number, throttleMs?: number }`.

**Ask First:**
- The throttle wait duration (proposed `GATE_THROTTLE_MS = 30_000` / 30s, tunable) — a product-feel decision.
- Storing the pending action as a function (`gateAction`) in Zustand state vs. a Shell-local ref.

**Never:**
- Wire a real destructive caller (change-password, Panic, end-early) — that's 3-3/3-4/4-6.
- Persist `gateAttempts`/`gateThrottleUntil` to `config.json`, or add them to `Config`/`types.ts`.
- Reset the attempt counter on Esc/close (only on success or throttle expiry).
- Build the Danger Zone section, change-password, or Panic.
- Leak plaintext beyond the field lifecycle, or log the password.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Correct entry | password set; entry = password | `onVerified` fires; sheet closes; `gateAttempts`→0, `gateThrottleUntil`→null; field cleared | N/A |
| Wrong entry (tries 1–4) | password set; entry ≠ password | Field cleared; "That didn't match. N tries left." (N = 5−attempts); `gateAttempts++` | N/A |
| 5th wrong entry | `gateAttempts` = 4; entry ≠ password | Throttle engages: `gateThrottleUntil` = now+30s; field+submit disabled; visible countdown | N/A |
| Throttle expiry | now ≥ `gateThrottleUntil` | Field re-enabled; `gateAttempts`→0; 5 fresh tries | N/A |
| Esc / cancel | sheet open, any state | Sheet closes; `onVerified` NOT called; attempts + throttle preserved | N/A |
| No password set | `committed.passwordHash` unset; `requirePassword(action)` | `action()` runs immediately; no sheet rendered | N/A |

</frozen-after-approval>

## Code Map

- `src/components/PasswordGate.tsx` (NEW) — reusable gate sheet. Mirror `HostsViewer.tsx:94-112,157-178` (scrim+panel+`onClose`) and `SetPassword.tsx:175-208,245-262` (one `secureTextEntry` field + Show/Hide + inline-error). Props `onVerified`/`onClose`; reads `verifyPassword`+throttle state; `setInterval` countdown calls `clearGateThrottle()` at 0.
- `src/domain/store.ts:72-154,156,366-409,419-435` — add runtime state `gateOpen`, `gateAction: (()=>void)|null`, `gateAttempts`, `gateThrottleUntil`; actions `requirePassword(action)` (short-circuit when no `passwordHash`, else open sheet), `verifyPassword(pw)` (throttle-gated `hashPassword` compare vs `committed.passwordHash`; increment/reset attempts; throttle at `GATE_MAX_ATTEMPTS`), `closeGate()` (clear open+action, preserve attempts), `clearGateThrottle()` (null throttle, reset attempts). READ-ONLY: `setPassword`/`enqueue`/`apply` unchanged.
- `src/components/Shell.tsx:44-53,81,126-167,170-183,203-205` — render `<PasswordGate onVerified={runGateAction} onClose={closeGate}/>` when `gateOpen`; add Esc branch (mirrors `:134-137`) → `closeGate`; add `&& !gateOpen` to the Return→Apply guard at `:159`.
- `src/config/password.ts:26,36` — READ-ONLY reuse `hashPassword`/`PASSWORD_MIN_LENGTH`; add `GATE_MAX_ATTEMPTS = 5` and `GATE_THROTTLE_MS = 30_000` (co-located, importable by tests).
- READ-ONLY constraints: `src/components/Settings.tsx:26-43` (no caller in 3-2 — 3-3 adds Danger Zone); `src/theme/tokens.ts:50,86,92-95,97-130` (`destructive`, `primary`/`primaryForeground`, type/spacing/rounded); `src/config/types.ts:62` (`passwordHash?: string` persisted — do NOT add gate state to `Config`).
- `__tests__/PasswordGate.test.tsx` (NEW) — `react-test-renderer` (mirror `SetPassword.test.tsx:46,99-226`): render + a11y; Show/Hide; wrong→tries-left+clear; 5th wrong→throttle; correct→`onVerified`+clear; Esc→`onClose`.
- `__tests__/store.test.ts:57-84,1276-1433` — add `verifyPassword`/`requirePassword`/`closeGate`/`clearGateThrottle` tests: attempts increment + triesLeft; throttle at 5; reset on success; no-password short-circuit; attempts persist across `closeGate`+reopen; throttle expiry resets.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/password.ts` -- add `GATE_MAX_ATTEMPTS = 5` and `GATE_THROTTLE_MS = 30_000` -- the two gate-policy knobs, importable by store + tests.
- [x] `src/domain/store.ts` -- add runtime state `gateOpen`/`gateAction`/`gateAttempts`/`gateThrottleUntil` and actions `requirePassword(action)` (short-circuit when no `passwordHash`, else open sheet), `verifyPassword(pw)` (throttle-gated `hashPassword` compare; increment/reset attempts; throttle at `GATE_MAX_ATTEMPTS`), `closeGate()` (clear open+action, preserve attempts), `clearGateThrottle()` (null throttle, reset attempts) -- the reusable gate mechanism; no `writeConfig`/`writeHosts`, no `apply.ts` change.
- [x] `src/components/PasswordGate.tsx` -- scrim+panel (mirror `HostsViewer`), one `secureTextEntry` field + Show/Hide + paste (mirror `SetPassword`), neutral tries-left message, throttle countdown via `setInterval` calling `clearGateThrottle()` at 0, `onVerified`/`onClose` props, submit disabled until clean and during throttle -- the reusable gate sheet UI.
- [x] `src/components/Shell.tsx` -- render `<PasswordGate/>` when `gateOpen`, add Esc→`closeGate` branch, add `&& !gateOpen` to the Return→Apply guard -- wire the single hosted instance + keep keyboard routing sane while the gate is open.
- [x] `__tests__/store.test.ts` -- cover `verifyPassword` (correct/wrong/throttle/reset), `requirePassword` (no-password short-circuit vs sheet-open), attempt persistence across `closeGate`+reopen, `clearGateThrottle` -- prove the mechanism before 3-3 wires a caller.
- [x] `__tests__/PasswordGate.test.tsx` -- cover render + a11y, Show/Hide, wrong→tries-left+clear, 5th wrong→throttle, correct→`onVerified`+clear, Esc→`onClose` -- prove the sheet UI behaves per the matrix.

**Acceptance Criteria:**
- Given a password is set, when a caller invokes `requirePassword(action)`, then the gate sheet opens; given no password is set, when a caller invokes `requirePassword(action)`, then `action` runs immediately and no sheet renders.
- Given a correct entry, when the user submits, then `onVerified` fires, the sheet closes, and `gateAttempts`/`gateThrottleUntil` reset.
- Given a wrong entry (tries 1–4), when the user submits, then the field clears and "That didn't match. N tries left." shows with no plaintext leakage.
- Given 5 wrong entries, when the 5th is submitted, then a throttle countdown shows and the field is disabled until it elapses.
- Given the gate is open, when the user presses Esc, then the sheet closes, the action does NOT fire, and the attempt counter is preserved.
- Given the gate is open, when the user presses Return, then Apply does NOT fire (the gate blocks the Return→Apply shortcut).
- Given wrong attempts were made, when the sheet is closed and reopened, then the attempt counter is unchanged (Esc/close does not reset it).

## Design Notes

- **Shell-hosted single instance:** the app centralises key handling in `Shell.tsx` and already owns the one overlay (`viewerOpen`/`HostsViewer`). A single `gateOpen` instance reuses that Esc branch and keeps the Return→Apply guard sane; per-caller instances would each need Esc wiring and would each have to teach the guard about them. The pending action is stored as `gateAction` in Zustand (flagged Ask First) — simplest "callable from anywhere" API.
- **Throttle persistence:** `gateAttempts`/`gateThrottleUntil` live in the store (not component-local) so Esc/close can't reset them — otherwise the 5-try limit is bypassed by reopening. Runtime-only (not in `Config`); relaunch resets them. On throttle expiry the countdown tick calls `clearGateThrottle()` for 5 fresh tries.
- **No caller in this story:** 3-2 delivers the mechanism only; 3-3 (change-password) is the first real caller, so the manual macOS exercise of the full gate lands in 3-3. 3-2's manual check is "builds + launches, no regression, gate dormant"; unit + Shell-integration tests cover the mechanism now.
- **`Date.now()`** is fine in app code (the workflow's ban is for workflow scripts only).

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors (pnpm wrapper is sandbox-broken; use `node_modules/.bin/tsc`).
- `node_modules/.bin/jest --watchman=false __tests__/PasswordGate.test.tsx __tests__/store.test.ts` -- expected: gate + store tests green.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions.

**Manual checks:**
- App builds + launches (usual pnpm macos path); Settings still shows the 3-1 set-password / "Password set" state; no regression. The gate has no caller yet — its full manual exercise is deferred to 3-3.
## Suggested Review Order

Review the diff since `baseline_commit` in the stops below (relative paths from this spec's directory). The leading stop is the design intent; the rest are its consequences. Each link is one line — Cmd+click (macOS) / Ctrl+click to open.

### Gate mechanism (the design intent — start here)

- [store.ts:486 — `requirePassword(action)` opens the gate, stashes the action](../../src/domain/store.ts#L486) — the entry point callers use.
- [store.ts:500 — `verifyPassword(pw)` re-hash + compare, throttle-gated](../../src/domain/store.ts#L500) — the pure-JS check; 5-try limit + throttle here.
- [store.ts:553 — `closeGate` preserves attempts (Esc/close never resets)](../../src/domain/store.ts#L553) — the anti-bypass invariant.
- [store.ts:562 — `clearGateThrottle` guarded reset (no-op when not throttled)](../../src/domain/store.ts#L562) — the E4 fix; stops a stray call wiping attempts.
- [password.ts:37 — `GATE_MAX_ATTEMPTS` + `GATE_THROTTLE_MS` constants](../../src/config/password.ts#L37) — the tunable knobs.

### The reusable gate sheet UI

- [PasswordGate.tsx:127 — `handleSubmit` trims + fresh-throttle + verify](../../src/components/PasswordGate.tsx#L127) — E7/B11 + E5/B4: trim-before-hash + fresh-clock throttle.
- [PasswordGate.tsx:89 — countdown interval, calls `clearGateThrottle` at 0](../../src/components/PasswordGate.tsx#L89) — the throttle expiry path.
- [PasswordGate.tsx:121 — mount effect clears an already-expired throttle](../../src/components/PasswordGate.tsx#L121) — the E6 fix for re-open-after-expiry.
- [PasswordGate.tsx:182 — panel a11y (no container `alert` role)](../../src/components/PasswordGate.tsx#L182) — the B6 fix; dynamic messages keep their own alert.

### Shell wiring

- [Shell.tsx:208 — `runGateAction` try/finally + re-open identity guard](../../src/components/Shell.tsx#L208) — E3/B2 + E2/B1: throwing action won't strand the gate; a re-opened gate isn't clobbered.
- [Shell.tsx:143 — Esc branch aborts the action without firing it](../../src/components/Shell.tsx#L143) — the cancel path.
- [Shell.tsx:181 — Return→Apply guard now also gated with `!gateOpen`](../../src/components/Shell.tsx#L181) — stops bare Return firing Apply through the gate.
- [Shell.tsx:259 — renders the single hosted `<PasswordGate>`](../../src/components/Shell.tsx#L259) — the one instance every caller reuses.

### Tests (peripherals)

- [PasswordGate.test.tsx — matrix + trim + countdown](../../__tests__/PasswordGate.test.tsx#L581) — the new UI-layer coverage (trim, throttle countdown).
- [store.test.ts — gate actions + no-writeConfig invariant](../../__tests__/store.test.ts#L1771) — the three new store tests (guarded clearGateThrottle, throttled triesLeft:0, no-persist).
- [Shell.test.tsx — end-to-end verify flow + call-time read](../../__tests__/Shell.test.tsx#L1527) — the two new Shell tests (action runs + closes; stale-closure seam).

### Deferred (see deferred-work.md)

- `requirePassword` double-open (E1/B3) — deferred; a naive guard conflicts with the re-open path enabled by the E2/B1 identity-compare fix; the two must be designed together.
- Scrim click-outside (B14) — deferred as a product decision; a gate arguably should NOT close on outside click.
