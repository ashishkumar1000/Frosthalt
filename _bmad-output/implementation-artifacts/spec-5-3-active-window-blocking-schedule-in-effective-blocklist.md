---
title: 'Active-window blocking (schedule in effective blocklist)'
type: 'feature'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
baseline_commit: 15693e0bd84c47313a3e2ea9ce3fbf89a4309c3c
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Schedules can be created, edited, and staged (5.1/5.2), but their domains never reach `/etc/hosts` — `effectiveBlocklist` ignores `config.schedules`, so an enabled schedule in its window blocks nothing. The Epic 5 reservation in the union is unfilled.

**Approach:** Add a pure schedule-window evaluator (weekday + time range against an injected `now`) in the domain layer, and append active schedules' domains as `effectiveBlocklist`'s third contribution. Every hosts-payload path (Apply, timer start/expire/end-early, restore, drift) then picks schedule domains up automatically via the shared `effectiveHostsLines` helper — no new write path. 5.4 owns live ticking; 5.3 only makes the payload correct whenever it is computed.

## Boundaries & Constraints

**Always:**
- Evaluation is pure domain logic in `src/domain/scheduleEval.ts`; `now` is an injected `Date` parameter — the evaluator never calls `new Date()` itself (call sites default it).
- Time parsing goes through `normaliseTime` — an unpadded `'9:00'` in committed config must evaluate (deferred-work hard requirement); never compare `HH:mm` lexically.
- Weekday mapping: config uses 0=Mon..6=Sun; convert from JS `Date.getDay()` (0=Sun) via `(jsDay + 6) % 7`.
- The window is half-open `[start, end)`: `start` inclusive, `end` exclusive.
- Defensive reads mirror the store's posture: `enabled` coerces `typeof === 'boolean' ? v : true`; `weekdays`/`domains` missing-or-not-array → empty; junk elements dropped; unparseable time → schedule inactive. Never crash the pipeline.
- A degenerate window (`endTime <= startTime`, hand-editable) is never active — blocking only ever shrinks on bad data.
- The third contribution appends AFTER the timer walk with the same `normaliseDomain` + `seen`-dedupe discipline (an apex that is always-on, timer-selected, AND scheduled writes once).
- Dependency direction holds: UI → domain → adapters → ports; no `fs`/`child_process`/`os` in `src/`.

**Ask First:** <!-- Agent: if any of these trigger during execution, HALT and ask the user before proceeding. -->
- Any change to the strict `writeConfig → writeHosts` order or the `runApply`/store split.
- Any hosts write outside the existing Apply/enqueue paths (e.g. an automatic write on launch or on a window boundary).
- Adding schedule state to the badge or the status header (5.4's scope).

**Never:**
- No `launchd`/daemon/interval — 5.4 owns live transitions; this story must not add ticking or a launch-time hosts write. No enforcement while the app is closed (FR-13, accepted v1 limitation).
- No UI changes (no badge, no Schedule-surface changes) and no new native modules.
- No changes to `stageSchedule*` staging semantics — 5.1/5.2 already own them.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| In-window | Enabled schedule, weekday matches, `start <= now < end` | Its domains appear in `effectiveBlocklist` and in the hosts payload `runApply` writes | N/A |
| Out-of-window | Same config, `now` outside the window (or after `end`) | Its domains absent from blocklist and hosts payload | N/A |
| Wrong weekday | Time matches, weekday does not | Not active — domains not blocked | N/A |
| Half-open boundary | `now == startTime` → active; `now == endTime` → inactive | Pin both edges in the unit test | N/A |
| Disabled schedule | `enabled: false`, inside the window | Contributes nothing regardless of window | N/A |
| Legacy unpadded time | Committed `startTime: '9:00'` (hand-edited) | Evaluates as 09:00 — inside/outside decided correctly | N/A |
| Degenerate window | `endTime <= startTime` (hand-edited) | Never active | N/A |
| Junk/missing fields | `enabled` missing → true; `weekdays: [7, 1]` → `[1]`; junk/non-hostname domains dropped; unparseable time | Junk skipped, schedule inactive if unparseable — never throws | N/A |
| Three-way union dedupe | Apex both always-on and in an in-window schedule (and timer-selected) | Written ONCE, schedule contribution after the timer's | N/A |
| Drift expectation | Committed config with in-window schedule; hosts section lacks its lines | `computeDrift` reports drift — expected lines include the schedule's domains | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/effectiveBlocklist.ts:37-85` -- the union; `:80-81` is the Epic-5 reservation comment = the exact insertion point; `effectiveHostsLines` `:98-100` is the shared DRY helper.
- `src/domain/apply.ts:95` -- `runApply` computes lines from `nextConfig`; inherits the contribution with zero changes.
- `src/domain/drift.ts:62-105` -- `computeDrift`; expected = `effectiveHostsLines(committed)` at `:73` (order-sensitive equality). Only triggered on HostsViewer mount.
- `src/domain/store.ts` -- `restoreSection` `:869`, timer paths `:1013`/`:1115`/`:1226` all call `effectiveHostsLines` (all inherit); `apply()` `:756-780` passes the call-time committed snapshot. `timerStore` ticker `:175-191` is the 5.4 precedent — untouched here.
- `src/domain/normalise.ts` -- `normaliseTime` `:117-153` (accepts unpadded, `null` on invalid); `toHostsLines` `:149`; `normaliseDomain` `:59`.
- `src/config/types.ts` -- `Weekday` `:22` (0=Mon); `Schedule` `:31-66` (defensive-read docblock); `DEFAULT_CONFIG.schedules: []` `:96-103`.
- `src/domain/scheduleSummary.ts` -- formatting only, explicitly no time parsing to reuse.
- Tests: `__tests__/effectiveBlocklist.test.ts` (13 tests, none seed `schedules` — the Epic-4 union test at `:91-101` is the shape precedent); `__tests__/drift.test.ts` (no schedules); `__tests__/apply.test.ts:329/:354` (enabled schedules, config-content asserts only); `__tests__/store.test.ts:3461+` (staged schedule Apply, call-count asserts). Today NO test pins an enabled-schedule config against exact hosts output — 5.3 adds that.

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/scheduleEval.ts` (NEW) -- `isScheduleActive(schedule: unknown, now: Date): boolean` with a docblock stating purity, defensiveness, half-open window, degenerate-window-inactive -- the frozen matrix's evaluator.
- [x] `src/domain/effectiveBlocklist.ts` -- thread `now: Date = new Date()` through `effectiveBlocklist` + `effectiveHostsLines`; third contribution walks `config.schedules` behind an `isScheduleActive` gate with the `seen`-dedupe discipline; retire the reservation comment, update docblocks (Epic 5 paragraph).
- [x] `__tests__/scheduleEval.test.ts` (NEW) -- unit test of the window evaluation (weekday + time range) for inside/outside cases: all matrix rows, injected fixed `Date`s, Sunday (`jsDay 0 → weekday 6`) and Monday mapping, `'9:00'`, degenerate, junk fields.
- [x] `__tests__/effectiveBlocklist.test.ts` -- union tests with schedules: schedule-only contribution, dedupe against always-on, order after the timer walk, disabled/out-of-window contribute nothing, explicit `now` injection.
- [x] `__tests__/apply.test.ts` + `__tests__/drift.test.ts` -- hosts-payload assertions: in-window schedule → exact lines present; out-of-window → absent; `computeDrift` expects in-window lines (drift) and out-of-window lines (in-sync).

**Acceptance Criteria:**
- Given an enabled schedule inside its window, when any hosts payload is computed (Apply, timer start/expire/end-early, restore, drift check), then its domains are included and written via the EXISTING Epic 1 pipeline — strict order unchanged, one admin prompt, no new write path.
- Given a staged schedule enable or disable, when Apply runs, then the written hosts section reflects window membership at the Apply instant — staging alone never writes hosts.
- Given the app running across a window boundary with no user action, then nothing writes hosts in this story (5.4 owns transitions); the suite contains no interval, no launch write, and no store changes.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Do not modify or delete existing entries. -->

- **08-28 (step-04 review patches, `review_loop_iteration: 0` — no loopback):** 3 hunters returned 24 raw findings (Blind Hunter 19, Edge Case Hunter 4, Verification Gap 1); after claim-by-claim verification, 6 patched, 2 deferred, 16 rejected.
  - **ECH-1 (med, patched):** `isScheduleActive`'s never-throws docblock claim was false — a non-Date `now` (null/undefined/number) threw at `now.getDay()`. A structural guard was added (reject `now == null`, non-callable `getTime`, or NaN time) instead of `instanceof Date`, which misjudges Dates under the tests' mocked global `Date` and cross-realm Dates. Pinned: non-Date and NaN-time `now` → inactive, never thrown.
  - **BH-10 (low, patched):** the "seconds field does not extend the window" boundary test never passed a non-zero seconds value — its claim was untested. `dateAt` gained a `second` parameter; the test now pins 17:00:30 (outside) and 16:59:59 (inside).
  - **BH-2 (low, patched):** `linesFor` in apply.test and drift.test hand-mirrored `toHostsLines` (silent-drift risk if the expansion ever changes); both now delegate to the real `toHostsLines`.
  - **BH-11 (low, patched):** the junk-weekdays test covered out-of-range integers only; extended with string/float junk (`['2', 2.5, 2]` → only the valid `2` survives), matching the evaluator's docblock claim.
  - **BH-16 (low, patched):** the default-now test raced its own `new Date()` against the function's internal one (only at exactly midnight); now deterministic via `jest.useFakeTimers()` + `setSystemTime`, restored in a `finally`.
  - **BH-7/BH-8 (med, patched):** no Apply-level test covered the COMMITTED-schedules path (`stagedSchedules: null`) — applying an unrelated staged-domain change must re-write active schedule lines from committed config, not drop them (the staged domains slice REPLACES committed `domains`, so a formerly always-on domain survives only via schedule membership). New test pins the exact payload + strict writeConfig→writeHosts order.
  - **VG-1 + BH-14/BH-15 (deferred → deferred-work.md):** missing-`enabled` renders the Schedule-row checkbox OFF while the evaluator (per frozen spec) enforces ON — belongs to the read-time normalisation family deferred from 5-2; and store-level payload asserts for restore/timer paths (their schedule inheritance is proven via the shared `effectiveHostsLines` unit tests + Apply-level tests; natural fit for 5.4's ticker work).
  - **Rejected after verification (notable):** BH-4/ECH-3/ECH-4 (`Date.now` unspied — the constructor spy makes any `Date.now()` call throw loudly, so silent clock dependence is impossible); BH-5 (withFixedNow's spy stays installed across the whole awaited call); BH-6 (drift's absent-section shortcut keys on `expected.length`, which includes the schedule contribution — verified by reading `computeDrift`); BH-9 (writeConfig contents asserted by pre-existing apply tests); BH-12/ECH-2 (missing-enabled coercion and `'24:00'` → inactive are the spec's frozen bad-data-shrinks posture, explicitly docblocked); BH-17 (no trailing newline is this repo's `.ts` convention); BH-18 (slice-coupling to `normaliseTime`'s guaranteed `HH:mm` output is the contract); BH-13/BH-19/BH-3 (thin flatMap / drift shapes / per-file fixtures — covered or convention).

## Design Notes

- **Why `now` as a defaulted parameter:** all six `effectiveHostsLines` call sites keep working unchanged (default = current time, correct for each); tests inject a fixed `Date` for determinism, and the evaluator stays pure.
- **Drift at a window boundary (known, accepted):** between a boundary and the next hosts write, the disk section lags the recomputed expectation. The drift check only runs on HostsViewer mount, so this surfaces only there, and Restore writes the correctly-recomputed lines. 5.4's ticker closes the gap — state it in the drift docblock, do not special-case it.
- **Evaluator shape:**

```ts
// config weekdays 0=Mon..6=Sun; JS getDay() 0=Sun..6=Sat
const weekday = (now.getDay() + 6) % 7;
const minutes = (h, m) => h * 60 + m;
// start <= cur < end  (half-open); end <= start -> degenerate -> false
```

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions; record the actual suite/test/snapshot counts in this section.

**Actual results (2026-08-28, after step-04 review patches P1-P6):**
- `node_modules/.bin/tsc --noEmit` -- no type errors (exit 0).
- `node_modules/.bin/jest --watchman=false` -- 34 test suites passed, 767 tests passed, 3 snapshots passed, 0 failed (one pre-existing `act()` warning from `store.test.ts`'s timer path, unrelated to 5.3).

**Matrix Test Audit (2026-08-28, step-03, re-anchored after step-04 patches):** all 10 frozen matrix rows covered by passing tests — In-window (`effectiveBlocklist.test 'an in-window schedule contributes its domains…' :200`, `apply.test 'in-window staged schedule: the hosts payload includes its domains…' :463`); Out-of-window (`effectiveBlocklist.test :218`, `apply.test :504`); Wrong weekday (`scheduleEval.test :63`, `effectiveBlocklist.test :227`); Half-open boundary (`scheduleEval.test 'now == startTime is ACTIVE' :76` / `'now == endTime is INACTIVE' :80` / seconds :84 — now exercising non-zero seconds); Disabled (`scheduleEval.test :95`, `effectiveBlocklist.test :235`, `apply.test :519`, `drift.test :361`); Legacy unpadded (`scheduleEval.test :130`, `:137`); Degenerate window (`scheduleEval.test :149`, `:155`); Junk/missing fields (`scheduleEval.test :166/:181/:188/:196/:207/:214/:219` — incl. non-integer weekday junk and non-Date/NaN `now`, `effectiveBlocklist.test :300/:310/:323`); Three-way union dedupe (`effectiveBlocklist.test 'alwaysOn AND timer-selected AND scheduled writes ONCE' :243`, order `:259`, apply-level committed-schedules path `apply.test :532`); Drift expectation (`drift.test 'in-window schedule + section missing its lines -> mismatch' :325`, plus in-sync/mismatch variants :335/:343/:351). Supplementary pins beyond the matrix: weekday mapping (`scheduleEval.test :105/:112/:118`), 00:00-start / 23:59-end edges (:229/:236), purity (:246). All ran in the 767-test green run above; no expectations edited to match code.

**Manual checks (post-build, optional):**
- With an in-window schedule staged and Applied, inspect `/etc/hosts` — its domains appear once; after the window ends (no further Apply), the section is unchanged (5.4 owns live unblocking).
## Suggested Review Order

**The evaluator (design intent)**

- The whole story in one pure function — defensive reads, half-open window, injected `now`.
  [`scheduleEval.ts:42`](../../src/domain/scheduleEval.ts#L42)

- The never-throws guard — structural (not `instanceof`) so it survives mocked/cross-realm Dates.
  [`scheduleEval.ts:52`](../../src/domain/scheduleEval.ts#L52)

- Config 0=Mon..6=Sun from JS `getDay()`; half-open `[start, end)` return.
  [`scheduleEval.ts:73`](../../src/domain/scheduleEval.ts#L73)
  [`scheduleEval.ts:102`](../../src/domain/scheduleEval.ts#L102)

**The union (third contribution)**

- Epic 5 walk: LAST, behind the `isScheduleActive` gate, same normalise + dedupe discipline.
  [`effectiveBlocklist.ts:92`](../../src/domain/effectiveBlocklist.ts#L92)

- `now` defaulted per call — all six `effectiveHostsLines` call sites inherit with zero changes.
  [`effectiveBlocklist.ts:141`](../../src/domain/effectiveBlocklist.ts#L141)

**Drift semantics (documented, not special-cased)**

- Boundary-lag docblock: disk section lags between a window edge and the next write; 5.4's ticker closes it.
  [`drift.ts:32`](../../src/domain/drift.ts#L32)

**Tests (peripherals)**

- The pinned-`now` helper (`Date` constructor spy, active across the whole awaited call).
  [`apply.test.ts:428`](../../__tests__/apply.test.ts#L428)

- The matrix rows in unit form — 25 evaluator tests incl. unpadded, degenerate, junk.
  [`scheduleEval.test.ts:49`](../../__tests__/scheduleEval.test.ts#L49)

- Three-way union dedupe at the union level.
  [`effectiveBlocklist.test.ts:243`](../../__tests__/effectiveBlocklist.test.ts#L243)

- Payload-level pins: committed-schedules path + strict write→write order.
  [`apply.test.ts:532`](../../__tests__/apply.test.ts#L532)

- Drift expectation flips with window membership.
  [`drift.test.ts:325`](../../__tests__/drift.test.ts#L325)
