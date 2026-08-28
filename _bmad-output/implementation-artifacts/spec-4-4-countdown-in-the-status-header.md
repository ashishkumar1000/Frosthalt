---
title: 'Countdown in the status header (Story 4.4)'
type: 'feature'
created: '2026-08-28'
status: 'done'
baseline_commit: '112c37644cc2c5fa257ea0e7f91438a5613cbe20'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The status header still shows the static "no active timer" placeholder and a permanently "Free" badge while a focus session is running — the live countdown (4.3) is visible only on the Timer surface, so the user loses all session awareness the moment they navigate away.

**Approach:** Make `StatusHeader` the scoped timer slice's second subscriber (the always-mounted one): while `committed.activeTimer` is live the header reads `[Blocked badge] · N domains · mm:ss · [16×16 mini ring] · View hosts` (UX-DR3/DR5); with no session it renders the unchanged Epic-2 form. No new driver, no new store code beyond shared derived helpers — the 4.3 slice's refcount already supports co-subscribers.

## Boundaries & Constraints

**Always:**
- The countdown derives ONLY from the existing `useTimerStore` slice (`selectRemainingMs` + `totalMs`) via the same `useLayoutEffect` start/stop lifecycle pattern Timer.tsx uses — one `setInterval(1000)` total, refcount-shared.
- `activeEndEpochMs` normalisation mirrors Timer.tsx exactly (`!= null && Number.isFinite`), so the header, the Timer surface and the slice can never disagree about whether a session is live.
- Per-tick re-renders stay confined to `StatusHeader` — Shell, Blocklist, Settings, Schedule, Sidebar must never subscribe to the slice.
- Token indirection stays mandatory (`tokens.*`); the numeral keeps `fontVariant: ['tabular-nums']`; the ring's colours are `tokens.status.blocked` (track) + `tokens.primary` (arc) — same as the Timer surface ring (UX-DR5).
- The header's existing count-announce behaviour (`StatusHeader.tsx:63-72`) is preserved untouched.

**Ask First:**
- Any change to the slice's state shape or driver semantics (state fields, interval behaviour, refcount model).
- Any per-minute VoiceOver announce emitted from the header (see Design Notes — the plan is that the header announces NOTHING per-minute; if review shows a hard a11y requirement for it, HALT and ask).

**Never:**
- No expiry handling — an expired session holds `Blocked · 00:00` exactly like the Timer surface does; Story 4.5 owns clearing `activeTimer`, 4.7 owns launch re-arm.
- No per-tick or per-minute announces from the header; no `accessibilityLiveRegion` on macOS (no-op).
- No menu-bar work (6.2), no End-early changes (4.6), no new dependencies, no raw hex colours, no changes to `effectiveBlocklist` or the count derivation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path — no session | `committed.activeTimer == null` | Epic-2 form verbatim: `Free` badge · `N domains` · `no active timer` · `View hosts`; slice NOT started by the header | N/A |
| Happy path — session live | `activeTimer.endEpochMs` finite, `> Date.now()` | `Blocked` badge · `N domains` · tabular `mm:ss` · 16×16 ring (blocked track / primary arc) · `View hosts`; numeral decrements each second | N/A |
| Malformed end time | `activeTimer.endEpochMs` non-finite (NaN/string) | Header renders the NO-SESSION form (normalisation gates it out) — never `NaN:NaN` | Normalised to `null` before any slice call |
| Expired at mount | finite `endEpochMs <= Date.now()` | `Blocked` badge + `00:00` + empty ring; slice parks immediately (no tick loop); header re-renders once, not per-second | 4.5 owns the unblock |
| Session ends | `activeTimer` cleared (4.5/4.6) | Header reverts to the Epic-2 form; the header's `stop()` releases its refcount | N/A |
| Co-subscriber | Timer (Blocked) + header both mounted | ONE driver (refcount 2); unmounting Timer keeps the header counting | Refcount, already built in 4.3 |

</frozen-after-approval>

## Code Map

- `src/components/StatusHeader.tsx` (120 lines) — THE EDIT TARGET. `committed` read `:53`, effective count + label `:54-55`; on-change count announce `:63-72` (KEEP untouched); JSX `:74-90` — hardcoded `<StatusBadge status="free"/>` `:76`, the static `no active timer` text `:80`; styles `:93-121` (`.count` already carries `tabular-nums` `:107-113`).
- `src/domain/timerStore.ts` (159 lines) — additive only: export a shared `selectProgress(s)` (same math as Timer.tsx:173-179: `total <= 0 → 0`, else `1 - selectRemainingMs/total`, clamped) and a shared `formatMmSs(remainingMs)` (zero-padded `mm:ss`; minutes may exceed 99 — a 24 h session renders `1440:00`, same as the Timer surface numeral, frozen-spec-conformant). NO changes to state shape, `start`/`stop`, driver, or refcount.
- `src/components/Timer.tsx` (714 lines) — PATTERN SOURCE + tiny refactor: normalisation `:199-204` (`rawEndEpochMs` → `activeEndEpochMs` → `hasActiveTimer`), slice lifecycle `useLayoutEffect` `:323-331` (keyed on `activeEndEpochMs`; `start` on mount, `stop` on cleanup), local `selectProgress` `:173-179` and inline mm:ss math `:209-213` — both replaced by imports from the slice (behaviour-identical, single derivation source).
- `src/components/CountdownRing.tsx` (125 lines, READ-ONLY) — its own doc comments `:47-49` already reserve the 4.4 usage: `size={16} strokeWidth={1.5}`; a11y-hidden internally; degenerate-radius clamp already covers the 16 px geometry (`r = 7.25`).
- `src/components/StatusBadge.tsx` (58 lines, READ-ONLY) — `blocked` already exists in `STATUS_LABELS` ("Blocked", `statusFill('blocked')` = systemRed); the header only needs to pass the right `status` prop.
- `src/components/Shell.tsx:238` — renders `<StatusHeader onViewHosts/>` above ALL surfaces; the header is always mounted, which is exactly why it (not the Shell) owns the slice lifecycle — the driver stays alive across surface navigation.
- `__tests__/Shell.test.tsx:461,495` — existing assertions that the header shows `no active timer`; their seeds carry no `activeTimer`, so they must stay green unmodified (the no-session form is preserved).
- `__tests__/Timer.test.tsx` — test-convention reference: per-file native-spec mocks `:43-52`, `seedState` `:180-203`, afterEach slice reset (`stop()` + `setState` wipe) `:207-223`, ApplyButton mock `:56-80`.
- `__tests__/StatusHeader.test.tsx` (NEW) — follows the Timer.test.tsx conventions exactly (real stores, per-file native mocks, fake timers where a tick is asserted).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/timerStore.ts` — export `selectProgress` and `formatMmSs` (pure functions, moved from Timer.tsx's local math; doc comments noting 4.4 as the second consumer) — one derivation shared by every countdown consumer.
- [x] `src/components/Timer.tsx` — swap the local `selectProgress` (:173-179) and inline mm:ss math (:209-213) for the slice exports; delete the now-dead local code. No behaviour change.
- [x] `src/components/StatusHeader.tsx` — subscribe to `useTimerStore` (`selectRemainingMs`, `selectProgress`); add the Timer.tsx normalisation (`activeEndEpochMs`/`hasActiveTimer`); add the `useLayoutEffect` start/stop lifecycle keyed on `activeEndEpochMs`; in the live branch render `Blocked` badge + `mm:ss` numeral (`formatMmSs(selectRemainingMs(s))`, tabular-nums, `accessibilityLabel="Time remaining"`) + `<CountdownRing size={16} strokeWidth={1.5} .../>` in place of the `no active timer` text; inactive branch keeps the Epic-2 JSX byte-for-byte.
- [x] `__tests__/StatusHeader.test.tsx` (NEW) — the full I/O matrix: no-session Epic-2 form; live session renders Blocked + mm:ss + ring and decrements after one fake tick; malformed end → no-session form; expired-at-mount → `00:00` + empty ring + no tick loop; session cleared → Epic-2 form returns; co-subscriber (render Timer Blocked + header together, unmount Timer, header keeps counting); numeral a11y label; no per-minute announce from the header.
- [x] `__tests__/Shell.test.tsx` (APPEND) — one integration test: seed a live `activeTimer`, render the Shell, assert the header row shows the `Blocked` badge label + a `mm:ss` countdown (the existing no-session assertions at `:461/:495` stay untouched and green).

**Acceptance Criteria:**
- Given no active session, when any surface renders, then the header is visually and semantically identical to its Epic-2 form and the slice is NOT started by the header (refcount 0 when Timer is unmounted).
- Given a live session, when the header is visible on ANY surface, then it shows the `Blocked` badge, a tabular `mm:ss` numeral and the 16×16 ring, all derived from the same slice state — and each second tick re-renders ONLY the header subtree (Shell and surface trees are not slice subscribers).
- Given the user navigates Timer → Blocklist mid-session, when Timer unmounts, then the countdown in the header keeps ticking (refcount drops to 1, driver stays alive) — the 4.3 "interval stays alive across surface navigation" AC becomes real.
- Given `activeTimer.endEpochMs` is non-finite, when the header renders, then it shows the no-session form and the slice never receives the malformed value.
- Given the session expired before mount, when the header renders, then it shows `Blocked · 00:00` with an empty ring and the slice parks (no interval).
- Given `activeTimer` is cleared, when the header re-renders, then it returns to the Epic-2 form and its `stop()` releases the refcount.
- Given VoiceOver, when the user focuses the header countdown, then the numeral announces its time via `accessibilityLabel`; the header emits NO announce on ticks or minute rollovers (the Timer surface owns those, UX-DR17).

## Spec Change Log

- **Step-04 review (no loopback; `review_loop_iteration` stayed 0):** 24 findings triaged — 9 patches applied, 6 deferred (see `deferred-work.md`), 9 rejected with reasoning. Patches: (1) header numeral a11y label now EMBEDS the live value (`Time remaining mm:ss`) — a bare label replaces the text content for VoiceOver, failing the "numeral announces its time" AC; (2) `formatMmSs` non-finite guard (`NaN`/`Infinity` → `00:00`) + direct unit tests for `formatMmSs`/`selectProgress`; (3) stale Timer.tsx 4.3-ownership comments corrected (header owns the lifecycle; Timer is a co-subscriber) + relaunch `totalMs` quirk documented; (4) `jest.restoreAllMocks()` in Shell.test afterEach; (5) Shell integration test asserts the badge via its `Status: Blocked` a11y label; (6) NEW source-subscriber guard test pinning "Shell and surface trees are not slice subscribers"; (7) NEW live→expiry-while-mounted test (self-park, `00:00` holds, badge stays Blocked); (8) `useMemo` on `committed` for the count (no per-tick `effectiveBlocklist` walk). Post-patch: 513 tests / 27 suites green, tsc clean.

## Design Notes

- **Why the header owns the slice lifecycle (not Shell):** the header is the one component that is mounted on every surface for the app's whole life. Putting `start`/`stop` there makes the slice's "always alive while a session runs" property fall out of the existing refcount with zero new store code — and it is the exact pattern 6.2's menu-bar subscriber will reuse.
- **Badge semantics:** the badge flips to `Blocked` for the duration of a live session per UX-DR3, sourced from `committed.activeTimer` — the same applied-state source as the `N domains` count, so badge and count can never disagree (both move only on Apply success).
- **No header announces (deliberate):** Timer.tsx already announces mount + per-minute rollover while the Timer surface is mounted (UX-DR17). A header-side announce would double up on the Timer surface and be noisy everywhere else; the header numeral is a passive readout that VoiceOver reads on focus via its accessibility label. `accessibilityLiveRegion` is skipped — Android-only, no-op on macOS (established in 4.3).
- **`formatMmSs` placement:** in the slice file next to `selectRemainingMs` so stroke + numeral + ring stay single-derivation (the 4.3 "single source of truth" design note) — the header and the Timer surface can never render different times from the same tick.
- **Ring at 16 px:** `r = (16 − 1.5)/2 = 7.25`, well inside CountdownRing's existing clamps; the conditional-arc guard (no zero-length round-cap dot) already covers the `progress → 0` expiry case.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/StatusHeader.test.tsx __tests__/Shell.test.tsx __tests__/Timer.test.tsx __tests__/timerStore.test.ts __tests__/CountdownRing.test.tsx` -- new + affected suites green.
- `node_modules/.bin/jest --watchman=false` -- full suite stays green (no regressions to the existing 487 tests).

**Manual checks:**
- Start a 25-min session, navigate to Blocklist — the header shows `Blocked · N domains · mm:ss` with the shrinking mini ring while the Timer surface is unmounted; Blocklist rows do not re-render per tick.
- Let a 1-min session expire on the Blocklist surface — header holds `Blocked · 00:00` (4.5 will own the flip back).
- With no session running — header reads exactly as before this story (Free badge, `no active timer`).
## Suggested Review Order

**Shared derivation (the slice exports)**

- Single derivation source — every countdown consumer reads the same pair, can never desync.
  [`timerStore.ts:87`](../../src/domain/timerStore.ts#L87)

- Shared `mm:ss` formatter; non-finite guard added in review (never `NaN:NaN`).
  [`timerStore.ts:105`](../../src/domain/timerStore.ts#L105)

- Refcounted lifecycle unchanged since 4.3 — the header is just a second subscriber.
  [`timerStore.ts:137`](../../src/domain/timerStore.ts#L137)

**Header: slice lifecycle (the design intent)**

- Entry point: the always-mounted header OWNS start/stop, keyed on the normalised end.
  [`StatusHeader.tsx:147`](../../src/components/StatusHeader.tsx#L147)

- Normalisation mirrors Timer.tsx exactly — header, Timer surface and slice can never disagree.
  [`StatusHeader.tsx:129`](../../src/components/StatusHeader.tsx#L129)

- Relaunch quirk documented here: resumed session captures `totalMs` as remaining-only (4.7 owns re-arm).
  [`StatusHeader.tsx:72`](../../src/components/StatusHeader.tsx#L72)

**Header: the live form (UX-DR3/DR5)**

- Badge flips free/blocked from the same applied state as the count.
  [`StatusHeader.tsx:177`](../../src/components/StatusHeader.tsx#L177)

- Numeral a11y label embeds the live value (review patch 1 — a bare label replaces the text for VoiceOver).
  [`StatusHeader.tsx:189`](../../src/components/StatusHeader.tsx#L189)

- 16×16 mini ring, blocked track + primary arc (UX-DR5); a11y-hidden internally.
  [`StatusHeader.tsx:198`](../../src/components/StatusHeader.tsx#L198)

**Header: per-tick cost**

- Count memoised on `committed` — no `effectiveBlocklist` walk on each of the 3600 ticks/hour.
  [`StatusHeader.tsx:111`](../../src/components/StatusHeader.tsx#L111)

**Timer surface (pattern source + co-subscriber)**

- Comments corrected: co-subscriber since 4.4, header owns the lifecycle (review patch 3).
  [`Timer.tsx:26`](../../src/components/Timer.tsx#L26)

**Tests — I/O matrix**

- The full I/O matrix (13 tests) incl. malformed, expired-at-mount, co-subscriber, no-announce.
  [`StatusHeader.test.tsx:184`](../../__tests__/StatusHeader.test.tsx#L184)

- Live→expiry-while-mounted: driver self-parks, numeral holds 00:00, badge stays Blocked (review patch 7).
  [`StatusHeader.test.tsx:632`](../../__tests__/StatusHeader.test.tsx#L632)

- Source-subscriber guard: only StatusHeader/Timer/timerStore may import the slice (review patch 6).
  [`StatusHeader.test.tsx:688`](../../__tests__/StatusHeader.test.tsx#L688)

**Tests — integration + units**

- Shell-level wiring: badge element asserted by a11y label, mm:ss from the real slice (review patch 5).
  [`Shell.test.tsx:1797`](../../__tests__/Shell.test.tsx#L1797)

- Direct unit tests for the shared helpers (review patch 2).
  [`timerStore.test.ts:267`](../../__tests__/timerStore.test.ts#L267)

- afterEach now restores mocks — no spy leak across tests (review patch 4).
  [`Shell.test.tsx:127`](../../__tests__/Shell.test.tsx#L127)
