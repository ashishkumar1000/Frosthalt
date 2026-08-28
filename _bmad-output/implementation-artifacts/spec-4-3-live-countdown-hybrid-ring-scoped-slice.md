---
title: 'Live countdown (hybrid ring + scoped slice)'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 1
baseline_commit: 8ea3bdedf67a520b4ebee501e1d318a999617757
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-2-start-focus-session-block-and-persist-epoch-end-time.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-4-1-timer-surface-with-duration-presets-and-domain-selection.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 4.2 persists `activeTimer: { endEpochMs, selectedDomains }`, but no UI shows the user it is running. `Timer.tsx:325-345` is a defensive placeholder ("Timer running. Switch to Blocklist to see the countdown.") that 4.3 must replace. Stories 4.4 (status-header countdown), 4.5 (auto-unblock on expiry), 4.6 (end-early password-gated), 4.7 (re-arm on launch) all need a live countdown source. No countdown = no Epic 4 user value.

**Approach:** Build a NEW scoped Zustand slice (`useTimerStore`) holding `nowMs` + `endEpochMs`, driven by a single `setInterval(1000)` started on `activeTimer` mount and stopped on unmount. Add a `CountdownRing` SVG component (status-blocked track + primary remaining arc via `stroke-dasharray`) at 64×64 for the Timer surface, plus a tabular-numeral `mm:ss` numeral rendered next to it. Replace the Timer placeholder with full Blocked UI: ring + numeral + "Locked until HH:mm" + destructive `End early` button + hint line. End-early is wired through `requirePassword` (same Epic 3 gate as Panic / Change-password — 4.6 owns the actual config-clearing run; 4.3 only wires the UI + gate call so the button is functional-but-deferred to 4.6 for the privileged write). Slice subscription is selector-scoped so unrelated surfaces don't re-render every tick.

## Boundaries & Constraints

**Always:**
- New store `src/domain/timerStore.ts` using `zustand/create` with state `{ nowMs: number; endEpochMs: number | null }`. Driver is a module-level `setInterval(1000)` that updates `nowMs`; started when `endEpochMs` transitions from `null` → number, cleared when it transitions back to `null` (or when `nowMs >= endEpochMs` and the slice parks itself). Reused by 4.4 (status header) and 6.2 (menu bar) — shaped for three subscribers from 4.3 onward.
- Selector-scoped subscription: `Timer.tsx`'s Blocked path subscribes via `useTimerStore((s) => Math.max(0, (s.endEpochMs ?? 0) - s.nowMs))` (the single derived value the surface needs). `effectiveBlocklist`/`applyStatus`/etc. do NOT subscribe to `nowMs`.
- `CountdownRing` (`src/components/CountdownRing.tsx`, NEW) is a presentational SVG: `size`, `strokeWidth`, `trackColor`, `remainingColor`, `progress` (`0..1`, `1 - remaining/total`) props. `progress === 1` = full ring remaining; `progress === 0` = empty. Two stacked `<circle>` elements (both `fill="none"`): the **track** (full circle, `trackColor`) and the **remaining arc** (`remainingColor`). The arc uses `stroke-dasharray={`${C * progress} ${C}`}` (the dash+gap pattern, NOT `stroke-dashoffset`) — this lets the per-tick update rewrite a single string value via a plain React re-render with no `Animated`/Reanimated worklet overhead. `strokeLinecap="round"` on the arc for the soft-cap premium feel. Rotation `-90deg` at `originX={size/2, size/2}` so the arc starts at 12 o'clock and shrinks clockwise (the universally-recognised countdown direction). Radius is `r = (size - strokeWidth) / 2` (inset the stroke so the bounding box matches `size`). Circumference `C = 2 * Math.PI * r` is pre-computed OUTSIDE the JSX so React does not recompute it on every render. `accessibilityElementsHidden` + `importantForAccessibility="no"` so VoiceOver does not announce the SVG itself (the numeral carries the announce).
- `Timer.tsx` Blocked path replaces the defensive placeholder at `:325-345`. Renders a premium hybrid layout: small uppercase status label "FOCUS SESSION" (`tokens.typography.label`, letter-spaced, secondary colour) → flex-row with `<CountdownRing size={64} strokeWidth={4} trackColor={tokens.status.blocked} remainingColor={tokens.primary} progress={...}/>` on the left and `<Text style={tokens.typography.countdown}>{mm}:{ss}</Text>` (tabular numerals, fontSize 28, weight 600) on the right → "Locked until HH:mm" subtitle (`tokens.typography.body`, secondary) → `End early` destructive `Pressable` (NOT default; never bound to Return; outlined destructive, never primary-filled) → hint line "End early needs your password. Timer ends automatically at HH:mm."
- `mm:ss` derivation: `Math.floor(remainingSec / 60)` minutes, `remainingSec % 60` seconds, both zero-padded to 2 digits. Zero-pad via `(n).toString().padStart(2, '0')`.
- "Locked until HH:mm": `new Date(endEpochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })` — local time, deterministic. "Timer ends automatically at HH:mm" reuses the same derivation.
- `End early` button calls `requirePassword(() => { /* deferred to 4.6 */ })` — for 4.3 the action body is a no-op (4.6 owns the actual config-clearing + hosts write). The wiring IS the deliverable; the body stays minimal so 4.3 stays a UI + slice story, not a config-write story.
- Slice start/stop is driven by the Timer surface itself: on mount when `committed.activeTimer != null`, call `useTimerStore.getState().start(endEpochMs)` (NEW action). On unmount, call `useTimerStore.getState().stop()` ONLY IF no other subscriber is active (use a refcount). On the activeTimer transition to null (4.5 expiry / 4.6 end-early / 4.7 launch re-arm), the slice's `start` action parks `nowMs` and the per-second driver clears. Defensive: if `start` is called with `endEpochMs <= Date.now()`, the slice parks immediately (no zero-second ring).
- Mount announce on Blocked entry: `"Timer running, ${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'} remaining"` spoken via `AccessibilityInfo.announceForAccessibility` on a `useEffect` keyed on `hasActiveTimer` becoming true (single-fire per transition). The per-minute rollover (UX-DR17) uses `accessibilityLiveRegion="polite"` on the numeral.
- Tabular-numeral pattern for the countdown: reuse `tokens.typography.countdown` (already `fontVariant: ['tabular-nums']` at `tokens.ts:115-121`).
- 4.3 stays STRICTLY scoped to: Timer surface Blocked UI + scoped timer slice + `CountdownRing` SVG + the gate-wiring scaffold. NO config-clearing on End-early (4.6), NO status-header countdown (4.4), NO auto-unblock on expiry (4.5), NO launch re-arm (4.7).

**Ask First:**
- Wiring `End early` directly to a config-clearing action in 4.3 (no — 4.6 owns the actual privileged write; 4.3 wires the UI + gate scaffold only).
- Adding a toast primitive for expiry/end-early (no — `AccessibilityInfo.announceForAccessibility` cue carries it; Epic 5 owns the toast primitive).
- Persisting `nowMs` (no — wall-clock is the source of truth; `Date.now() - endEpochMs` is the only state that matters).
- Changing the existing 4.1 picker / 4.2 stageStartTimer paths (no — read-only on `Timer.tsx:107-322`).

**Never:**
- Render the Free-state path when `committed.activeTimer != null` (the Blocked path is the only path the running timer sees — the picker / presets / checkboxes / Start are all hidden).
- Re-render the Blocklist / Settings / Schedule / Sidebar surfaces on every `nowMs` tick — selector-scoped subscription is mandatory.
- Persist anything to `config.json` from this story (4.3 has zero new persistent state; the slice is runtime-only, mirroring the Epic 3 gate-state model).
- Import `child_process`/`fs`/`os` in `src/` (AD-11 / AR-13).
- Use raw hex tokens; every colour goes through `tokens.*`.
- Touch `Blocklist`, `HostsViewer`, `Settings`, `Panic`, `Shell`, `Sidebar`, `StatusHeader` (their own stories).
- Build the status-header mini ring (4.4), the menu-bar mirror (6.2), the auto-unblock on expiry (4.5), or the launch re-arm (4.7).
- Route End-early through `PasswordGate` directly (the gate is a Shell singleton; the canonical path is `requirePassword(action)` — the same Panic uses).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Timer mounts, session running | `committed.activeTimer != null`, `endEpochMs > Date.now()` | Blocked UI replaces placeholder; ring shows progress; numeral shows `mm:ss`; `Locked until HH:mm` set; End early wired to `requirePassword(no-op)`; mount announce "Timer running, N minutes M seconds remaining" | N/A |
| Timer mounts, session just expired | `committed.activeTimer != null`, `endEpochMs <= Date.now()` | Numeral shows `00:00`; ring shows empty; UI still renders Blocked (expiry is 4.5's job — 4.3 cannot trigger it); the slice parks `nowMs` and clears the interval | N/A |
| Timer mounts, no session | `committed.activeTimer == null` | Free-state path renders (unchanged from 4.1/4.2); slice never started | N/A |
| Per-second tick | `setInterval(1000)` fires; `nowMs` updates | ONLY consumers of the `remainingMs` selector re-render (Timer Blocked + future 4.4 + future 6.2); Blocklist / Settings / Schedule / Sidebar / Shell do NOT re-render | N/A |
| Last second of session | `nowMs + 1000 >= endEpochMs` | Numeral counts down to `00:00`; ring shrinks to empty; 4.3 does NOT auto-unblock — slice parks, surfaces show `00:00` until 4.5 expiry path runs | N/A |
| End early click, no password set | `passwordHash == null` | `requirePassword` short-circuits (3.2 no-op); 4.3's no-op body runs immediately; announce "End-early wired in 4.6" placeholder cue so the user sees the click registered | N/A |
| End early click, password set, wrong entry | `requirePassword` opens gate; 5 wrong tries | Gate throttles 30s per 3.2; surface unchanged; no hosts-write fires | 3.2 gate handles |
| End early click, password set, correct | `requirePassword` verifies; gate closes; 4.3's no-op body runs; announce "End-early wired in 4.6 — actual end will land in Story 4.6" | N/A |
| Slice started twice (defensive) | `start(endEpochMs)` called while already running | Idempotent: the existing interval clears and a new one starts with the new `endEpochMs`; no double-driver | N/A |
| Slice stopped with no subscribers | `stop()` called when refcount === 0 | Interval clears; `nowMs` parks at `Date.now()` | N/A |
| Tab away mid-session | `surface !== 1`; Timer unmounts | Slice stops ONLY if no other subscriber; the slice is shared — 4.4 will keep it alive from the header; for 4.3 alone (no 4.4 yet) the slice parks on Timer unmount; ring pauses | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/timerStore.ts` (NEW) — scoped Zustand slice `{ nowMs: number; endEpochMs: number | null }` + actions `start(endEpochMs: number)` (idempotent; clears any existing interval; starts `setInterval(1000)` that updates `nowMs`; if `endEpochMs <= Date.now()` parks immediately and clears interval) + `stop()` (decrements internal refcount; interval clears when refcount hits 0). Selector `selectRemainingMs = (s) => Math.max(0, (s.endEpochMs ?? 0) - s.nowMs)` for the consumer-side derived value. Refcount pattern keeps 4.3 (Timer) + 4.4 (status header) + 6.2 (menu bar) coexisting without double-driver. Verified: `src/domain/` currently holds only apply/drift/effectiveBlocklist/normalise/stagedChangeCount/store — no timerStore.
- `src/domain/store.ts` (807 lines, READ-ONLY this story) — `DomainState` interface at `:92-285`; `stageStartTimer` declared `:194` (doc comment at `:182` notes it deliberately does NOT route through requirePassword — 4.3's End-early is the first gated timer path), impl `:549`; `requirePassword` declared `:258`, impl `:655-667` — short-circuit `if (hash == null || hash === '') { action(); return; }`, else `set({ gateOpen: true, gateAction: action })`.
- `src/components/Timer.tsx` (465 lines) — render structure: component logic `:107-322` (store reads `:109-111` = `committed` / `applyStatus` / `stageStartTimer` via useDomainStore selectors; mount-announce `useEffect` at `:214-217` currently fires `'Timer, free'` unconditionally); **Blocked placeholder `:324-345`** (`RUNNING_PLACEHOLDER_TEXT` declared `:72-73`, rendered `:329`, + "Open Blocklist" Pressable CTA `:330-342`) — THIS is what 4.3 replaces; empty path `:347-368`; Free-state JSX `:370-465` (READ-ONLY — picker/presets/checkboxes/Start). The Blocked branch already sits FIRST in the render order, before empty/Free.
- `src/components/CountdownRing.tsx` (NEW) — pure presentational SVG via **react-native-svg** (`Svg`, `G`, `Circle`). Props: `size: number` (default 64), `strokeWidth: number` (default 4), `trackColor: PlatformColorOutput`, `remainingColor: PlatformColorOutput`, `progress: number` (`0..1`). Module-scope (or `useMemo`) pre-compute `r = (size - strokeWidth) / 2` and `C = 2 * Math.PI * r`. Renders two stacked `<circle>` elements (`fill="none"`): the track is a full circle, the remaining arc uses `strokeDasharray={`${C * progress} ${C}`}` (dash+gap pattern, no worklet). Both circles share `cx={size/2} cy={size/2} r={r}`. The remaining arc carries `strokeLinecap="round"`. Rotation wrapper: `<G rotation={-90} originX={size/2} originY={size/2}>` around BOTH circles. `accessibilityElementsHidden` + `importantForAccessibility="no"` on the SVG so VoiceOver does not announce the SVG itself (the numeral carries the announce).
- **NEW DEPENDENCY (required by the frozen SVG intent): `react-native-svg`.** Verified ABSENT from package.json — the project has zero SVG primitives today (HostsViewer is Text/ScrollView). react-native-svg officially supports macOS via Fabric (this app is New Architecture — story 1-1), recent versions support RN 0.78+ (0.81 included), and its podspec auto-detects the RN minor version. Install: `pnpm add react-native-svg` then `cd macos && pod install` (if the glog header-staging failure reappears, apply the fix recorded in memory). This is flagged at CHECKPOINT 1 — it is the only new dependency this story adds.
- `src/components/Shell.tsx:292` (`<PasswordGate onVerified={runGateAction} onClose={closeGate}/>`; `runGateAction` at `:209`) — READ-ONLY. End-early routes through the existing `requirePassword` Shell wires.
- **requirePassword access pattern** — surfaces call it lazily via `useDomainStore.getState().requirePassword(() => ...)`, NOT via subscribed selector (confirmed in `Panic.tsx` and `ChangePassword.tsx:121`). 4.3's End-early onPress mirrors this.
- `src/theme/tokens.ts` — `typography.countdown` at `:115-121` (fontFamily -apple-system, fontSize 28, weight 600, lineHeight 28, `fontVariant: ['tabular-nums']`) reused for the numeral. `tokens.primary` at `:86` = `PlatformColor('controlAccentColor')`; `tokens.status.blocked` at `:90` = `PlatformColor('systemRedColor')` (the `statusColorNames` map at `:32` is the Jest-assertable plain-string source of truth); both are PlatformColor objects, accepted directly by react-native-svg stroke props? — NO: **PlatformColor is not guaranteed in SVG stroke props; if react-native-svg rejects it, resolve via `PlatformColor` → hex mapping from `statusColorNames`/theme. Decide at implementation; the token indirection (`tokens.*`) stays mandatory either way.** `typography.body` at `:97-102` (13/400/19), `typography.label` at `:103-108` (11/500/14) — NOTE: **no letterSpacing on either token**, so the frozen "letter-spaced" FOCUS SESSION label is a local `letterSpacing` style in Timer.tsx (tokens untouched).
- `src/config/types.ts:48-53` (`ActiveTimer`) — READ-ONLY. `endEpochMs: number` at `:50`, `selectedDomains: string[]` at `:52` is the slice's mirror source.
- `__tests__/timerStore.test.ts` (NEW) — `start`/`stop` refcount + idempotent start + immediate park on expired `endEpochMs` + per-tick `nowMs` advance; no test for React rendering.
- `__tests__/CountdownRing.test.tsx` (NEW) — snapshot-test the SVG structure for progress=0/0.5/1; assert the `stroke-dasharray` value matches the math; assert both `<circle>` elements have `fill="none"`.
- `__tests__/Timer.test.tsx` (EXISTS, 654 lines — append, do not create) — Blocked-state tests appended. Existing conventions to follow: no shared setup file (`jest/` dir empty; `jest.config.js` = preset react-native + pnpm transformIgnorePatterns); per-file mocks of `NativeConfigStoreSpec`/`NativeShellRunnerSpec` so `readConfig()` falls back to DEFAULT_CONFIG; the REAL Zustand store with `seedState`/`REAL_*` restore so jest.fn wrappers never leak; `AccessibilityInfo.announceForAccessibility` cast to `jest.Mock` directly; fake timers per-test; `../src/components/ApplyButton` mocked at `:62`.
- `__tests__/Panic.test.tsx` — gate-wiring pattern reference (no-password short-circuit asserted at ~`:1084`; "stash then run" gate pattern: trigger click → `gateOpen: true` + action stashed → test runs the stashed action + `closeGate`).

## Tasks & Acceptance

**Execution:**
- [x] `package.json` + macos pods -- `pnpm add react-native-svg`, then `cd macos && pod install` (apply the glog header-staging fix from memory if the failure reappears); confirm the macOS app still builds -- the ONLY new dependency this story adds, required by the frozen SVG intent.
- [x] `src/domain/timerStore.ts` -- create Zustand slice `{ nowMs: number; endEpochMs: number | null }` + `start(endEpochMs)` (idempotent; clears existing interval; `setInterval(1000)` updates `nowMs`; if `endEpochMs <= Date.now()` parks immediately and clears interval) + `stop()` (refcount decrement; clears interval at 0) + exported selector `selectRemainingMs` -- the scoped countdown source for Timer (4.3) + status header (4.4) + menu bar (6.2).
- [x] `src/components/CountdownRing.tsx` -- pure SVG component: `size`, `strokeWidth`, `trackColor`, `remainingColor`, `progress` props; pre-compute `r = (size - strokeWidth) / 2` and `C = 2π*r` once (useMemo); two stacked `<circle>` (track + remaining arc) inside a `<G rotation={-90} originX={size/2} originY={size/2}>` wrapper, both `fill="none"`; remaining arc uses `strokeDasharray={`${C * progress} ${C}`}` (dash+gap, not dashoffset) + `strokeLinecap="round"`; `accessibilityElementsHidden` + `importantForAccessibility="no"` -- the visual countdown primitive.
- [x] `__tests__/timerStore.test.ts` -- refcount + idempotent start + immediate park + tick advance + `stop()` at 0 clears; no React -- pins the slice contract for downstream consumers (4.4, 6.2 will rely on the same shape).
- [x] `__tests__/CountdownRing.test.tsx` -- snapshot the SVG for progress=0/0.5/1; assert `stroke-dasharray` math uses the dash+gap pattern (`${C*p} ${C}`, NOT a dashoffset); assert both circles `fill="none"`; assert the `<G>` wrapper carries `rotation={-90}` + `originX={size/2}` + `originY={size/2}`; assert a11y-hidden attribute; assert `strokeLinecap="round"` on the remaining arc -- pins the visual primitive ahead of UI consumers.
- [x] `src/components/Timer.tsx:109-111` -- extend store reads: add `committed.activeTimer?.endEpochMs` (for the slice mirror), `requirePassword`; keep `stageStartTimer`, `committed`, `applyStatus` reads -- Timer subscribes to the slice.
- [x] `src/components/Timer.tsx:324-345` -- REPLACE defensive placeholder (RUNNING_PLACEHOLDER_TEXT + Open-Blocklist CTA). New Blocked path: `if (hasActiveTimer)` branch FIRST (already is); imports `useTimerStore`, `CountdownRing`; mounts the slice via `useEffect` keyed on `endEpochMs` (`start(endEpochMs)` / `stop()`); renders the premium hybrid layout: small uppercase status label "FOCUS SESSION" (tokens.typography.label + local letterSpacing, secondary colour) → flex-row with `<CountdownRing size={64} strokeWidth={4} trackColor={tokens.status.blocked} remainingColor={tokens.primary} progress={1 - remaining/total}/>` on the left and `<Text style={tokens.typography.countdown}>{mm}:{ss}</Text>` on the right → "Locked until HH:mm" subtitle → `End early` `Pressable` (outlined destructive, NOT primary-filled, never default, never bound to Return) → hint line "End early needs your password. Timer ends automatically at HH:mm."; the empty path at `:347-368` and Free JSX at `:370-465` stay untouched.
- [x] `src/components/Timer.tsx:214-217` -- mount-announce useEffect transitions: announces "Timer running, N minutes M seconds remaining" when `hasActiveTimer` is true, "Timer, free" when false (single-fire per transition, keyed on `hasActiveTimer`) -- replaces the current unconditional `'Timer, free'`.
- [x] `src/components/Timer.tsx` -- `End early` onPress: `useDomainStore.getState().requirePassword(() => { AccessibilityInfo.announceForAccessibility('End-early wired in 4.6 — actual end will land in Story 4.6.'); })` -- the gate wiring (3.2 mechanism) + 4.3 no-op body (4.6 owns the privileged write).
- [x] `__tests__/Timer.test.tsx` -- append Blocked-state tests to the EXISTING 654-line file: Blocked mount renders ring + numeral + subtitle + End-early; numeral reads `mm:ss` from `endEpochMs - Date.now()`; End-early + no-password short-circuits to the announce; End-early + password-set opens the gate (mirrors `Panic.test.tsx` gate-wiring pattern); slice starts on Blocked mount + stops on Free mount (refcount path); mount announce speaks "Timer running, N minutes M seconds remaining" on Blocked entry.

**Acceptance Criteria:**
- Given a running session (`committed.activeTimer != null`, `endEpochMs > Date.now()`), when the Timer surface mounts, then the defensive placeholder is gone; a small uppercase "FOCUS SESSION" status label appears at the top, a 64×64 hybrid countdown ring (status-blocked track + primary remaining arc with `strokeLinecap="round"`, rotated `-90deg` at the center, dash+gap pattern) renders on the left, a tabular-numeral `mm:ss` on the right, "Locked until HH:mm" sits underneath, and an outlined destructive `End early` `Pressable` (not primary-filled) is visible below.
- Given the same running session, when `Date.now()` ticks past one second, then the numeral decrements by exactly one second (or by `Math.floor((endEpochMs - Date.now()) / 1000)` rounding) and the ring's `stroke-dasharray` (dash+gap pattern) updates to the new progress — but Blocklist / Settings / Schedule / Sidebar / StatusHeader / Shell do NOT re-render (selector-scoped subscription).
- Given the user clicks `End early` when no password is set, then `requirePassword` short-circuits to the no-op body (3.2 path), the announce "End-early wired in 4.6..." fires, no sheet appears.
- Given the user clicks `End early` when a password is set, then `<PasswordGate>` mounts (Shell wires it from `requirePassword`), the gate opens, attempts are tracked, throttle applies after 5 wrong tries — same model as Panic's gate-wiring path. 4.3 does NOT write to config or hosts.
- Given the Timer surface unmounts (user switches to Blocklist / Settings / Schedule), when no other slice subscriber is alive, then the per-second `setInterval` clears (refcount → 0); `nowMs` parks at `Date.now()`. When 4.4 ships the status-header subscriber, the interval stays alive across surface navigation.
- Given the session just expired at mount (`endEpochMs <= Date.now()`), when Timer mounts, then the numeral shows `00:00`, the ring is empty, the slice's `start` parks immediately and clears the interval (no zero-second tick loop).
- Given a session expires while the user is on Timer (`nowMs + 1000 >= endEpochMs`), when the next tick fires, then the numeral reads `00:00` and the ring is empty; the slice parks itself but the Blocked UI stays rendered — 4.5's expiry handler is what actually clears `committed.activeTimer` and unblocks; 4.3 only renders the visible state.
- Given VoiceOver focus on the Timer surface in Blocked state, when the surface first mounts, then `AccessibilityInfo.announceForAccessibility` speaks "Timer running, N minutes M seconds remaining". Subsequent per-second ticks do NOT re-announce (the numeral carries `accessibilityLiveRegion="polite"` for the per-minute rollover — UX-DR17).
- Given `useTimerStore.start(endEpochMs)` is called twice in a row with the same value, when the second call lands, then the existing interval clears and a new one starts (idempotent — defensive against double-mount in tests / Strict Mode).
- Given `useTimerStore.stop()` is called with no live subscribers, when it lands, then the interval clears and `nowMs` parks. The next `start(endEpochMs)` restarts cleanly.

## Spec Change Log

- (empty until first bad_spec loopback)

## Design Notes

- **react-native-svg is the only viable path to the frozen ring intent.** `stroke-dasharray` dash+gap arcs cannot be built from View borders or RN primitives; the project has zero SVG deps today, so this story introduces `react-native-svg` (macOS-supported via Fabric, New Architecture app). The podspec auto-detects the RN minor version; `pod install` is required after `pnpm add`. Watch for the glog header-staging pod-install failure recorded in memory if it reappears.
- **PlatformColor vs SVG stroke props.** `tokens.primary` / `tokens.status.blocked` are `PlatformColor` objects; react-native-svg's native stroke handling may not resolve them the way core RN views do. If SVG stroke rejects PlatformColor, resolve to concrete colours at render time (theme-mapped, still via the `tokens.*` indirection — raw hex stays forbidden). Decide at implementation and keep the `statusColorNames` map (`tokens.ts:32`) as the test-assertable source of truth.
- **letterSpacing is a local style.** `tokens.typography.label` and `body` carry NO letterSpacing; the frozen "letter-spaced" FOCUS SESSION label is satisfied with a local `letterSpacing` in Timer.tsx's Blocked styles. Tokens stay untouched.
- **Slice refcount.** 4.3 introduces a single slice and a single `setInterval(1000)` driver. The refcount lets 4.3 (Timer) + 4.4 (status header) + 6.2 (menu bar) coexist without three drivers. The Timer is the FIRST subscriber for 4.3; in the absence of 4.4, Timer unmount parks the slice (the ring pauses when the user navigates away). Once 4.4 lands, the status header keeps the slice alive across all surfaces.
- **`progress = 1 - remaining/total`** is the natural direction: `1` = full ring (just started), `0` = empty (expired). The `CountdownRing` props take `progress` directly — the component is presentational; the surface derives `progress` from `remainingMs / (endEpochMs - startEpochMs)` and `startEpochMs` is captured at the `start()` call site (a third piece of slice state is overkill; the Timer surface can derive `total` from `committed.activeTimer` + the time of mount, or simply from `remainingMs / progress` if the slice exposes the `totalMs` too — see the alternative below).
  - **Alternative:** `timerStore` carries `{ nowMs, endEpochMs, totalMs }` so consumers don't have to derive `total`. Simpler API; one more field. Choose this if 4.4's mini ring wants the same derivation without duplicating math.
- **Selector `selectRemainingMs`** is the single derived value. Blocked surface re-renders ONLY when this number changes (the `mm:ss` rollover). Per-second ticks that don't cross a second boundary do NOT trigger a re-render (Zustand's `Object.is` default bail).
- **No `accessibilityLiveRegion="polite"` on the ring.** The numeral carries the announce; the ring is purely visual.
- **`End early` is destructive but not the surface's default.** The Blocked surface does NOT have a default button — `Return` does nothing on this surface (no Start, no Apply, no End-early). Tab reaches End-early normally; the user has to make the destructive choice deliberately. UX-DR16.
- **Mount announce transition.** The Timer surface used to announce "Timer, free" on mount unconditionally (`Timer.tsx:214-217`). Now it announces "Timer running, ..." when `hasActiveTimer` flips true, and "Timer, free" when it flips false. 4.4 will own the announce from the status-header side for the running state — the Timer mount announce is a one-time cue at surface entry.
- **`mm:ss` is zero-padded.** `00:00` on expiry, `01:00` after one minute elapsed, `24:59` at the example mock. Mirrors the `tokens.typography.countdown` font (tabular-nums) so digit width is fixed across the countdown.
- **Typography hierarchy.** Three weights + three sizes do the heavy lifting of the premium feel — the small uppercase "FOCUS SESSION" label (`tokens.typography.label`, secondary colour), the large tabular `mm:ss` numeral (`tokens.typography.countdown`, fontSize 28, weight 600), and the medium body line ("Locked until HH:mm" using `tokens.typography.body`, secondary). Avoid adding more type styles — three is the sweet spot; anything more feels cluttered.
- **Single source of truth.** `useTimerStore((s) => selectRemainingMs(s))` is the single derived value the Blocked surface reads. The numeral derives `mm:ss` from it; the ring derives `progress = remaining / total` from it. Stroke + numeral + ring fill can NEVER desync because they all derive from the same selector. 4.4 (status header) will subscribe to the same selector; 6.2 (menu bar) will subscribe to the same selector.
- **Smooth per-second motion.** The countdown changes value once per second (not 60 times per second). A `setInterval(1000)` + plain Zustand `setState` is the right tool — no `Animated`/Reanimated worklet needed. The selector-scoped subscription triggers a single Blocked-surface React re-render per tick (Blocklist / Settings / Schedule / Sidebar / StatusHeader / Shell stay untouched). Reanimated would be overkill for once-per-second and would add the worklet bridge cost for no visible win.
- **Premium stroke details.** `strokeLinecap="round"` on the remaining arc (NOT `butt`) gives the soft-cap that reads as "finished" rather than "clipped"; radius is inset (`r = (size - strokeWidth) / 2`) so the bounding box matches `size` and the stroke does not get clipped at the edges; rotation `-90deg` at `originX={size/2, size/2}` so the arc starts at 12 o'clock and shrinks clockwise (the universally-recognised countdown direction).
- **Defer end-of-session colour sweep.** The remaining arc could gradient from `tokens.primary` → `tokens.status.warn` (yellow) → `tokens.status.blocked` (red) as `remaining/total` drops below thresholds (e.g. 30% / 10%). This reads as "the session is winding down" but requires a new token (`tokens.status.warn`) and a separate interpolation step. Defer to 4.5 expiry polish — 4.3 ships the spine; 4.5 ships the finish.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- no type errors.
- `node_modules/.bin/jest --watchman=false __tests__/timerStore.test.ts __tests__/CountdownRing.test.tsx __tests__/Timer.test.tsx` -- slice + ring + Timer Blocked tests all green.
- `node_modules/.bin/jest --watchman=false` -- full suite stays green (no regressions to existing 451 tests).
- `cd macos && pod install` then macOS build/launch (pnpm macos path) -- react-native-svg pods install cleanly (apply the glog header-staging fix from memory if it reappears); the app builds and launches.

**Manual checks:**
- Start a 25-min session (Timer → 25 min preset + ≥1 domain → Start) — admin prompt → success → Timer surface now shows the 64×64 ring + tabular `mm:ss` + "Locked until HH:mm" + End-early + hint. The ring shrinks as the seconds tick; the numeral decrements.
- Click End-early with no password set — announce "End-early wired in 4.6..." fires, no sheet, no host write.
- Set a password, click End-early — `<PasswordGate>` sheet mounts, wrong entry bumps the attempts, 5 wrong → 30s throttle. Correct entry closes the gate, fires the same 4.3 no-op announce, no host write (4.6 will).
- Navigate to Blocklist mid-session — Timer unmounts; the slice parks (4.3 alone — 4.4 doesn't ship yet); the ring pauses. Navigate back to Timer — the slice restarts, the ring resumes from the parked `nowMs`.
- Tab away mid-session, wait 5s, return — the numeral reflects the elapsed wall-clock time (the `endEpochMs - parked-nowMs + 5s` derivation), not the parked value.
- Start a session, navigate to Settings, change nothing, return — slice re-mounts, countdown resumes, no second admin prompt.
- Start a 1-min session, wait 60s — numeral shows `00:00`, ring empty, the Blocked UI stays visible (4.5's expiry path owns the actual unblock). Navigate to Blocklist — Blocklist shows the chosen domains still in the managed section (because 4.5 hasn't fired).

## Suggested Review Order

**Dependency (gate for everything else)**
- react-native-svg added + pod install clean + macOS build green. [package.json](../../package.json)

**Timer slice (the design intent — start here)**
- New Zustand slice with `start`/`stop` refcount + immediate park on expired `endEpochMs`. [timerStore.ts:1](../../src/domain/timerStore.ts#L1)
- Selector `selectRemainingMs` for the per-second derived value. [timerStore.ts:1](../../src/domain/timerStore.ts#L1)

**Countdown ring (visual primitive)**
- Pure SVG: two stacked circles, `stroke-dasharray` derived from circumference × progress, rotation `-90deg` for 12 o'clock start. [CountdownRing.tsx:1](../../src/components/CountdownRing.tsx#L1)
- A11y-hidden so VoiceOver does not double-announce (the numeral carries it). [CountdownRing.tsx:1](../../src/components/CountdownRing.tsx#L1)

**Timer Blocked UI (surface integration)**
- Store reads extended with `endEpochMs` + `requirePassword`. [Timer.tsx:109](../../src/components/Timer.tsx#L109)
- Defensive placeholder (`:324-345`) replaced with the full Blocked path. [Timer.tsx:324](../../src/components/Timer.tsx#L324)
- Slice start/stop on hasActiveTimer transition. [Timer.tsx:324](../../src/components/Timer.tsx#L324)
- Mount announce transitions free → running. [Timer.tsx:214](../../src/components/Timer.tsx#L214)
- End-early wires through `requirePassword` with 4.3 no-op body. [Timer.tsx:324](../../src/components/Timer.tsx#L324)

**Tests (peripherals)**
- Refcount + idempotent start + immediate park + tick advance. [timerStore.test.ts](../../__tests__/timerStore.test.ts)
- SVG structure + `stroke-dasharray` math + a11y-hidden. [CountdownRing.test.tsx](../../__tests__/CountdownRing.test.tsx)
- Blocked mount renders ring + numeral + subtitle + End-early. [Timer.test.tsx](../../__tests__/Timer.test.tsx)
- End-early + no-password short-circuits to no-op announce. [Timer.test.tsx](../../__tests__/Timer.test.tsx)
- End-early + password-set opens the gate (Panic-pattern). [Timer.test.tsx](../../__tests__/Timer.test.tsx)
- Slice starts on Blocked mount + stops on Free mount. [Timer.test.tsx](../../__tests__/Timer.test.tsx)
## Suggested Review Order

**Scoped countdown slice (the story's core)**

- Entry point: the whole slice in 159 lines — state, driver, refcount, self-park.
  [`timerStore.ts:91`](../../src/domain/timerStore.ts#L91)

- Refcounted start with the non-finite park guard (malformed-config defence from review).
  [`timerStore.ts:96`](../../src/domain/timerStore.ts#L96)

- Single `setInterval(1000)` driver; self-parks at `endEpochMs` — 4.5 owns expiry.
  [`timerStore.ts:134`](../../src/domain/timerStore.ts#L134)

- The one derived selector consumers subscribe to (frozen-specified formula).
  [`timerStore.ts:73`](../../src/domain/timerStore.ts#L73)

**Ring primitive**

- Geometry memoised outside JSX; radius clamped against degenerate size/strokeWidth.
  [`CountdownRing.tsx:74`](../../src/components/CountdownRing.tsx#L74)

- NaN-safe progress clamp + conditional arc (no zero-length round-cap dot at 0).
  [`CountdownRing.tsx:81`](../../src/components/CountdownRing.tsx#L81)

- Rotation -90° so the arc starts at 12 o'clock and shrinks clockwise.
  [`CountdownRing.tsx:97`](../../src/components/CountdownRing.tsx#L97)

**Timer Blocked surface**

- Selector-scoped reads — only this surface re-renders per tick, by design.
  [`Timer.tsx:173`](../../src/components/Timer.tsx#L173)

- Usable-end normalisation: non-finite `endEpochMs` falls to Free, gate + announce agree.
  [`Timer.tsx:199`](../../src/components/Timer.tsx#L199)

- `useLayoutEffect` slice start — kills the one-frame 00:00 flash on Blocked mount.
  [`Timer.tsx:323`](../../src/components/Timer.tsx#L323)

- Per-minute rollover announce (UX-DR17) — liveRegion is Android-only, so explicit.
  [`Timer.tsx:333`](../../src/components/Timer.tsx#L333)

- Mount announce: running vs free, single-fire per transition.
  [`Timer.tsx:357`](../../src/components/Timer.tsx#L357)

- End-early wiring: lazy `requirePassword`, announce-only body (4.6 owns the write).
  [`Timer.tsx:494`](../../src/components/Timer.tsx#L494)

- Blocked JSX: ring + tabular numeral + Locked-until + destructive End-early.
  [`Timer.tsx:503`](../../src/components/Timer.tsx#L503)

**Peripherals**

- `PlatformColorOutput` type export so the ring stays on the `tokens.*` indirection.
  [`tokens.ts:37`](../../src/theme/tokens.ts#L37)

- Exact-pin `react-native-svg` — ring tests pin parse internals a caret bump could break.
  [`package.json:25`](../../package.json#L25)

- Non-finite `endEpochMs` parks without a driver.
  [`timerStore.test.ts:122`](../../__tests__/timerStore.test.ts#L122)

- Ring: track-only at 0, NaN-safe tree, degenerate-geometry clamp.
  [`CountdownRing.test.tsx:129`](../../__tests__/CountdownRing.test.tsx#L129)

- Rollover announce + ring-advance + no-write-on-End-early coverage.
  [`Timer.test.tsx:815`](../../__tests__/Timer.test.tsx#L815)
