---
title: 'Auto-unblock on expiry — unless also always-on (Story 4.5)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: 'e12b6a40582746de91043366d8bc37bcff848a5a'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A focus session that reaches its `endEpochMs` while the app is open never ends — `/etc/hosts` keeps blocking the timer's domains, the badge stays `Blocked` at `00:00` forever, and the only way out is Panic. Nothing clears `activeTimer`.

**Approach:** A new serialized store action `expireTimer()` that mirrors `stageStartTimer`'s body: at the moment the job acquires the queue it re-reads `committed`, builds `{...committed, activeTimer: null}`, writes config first, then `/etc/hosts` via `effectiveHostsLines(nextConfig)` — so the effective blocklist is computed AT QUEUE TIME (always-on only, because the active-timer set lifts), never from a stale tick-time snapshot. The always-on loop alone keeps an also-always-on domain blocked (union precedence by construction — no removal code path). The trigger is a module-level `useTimerStore.subscribe` in store.ts that fires when the slice's driver self-parks (expired flag false→true). A minimal Shell-level toast (runtime-only store state) announces "Session ended. Domains unblocked." on success or "Couldn't update /etc/hosts. No changes made." on admin denial. Stories 4.6 and 4.7 reuse this exact path.

## Boundaries & Constraints

**Always:**
- Expiry runs through the shared `enqueue` chain (`store.ts:755-769`) — no parallel hosts-write path, no direct `apply()`/`runApply` reuse (they never write `activeTimer`).
- The effective blocklist is computed from a RUN-TIME re-read of `committed` inside the queued job — never from a snapshot captured at tick time.
- Mirror `stageStartTimer`'s body shape exactly (`store.ts:549-651`): queue-time guard → `writeConfig(nextConfig)` first → `applyStatus: 'running'` → hosts write in try/catch → on success advance `committed` + set `lastResult`; on config-write failure return BEFORE flipping `applyStatus`; on hosts deny/throw leave `committed.activeTimer` INTACT and reset `applyStatus: 'idle'`.
- The action is idempotent: guard `committed.activeTimer != null && Number.isFinite(endEpochMs) && Date.now() >= endEpochMs`; out-of-guard returns `{ok:false, error:'not-expired'}` without touching any port.
- The trigger is a module-level `useTimerStore.subscribe((state, prev))` in store.ts firing on the expired-flag transition (not on every tick); duplicate fires are absorbed by the queue-time guard.
- Toast state is runtime-only (never in `Config`/`types.ts` — same precedent as 3-2's gate state); Shell renders it with an 8 s auto-dismiss and a VoiceOver announce of its text.
- Badge and countdown revert with ZERO changes to `StatusHeader.tsx` or the Timer surface — both already derive everything from `committed.activeTimer` and the slice.

**Ask First:**
- Any retry/heartbeat mechanism for an expiry job queued behind an unanswered admin prompt (known deferred queue-hang; default = it waits, no toast).
- Any change to the timer slice's state shape, driver, or refcount model.
- Any toast styling beyond a minimal Shell-level element reusing existing tokens (Epic 5 owns a real toast primitive).

**Never:**
- No End-early wiring (4.6), no launch re-arm UX (4.7 — but the trigger firing on an expired-at-mount session is IN scope), no menu-bar work, no new dependencies, no changes to `effectiveBlocklist`, no removal of domains from `alwaysOn`, no migration of Panic's component-local toast.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path — expiry while app open | driver tick crosses `endEpochMs`, `activeTimer` set | Queued `expireTimer` clears `activeTimer`, writes config then hosts (= always-on lines only), advances `committed`, `lastResult` set; badge → `Free`, count drops, countdown disappears; toast "Session ended. Domains unblocked." | N/A |
| Also always-on | a selected domain is also in `alwaysOn` | It REMAINS in hosts (always-on loop keeps it) — only timer-only domains disappear | N/A |
| Hosts admin-denied | user denies the osascript prompt | `activeTimer` retained in memory (config.json already cleared — accepted-drift mirror of Start), `applyStatus: 'idle'`, hosts unchanged; toast "Couldn't update /etc/hosts. No changes made." | Retry = relaunch (4.7 re-arm) or a new session |
| Hosts write throws | `writeHosts` throws | Same as deny, envelope `{ok:false, error:'hosts-throw:<detail>'}` | `applyStatus: 'idle'` always restored |
| Config write fails | `writeConfig` fails | Return `{ok:false, error:'config-write:<detail>'}` BEFORE any hosts write or state change | `applyStatus` untouched |
| Expired at mount (launch) | persisted `activeTimer` already past, slice parks on first tick | Trigger fires → session unblocked; 4.7 layers the launch UX on this same path | Idempotent guard absorbs double-fires |
| Superseding session | user starts a NEW session before the queued expiry job runs | Queue-time re-read sees the new future `endEpochMs` → guard fails → no-op | No toast, no write |
| Queue busy / hung | Apply in flight (or admin prompt unanswered) | Expiry job waits behind it in the chain; runs with a fresh re-read when reached | No toast while waiting (Ask First on retries) |
| Double trigger | subscribe fires again after park | Guard no-ops (activeTimer already null) | Idempotent |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts` (~770 lines) — THE EDIT TARGET. `stageStartTimer` `:549-651` = the mirror source for `expireTimer` (guards `:563-568`, config-first `:596-602`, running-flip `:610`, hosts try/catch `:620-649`, committed-advance `:627-631`); `enqueue` `:755-769` + `runChain` `:753`; `applyStatus: 'idle' | 'running'` only `:78` — outcome rides on the envelope + `lastResult`; `committed` initialised at store creation `:288` (no `init()` — 4.7 owns launch).
- `src/domain/effectiveBlocklist.ts` (READ-ONLY) — `effectiveBlocklist` `:37-85` (always-on loop `:42-58` = what keeps an also-always-on domain blocked once `activeTimer` is null); `effectiveHostsLines` `:98-100`.
- `src/domain/timerStore.ts` (READ-ONLY) — driver self-park `:175-188` (parks `nowMs` AT `endEpochMs`, clears driver) = the moment the trigger subscribes to. NO changes to the slice.
- `src/hosts/shellRunner.ts:48-50` — `writeHosts(lines)` takes plain body lines, no markers; empty array = markers-only.
- `src/components/Shell.tsx` — EDIT: renders the toast element after the `PasswordGate` overlay (`:291-293`), before the root `View` closes (~`:294`); 8 s auto-dismiss + `AccessibilityInfo` announce on change.
- `src/components/Panic.tsx:335-365` — toast RENDER REFERENCE (auto-dismiss pattern, `accessibilityLiveRegion="polite"`); NOT migrated.
- `__tests__/store.test.ts` — conventions: native-spec mocks `:21-34`, `setState` reset `:67-98`, hosts payload assertions via `shellNative.writeHosts.mock.calls[0][0]` `:1496-1514`, `invocationCallOrder` ordering `:1476-1478`, stageStartTimer matrix `:1458-1691`.
- `__tests__/Shell.test.tsx` — toast rendering/auto-dismiss tests appended here (existing badge/countdown integration at `:1797` stays green).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/store.ts` — add `expireTimer(): Promise<WriteResult>` mirroring `stageStartTimer`: queue-time guard → `writeConfig({...committed, activeTimer: null})` → `applyStatus: 'running'` → `writeHosts(effectiveHostsLines(nextConfig))` in try/catch → on success advance `committed` + `lastResult` + toast; on deny/throw keep `activeTimer` + reset to idle. JSDoc: 4.6/4.7 call this directly.
- [x] `src/domain/store.ts` — runtime-only toast state `{ message: string; tone: 'info' | 'error' } | null` + `clearToast()` (set internally by `expireTimer`; not persisted).
- [x] `src/domain/store.ts` — module-level `useTimerStore.subscribe` firing `expireTimer()` on the expired-flag false→true transition; fire-and-forget (toast carries the outcome).
- [x] `src/components/Shell.tsx` — render the toast after the overlays (8 s auto-dismiss, `accessibilityLiveRegion="polite"` + VoiceOver announce, tokens-only styling).
- [x] `__tests__/store.test.ts` (APPEND) — the I/O matrix: success (config-then-hosts order, hosts payload = always-on lines only, `activeTimer` cleared), also-always-on stays blocked, deny, throw, config-write fail, not-expired guard, superseding-session no-op, double-fire idempotency, queue-behind-Apply, toast set/cleared per outcome.
- [x] `__tests__/Shell.test.tsx` (APPEND) — toast renders on seeded expiry state + auto-dismisses after 8 s; badge/count revert end-to-end.
- [x] `sprint-status.yaml` — `4-5` → `review` at step-05 (the `done` flip rides the story commit, same as 4-4).

**Acceptance Criteria:**
- Given a live session, when the countdown reaches `00:00` while the app is open (on ANY surface), then the timer-only domains are removed from `/etc/hosts` via the serialized Apply path, config's `activeTimer` is cleared, and the toast "Session ended. Domains unblocked." appears and auto-dismisses.
- Given a selected domain that is also always-on, when the session expires, then that domain remains blocked in `/etc/hosts` (only timer-only domains disappear).
- Given the admin denies the hosts write at expiry, then nothing is unblocked, `committed.activeTimer` is intact, `applyStatus` returns to `idle`, and the failure toast shows.
- Given a superseding session or a not-yet-expired state at queue time, then `expireTimer` is a no-op (no writes, no toast).
- Given expiry, the header badge flips to `Free` and the countdown disappears with no changes to `StatusHeader.tsx`.
- Given VoiceOver, the toast text is announced when it appears.

## Spec Change Log

- (step-02 draft — no entries yet)

## Design Notes

- **Why the trigger lives in store.ts (not a component):** expiry is a privileged write — it belongs in the domain layer. A `useTimerStore.subscribe` at module scope in store.ts creates a ONE-WAY store→timerStore import (timerStore imports nothing from store; no cycle). A UI-side trigger was rejected: the Timer surface unmounts and the driver parks regardless of surfaces — the slice, not the view tree, knows the moment.
- **Why config-first on expiry:** it mirrors `stageStartTimer`'s accepted-drift order and keeps the failure direction safe: a config-write success + hosts deny leaves disk saying "no session" while hosts still blocks — over-blocking, never a leak. Memory keeps `activeTimer` so 4.7's relaunch re-arm can converge.
- **Why a store-level toast:** expiry can fire on any surface; component-local toasts (Panic's) can't. Minimal runtime-only state + a Shell element also starts paying down 3-4's deferred "Shell-level toast infra" gap — but Epic 5 owns the real primitive, so this stays minimal (no queue, no stack, one message).
- **Launch expiry is in scope deliberately:** the trigger firing on an expired-at-mount session is the same path 4.7 explicitly reuses; the idempotent guard makes any double-fire harmless.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/store.test.ts __tests__/Shell.test.tsx __tests__/Timer.test.tsx __tests__/timerStore.test.ts __tests__/StatusHeader.test.tsx` — new + affected suites green.
- `node_modules/.bin/jest --watchman=false` — full suite green (no regressions to the existing 513 tests).

**Manual checks:**
- Start a 1-min session on the Timer surface, navigate to Blocklist, let it expire — badge flips to `Free`, count drops, toast appears and dismisses after 8 s, `/etc/hosts` (via View hosts) no longer lists the timer domains.
- Same run with one domain also always-on — that domain stays in `/etc/hosts` after expiry.
- Deny the admin prompt at expiry — hosts unchanged, badge stays `Blocked` at `00:00`, failure toast shows.

## Suggested Review Order

1. **The expiry action (entry point):** [`src/domain/store.ts:752`](../../src/domain/store.ts#L752) — `expireTimer` mirrors `stageStartTimer`: queue-time guard + committed re-read `[:762-788](../../src/domain/store.ts#L762)`, config-first `[:794-798](../../src/domain/store.ts#L794)`, running-flip `[:808](../../src/domain/store.ts#L808)`, hosts write + success/committed-advance/toast `[:816-827](../../src/domain/store.ts#L816)`, deny branch (activeTimer INTACT + error toast) `[:837-839](../../src/domain/store.ts#L837)`, throw catch `[:846-852](../../src/domain/store.ts#L846)`.
2. **Shared failure copy:** [`src/domain/store.ts:91`](../../src/domain/store.ts#L91) — `HOSTS_FAILURE_TOAST` const used by both failure branches.
3. **The trigger:** [`src/domain/store.ts:979`](../../src/domain/store.ts#L979) — `sliceExpiredParked` predicate, then the module-level `useTimerStore.subscribe` `[:1000](../../src/domain/store.ts#L1000)` firing `expireTimer()` fire-and-forget on the expired false→true park.
4. **Toast plumbing:** [`src/domain/store.ts:862`](../../src/domain/store.ts#L862) — `clearToast()`; runtime-only toast state + type at `[:260-341](../../src/domain/store.ts#L260)`.
5. **The toast UI:** [`src/components/Shell.tsx:113`](../../src/components/Shell.tsx#L113) — store subscription, announce + 8 s auto-dismiss effect `[:116-134](../../src/components/Shell.tsx#L116)`, render after the gate overlay `[:328-352](../../src/components/Shell.tsx#L328)`, `styles.toast` `[:374](../../src/components/Shell.tsx#L374)`.
6. **Store test matrix:** [`__tests__/store.test.ts:2164`](../../__tests__/store.test.ts#L2164) — success (config-then-hosts order, always-on-only payload) `[:2164](../../__tests__/store.test.ts#L2164)`, also-always-on `[:2202](../../__tests__/store.test.ts#L2202)`, deny `[:2225](../../__tests__/store.test.ts#L2225)`, throw `[:2253](../../__tests__/store.test.ts#L2253)`, config-write fail `[:2284](../../__tests__/store.test.ts#L2284)`, not-expired + NaN guards `[:2303-2327](../../__tests__/store.test.ts#L2303)`, empty always-on `[:2355](../../__tests__/store.test.ts#L2355)`, hung queue `[:2387](../../__tests__/store.test.ts#L2387)`, superseding `[:2439](../../__tests__/store.test.ts#L2439)`, double-fire `[:2486](../../__tests__/store.test.ts#L2486)`, queue-behind-Apply `[:2504](../../__tests__/store.test.ts#L2504)`, toast lifecycle `[:2569](../../__tests__/store.test.ts#L2569)`.
7. **Trigger tests:** [`__tests__/store.test.ts:2594`](../../__tests__/store.test.ts#L2594) — seeded expired session; expired-at-mount `[:2640](../../__tests__/store.test.ts#L2640)`.
8. **Peripherals (last):** e2e success + deny on the Shell surface [`__tests__/Shell.test.tsx:1874`](../../__tests__/Shell.test.tsx#L1874) and `[:1971](../../__tests__/Shell.test.tsx#L1971)`; real-mount-path expired-at-mount trigger test [`__tests__/StatusHeader.test.tsx:321`](../../__tests__/StatusHeader.test.tsx#L321) + widened source-subscriber allowlist `[:751](../../__tests__/StatusHeader.test.tsx#L751)`; 4-5 defers logged in [`deferred-work.md`](../../_bmad-output/implementation-artifacts/deferred-work.md).