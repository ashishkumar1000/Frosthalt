---
title: 'Closed-mid-session persistence and re-arm on launch (Story 4.7)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: 'da4ccc2'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A persisted focus session must survive quitting Frosthalt (anti-cheat: blocks stay in `/etc/hosts` while closed) and be reconciled on relaunch — resume if `now < endEpochMs`, unblock via the Apply path if `now ≥ endEpochMs`. The machinery already exists and is believed to work (4-5's expiry trigger, 4-4's always-mounted header subscriber), but NO test asserts the re-arm contract from a PERSISTED config — every existing test seeds `activeTimer` via `setState`, so a store-creation regression (e.g. dropping `readConfig()` from the `create(...)` body) would pass the whole suite. The epics AC explicitly demands a unit test for both re-arm branches.

**Approach:** A new launch-path test suite that seeds `configNative.readConfig` to return a persisted `config.json` and exercises the REAL launch chain (`jest.isolateModules` fresh store require → StatusHeader real mount → timer slice start → 4-5 trigger): (a) future end-time → countdown resumes, badge Blocked, ZERO port writes at launch (anti-cheat); (b) expired end-time → config write `activeTimer: null` then hosts write (always-on only), badge reverts. Plus pins for malformed `endEpochMs` (fail-safe, no crash) and denied-expiry relaunch (no re-arm possible, drift banner is the escape). Zero production-code changes are expected — if implementation discovers a genuine gap in the launch path, that is a CHECKPOINT ask-first event, not silent code.

## Boundaries & Constraints

**Always:**
- The re-arm tests exercise the REAL module-eval → `committed: readConfig()` (store.ts:448) → header-mount → slice → expiry-trigger chain. Seeding `activeTimer` via `useDomainStore.setState` does NOT count as a re-arm test for either branch — disk-seeded state is the whole point.
- The resume-branch test asserts the anti-cheat invariant: with a persisted FUTURE session, launch performs zero `writeConfig`/`writeHosts` calls (nothing removes blocks at startup).
- The expired-branch test asserts the full 4.5 shape through the real mount chain: config-first `writeConfig` with `activeTimer: null`, then `writeHosts` with always-on-only lines (use `invocationCallOrder`), `committed.activeTimer` null, badge reverts.
- Malformed `endEpochMs` (string/NaN from a hand-edited config) degrades fail-safe: no crash, no slice start, no expiry fire, hosts untouched, Start remains available (header normalisation returns null).
- The denied-expiry-relaunch pin documents reality: disk says `activeTimer: null` → `expireTimer` no-ops (`not-expired`) → no re-arm; the user's escape is the hosts-viewer drift banner + Restore. Record this as the corrected behaviour (spec-4-5's matrix wording "Retry = relaunch (4.7 re-arm)" is stale — note it in the spec, do not edit that spec's frozen block).

**Ask First:**
- ANY production-code change to make a branch pass (e.g. an init-time repair of a malformed `activeTimer`, a launch-time drift surface, re-arm on a session whose disk state was already cleared). The epic intent is the distributed comparison ALREADY in place; 4.7 proves it.
- Persisting the session's original duration (or start time) on `ActiveTimer` to make the relaunched ring's `totalMs` accurate (types.ts:48-53 — schema change, currently documented as ring-starts-full).
- Any launch-time toast/announce ("Session resumed").

**Never:**
- No `launchd`/background enforcement while the app is closed (PRD §10 accepted limitation), no new dependencies, no changes to timer-slice state shape/driver/refcount, no changes to `expireTimer`/`endEarly`/`stageStartTimer` guards, no ActiveTimer schema change, no superseding-session re-key component test (still unreachable — remains the 4-4 defer), no Panic or gate changes, no removal of the existing 4-5 expired-at-mount tests.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Launch — resume | persisted `activeTimer` with FUTURE `endEpochMs` | `committed` carries it from disk; header mount starts the slice; countdown ticks; badge Blocked; ZERO `writeConfig`/`writeHosts` calls at launch | N/A |
| Launch — expired | persisted `activeTimer` with PAST `endEpochMs` | Real mount chain parks the slice → 4-5 trigger → config write (`activeTimer: null`) BEFORE hosts write (always-on only); `committed.activeTimer` cleared; badge Free | Idempotent; mirrors 4.5 matrix |
| Launch — also always-on | expired session, one selected domain also always-on | Hosts payload keeps the always-on line; timer-only domains drop | N/A |
| Launch — malformed end | `endEpochMs` is a string/NaN | No crash; header normalises null; slice never starts; trigger's finite guard holds; hosts untouched; Start available | Fail-safe (stuck session stays blocked) |
| Launch after denied expiry | disk `activeTimer: null`, hosts still blocks timer domains | No re-arm; `expireTimer` → `{ok:false, error:'not-expired'}`; Free badge; drift banner + Restore available in the hosts viewer | Accepted-drift documented |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts:448` — `committed: readConfig()` is the FIRST field of `create(...)` (module-eval, exactly once — store.test.ts:64-70 asserts this); NO `init()` exists anywhere. Launch behaviour is entirely this line + downstream consumers.
- `src/config/configStore.ts:36-87` — `readConfig` never throws: native throw, `null`, `ok:false`, missing file, JSON.parse throw, non-Config shape ALL fall back to `DEFAULT_CONFIG` (types.ts:73-78, returned by reference). Validation is top-level only (:66-82); `activeTimer` element shape deliberately unchecked (:59-65; 4-3 defer).
- `src/domain/store.ts:1166-1170` — `sliceExpiredParked` predicate (finite `endEpochMs` && `nowMs >= endEpochMs`); `[:1187-1194](../../src/domain/store.ts#L1187)` — module-level `useTimerStore.subscribe` firing `expireTimer()` on the expired false→true park.
- `src/domain/timerStore.ts:151-161` — `start(expiredEnd)` park branch (`totalMs: 0`, expired flag true — the expired-at-launch moment); `[:167-173]` — first-start `totalMs = Math.max(0, endEpochMs - Date.now())` (remaining-only → relaunched ring starts full; documented defer, no 4.7 fix).
- `src/components/StatusHeader.tsx:128-133` — `activeEndEpochMs` normalisation (non-finite → null); `[:147-155]` — `useLayoutEffect` keyed `[activeEndEpochMs]` calling `useTimerStore.getState().start(...)`. Shell.tsx:272 always mounts the header → this effect IS the launch trigger for both branches.
- `src/domain/store.ts:841-846` — `expireTimer` queue-time guard: `active == null || !Number.isFinite(end) || Date.now() < end` → `{ok:false, error:'not-expired'}` (why a malformed session never re-arms).
- `src/components/HostsViewer.tsx:75-84` + `src/domain/drift.ts:91-95` — `checkDrift` on viewer mount → banner + Restore: the ONLY drift surface (the denied-expiry escape). No launch-time drift check exists.
- `__tests__/store.test.ts:64-70` — the readConfig mock + `mockReset` convention (why existing tests can't seed persisted config); `:2589` — `resetTimerSlice()` helper; `:2640-2665` — 4.5's `start(expiredEnd)` → trigger test (setState-seeded, NOT disk-seeded).
- `__tests__/StatusHeader.test.tsx:321-396` — the existing real-mount expired-at-mount test (setState-seeded) — the 4.7 disk-seeded analogs mirror its assertions.
- **Test-seam warning:** no existing suite uses `jest.isolateModules`; the fresh store require must be imported INSIDE `isolateModules(() => {...})` together with StatusHeader (the outer module instance is bound to the outer store). Verify the native-spec jest mocks (seeded via `require('../src/native/specs/...')` at file top, per store.test.ts:21-34) are visible to the isolated require — if the isolated registry does not share them, do the seeding and assertions on the handles required inside the isolateModules callback.

## Tasks & Acceptance

**Execution:**
- [x] `__tests__/launchReArm.test.tsx` (NEW) — the launch-path suite: native-spec mocks at file top; per-test `jest.isolateModules` fresh require of store + StatusHeader. Tests: (1) resume — future session from disk, real header mount, countdown ticks, zero port writes; (2) expired — real mount chain fires the 4.5 shape (config-then-hosts order, always-on payload, committed cleared, badge revert); (3) also-always-on — payload keeps the always-on line; (4) malformed `endEpochMs` — no crash, no slice, no write, Start available; (5) denied-expiry relaunch — `expireTimer` no-op `not-expired`, zero writes.
- [x] `__tests__/launchReArm.test.tsx` — anti-cheat structural pin inside test (1): assert `configNative.writeConfig` and `shellNative.writeHosts` have ZERO calls before any user action.
- [x] `_bmad-output/implementation-artifacts/spec-4-7-closed-mid-session-persistence-and-re-arm-on-launch.md` — Spec Change Log: record the spec-4-5 "Retry = relaunch (4.7 re-arm)" matrix wording as corrected-by-4.7 (relaunch after a denied expiry CANNOT re-arm; drift banner is the escape).
- [x] `sprint-status.yaml` — `4-7` → `review` at step-05 (the `done` flip rides the story commit; `epic-4` → `done` flips with it if 4-7 is the last story).

**Acceptance Criteria:**
- Given a persisted unexpired session in `config.json`, when the app launches, then the countdown resumes and blocks persist with no hosts write and no config write until the user acts.
- Given a persisted expired session in `config.json`, when the app launches, then the expiry path fires through the real mount chain: config write with `activeTimer: null` precedes the hosts write, the hosts payload contains only always-on lines, and the badge reverts to Free.
- Given a hand-edited config whose `activeTimer.endEpochMs` is not a finite number, when the app launches, then nothing crashes, no port is written, and the user can still start a fresh session.
- Given the app was closed while a session was live, when nothing else runs, then the managed section in `/etc/hosts` is unchanged (no launch-time removal path exists).
- Given a relaunch after an admin-denied expiry, then no re-arm occurs and the drift banner + Restore in the hosts viewer is the recovery path (documented, not built).

## Spec Change Log

- 2026-08-28 (step-05): spec-4-5's I/O matrix wording "Retry = relaunch (4.7 re-arm)" is CORRECTED by this story. A relaunch after an admin-denied expiry CANNOT re-arm: 4.5's config-first order cleared `activeTimer` on disk before the denied hosts write, so the relaunched store finds `activeTimer: null`, the header never starts the slice, and `expireTimer()` no-ops with `{ok:false, error:'not-expired'}` — pinned by the denied-expiry-relaunch test in `__tests__/launchReArm.test.tsx`. The honest recovery paths are the hosts-viewer drift banner + Restore (`HostsViewer.tsx` mount -> `checkDrift`, the only drift surface) or Panic. Recorded here only; 4-5's frozen spec block is left untouched.

## Design Notes

- **Why this is a tests-first story:** the re-arm comparison (`Date.now() vs endEpochMs`) is distributed across store creation, the header's layout effect, and the slice's park + the 4-5 trigger — deliberately, so there is one expiry path and no parallel "launch unblock" code. The epic context's "re-arm lives in the store init path" is satisfied BY that distribution; 4.7's job is to make a regression in ANY of the three pieces fail a test, from the persisted-disk seam none of the existing tests use.
- **The launch window:** between module eval and the header's first layout commit, a persisted expired session shows `Blocked · 00:00` with hosts still blocking for a few frames before `expireTimer` fires. Acceptable under the no-enforcement-while-closed posture; state it, don't fix it (an eager pre-mount fire would need a subscriber-less trigger — new machinery for a few frames).
- **Denied-expiry relaunch is a dead end BY DESIGN of 4-5's config-first order** (disk already says `activeTimer: null`, over-block direction). The honest recovery paths are the drift banner's Restore (unblocks timer-only domains, keeps always-on) or Panic. Fixing it properly would need a persisted "hosts last written with activeTimer" marker — out of scope; noted for Epic 5/6 if a launch-time drift surface is ever wanted.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` — no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/launchReArm.test.tsx __tests__/store.test.ts __tests__/StatusHeader.test.tsx __tests__/timerStore.test.ts` — new + affected suites green.
- `node_modules/.bin/jest --watchman=false` — full suite green: 558 tests / 28 suites / 3 snapshots (recorded actual result, 08-28; no regressions).

**Manual checks:**
- Start a 1-min session, quit the app, confirm `/etc/hosts` still lists the timer domains while closed, relaunch after expiry → badge Free, count drops, hosts rewritten (View hosts shows always-on only).
- Relaunch while a 25-min session is still live → countdown resumes from the correct remaining time (note: ring starts full — documented defer).

## Suggested Review Order

**The launch seam (entry point — the disk-seeding helper everything hangs off)**

- `launchFromDisk` is the whole story: seed `readConfig` with a persisted `config.json`, then require a FRESH store + header inside `jest.isolateModules` — module eval runs `committed: readConfig()` for real.
  [`launchReArm.test.tsx:196`](../../__tests__/launchReArm.test.tsx#L196)

- The two registry facts the seam relies on (shared mock instances; the react pin that prevents "Invalid hook call").
  [`launchReArm.test.tsx:58`](../../__tests__/launchReArm.test.tsx#L58)

**Resume branch + anti-cheat**

- The frozen matrix's resume row: countdown resumes from disk, ticks, and — the anti-cheat pin — ZERO `writeConfig`/`writeHosts`/`readHostsSection` calls plus a null toast before any user action.
  [`launchReArm.test.tsx:360`](../../__tests__/launchReArm.test.tsx#L360)

- The launch trigger itself is unchanged production code: the always-mounted header's layout effect starting the slice (read-only context for the tests above).
  [`StatusHeader.tsx:147`](../../src/components/StatusHeader.tsx#L147)

**Expired branch — the real 4.5 shape through the real mount chain**

- Config write (`activeTimer: null`) BEFORE hosts write via `invocationCallOrder`; committed cleared; toast; badge reverts to Free.
  [`launchReArm.test.tsx:429`](../../__tests__/launchReArm.test.tsx#L429)

- Also-always-on: the payload keeps the always-on line, drops the timer-only domain (union precedence, no removal code path).
  [`launchReArm.test.tsx:488`](../../__tests__/launchReArm.test.tsx#L488)

- Equality boundary (review patch P2): `endEpochMs === now` must take the EXPIRED branch — pins the `>=` in `sliceExpiredParked`, the off-by-one this story exists to catch.
  [`launchReArm.test.tsx:521`](../../__tests__/launchReArm.test.tsx#L521)

**Malformed end — fail-safe, both variants**

- The string variant: normalisation → null, no slice start, no write, Start still available on the Timer surface.
  [`launchReArm.test.tsx:565`](../../__tests__/launchReArm.test.tsx#L565)

- The null variant (review patch P1): a persisted NaN serialises to null through the real JSON seam — the JSON-realistic malformed case, same fail-safe shape.
  [`launchReArm.test.tsx:621`](../../__tests__/launchReArm.test.tsx#L621)

**Denied-expiry relaunch — documented dead end**

- Disk already says `activeTimer: null` after a denied expiry, so no re-arm is possible; `expireTimer` no-ops `not-expired`, zero writes. Corrects spec-4-5's stale matrix wording (see Change Log).
  [`launchReArm.test.tsx:665`](../../__tests__/launchReArm.test.tsx#L665)

- The escape surface this test documents (read-only): drift banner + Restore on viewer mount — already covered by HostsViewer's own suite.
  [`HostsViewer.tsx:75`](../../src/components/HostsViewer.tsx#L75)

**Peripherals**

- The Change Log entry recording the spec-4-5 correction (relaunch after denied expiry CANNOT re-arm).
  [`spec-4-7-...md:78`](../../_bmad-output/implementation-artifacts/spec-4-7-closed-mid-session-persistence-and-re-arm-on-launch.md#L78)

- sprint-status flip `4-7` → `review`; the `done` + `epic-4: done` flips ride the story commit.
  [`sprint-status.yaml:72`](../../_bmad-output/implementation-artifacts/sprint-status.yaml#L72)