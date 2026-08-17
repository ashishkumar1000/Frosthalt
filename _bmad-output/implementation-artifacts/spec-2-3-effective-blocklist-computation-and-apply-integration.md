---
title: 'Apply controls completion: staged-changes hint, pulse, running state, and Return-to-Apply'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '97b67649e63e60a41f211e77aba5f19c662d7d0f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-add-domain-field-with-live-normalisation.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-blocklist-surface-with-always-on-checkbox.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-staged-then-apply-serialized-pipeline-proven-on-one-domain.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Scope note (flag at CHECKPOINT 1):** 1.6 already built `effectiveBlocklist` (filters `alwaysOn`, `effectiveBlocklist.ts:34`) and the serialized `apply()` pipeline (`store.ts:156-201`); 2.1 wired the Apply/Cancel controls (`Blocklist.tsx:120`) and `applyStatus: 'idle'|'running'` (`store.ts:56`); 2.2 added the add field + Return-in-field→Add. So the story's literal name — "effective blocklist computation and Apply integration" — is **architecturally done**. 2-3 is the **Apply-button live-UX completion** that 2-1/2.2 explicitly deferred: the UX-DR9 "N changes staged" hint + pulse, the 2-1 in-flight running indicator, and the 2-2 Return→Apply half of UX-DR16. No new domain computation, no new pipeline, no new ports.

**Problem:** A user with staged edits gets no count of pending changes, no "notice me" pulse on Apply, no in-flight cue while the osascript admin prompt is open, and no keyboard path to commit — they must click Apply. 2-1's `ApplyButton` is visual-only (`ApplyButton.tsx:15-19`, no pulse/running/animation); 2-1 deferred the running indicator to 2.3; 2.2 deferred Return→Apply to 2-3; UX-DR9's hint+pulse are unbuilt.

**Approach:** Four additions, all driven by existing store state: (1) a pure domain helper `stagedChangeCount(staged, committed)` — a sibling to `draftEqualsCommitted` (`store.ts:282`) — diffing per-hostname (added+removed+toggled), so the count survives the toggle clean-revert; (2) an "N changes staged" hint `Text` in the Blocklist controls row, shown only when `staged != null`; (3) a subtle Apply pulse — the codebase's first `Animated.loop` (`useNativeDriver` opacity) — via a new `pulse?: boolean` prop on `ApplyButton`, driven `hasStaged && !running`; (4) an in-flight "Applying…" label + `busy` accessibilityState while `applyStatus === 'running'`; (5) Return→Apply as the Blocklist view's default button — Shell tracks add-field focus (so the focused field always owns Return→Add) and fires `apply()` on bare Return iff `surface === 0 && !addFieldFocused && staged != null`. No new privileged code.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way, unchanged: 2-3 only reads store state (`staged`, `committed`, `applyStatus`) and calls the existing `apply()`. No new ports; no `child_process`/`fs`/`os` in `src/`.
- `stagedChangeCount` is PURE (sibling to `draftEqualsCommitted`, `store.ts:282`), diffing by hostname: added (in staged, not committed) + removed (in committed, not staged) + toggled (in both, `alwaysOn` differs). It MUST NOT use a naive length-diff — the toggle clean-revert (`store.ts:146-149`) makes length-diff wrong (a toggle is 0 length-change but 1 change; off-then-on is 0). The hint shows ONLY when `staged != null` (invariant: `staged != null ⟹ count ≥ 1`, since clean-revert clears `staged` to `null` on net-zero).
- The Apply pulse is the codebase's FIRST animation: `Animated.loop` on opacity, `useNativeDriver: true` (opacity-only, off-main-thread). Started/stopped in a `useEffect` keyed on the `pulse` prop; stopped on unmount. No JS-driver animation, no scale/transform (those would break `useNativeDriver: true`).
- Return→Apply is GATED: fires iff `surface === 0 && !addFieldFocused && staged != null`. The add field ALWAYS owns Return when focused (its `onSubmitEditing`→Add, `submitBehavior="submit"` keeps focus, `AddDomain.tsx:123`). Shell tracks `addFieldFocused` via an AddDomain focus-change callback — deterministic, does NOT rely on uncertain Return bubble semantics, and is unit-testable.
- The running state reuses the existing `applyStatus === 'running'` (`store.ts:56`); 2-3 only RENDERS it. Apply's `disabled={running || !hasStaged}` (`Blocklist.tsx:120`) is unchanged; 2-3 layers pulse + label + `busy` on top.

**Ask First:**
- Apply-failure feedback (surfacing `lastResult.error`, which no UI consumes today): 2-1 deferred it to 2.5 (status-header territory). 2-3 introduces the in-flight "Applying…" state but does NOT surface the failure envelope. Propose 2.5 owns the failure status line. Flag at CHECKPOINT 1.
- The pulse magnitude/colour: reuse `tokens.primary` (controlAccentColor, already the Apply fill) via opacity; the `status.*` colors are off-limits for decoration per `tokens.ts`'s own contract. No new `motion` token group for 2-3 — hardcode the loop duration in `ApplyButton`; propose a `motion` group only if a second animation lands. Flag at CHECKPOINT 1.

**Never:**
- No remove button/confirm-alert (2-4), no domain count in the status header (2-5), no hosts viewer/drift banner (2-6).
- No re-implementation of `effectiveBlocklist` / `apply()` / the serialized queue / Cancel — all done in 1.6/2.1.
- No `applyStatus` value beyond `'idle'|'running'` (no `'error'` state — failure lives in `lastResult`, surfaced by 2.5).
- No auto-Apply; no Apply on Add; no background re-apply.
- No `ActivityIndicator`/spinner — the "Applying…" label + disabled state is the in-flight cue (Apply's work is the osascript admin prompt, not CPU).
- No Return→Apply on surfaces other than 0; no Return→Apply while the add field is focused; no ⌘Return (bare Return only, matching the "default button" contract).
- No new privileged code / ports.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| idle, no staged | `staged == null`, surface 0 | Apply disabled (dimmed), no pulse, label "Apply", no hint | N/A |
| idle, 1 change staged | `staged != null`, count 1 (added OR toggled) | "1 change staged" hint, Apply enabled + pulsing, label "Apply" | N/A |
| idle, N changes staged | `staged != null`, count N>1 | "N changes staged" hint, Apply enabled + pulsing | N/A |
| running | `applyStatus === 'running'` | Apply disabled, label "Applying…", `accessibilityState.busy`, no pulse; hint persists (staged retained) | N/A |
| toggle clean-revert | toggle off then on → `staged == null` | no hint, no pulse, Apply disabled (net-zero) | N/A |
| Return (field blurred, staged) | surface 0, `!addFieldFocused`, `staged != null`, bare Return | `apply()` fires | N/A |
| Return (field focused) | field focused, bare Return | Add owns Return (`onSubmitEditing`); `apply()` NOT fired | N/A |
| Return (no staged) | `staged == null`, bare Return | nothing (`apply()` short-circuits at call time) | N/A |
| Return (other surface) | surface != 0, bare Return | nothing (no Apply on Timer/Schedule/Settings) | N/A |
| ⌘N then empty Return | ⌘N focused field, empty input, `staged != null`, bare Return | Add no-op (field owns Return); `apply()` NOT fired (field focused) — documented edge | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/stagedChangeCount.ts` -- NEW. Pure `stagedChangeCount(staged: Domain[], committed: Domain[]): number` = added + removed + toggled, diffed by hostname (a `Map<hostname, alwaysOn>` over committed, then walk staged counting mismatches + misses). Sibling to `draftEqualsCommitted` (`store.ts:282`); EXPORTED (the UI consumes it). No store import.
- `src/components/ApplyButton.tsx` -- EDIT. Add `pulse?: boolean` + `busy?: boolean` props. `accessibilityState={{ disabled, busy }}`. The pulse: module-level `const AnimatedPressable = Animated.createAnimatedComponent(Pressable)`, an `Animated.Value` opacity driven by an `Animated.loop` (`Animated.sequence` of two `Animated.timing`, `useNativeDriver: true`) started in a `useEffect` when `pulse` is true, stopped on false/unmount. Opacity oscillates 1.0 ↔ ~0.8 (subtle, ~800ms each way). On stop, `setValue(1)` so a mid-cycle stop never leaves a dimmed opacity that would clash with a later `disabled` (opacity 0.4) state. The label/`disabled`/`onPress` surface is unchanged — the caller swaps the label for "Applying…". The animation itself is native-runtime (not unit-testable in the node jest env — same caveat as the ⌘N focus call); tests assert the `pulse`/`busy` props are forwarded.
- `src/components/Blocklist.tsx` -- EDIT. Add a `committed` selector (if not already read) and `const changeCount = staged != null ? stagedChangeCount(staged, committed.domains) : 0`. Render an "N changes staged" hint `Text` in the controls row (`Blocklist.tsx:114`) when `hasStaged`: `changeCount === 1 ? '1 change staged' : \`${changeCount} changes staged\``. Pass `pulse={hasStaged && !running}` + `busy={running}` + `label={running ? 'Applying…' : 'Apply'}` to `ApplyButton`. Forward the new `onFocusChange` prop to `<AddDomain>` (alongside the existing `addFieldRef`). Keep the 2-1 rows / Cancel / empty-state copy.
- `src/components/AddDomain.tsx` -- EDIT. Add optional `onFocusChange?: (focused: boolean) => void`; wire the `TextInput` `onFocus={() => onFocusChange?.(true)}` + `onBlur={() => onFocusChange?.(false)}`. No other behavior change (the raw-input `useState`, the live preview, the duplicate gate, the Add, the `forwardRef` all stay).
- `src/components/Shell.tsx` -- EDIT. Add `const [addFieldFocused, setAddFieldFocused] = useState(false)`. Add `staged` + `apply` selectors from the store (Shell reads neither today — Blocklist owns them; both may read the same store). Pass `onFocusChange={setAddFieldFocused}` to `<Blocklist>`. Add `{ key: 'Return' }` + `{ key: 'Enter' }` to `KEY_DOWN_EVENTS` (`Shell.tsx:37`). In `onKeyDown`, add a branch (bare-key, no `metaKey`) before the `⌘1-⌘4` branch: `if (!metaKey && (key === 'Return' || key === 'Enter') && surface === 0 && !addFieldFocused && staged != null) { void apply(); return; }`. Leave `⌘N` + `⌘1-⌘4` + the mount-announce untouched.
- `__tests__/stagedChangeCount.test.ts` -- NEW. Pure unit tests: added-only, toggled-only, removed-only (general, even though remove lands in 2-4), added+toggled, mixed, and a value-equal-staged-vs-committed → 0 (the off-then-on clean-revert analogue, since the helper receives the resulting array not the history).
- `__tests__/Blocklist.test.tsx` -- EDIT. Assert: hint shows "1 change staged" / "N changes staged" with the right count when `staged != null`; hint absent when `staged == null`; `pulse` prop on Apply = `hasStaged && !running`; `running` → label "Applying…" + `busy` + no pulse; `onFocusChange` forwarded to AddDomain. Use the existing `seedState` + prop-based query pattern.
- `__tests__/Shell.test.tsx` -- EDIT. Assert Return+Enter are declared in `keyDownEvents`; Return (surface 0, `!addFieldFocused`, `staged != null`) → `apply()` called (mock `apply` via `useDomainStore.setState({ apply: jest.fn() })`, the AddDomain `mockStageAdd` pattern); Return with `addFieldFocused` true → `apply` NOT called; Return with `staged == null` → not called; Return on surface 1 → not called. The `addFieldFocused` state is driven via the AddDomain `onFocusChange` prop the Shell passes through Blocklist.
- `__tests__/AddDomain.test.tsx` -- EDIT. Assert `onFocusChange` is invoked with `true` on `onFocus` and `false` on `onBlur` (invoke the `TextInput`'s `onFocus`/`onBlur` props, assert the callback).
- Reuse (read-only): `src/domain/store.ts:282` (`draftEqualsCommitted` — the sibling pattern), `src/domain/effectiveBlocklist.ts:34` (unchanged), `src/theme/tokens.ts` (`primary`), `src/config/types.ts:15` (`Domain`).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/stagedChangeCount.ts` -- NEW pure per-hostname diff helper (added+removed+toggled) -- the "N changes" count.
- [x] `src/components/ApplyButton.tsx` -- add `pulse` + `busy` props + the `Animated.loop` opacity pulse -- the codebase's first animation.
- [x] `src/components/Blocklist.tsx` -- "N changes staged" hint + pulse/busy/label wiring + forward `onFocusChange` -- render the live Apply state.
- [x] `src/components/AddDomain.tsx` -- `onFocusChange` prop (onFocus/onBlur) -- the focus signal for Return gating.
- [x] `src/components/Shell.tsx` -- `addFieldFocused` state + store `staged`/`apply` reads + Return→Apply branch -- the default-button binding.
- [x] `__tests__/stagedChangeCount.test.ts` -- pure diff tests (added/toggled/removed/mixed/value-equal→0).
- [x] `__tests__/Blocklist.test.tsx` -- hint count/singular-plural, pulse wiring, running label+busy, onFocusChange forwarding.
- [x] `__tests__/Shell.test.tsx` -- Return→Apply gating (field-blurred fires; field-focused/empty-staged/other-surface don't).
- [x] `__tests__/AddDomain.test.tsx` -- `onFocusChange` fires on focus/blur.

**Acceptance Criteria:**
- Given `pnpm test`, when the suite runs, then `stagedChangeCount` + `Blocklist` + `Shell` + `AddDomain` suites pass with the native specs mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given `staged != null` with 1 change, then the hint reads "1 change staged"; given N>1 changes, then "N changes staged"; given `staged == null`, then no hint.
- Given `staged != null && !running`, then Apply pulses; given `running`, then Apply shows "Applying…" + `busy` + no pulse; given `staged == null`, then Apply does not pulse.
- Given surface 0, `!addFieldFocused`, `staged != null`, when the user presses bare Return, then `apply()` fires; given the add field is focused, then bare Return does NOT fire `apply()` (Add owns it); given `staged == null` or surface != 0, then bare Return does nothing.
- Given `stagedChangeCount`, then a value-equal staged-vs-committed yields 0, an added domain yields +1, a toggled `alwaysOn` yields +1, and a removed domain yields +1.
- Given AddDomain, then `onFocus`/`onBlur` report focus changes via `onFocusChange`.
- Given any domain-layer code, then it imports ShellRunner/ConfigStore only via the ports and never `child_process`/`fs`/`os`.

## Spec Change Log

<!-- Empty until the first bad_spec loopback. -->

## Design Notes

- **Scope narrowing (flag at CHECKPOINT 1):** the story's literal name is a vestige — 1.6/2.1/2.2 absorbed `effectiveBlocklist` + the `apply()` pipeline + Apply/Cancel + the add field. 2-3 is the Apply-button live UX only: UX-DR9's "N changes staged" hint + pulse, the 2.1 in-flight running indicator, and the 2.2 Return→Apply half of UX-DR16. If a bigger 2-3 was expected, renegotiate here.
- **Why a per-hostname diff, not a length-diff:** `stageAlwaysOnToggle` clean-reverts to `staged == null` when the draft value-equals committed (`store.ts:146-149`), and a toggle changes no length. So `staged.length - committed.length` is wrong in both directions. `stagedChangeCount` diffs by hostname (added/removed/toggled), matching `draftEqualsCommitted`'s discipline.
- **Why Shell tracks focus (not Return-bubble-reliance):** whether a Return keydown consumed by the field's `onSubmitEditing` also bubbles to the root `onKeyDown` is uncertain in RN-macos. Tracking `addFieldFocused` via an explicit `onFocusChange` callback makes the "focused field always owns Return" contract deterministic AND unit-testable (the test toggles the state via the prop, not a native focus event). This is the same prop-driven testability discipline as the 2.2 ⌘N declaration test.
- **Why "Applying…" not a spinner:** Apply's in-flight work is the osascript admin prompt (the user is at a system dialog, not waiting on CPU). A label change to "Applying…" + disabled + `busy` is a clearer, asset-free in-flight cue than an `ActivityIndicator`, and it matches the macOS default-button mental model (the button momentary-presses; it does not spin).
- **Why opacity / `useNativeDriver: true` for the pulse:** this is the codebase's first animation. Opacity-only keeps `useNativeDriver: true` (off-main-thread, no JS-frame work) — scale/transform would still allow `useNativeDriver` but opacity is the cheapest "notice me" signal and needs no transform plumbing. The pulse is an internal `ApplyButton` concern (`pulse?: boolean`) so Blocklist stays declarative: `pulse={hasStaged && !running}`.
- **The focus-context edge (⌘N + empty + staged + Return → Add no-op, NOT Apply):** after ⌘N the field is focused and empty; bare Return fires the field's `onSubmitEditing` → `handleAdd` early-returns on `!addEnabled` (`AddDomain.tsx:98`). `apply()` does NOT fire because the field is focused. This is the predictable "focused field owns Return" contract; the user clicks Apply (or blurs the field with Tab/Esc, then Return) to commit. Documented in the matrix; not a bug.
- **Apply-failure feedback is 2.5, not 2.3 (flag at CHECKPOINT 1):** 2-3 renders the in-flight `running` state but does not surface `lastResult.error`. The failure envelope already exists in the store (`store.ts:62,197`); 2.5 (domain count in the status header) is the natural home for a failure status line. Introducing it here would pull in status-header scope.
- **Golden example** — add `social.com` to a list with `example.com` committed → "1 change staged", Apply pulses; toggle `example.com` off → "2 changes staged" (1 added + 1 toggled), still pulsing; toggle `example.com` back on → "1 change staged"; press bare Return (field blurred) → admin prompt, Apply shows "Applying…", no pulse, hint persists; on allow → committed, hint + pulse gone. Remove `social.com` from the draft (2-4) would read "-1" — but remove is out of scope here; `stagedChangeCount` already counts it.

## Verification

**Commands:**
- `pnpm typecheck` (`tsc --noEmit`) -- expected: exit 0.
- `pnpm test --watchman=false -- stagedChangeCount Blocklist Shell AddDomain` -- expected: the four suites pass.

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds.
- On surface 0: with `example.com` committed, add `social.com` → see "1 change staged" + a gently pulsing Apply; toggle `example.com` off → "2 changes staged"; toggle back → "1 change staged"; press bare Return (click away from the field first so it is blurred) → osascript admin prompt, Apply reads "Applying…" (no pulse); on Allow → `config.json` + `/etc/hosts` reflect both domains, hint + pulse gone. Press ⌘N, type nothing, press Return → nothing (field owns Return). **Back up `/etc/hosts` before, restore after.**

## Suggested Review Order

**Staged-changes computation**

- The pure per-hostname diff (added+removed+toggled) — the count's definition and the story's conceptual core.
  [`stagedChangeCount.ts:29`](../../src/domain/stagedChangeCount.ts#L29)

- Count computed + singular/plural hint, shown only when `staged != null` (clean-revert clears it on net-zero).
  [`Blocklist.tsx:92`](../../src/components/Blocklist.tsx#L92)

**Apply-button live UX (pulse + running label + busy)**

- The `Animated.loop` opacity pulse — the codebase's first animation, keyed on `pulse`, `useNativeDriver:true`.
  [`ApplyButton.tsx:71`](../../src/components/ApplyButton.tsx#L71)

- Module-level `AnimatedPressable` host — created once so the animated node isn't re-mounted per render.
  [`ApplyButton.tsx:36`](../../src/components/ApplyButton.tsx#L36)

- Wires `pulse={hasStaged && !running}` + `busy={running}` + the "Applying…" label swap to `ApplyButton`.
  [`Blocklist.tsx:136`](../../src/components/Blocklist.tsx#L136)

**Return→Apply default-button binding + focus tracking**

- The bare Return→Apply gate — `surface 0 && !addFieldFocused && staged != null`, placed before the ⌘1-⌘4 branch.
  [`Shell.tsx:111`](../../src/components/Shell.tsx#L111)

- `selectRow` resets `addFieldFocused` — the step-04 PATCH closing the dropped-`onBlur` stale-focus race.
  [`Shell.tsx:75`](../../src/components/Shell.tsx#L75)

- `addFieldFocused` tracked via the AddDomain `onFocusChange` callback — deterministic, not Return-bubble-reliant.
  [`Shell.tsx:68`](../../src/components/Shell.tsx#L68)

- `onFocus`/`onBlur` fire `onFocusChange` — the focus signal the Shell gates Return on.
  [`AddDomain.tsx:139`](../../src/components/AddDomain.tsx#L139)

**Tests**

- Golden example + per-hostname diff coverage (added/toggled/removed/mixed/value-equal→0).
  [`stagedChangeCount.test.ts:189`](../../__tests__/stagedChangeCount.test.ts#L189)

- Regression: focus → navigate-away → back → bare Return fires `apply()` (the PATCH guard).
  [`Shell.test.tsx:792`](../../__tests__/Shell.test.tsx#L792)

- Return NOT fired when the field is focused (the field owns Return → Add).
  [`Shell.test.tsx:658`](../../__tests__/Shell.test.tsx#L658)

- Hint count/singular-plural + `pulse`/`busy`/label wiring asserted via prop-based queries.
  [`Blocklist.test.tsx:601`](../../__tests__/Blocklist.test.tsx#L601)

- `onFocusChange` fires `true` on focus and `false` on blur.
  [`AddDomain.test.tsx:472`](../../__tests__/AddDomain.test.tsx#L472)