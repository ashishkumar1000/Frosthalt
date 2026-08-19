---
title: 'Start focus session (block + persist epoch end-time)'
type: 'feature'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '26007207f8fbb1e6e2b6d6c4f8a3f6c7e2b3a4b5'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-timer-surface-with-duration-presets-and-domain-selection.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 4.1 built the Timer Free-state surface but its Start engine stages per-domain `alwaysOn` flips — wrong engine for a TIMED session. No `activeTimer` write, no epoch end-time. Stories 4.3–4.7 have nothing to read from.

**Approach:** Swap Start's engine. Add a new store action `stageStartTimer({ durationMs, selected })` that computes `endEpochMs = Date.now() + durationMs` INSIDE the shared serialized `enqueue`, then `writeConfig(nextConfig)` (carrying `activeTimer: { endEpochMs, selectedDomains }`) THEN `writeHosts(effectiveHostsLines(nextConfig))` — strict order, one admin prompt. Extend `effectiveBlocklist` to walk `config.activeTimer?.selectedDomains` as a second contribution. On hosts-deny, leave `committed.activeTimer` null (retry-safe). 4.2 is engine + persistence only — no countdown ring, no UI rework.

## Boundaries & Constraints

**Always:**
- One new store action `stageStartTimer({ durationMs, selected }) => Promise<WriteResult>` mirroring `setPassword`'s run-time re-read of `committed` (store.ts:454-460) + `restoreSection`'s hosts-write + applyStatus flip (store.ts:411-415). On `writeConfig` fail → return `{ok:false, error:'config-write:<detail>'}`, NO hosts call, NO `applyStatus` flip, `committed` unchanged. On `writeConfig` ok → flip `applyStatus: 'running'`, call `writeHosts(effectiveHostsLines(nextConfig))`. On hosts ok → advance `committed.activeTimer` + `applyStatus: 'idle'`. On hosts deny → `applyStatus: 'idle'`, `committed.activeTimer` STAYS at pre-Start value (retry-safe — same model as `apply()`'s denial at store.ts:372-377). `endEpochMs` computed at run time inside `enqueue`, not at call time (so the user gets full durationMs even after queue waits). Route through the SAME shared `enqueue` `apply`/`setPassword` use. Re-read `committed` inside the enqueue at run time.
- Extend `src/domain/effectiveBlocklist.ts:28-56` to walk `config.activeTimer?.selectedDomains` as a second contribution AFTER the always-on loop, with same `normaliseDomain` + apex dedupe. Update header comment at `:7-13` to mark Epic 4 active. Keep Epic 5 reservation at `:51-53`.
- Flip `applyStatus: 'running'` for the hosts write — gates the `liveApplyStatus` Start guard at `Timer.tsx:107` and prevents double-tap queuing two prompts.
- `Timer.tsx:245-287 handleStart` — replace per-domain `stageAlwaysOnToggle` loop with single `stageStartTimer({ durationMs: minutes * 60_000, selected })` call. Keep `liveApplyStatus === 'running'` guard. Keep success/deny `announceForAccessibility` pattern.
- Timer success toast copy retune at `Timer.tsx:75-76`: "Started blocking N domains." → "Focus session started. N domains blocked." (N = `selected.size`, not a `stagedCount`). `START_DENIED_TOAST` reused verbatim.
- `ActiveTimer` shape (`types.ts:47-53`) stays `{ endEpochMs, selectedDomains }` — sufficient for 4.3–4.7.
- `stageStartTimer` does NOT touch `staged`. Blocklist pending edits remain staged for the user's next Apply.
- One admin prompt per Start (one osascript — the hosts write is the single privileged op).

**Ask First:**
- Wiring `stageStartTimer` through `requirePassword` (Start stays friction-free per OQ-1; no).
- Auto-committing staged Blocklist edits with Start (no — Start is its own atomic config write).
- Changing `Config.activeTimer` shape.

**Never:**
- Build countdown ring (4.3), status-header countdown (4.4), auto-unblock on expiry (4.5), end-early (4.6), or re-arm on launch (4.7).
- Reuse `runApply` as the queue body — it's shaped for `staged`-snapshot Apply. `stageStartTimer` writes a different `nextConfig` shape. Parallel queue body keeps the strict order (config-then-hosts) auditable in one place.
- Touch `Blocklist`, `HostsViewer`, `Settings`, `PasswordGate`, `StatusHeader`, `Sidebar`, `Shell`, or `Panic` — strict Timer + store change.
- Raw hex tokens; `child_process`/`fs`/`os` in `src/`.

## I/O & Edge-Case Matrix

| Scenario | Input | Outcome | Handling |
|----------|-------|---------|----------|
| Start, fresh, valid | `committed.activeTimer == null`, `selected.size ≥ 1` | `writeConfig({activeTimer:{endEpochMs,selectedDomains}})` then `writeHosts`; on both ok: `committed.activeTimer` advances, toast "Focus session started. N domains blocked.", one admin prompt | N/A |
| Hosts-deny | `writeHosts` → `{ok:false}` | `committed.activeTimer` STAYS null, `applyStatus:'idle'`, deny toast. `config.json` on disk has the `activeTimer` write (accepted drift, apply.ts:13-16) | Retry-safe — user re-clicks Start |
| Config-fail | `writeConfig` → `{ok:false}` | `writeHosts` NOT called, no admin prompt, `applyStatus` NOT flipped, `committed` unchanged, deny toast | N/A |
| Empty selection | `selected.size === 0` | Start disabled at surface; `stageStartTimer` never invoked | N/A |
| Overlap with alwaysOn | some selected are already `alwaysOn:true` | Dedupe by apex in `effectiveBlocklist`; no duplicates | N/A |
| Race vs in-flight Apply | Apply running; user taps Start | Serialized FIFO; `committed` re-read at run time so timer's `activeTimer` carries the Apply's just-committed domains | N/A |
| Race vs in-flight Start (double-tap) | `applyStatus:'running'` | `liveApplyStatus` guard at `Timer.tsx:255-258` short-circuits second tap | N/A |
| Staged Blocklist edit + Start | `staged != null`, user taps Start | `stageStartTimer` doesn't touch `staged`; staged edit remains for next Apply | N/A |
| Back-to-back Start | previous Start running; user taps Start again | Serialized; second's `endEpochMs` ≥ first's; supersedes cleanly | N/A |
| Long-Apply queue wait before Start | queued behind long Apply | `endEpochMs` computed at run time, not call time → user gets full `durationMs` | N/A |
| Stale selection (hostname no longer in `committed.domains`) | `activeTimer.selectedDomains` references removed domain | Timer mount filter at `Timer.tsx:153-173` drops stale ones before Start; `effectiveBlocklist` defensively re-normalises anyway | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/effectiveBlocklist.ts:28-56` — extend `effectiveBlocklist(config)` to walk `config.activeTimer?.selectedDomains` after the always-on loop, reusing `normaliseDomain` + `seen` dedupe. Update header comment `:7-13`. The single change that makes the timer's hosts write cover the timer-selected domains; without this the hosts write is silently a no-op for the timer's union.
- `src/domain/store.ts:84-222` — add `stageStartTimer: ({ durationMs, selected }: { durationMs: number; selected: Set<string> }) => Promise<WriteResult>` to `DomainState` with the same doc-comment style as existing actions.
- `src/domain/store.ts:333-380` region (after `apply`, before `restoreSection`) — new queue body mirroring `setPassword`'s run-time re-read (`:454-460`) + `restoreSection`'s hosts-write + applyStatus flip (`:411-415`). Strict config-then-hosts order. Hosts-deny leaves `committed.activeTimer` null.
- `src/domain/store.ts:584-600` (`enqueue`) — reused unchanged; FIFO chain semantics cover the new action.
- `src/domain/apply.ts:1-86` (`runApply`) — NOT modified. Parallel queue body for `stageStartTimer` keeps the strict order contract auditable.
- `src/domain/effectiveBlocklist.ts:69-71` (`effectiveHostsLines`) — unchanged; the timer's contribution rides through automatically.
- `src/components/Timer.tsx:93-99` — swap `stageAlwaysOnToggle` selector for `stageStartTimer`; drop the `apply` selector. Keep `committed`, `applyStatus`.
- `src/components/Timer.tsx:245-287` — `handleStart` replaces the per-domain loop (`:261-267`) with a single `stageStartTimer({ durationMs, selected })` call. Drop `stagedCount` local. Update success announce to `START_SUCCESS_TOAST(selected.size)`.
- `src/components/Timer.tsx:75-76` — `START_SUCCESS_TOAST` retuned to "Focus session started. ${n} ${n === 1 ? 'domain' : 'domains'} blocked." Copy reflects timed session, not permanent block.
- `src/components/Timer.tsx:78` — `START_DENIED_TOAST` reused verbatim.
- `src/config/types.ts:47-53` (`ActiveTimer`) — READ-ONLY. Shape `{endEpochMs, selectedDomains}` is sufficient for 4.3–4.7.
- `src/config/configStore.ts:100` + `src/hosts/shellRunner.ts:48-50` — `writeConfig` + `writeHosts` reused, no new port calls.
- `__tests__/effectiveBlocklist.test.ts` (or extend existing blocklist test) — new test pinning the union semantic + dedupe + null activeTimer.
- `__tests__/store.test.ts` — append `stageStartTimer` test block mirroring `setPassword` at `:1286-1443`: success (strict config→hosts order), config-fail (no hosts call), hosts-deny (activeTimer stays null), race-vs-Apply (run-time `committed` re-read), back-to-back (2nd's `endEpochMs` strictly greater), no-clobber-of-staged.
- `__tests__/Timer.test.tsx:518-597` — UPDATE existing Start success/failure tests to spy on `stageStartTimer` (not `stageAlwaysOnToggle` + `apply`), assert new toast copy, and assert `committed.activeTimer` stays null on hosts-deny.
- READ-ONLY (NOT modified): `src/components/Blocklist.tsx`, `HostsViewer.tsx`, `Settings.tsx`, `Panic.tsx`, `Shell.tsx`, `StatusHeader.tsx`, `Sidebar.tsx`. 4.3–4.7 will touch StatusHeader (countdown), Shell (running-timer nav hint), etc., as their own stories.
- `src/components/Timer.tsx:277-308` (defensive running-timer placeholder + "Open Blocklist" CTA) — READ-ONLY. 4.1 left it as forward-compat; 4.3 will replace with full running-state UI.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/effectiveBlocklist.ts:28-56` -- extend `effectiveBlocklist(config)` to walk `config.activeTimer?.selectedDomains` after the always-on loop with `normaliseDomain` + `seen` dedupe; update header `:7-13` to mark Epic 4 active; preserve Epic 5 reservation at `:51-53` -- makes the timer's hosts write cover the union.
- [x] `__tests__/effectiveBlocklist.test.ts` -- add test asserting `effectiveBlocklist({domains:[{alwaysOn:true,a.com}],activeTimer:{endEpochMs:...,selectedDomains:['b.com']}})` returns `['a.com','b.com']`; assert dedupe when overlap; assert empty contribution when `activeTimer` null -- pins the new union.
- [x] `src/domain/store.ts:84-222` -- add `stageStartTimer` to `DomainState` with the doc-comment matching the Always clause -- declares the new action on the store.
- [x] `src/domain/store.ts:333-380` region -- implement `stageStartTimer` body: `return enqueue(async () => { const committed = get().committed; const nextConfig = {...committed, activeTimer: {endEpochMs: Date.now() + durationMs, selectedDomains: Array.from(selected)}}; const cfg = writeConfig(nextConfig); if (!cfg.ok) return {ok:false, error:'config-write:' + (cfg.error ?? 'unknown')}; set({applyStatus:'running'}); const lines = effectiveHostsLines(nextConfig); const result = await writeHosts(lines); if (result.ok) set({committed:nextConfig, applyStatus:'idle', lastResult:result}); else set({applyStatus:'idle', lastResult:result}); return result; });` -- mirrors `setPassword`'s run-time re-read + `restoreSection`'s hosts-write + applyStatus flip.
- [x] `src/components/Timer.tsx:93-99` -- swap `stageAlwaysOnToggle` selector for `stageStartTimer`; drop `apply` selector.
- [x] `src/components/Timer.tsx:245-287` -- replace per-domain `stageAlwaysOnToggle` loop with single `stageStartTimer({durationMs: minutes * 60_000, selected})` call; drop `stagedCount` local; update success-announce to `START_SUCCESS_TOAST(selected.size)` -- the engine swap.
- [x] `src/components/Timer.tsx:75-76` -- retune `START_SUCCESS_TOAST` to `"Focus session started. ${n} ${n === 1 ? 'domain' : 'domains'} blocked."` -- timed-session framing.
- [x] `__tests__/Timer.test.tsx:518-597` -- UPDATE Start success/failure tests: spy `stageStartTimer` (not `stageAlwaysOnToggle`+`apply`); assert single call carries `{durationMs: 25*60_000, selected:<Set>}`; success assert new toast copy; failure assert `stageStartTimer` returned `{ok:false}`, deny toast announced, `committed.activeTimer` stays null (retry-safe). Defensive running-timer placeholder test at `:277-308` stays untouched.
- [x] `__tests__/store.test.ts` -- append `stageStartTimer` block mirroring `setPassword` at `:1286-1443`: success (golden config→hosts payload, `committed.activeTimer` advances, returns `{ok:true}`); config-fail (returns `{ok:false, error:'config-write:<detail>'}`, `writeHosts` NOT called, `applyStatus` NOT flipped, `committed` unchanged); hosts-deny (`committed.activeTimer` null, `applyStatus:'idle'`, `lastResult` set); race-vs-Apply (queued behind in-flight Apply, timer's `writeConfig` payload's `domains` carries the Apply's additions, timer's `activeTimer` preserved); back-to-back (2nd's `endEpochMs` strictly greater); `staged` not clobbered (a staged add + a Start leaves `staged` intact after the hosts-write ok).

**Acceptance Criteria:**
- Given valid duration + ≥1 selected, when I press Start, then `stageStartTimer` runs through the shared serialized queue: `writeConfig` (`activeTimer:{endEpochMs, selectedDomains}`) BEFORE `writeHosts`, exactly ONE admin prompt, managed hosts section covers `alwaysOn ∪ selectedDomains` (union, deduped by apex), `committed.activeTimer` advances.
- Given admin denial, when hosts write returns `{ok:false}`, then `committed.activeTimer` STAYS at pre-Start value (null on fresh), `applyStatus` → `idle`, `lastResult` carries the envelope, deny toast announces. Retry click issues the same intent.
- Given `writeConfig` failure, when config-write envelope returns `{ok:false}`, then `writeHosts` NOT called, no admin prompt, `applyStatus` NOT flipped, `committed.activeTimer` unchanged, deny toast announces.
- Given in-flight Apply when Start is pressed, when the queue serializes, then `stageStartTimer` re-reads `committed` at run time so `activeTimer` write preserves the Apply's just-committed domains; no clobber.
- Given `applyStatus:'running'` (double-tap), when the second tap fires, then the `liveApplyStatus` guard at `Timer.tsx:255-258` short-circuits; only one `stageStartTimer` ever runs.
- Given `committed.activeTimer != null` (session running), when I open Timer, then the Free-state Start button is not rendered; the defensive running-timer placeholder renders with "Open Blocklist" CTA. (4.3 owns Blocked UI.)
- Given long queue wait before my Start runs, when the Start finally acquires the queue, then `endEpochMs` is computed at run time → user gets full `durationMs`.
- Given `selectedDomains` overlap with `alwaysOn:true`, when Start writes hosts, then the apex is written ONCE (dedupe); no duplicate `0.0.0.0 apex` / `:: apex`.
- Given back-to-back `stageStartTimer` (session supersession), when the second Start runs, then it overwrites `committed.activeTimer` with the second intent; stale selection is gone.
- Given a staged Blocklist edit when Start is pressed, when Start's hosts write succeeds, then `staged` remains intact for a later Apply.

## Spec Change Log

- **4.2 toast copy retune**: success toast changed from "Started blocking N domains." (4.1 permanent-block copy) to "Focus session started. N domains blocked." (4.2 timed-session framing).
- **4.2 engine swap**: Timer.handleStart replaces per-domain `stageAlwaysOnToggle` loops with a single `stageStartTimer({durationMs, selected})` call. The store action serialises the strict config-then-hosts order.
- **4.2 `committed.activeTimer` invariant**: hosts-deny leaves `committed.activeTimer` at its pre-Start value (null on fresh). On-disk `config.json` may carry the `activeTimer` write (accepted drift — 4.7 re-arm reads it on next launch).
- **4.2 `effectiveBlocklist` Epic 4 contribution**: walks `config.activeTimer?.selectedDomains` AFTER the always-on loop, reusing `normaliseDomain` + apex dedupe. Epic 5 reservation preserved.

## Design Notes

- **`stageStartTimer` does NOT use `runApply`.** `runApply` takes `{committed, staged}` and writes `domains = staged`; the timer needs to write `activeTimer`. Parallel queue body keeps strict config→hosts order auditable in one place. 5-line duplication of `writeConfig`+`writeHosts` is intentional, mirrors `restoreSection` (store.ts:411-436).
- **Hosts-deny leaves `committed.activeTimer` null.** Same model as `apply()`'s denial path. If it advanced `committed.activeTimer`, the UI would show "session running" that the disk state cannot back; 4.7's re-arm would have nothing to resume from. Keeping the advance gated on hosts-write success is the cleanest invariant.
- **`config.json` on disk may carry the `activeTimer` write even on hosts-deny.** Same accepted-drift model as `apply.ts:13-16` (config = intent, hosts = derived enforcement). On next launch, 4.7's re-arm reads it; if the user retries and the second attempt succeeds, the running state syncs in-memory. If the user never retries, 4.7's `now >= endEpochMs` auto-unblock fires as a normal expiry.
- **`endEpochMs` computed INSIDE `enqueue` at run time**, not at call time. Otherwise the user gets `(durationMs - queueWaitMs)` instead of full durationMs. 4.3's countdown reads `endEpochMs - Date.now()`, so this is consistent with the ring.
- **Toast copy change** is a 4.2 product decision: 4.1's copy framed Start as "block N domains" because the engine was permanent (`alwaysOn` flips). 4.2's engine is time-bounded; copy now reflects "session started, N domains blocked for the duration". 4.5 (Expiry) and 4.6 (End-early) own their own "Session ended" copy variants.
- **`staged` buffer untouched.** `stageStartTimer` does NOT read or write `staged`. Pending Blocklist edit remains staged; Apply from Blocklist commits it independently. "Apply staged + Start in one shot" is a separate product decision (Ask First) — 4.2 ships without it.
- **No `useToastStore`.** Toast wording is the `AccessibilityInfo.announceForAccessibility` cue; 4.1's pattern. Epic 5 owns a real toast primitive.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/effectiveBlocklist.test.ts __tests__/store.test.ts __tests__/Timer.test.tsx` -- boundary + union + Start success/failure all green.
- `node_modules/.bin/jest --watchman=false` -- full suite stays green (no regressions to existing 411 tests).
- macOS build/launch (pnpm macos path) -- open Timer with `⌘2`, pick 25 min + ≥1 domain, press Start; ONE admin prompt; on success, `cat /etc/hosts` shows managed section covering the picked domains; cancel the prompt, deny announce fires, picker remains armed for retry.

**Manual checks:**
- Start with valid 25 min + ≥1 domain -- one admin prompt; success → Blocklist shows chosen domains alwaysOn, `config.json`'s `activeTimer` populated; cancel → deny announce, Blocklist unchanged.
- Running session, navigate back to Timer -- defensive "Timer running" placeholder renders (4.3 will replace with full countdown).
- Double-tap Start -- only one admin prompt; second tap no-op.
- Custom "30" minutes -- admin prompt covers chosen domains; persisted `activeTimer.endEpochMs ≈ Date.now() + 30*60_000`.
- Start with staged Blocklist edit -- Start succeeds, staged is STILL staged (visit Blocklist), Apply from Blocklist commits the edit alongside the running session.
- Close + reopen app during running session -- session preserved on disk; running-timer placeholder remains on Timer (4.3 replaces; 4.7 owns auto-unblock / resume).

## Suggested Review Order

**Engine swap (start here — the design intent)**
- `stageStartTimer` is the 4.2 timed-session engine: twin queue body with strict config-then-hosts order, input guards at the top, try/catch around `writeHosts` so `applyStatus` always resets. [store.ts:549](../../src/domain/store.ts#L549)
- JSDoc on the action contract + domain-layer re-read at run time. [store.ts:194](../../src/domain/store.ts#L194)
- Same mirrored patterns in `setPassword` (run-time re-read) and `restoreSection` (hosts-write + applyStatus flip). [store.ts:467](../../src/domain/store.ts#L467) · [store.ts:411](../../src/domain/store.ts#L411)

**Effective-blocklist union extension**
- `activeTimer?.selectedDomains` walked after the always-on loop, dedupe preserved, defensive against hand-edited configs. [effectiveBlocklist.ts:64](../../src/domain/effectiveBlocklist.ts#L64)

**Timer surface engine swap**
- `handleStart` — single `stageStartTimer({durationMs, selected})` call replaces the per-domain loop. [Timer.tsx:266](../../src/components/Timer.tsx#L266)
- Success toast copy retuned to timed-session framing. [Timer.tsx:89](../../src/components/Timer.tsx#L89)
- Singular/plural branch lives in the toast helper. [Timer.tsx:89](../../src/components/Timer.tsx#L89)
- Subscribed store action swap. [Timer.tsx:111](../../src/components/Timer.tsx#L111)

**Tests (peripherals)**
- Union + dedupe + null activeTimer + www-prefix normalise. [effectiveBlocklist.test.ts](../../__tests__/effectiveBlocklist.test.ts)
- Success (with hosts-payload content assertion) / config-fail / hosts-deny / race-vs-Apply / back-to-back / staged-not-clobbered. [store.test.ts:1458](../../__tests__/store.test.ts#L1458)
- Start success (plural) → new spy + toast copy. [Timer.test.tsx:519](../../__tests__/Timer.test.tsx#L519)
- Start success (singular) → `n === 1` toast copy. [Timer.test.tsx:567](../../__tests__/Timer.test.tsx#L567)
- Start failure → hosts-deny-leaves-activeTimer-null. [Timer.test.tsx:629](../../__tests__/Timer.test.tsx#L629)
