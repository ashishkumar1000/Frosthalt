---
title: 'End-early — password-gated (Story 4.6)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: '7b540cd'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A running focus session can only end at expiry. The Timer surface's destructive "End early" button is wired to the gate but its action body is an announce-only placeholder (4.3) — the only early escape today is Panic, which nukes the whole blocklist. There is no way to end just the session early.

**Approach:** A new serialized store action `endEarly()` mirroring `expireTimer`'s body: queue-time guard (`activeTimer == null` → no-op), re-read of `committed` inside `enqueue`, config-first `writeConfig({...committed, activeTimer: null})`, then `writeHosts(effectiveHostsLines(nextConfig))` (always-on only at queue time). The Timer surface's existing End-early button replaces its placeholder body with `requirePassword(() => endEarly())` — the Epic 3 gate, no new gate code. Success toast "Session ended. N domains unblocked." where N counts only the selected domains that actually lift (selected minus always-on); "Session ended." when N = 0. Also pays down the 4-5 defer: every hosts-throw catch in the store now sets `lastResult`.

## Boundaries & Constraints

**Always:**
- `endEarly()` runs through the shared `enqueue` chain and mirrors `expireTimer`'s body shape exactly (`store.ts:752-870`): queue-time guard → config-first write → `applyStatus: 'running'` → hosts write in try/catch → on success advance `committed` + set `lastResult`; on hosts deny/throw leave `committed.activeTimer` INTACT and reset `applyStatus: 'idle'`; on config-write failure return BEFORE elevation.
- The action is idempotent: guard `committed.activeTimer == null` → `{ok:false, error:'no-active-session'}` without touching any port. A queue-time re-read is authoritative — an expiry queued ahead that already cleared the session makes end-early a no-op.
- Gate-first via `requirePassword` (the 3-2 sheet; lazy `getState()` access, not a subscribed selector). With no password set the gate short-circuits and the body runs immediately — the Panic pattern.
- N in the toast = `selectedDomains` whose normalised apex is NOT always-on; always-on domains stay blocked and are not counted. Singular/plural: "Session ended. 1 domain unblocked." / "Session ended. N domains unblocked."; N = 0 → "Session ended."
- Deny/throw toast = the shared `HOSTS_FAILURE_TOAST` ("Couldn't update /etc/hosts. No changes made.").
- Fix the 4-5 defer while touching these invariants: all THREE hosts-throw catch branches (`endEarly`, `expireTimer`, `stageStartTimer`) now set `lastResult` to the throw envelope, matching what their deny branches already do.
- The countdown/badge revert with ZERO changes to `StatusHeader.tsx`, `CountdownRing.tsx`, or the timer slice — all consumers derive from `committed.activeTimer`.

**Ask First:**
- Any retry/heartbeat for an end-early job queued behind an unanswered admin prompt (known deferred queue-hang; default = it waits).
- Any confirm dialog between gate-verify and the end action (v1 = the password IS the friction; UX-DR16's "if any" gives latitude).
- Any change to the timer slice's state shape, driver, or refcount model.

**Never:**
- No launch re-arm UX (4.7), no menu-bar work, no new dependencies, no changes to `effectiveBlocklist` or the `alwaysOn` data, no Panic toast migration, no removal of the announce in `END_EARLY_PLACEHOLDER_TOAST`'s spirit beyond replacing its use. End-early is NEVER bound to Return (Tab/Space reachable, never the window default).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path — end early | live unexpired session, password verified | Queued `endEarly` clears `activeTimer`, writes config then hosts (always-on lines only), advances `committed`, sets `lastResult`; toast "Session ended. N domains unblocked."; badge → Free, countdown gone | N/A |
| All selected also always-on | every `selectedDomain` is always-on | Hosts payload is still the always-on lines (unchanged content), `activeTimer` cleared, toast "Session ended." | N/A |
| Hosts admin-denied | user denies the osascript prompt | `activeTimer` retained in memory (config.json already cleared — accepted-drift mirror), `applyStatus: 'idle'`, hosts unchanged; error toast | Retry = a new session, or relaunch (4.7 re-arm) |
| Hosts write throws | `writeHosts` throws | Same as deny; envelope `{ok:false, error:'hosts-throw:<detail>'}`; **`lastResult` now carries the envelope** | `applyStatus: 'idle'` always restored |
| Config write fails | `writeConfig` fails | Return `{ok:false, error:'config-write:<detail>'}` BEFORE any hosts write or state change | `applyStatus` untouched |
| No active session | `activeTimer` null at queue time (double press, or an expiry ran ahead) | No-op `{ok:false, error:'no-active-session'}`, zero ports, no toast | Idempotent |
| No password set | `passwordHash` null | Gate short-circuits; the end action runs immediately | Same as happy path |
| Gate wrong / cancelled | 5 bad tries or Esc | Action body never runs; session intact; gate attempts/throttle preserved | Existing gate behaviour |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts` (~1070 lines) — THE EDIT TARGET. `expireTimer` `:752-870` = the mirror source (guard `:762-788`, config-first `:794-798`, running-flip `:808`, hosts write + success `:816-827`, deny `:837-839`, catch `:846-852`); `HOSTS_FAILURE_TOAST` const `:91`; `clearToast` `:862`; `stageStartTimer`'s throw catch (4.2) carries the same lastResult gap — all three get the one-line fix. `enqueue` chain + `applyStatus: 'idle' | 'running'` unchanged.
- `src/components/Timer.tsx` — EDIT (surgical): `handleEndEarly` `:487-491` placeholder body → `requirePassword(() => { void endEarly()... })`; `END_EARLY_PLACEHOLDER_TOAST` `:125-130` becomes deletable; the Pressable `:523-535`, `END_EARLY_LABEL` `:109` and `endEarlyHint` `:116-119` stay as-is. Blocked-path comment block `:30-34` + `:480-486` needs its "4.6 owns the write" stale wording updated.
- `src/components/Shell.tsx` — READ-ONLY. Toast render path exists from 4-5 (`:113-134` effect, `:328-352` JSX): the store sets `toast`, Shell announces + auto-dismisses. Nothing to add.
- `src/domain/effectiveBlocklist.ts` — READ-ONLY. `effectiveBlocklist` `:37-85` (always-on loop `:42-58` keeps an also-always-on domain blocked once `activeTimer` is null); `effectiveHostsLines` for the payload; `normaliseDomain` is the comparison helper for the N count.
- `src/config/types.ts` — READ-ONLY. `Domain { hostname, alwaysOn }` `:19`; `Config.domains` `:63`.
- Epic 3 gate (no new code): `useDomainStore.requirePassword(action)` + `gateOpen`/`gateAction` runtime-only state; the Shell's single `<PasswordGate>` hosts it. Precedent: Panic.tsx, ChangePassword.tsx.
- `__tests__/store.test.ts` — conventions: native-spec mocks `:21-34`, `setState` reset `:67-98`, 4.5 matrix at `:2164-2569` (esp. `seedExpiredSession` `:2140` → seed a LIVE session analogously), `invocationCallOrder` for config-then-hosts ordering `:2172`.
- `__tests__/Timer.test.tsx` — Blocked-state render + gate-wired button tests from 4.3; extend for the real action.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/store.ts` — add `endEarly(): Promise<WriteResult>` mirroring `expireTimer` with the looser guard (activeTimer present, NOT requiring expiry); JSDoc notes 4.7 does NOT call this (re-arm uses expireTimer).
- [x] `src/domain/store.ts` — set `lastResult` in all three hosts-throw catches (`endEarly`, `expireTimer`, `stageStartTimer`) to close the 4-5 defer.
- [x] `src/components/Timer.tsx` — `handleEndEarly` calls `requirePassword(() => { void endEarly().catch(() => {}) })`; delete `END_EARLY_PLACEHOLDER_TOAST`; refresh the two stale 4.3-wiring comment blocks.
- [x] `__tests__/store.test.ts` — the I/O matrix: success (config-then-hosts order, always-on-only payload, N count incl. also-always-on exclusion and singular/plural/zero toast), deny, throw (incl. `lastResult` now set), config-write fail, no-active-session guard, double-fire, queue-behind-Apply re-read.
- [x] `__tests__/Timer.test.tsx` — End-early through the real gate: with password → gate opens, verify → action fires; without password → body runs immediately; deny-at-gate → session untouched.
- [x] `sprint-status.yaml` — `4-6` → `review` at step-05.

**Acceptance Criteria:**
- Given a live session, when the user presses End early and verifies the password, then the timer-only domains are removed from `/etc/hosts` via the serialized Apply path, config's `activeTimer` is cleared, and the toast "Session ended. N domains unblocked." appears (N excludes always-on domains).
- Given a selected domain that is also always-on, when the session ends early, then that domain remains blocked and is not counted in N.
- Given no password is set, when the user presses End early, then the session ends immediately with no gate sheet.
- Given the admin denies the hosts write at end-early, then nothing is unblocked, `committed.activeTimer` is intact in memory, `applyStatus` returns to `idle`, and the failure toast shows.
- Given end-early or expiry or Start hits an unexpected hosts throw, then `lastResult` carries the failure envelope (4-5 defer closed).
- Given the End-early button, it is reachable via Tab and never fires on bare Return.

## Spec Change Log

- (step-02 draft — no entries yet)

## Design Notes

- **Why a separate `endEarly()` instead of a flag on `expireTimer`:** the guards differ in kind — expiry requires `now >= end`, end-early must fire on a LIVE session. A `mode` parameter would fork one guard into two meanings inside one action; two sibling actions sharing the mirror idiom (the repo's established shape since 4.2) keep each guard readable. 4.7's launch path calls `expireTimer`; nothing calls `endEarly` outside the Timer surface.
- **Why no second confirm after the gate:** Panic is catastrophic-irreversible (whole blocklist gone) so it confirms; end-early is recoverable (start again) and the epic already prices the friction into the password. UX-DR16's "confirm dialog if any" reads as latitude.
- **Accepted-drift direction, same as Start/expiry:** config write succeeds + hosts deny → disk says "no session" while hosts still blocks. Over-blocking, never a leak; memory keeps `activeTimer` so the state stays describable.
- **The N count** must use `normaliseDomain`-level comparison (a selected "www.twitter.com" vs always-on "twitter.com" counts as still-blocked), matching how `effectiveBlocklist` dedupes.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/store.test.ts __tests__/Timer.test.tsx __tests__/Shell.test.tsx __tests__/timerStore.test.ts __tests__/StatusHeader.test.tsx` — new + affected suites green.
- `node_modules/.bin/jest --watchman=false` — full suite green (no regressions from the lastResult fix touching 4.2/4.5 paths).

**Manual checks:**
- Start a 25-min session, press End early on the Timer surface → gate sheet → password → badge flips Free, count drops, toast "Session ended. N domains unblocked.", `/etc/hosts` (via View hosts) shows always-on only.
- Same run with one selected domain also always-on — that domain stays in `/etc/hosts`, N excludes it.
- Deny the admin prompt — hosts unchanged, badge stays Blocked, failure toast shows, countdown still running.
## Suggested Review Order

1. **The end-early action (entry point):** [`src/domain/store.ts:943`](../../src/domain/store.ts#L943) — the 4.6 section; `endEarly` at `[:945](../../src/domain/store.ts#L945)` mirrors `expireTimer` with the looser queue-time guard (presence-only, no expiry check), config-first write, `applyStatus: 'running'`, hosts write in try/catch, deny/throw keep `activeTimer` intact + reset to idle, success advances `committed` + `lastResult` + toast.
2. **The N-count helper (incl. the review patch):** [`src/domain/store.ts:1234`](../../src/domain/store.ts#L1234) — `endEarlySuccessToast` counts per DISTINCT normalised apex (a `Set`, `[:1248](../../src/domain/store.ts#L1248)`), so `b.com` + `www.b.com` report one lifted domain; always-on apexes excluded first.
3. **The gate wiring (incl. the double-press guard):** [`src/components/Timer.tsx:488`](../../src/components/Timer.tsx#L488) — `handleEndEarly` returns early while `applyStatus === 'running'` (queue backpressure behind an unanswered admin prompt), then `requirePassword` with lazy `getState()`.
4. **The 4-5 defer closure:** `src/domain/store.ts` throw catches in `stageStartTimer` (~:781), `expireTimer` (~:885), `endEarly` (~:996) — all three now set `lastResult` to the throw envelope.
5. **Store matrix:** [`__tests__/store.test.ts:2686`](../../__tests__/store.test.ts#L2686) — success w/ config-then-hosts order `[:2727](../../__tests__/store.test.ts#L2727)`, N-count plural `[:2772](../../__tests__/store.test.ts#L2772)`, all-always-on zero branch `[:2790](../../__tests__/store.test.ts#L2790)`, www-vs-apex `[:2815](../../__tests__/store.test.ts#L2815)`, deny `[:2846](../../__tests__/store.test.ts#L2846)`, throw+lastResult `[:2874](../../__tests__/store.test.ts#L2874)`, config-write fail `[:2906](../../__tests__/store.test.ts#L2906)`, no-active-session `[:2925](../../__tests__/store.test.ts#L2925)`, double-fire `[:2937](../../__tests__/store.test.ts#L2937)`, queue-behind-Apply `[:2955](../../__tests__/store.test.ts#L2955)`, queue-behind-Expiry `[:3017](../../__tests__/store.test.ts#L3017)`, apex-dedupe `[:3059](../../__tests__/store.test.ts#L3059)`, empty-selected `[:3080](../../__tests__/store.test.ts#L3080)`, expired-but-uncleared `[:3098](../../__tests__/store.test.ts#L3098)`, NaN end `[:3117](../../__tests__/store.test.ts#L3117)`, lastResult re-pins `[:3140](../../__tests__/store.test.ts#L3140)` + `[:3174](../../__tests__/store.test.ts#L3174)`.
6. **Gate wiring tests:** [`__tests__/Timer.test.tsx:955`](../../__tests__/Timer.test.tsx#L955) — no-password runs immediately, with-password opens gate `[:981](../../__tests__/Timer.test.tsx#L981)`, deny-at-gate session untouched `[:1024](../../__tests__/Timer.test.tsx#L1024)`, running-guard `[:1068](../../__tests__/Timer.test.tsx#L1068)`; the anti-spy-leak module pattern `[:207-226](../../__tests__/Timer.test.tsx#L207)`.
7. **Real-flow e2e (last):** [`__tests__/Shell.test.tsx:2047`](../../__tests__/Shell.test.tsx#L2047) — press → config write → hosts write → toast rendered + announced + 8 s auto-dismiss → Free badge + numeral gone.
8. **Defers:** the 4-6 entry in [`deferred-work.md`](../../_bmad-output/implementation-artifacts/deferred-work.md) (apply/restoreSection throw hardening).
