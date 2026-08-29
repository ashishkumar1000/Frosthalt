---
title: 'Live schedule transitions while app running'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: f4f4e95a6be7e85f3c430ce3b36a411e0887abef
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 5.3 made the hosts payload correct whenever it is computed, but nothing recomputes it as time passes: a schedule window opening or closing while the app runs never reaches `/etc/hosts`, and the badge/count only update on Apply success (they are memoized on `committed`, which a window boundary does not touch). Epic 5's "live transitions" reservation is unfilled.

**Approach:** Add a scoped 1-second clock slice (the `timerStore` refcounted-driver pattern, new file, imports nothing from the store) with StatusHeader as its always-mounted subscriber. A module-level subscription in `store.ts` evaluates the effective blocklist each tick against a **baseline of last-known disk payload lines**: when the recomputed lines differ, it enqueues ONE hosts-only write through the existing serialized pipeline (the `restoreSection` precedent — config is canonical and unchanged, so no `writeConfig`). The badge ramps free→amber→blocked via a pure domain helper: amber while blocked and the earliest active schedule end is within 10 minutes and the blocklist actually shrinks at that boundary.

## Boundaries & Constraints

**Always:**
- All evaluation is pure domain logic with an injected `now`/`nowMs`; only the clock slice ever calls `Date.now()` (once per tick).
- Transitions write hosts via `enqueue` ONLY — one write per observed transition, strict queue serialization, `applyStatus` flips `running`→`idle` around it. The OS admin prompt fires per write (epic-accepted).
- Transition writes are hosts-only (`restoreSection` precedent): `writeConfig` is never called; `committed` never changes on a transition.
- The write body recomputes `effectiveHostsLines(committed, now)` at QUEUE-RUN time (the established queue-time re-read rule) and skips the write entirely when the lines equal the baseline — a window closing while its domains stay covered (always-on / another schedule / timer) produces NO write, NO admin prompt, NO toast.
- The transition baseline lives as `{ committedRef, lines }` at module level; a changed `committed` refreshes the baseline silently (every committed-changing path already wrote hosts), and the FIRST evaluation after load sets the baseline with ZERO writes — the mount/launch invariant from 4.7.
- Each observed transition attempts exactly ONE write: on deny or throw the baseline is still updated (no per-second retry/prompt spam); failure surfaces via `HOSTS_FAILURE_TOAST` + the existing drift banner; user Apply/Restore is the recovery path.
- Amber is a pure helper `computeBadgeState(committed, now)` returning `'free' | 'amber' | 'blocked'`; threshold constant `SCHEDULE_ENDING_SOON_MS = 10 * 60 * 1000`; amber requires the blocklist at the schedule's end instant to be strictly smaller than at `now` (never amber for a boundary that changes nothing).
- Dependency direction holds: UI → domain → adapters → ports; the clock slice imports nothing from `store.ts` (one-way rule, mirrors store→timerStore).

**Ask First:**
- Any change to the enqueue/queue or the one-attempt-per-transition policy.
- Extending amber to timer-only sessions (the 4-4 defer stands — 5.4 keeps amber schedule-driven only).
- Any new toast beyond the pinned strings, or badge label/token changes (`STATUS_LABELS`/`tokens.status` are already correct).

**Never:**
- No launchd/daemon/background process; no enforcement while the app is closed; no launch-time hosts write.
- No new native modules; no changes to `timerStore`, `runApply`, `computeDrift`, or `effectiveBlocklist` semantics.
- No `setInterval` anywhere except the clock driver (single refcounted interval, at most one ever running).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Window opens while running | `now` crosses an enabled schedule's `startTime` | ONE queued `writeHosts` adds its domains; badge→`blocked`, count live-updates; toast `Schedule "<name>" started — domains now blocked.` | Deny/throw → `HOSTS_FAILURE_TOAST` ('error'), baseline advances (single attempt) |
| Window ends while running | `now` crosses `endTime`, domains not otherwise covered | ONE queued write removes them; toast `Schedule "<name>" ended — domains unblocked.` | Same as above |
| Window ends, still covered | Domains also always-on / in another active schedule / timer-selected | Lines unchanged → NO write, NO prompt, NO toast | N/A |
| Two windows change in one tick | Both boundaries between ticks | ONE write (combined payload); toast `Schedule windows changed — blocklist updated.` | Same as above |
| Ending soon | Blocked; earliest active-schedule end ≤ 10 min away and blocklist shrinks there | Badge `amber` (label "Blocking" per tokens); NO alert/toast for the ramp (UX-DR15) | N/A |
| Ending soon, no shrink | Boundary covered by always-on/timer | Badge stays `blocked` | N/A |
| Timer-only session ending soon | No active schedule | Badge stays `blocked` — amber is schedule-scoped (4-4 defer) | N/A |
| Mount / launch | App starts mid-window or mid-drift | Baseline set from current evaluation; ZERO port writes | Drift banner (HostsViewer mount) surfaces pre-existing staleness |
| App closed across a boundary | Window opened/closed while app not running | No enforcement until the next hosts write; no launch write | Drift banner; next Apply/Restore recomputes |
| Clock denied / write throws mid-transition | `writeHosts` throws | `applyStatus` back to `idle`, failure toast, baseline advances | No retry loop, no prompt spam |

</frozen-after-approval>

## Code Map

- `src/domain/clockStore.ts` (NEW, Story 5.4) — the scoped clock slice: `useClockStore { nowMs }` + the module-level refcounted 1s driver (`start()`/`stop()`); imports nothing from `store.ts`.
- `src/domain/badgeState.ts` (NEW, Story 5.4) — pure `computeBadgeState(committed, now)` + `SCHEDULE_ENDING_SOON_MS`; imports only `effectiveBlocklist`/`isScheduleActive`/types.
- `src/domain/timerStore.ts:117-130,137-189` — the refcounted module-level driver pattern the clock slice copies (refCount, `clearDriver`, one interval max). Untouched.
- `src/domain/store.ts:1400-1422` — the module-level `useTimerStore.subscribe` expiry trigger: the precedent (and the neighbour) for 5.4's clock subscription. `enqueue` `:1433-1447`; `restoreSection` `:853-892` = the hosts-only-write precedent; `expireTimer` `:1052-1163` = the guard/toast/applyStatus shape to mirror; `HOSTS_FAILURE_TOAST` `:104`; `clearToast` `:1165-1169`.
- `src/components/StatusHeader.tsx:106-155` — count memo (keyed on `committed` only — goes live), badge ternary at `:177` (`hasActiveTimer ? 'blocked' : 'free'`), slice-lifecycle `useLayoutEffect` `:147-155` (the pattern the clock lifecycle copies).
- `src/components/StatusBadge.tsx:14-18,32-40` — `STATUS_LABELS` already has `amber: 'Blocking'`; `statusFill` handles it. Zero changes.
- `src/theme/tokens.ts:29-35,92-96,146-148` — `StatusKey`/`tokens.status.amber`/`statusFill`. Zero changes (domain helper returns its own string union; no UI import in domain).
- `src/domain/effectiveBlocklist.ts:141-145` — `effectiveHostsLines(config, now = new Date())`; the ticker and badge helper call it with an explicit `now`.
- `src/domain/scheduleEval.ts:42` — `isScheduleActive(schedule, now)`; `src/config/types.ts:26-50` — `Schedule` (defensive `domains` read contract).
- `src/components/Shell.tsx:171` — nav-announce count; event-driven (recomputes per navigation), already correct. Untouched.
- Tests: `__tests__/timerStore.test.ts:42-65` — fake-timer + `setInterval` spy pattern for the driver; `__tests__/launchReArm.test.tsx` — real-`StatusHeader`-mount + zero-write invariant pattern; `__tests__/store.test.ts` — state reset via `useDomainStore.setState` (module-level baseline self-heals via the committedRef rule, so no fresh-module isolation is needed); `__tests__/StatusHeader.test.tsx:185-186` — `setSystemTime` pattern.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/clockStore.ts` (NEW) — `useClockStore` with `{ nowMs: number }` (initialised `Date.now()`), module-level refcounted 1s driver (`start()`/`stop()` + `clearDriver`, the timerStore pattern verbatim); docblock stating the one-way import rule.
- [x] `src/domain/badgeState.ts` (NEW) — pure `computeBadgeState(committed, now): 'free' | 'amber' | 'blocked'` + `SCHEDULE_ENDING_SOON_MS`; earliest-active-schedule-end logic with the shrink check; never throws (junk schedules → inactive, per 5.3's evaluator contract).
- [x] `src/domain/store.ts` — `applyScheduleTransitions()` action (hosts-only enqueue body, queue-time recompute, skip-if-equal guard, `applyStatus` flip, pinned toasts, baseline advance on every outcome) + module-level `useClockStore.subscribe` detection loop with the `{ committedRef, lines }` baseline.
- [x] `src/components/StatusHeader.tsx` — clock lifecycle (`useLayoutEffect` start/stop on mount), live count (memo deps `[committed, nowMs]`, docblock updated), badge from `computeBadgeState`.
- [x] `__tests__/clockStore.test.ts` (NEW) — refcount/one-interval/tick pins (timerStore.test pattern).
- [x] `__tests__/badgeState.test.ts` (NEW) — every matrix row: opens, ends, still-covered, ending-soon shrink/no-shrink, timer-only, junk schedules.
- [x] `__tests__/store.test.ts` — transition action: hosts-only (writeConfig NOT called), skip-if-equal, one-attempt-on-deny, toasts, baseline refresh on committed change.
- [x] `__tests__/StatusHeader.test.tsx` — badge free→blocked/amber across a driven boundary (setState on the clock slice, no interval needed); zero-write-at-mount invariant.

**Acceptance Criteria:**
- Given the app running and a window boundary crossing, when the clock ticks, then exactly one queued hosts write makes the section match the recomputed blocklist, the badge and count reflect the new state live, and the admin prompt fires per write.
- Given a boundary that changes nothing (domains still covered), when the clock ticks, then no write, no prompt, and no toast occur.
- Given a schedule ending within 10 minutes whose end would shrink the blocklist, then the badge shows amber with no alert; a timer-only session never ambers.
- Given app mount or launch, then zero port writes occur (4.7 invariant); with the app closed across a boundary, nothing is enforced until the next hosts write.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Do not modify or delete existing entries. -->

- **08-29 (step-04 review patches, `review_loop_iteration: 0` — no loopback):** 3 hunters returned 29 raw findings (Blind Hunter 18, Edge Case Hunter 9, Verification Gap 2); after claim-by-claim verification, 12 patched, 1 deferred, 16 rejected. Post-patch verification: tsc clean; **36 suites / 806 tests / 3 snapshots** green (+5 tests over step-03's 801).
  - **VG-1 (med, patched):** the action-side queue-race branch (`applyScheduleTransitions`' `committedRef !== committed` silent refresh) had NO test — every existing test kept `committed` reference-identical between the tick that set the baseline and the queue-run, so the guard was unexercised. New test replaces `committed` with a NEW config object (Apply-shaped) before the action runs; pins `{ok:false, error:'no-transition'}`, zero port calls, no toast, baseline refreshed (a follow-up equal-lines call also no-ops).
  - **ECH-1 (med, patched):** no backwards-clock guard — a clock rollback (NTP correction) inverted the prev/now flip check, risking one spurious hosts write with wrong toast names. Guard added: `nowMs < transitionPrevTickMs` resets the measurement window and runs the normal baseline compare. Pinned by test.
  - **ECH-2 (low, patched):** a throw inside `evaluateScheduleTransitions` would propagate out of the zustand subscribe callback into the interval tick — uncaught every second, transitions silently dead. The call is wrapped in try/catch with `transitionPrevTickMs` still advancing on catch; recovery test drives a real throw via an `effectiveBlocklist` spy and asserts the next good tick writes with the generic toast.
  - **ECH-6 (low, patched):** `useClockStore.stop()` at refCount 0 still re-synced `nowMs`, firing the transition trigger with no live driver. Unpaired stop is now a true no-op; test extended to assert `nowMs` unmoved after 30s of fake-clock advance.
  - **ECH-7 (low, patched):** malformed `change.started/ended` threw in the toast-copy helper AFTER a successful write, mislabelling a successful write as `hosts-throw`. `Array.isArray` guards default to `[]`; test pins `{started:null, ended:undefined}` → `{ok:true}`, generic toast.
  - **BH-8 (low, patched):** no unmount-refcount test for the clock lifecycle (cleanup was only exercised via the afterEach double-stop hack). New test: unmount → exactly one new `clearInterval`, `nowMs` parked, a spare `stop()` is a true no-op.
  - **BH-5 (low, patched, partially):** the multi-second-forward-jump + backwards-clock paths were commented but untested; backwards pinned (above), forward-jump behaviour covered by the existing coalescing tests' mechanism.
  - **BH-13 + BH-18 (low, patched):** JSDoc corruption in store.ts's transition-baseline docblock (lost ` * ` continuation prefix); stale "one `setInterval(1000)` total" file-top docblock in StatusHeader.tsx; stale "count changes only when committed changes" count-announce comments (now: Apply success AND boundary ticks — both real blocklist changes VoiceOver should hear).
  - **BH-12 (low, patched):** spec's Tasks/Code Map said `startDriver()/stopDriver()`; shipped API is `start()/stop()` — non-frozen spec sections corrected.
  - **BH-10 (low, patched):** the header tests' inline 8× microtask drain loops now carry the "per-file twin of store.test.ts's `flushMicrotasks`" comment (jest collects every `__tests__` file as its own suite, so the helper cannot be shared).
  - **BH-3 (low, patched, docs):** Design Note added — the amber ramp considers only the EARLIEST active schedule's end; a later visible shrink never ambers (accepted simplification per the frozen rule). Matching overclaiming docblocks ("can never disagree") reworded to the accurate claim: badge/count never disagree with EACH OTHER; disk reconciliation is the trigger's job.
  - **Deferred → deferred-work.md:** midnight-crossing windows (22:00→06:00 never active — 5.3's frozen degenerate-window contract; product decision on overnight windows, evaluator + badge end-instant math both assume same-day end).
  - **Rejected after verification (notable):** trailing newlines (repo `.ts` convention, 5-3 precedent); the Never-clause's "no setInterval anywhere except the clock driver" wording is imprecise (PasswordGate's pre-existing component interval + the Design-Notes-accepted two-driver coexistence both predate — the intent "no NEW intervals beyond the clock driver" is honored; frozen wording flagged to the human, not renegotiated unilaterally); per-second header re-render even when idle (documented accepted cost); earliest-end-only amber (frozen rule — Design Note added); badge-overclaim after relaunch mid-window (the 4.7 zero-write-at-launch invariant + drift banner, spec'd); unbounded-queue-accumulation during a slow write (queued duplicates no-op at run time and are load-bearing for boundaries crossed mid-write; only ONE admin prompt ever); queue-serialization test (structural via the shared enqueue; the VG-1 race test covers the adjacent hazard); midnight-window badge math / DST skew (5.3's accepted local-time semantics); catch-all 'blocked' fail-safe (unreachable defensive path, direction documented); `transitionPrevTickMs` bookkeeping in the action's refresh branch (prevTickMs tracks the detection loop's timeline only); a11y for transitions (covered — the toast announce + the `[count]` VoiceOver announce both fire on a boundary that changes enforcement); ECH's removed-`hasActiveTimer` badge divergence (both derive from the same `committed.activeTimer` source); blind repeated-`stop()` test isolation and shared-helper extraction (repo conventions).

## Design Notes

- **Why a payload-lines baseline, not a schedule-id baseline:** one comparison covers opens, closes, still-covered closes, and multi-schedule ticks; it naturally suppresses no-op writes (the admin prompt is the scarcest resource) and makes the toast truthful (only fired when something was actually written). The `committedRef` refresh rule is safe because every committed-changing path already wrote hosts; `setPassword` (the exception) cannot change hosts lines.
- **Why one attempt, no retry:** expireTimer's deny semantics (one failure toast, give up) — a per-second retry would spam OS admin prompts. Drift banner + user Apply remain the recovery path.
- **Known edge (accepted):** if a timer expires BEFORE the schedule's end instant, `effectiveBlocklist(committed, endInstant)` may over-count the timer's contribution (expiry is a write-time fact), so a brief amber could appear and revert to `blocked` after the boundary write. Same "disk/derived state lags until the next write" class 5.3 documented for drift.
- **Driver always-on while the app runs:** StatusHeader never unmounts, so the refcount never drops; the per-tick cost is one `effectiveHostsLines` walk on a small config. Two 1s intervals coexist during a live session (timer driver + clock driver) — accepted, keeping 4.3's tested driver untouched.
- **Earliest-end-only amber (accepted simplification, step-04):** the ramp considers ONLY the earliest active schedule's end instant. If that earliest boundary is covered (no shrink at it) but a second, later-ending active schedule would produce a real shrink within the threshold, the badge stays `blocked` — that later visible shrink never ambers. Accepted per the frozen amber rule (earliest end + strict shrink); a fuller multi-boundary scan would be an Ask-First semantics change.
- **Badge/count vs disk (step-04 wording fix):** the badge and the count never disagree with EACH OTHER (both derive from the same `committed` + the same clock-mirror `now`); they are not guaranteed to agree with the disk payload at every instant — reconciling `/etc/hosts` to them is exactly the transition trigger's job (one write per observed boundary).

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — expected: no type errors.
- `node_modules/.bin/jest --watchman=false` — expected: full suite green, no regressions; record the actual suite/test/snapshot counts in this section.

**Actual results:** _(filled at step-03)_

- `node_modules/.bin/tsc --noEmit` — clean: no type errors.
- `node_modules/.bin/jest --watchman=false` — full suite green, no regressions:
  **36 suites passed, 806 tests passed, 3 snapshots passed.** New coverage: 2
  new suites — `clockStore.test.ts` (7 driver tests, incl. the unpaired-stop
  true-no-op pin), `badgeState.test.ts` (14 badge-matrix tests);
  +15 transition-action tests in `store.test.ts` (165 there — incl. the
  step-04 queue-race, backwards-clock, throw-containment and malformed-change
  tests); +3 driven-boundary/unmount tests in `StatusHeader.test.tsx`
  (18 there);
  the interval-count assertions in `launchReArm.test.tsx`,
  `Shell.test.tsx` and `StatusHeader.test.tsx` moved by one for the header's
  unconditional clock-driver mount interval (two 1s intervals during a live
  session, per the Design Notes).

**Matrix Test Audit (2026-08-29, step-03):** all 10 frozen matrix rows covered by passing tests in the green run above — Window opens while running (`store.test.ts 'a window opening queues ONE hosts-only write with the started toast' :4109` — asserts hosts-only, `writeConfig` NOT called, pinned started toast, `committed` reference unchanged; `StatusHeader.test.tsx 'a schedule window opening live flips the badge Free -> Blocked…' :900` — badge + count + exactly ONE hosts-only write; the deny branch of this row: `'a denied transition write advances the baseline and never retries' :4258`); Window ends while running (`store.test.ts 'a window ending writes the shrink and shows the ended toast' :4166`); Window ends, still covered (`store.test.ts 'a still-covered boundary skips without any write or toast' :4192`, plus `'skip-if-equal returns no-transition with zero side effects' :4358`); Two windows change in one tick (`store.test.ts 'two schedule flips in one tick coalesce into ONE write' :4219`); Ending soon (`badgeState.test.ts 'ending soon with a shrinking blocklist shows amber' :97` + `'the threshold is inclusive at exactly 10 minutes' :105`, rendered amber with zero writes in `StatusHeader.test.tsx :948`); Ending soon, no shrink (`badgeState.test.ts :119` always-on, `:136` another active schedule, `:148` no-shrink-earliest-end-wins); Timer-only session ending soon (`badgeState.test.ts 'a timer-only session never ambers, however close to expiry' :167` + the live-timer-with-schedule variant `:176`); Mount / launch (`store.test.ts 'the first tick sets the transition baseline and writes nothing' :4092`; `StatusHeader.test.tsx` zero-port-write-at-mount invariant; `launchReArm.test.tsx` zero-write anti-cheat suite); App closed across a boundary (`launchReArm.test.tsx` launch suites — zero port writes at launch, re-arm from disk only); Clock denied / write throws (`store.test.ts 'a thrown hosts write advances the baseline, toasts, and never retries' :4289` — applyStatus back to idle, failure toast, no retry). All ran and passed in the 806-test green run; no expectations were edited to match code.

**Manual checks (post-build, optional):**
- Live ramp: with a schedule window ending soon, the badge turns amber ~10 min before `endTime`; writes happen at `startTime`/`endTime` with one admin prompt each, and count/badge follow. Force-quit mid-window → hosts keep blocking → relaunch does NOT write; HostsViewer shows drift until Apply/Restore.
## Suggested Review Order

**The transition trigger — design intent**

- Start here: the payload-lines baseline concept — what /etc/hosts was last known to hold.
  [`store.ts:1593`](../../src/domain/store.ts#L1593)

- The clock-tick detector: baseline set → compare → diff → one fire-and-forget write attempt.
  [`store.ts:1663`](../../src/domain/store.ts#L1663)

- The write attempt itself: hosts-only enqueue, queue-time recompute, skip-if-equal, one attempt.
  [`store.ts:1222`](../../src/domain/store.ts#L1222)

- The module-level `useClockStore.subscribe` wiring (backwards-clock + throw containment guards).
  [`store.ts:1740`](../../src/domain/store.ts#L1740)

**The clock slice**

- New scoped store: `{ nowMs }` + refcounted 1s driver, imports nothing from the store.
  [`clockStore.ts:67`](../../src/domain/clockStore.ts#L67)

- Unpaired `stop()` is a true no-op (review patch) — no phantom mirror update.
  [`clockStore.ts:86`](../../src/domain/clockStore.ts#L86)

**The badge ramp**

- Pure amber derivation: earliest active end within 10 min AND strict shrink at that boundary.
  [`badgeState.ts:53`](../../src/domain/badgeState.ts#L53)

**The UI binding**

- Live count + badge memoized on `[committed, nowMs]`; unconditional clock lifecycle.
  [`StatusHeader.tsx:212`](../../src/components/StatusHeader.tsx#L212)

- Count/badge derivations — the per-tick mirror in action.
  [`StatusHeader.tsx:147`](../../src/components/StatusHeader.tsx#L147)

**Tests**

- Trigger matrix: baseline zero-write, open/end/coalesce/deny/throw/skip, race + backwards clock + throw recovery.
  [`store.test.ts:4028`](../../__tests__/store.test.ts#L4028)

- Badge matrix: every frozen matrix row, pure and total.
  [`badgeState.test.ts:1`](../../__tests__/badgeState.test.ts#L1)

- Driver pins: refcount, one-interval, foreign-interval safety.
  [`clockStore.test.ts:1`](../../__tests__/clockStore.test.ts#L1)

- Driven-boundary renders: live badge flip + count, amber with no write, unmount slot release.
  [`StatusHeader.test.tsx:900`](../../__tests__/StatusHeader.test.tsx#L900)
