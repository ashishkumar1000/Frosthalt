---
title: 'Menu Bar Badge Mirror and Countdown (Story 6.2)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: 646553f
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Story 6.1 menu-bar item exists but shows a static "Frosthalt" title and a frozen "Free · no active timer" placeholder row — it mirrors nothing, so glancing at the menu bar tells the user nothing about their block state or a running countdown.

**Approach:** Make the menu bar a live mirror of the same state the in-window status header already renders. Add one method to the existing MenuBar TurboModule contract — `setBadgeState({ state, buttonTitle, rowTitle })` — that native renders as (a) a badge-state-colored attributed title on the status-item button and (b) the live text of the disabled first menu row. All derivation stays in JS: a new domain module (`menuBarMirror.ts`) subscribes to the SAME Zustand slices the StatusHeader reads (domain store `committed`, clock slice, timer slice) — the menu bar becomes the timer slice's designed third subscriber — derives the badge via the pure `computeBadgeState`, the countdown via the shared `formatMmSs`/`selectRemainingMs`, and pushes to native only when the derived tuple actually changes. Click handling stays 6.3's; the status-item glyph asset question stays open (attributed text color carries the badge state — no new assets).

## Boundaries & Constraints

**Always:**
- One source of truth: the mirror derives from the SAME inputs the StatusHeader uses — `useDomainStore.committed`, `useClockStore.nowMs`, `useTimerStore` (`selectRemainingMs`), the pure `computeBadgeState` — never an independently computed badge or countdown. Badge label text comes from a single shared label map (moved into `badgeState.ts`; `StatusBadge` imports it — UI → domain is the allowed direction).
- The mirror is a module-level domain subscriber (the `store.ts` 4.5/5.4 trigger pattern), not a React component; it holds its OWN refcounted slot on the timer slice (`start`/`stop` keyed on the normalised `activeTimer.endEpochMs`), so it is a true third subscriber, not a free-rider on the header's slot.
- Native is a dumb renderer: `setBadgeState` receives the final strings + a `state` color key; it does no derivation, no `Date.now()`, no badge logic. All `NSStatusItem`/`NSMenu` mutation stays dispatched onto the main thread; both `initialize()` and `setBadgeState()` fire-and-forget `{ ok: true }`.
- Button title: the live `mm:ss` countdown while a session is live, else the badge label word ("Free" / "Blocking" / "Blocked"); the attributed title's foreground color is the badge-state system color (`systemGreen`/`systemOrange`/`systemRed` — the same NSColor names `tokens.status` maps). Menu first row: `"{label} · {countdown | 'no active timer'}"` — the exact 6.1 placeholder shape with live text.
- `App.tsx` starts the mirror in the same mount-only effect that calls `initializeMenuBar()` (after it — the main-queue FIFO guarantees the build runs before the first push).
- Status item length becomes `variableLength` (a live text title does not fit `squareLength`).

**Ask First:**
- Status-item glyph/asset — still none; color-attributed text is the design. Confirm before adding any asset file.
- Any change to the in-window `StatusBadge` visuals (this story only re-points its label source, no rendering change).

**Never:**
- No click-handling logic in JS (6.3) — `onQuickStart`/`onShowWindow`/`onQuit` remain unlistened.
- No window persistence (6.4), no ⌘W/⌘Q bindings (6.5).
- No edits to `ConfigStore`/`ShellRunner` native files, no `codegenConfig`/Podfile changes, no new Xcode project entries (all touched native files already registered).
- No re-derivation of badge/countdown math inside native Swift, and no second badge pipeline bypassing `computeBadgeState`/`timerStore`.
- Do not gate on `settings.menuBarEnabled` (unused flag, 6.1 precedent: the item lives whenever the app runs).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No session, no active schedule | app running, `activeTimer` null | button "Free" (green), row "Free · no active timer" | N/A |
| Live focus session | `activeTimer.endEpochMs` future | button "mm:ss" (red), row "Blocked · mm:ss", updates per second | N/A |
| Session expired, parked | slice parked at end, 4.5 not yet cleared | button/row hold "00:00" exactly like the header | N/A |
| Malformed `endEpochMs` (non-finite) | `readConfig` top-level-only validation | treated as no-timer (header's exact normalisation): "Free · no active timer" | never NaN text |
| Schedule-only blocking | active window, no timer | button "Blocking"/"Blocked" colored, row "{label} · no active timer" | N/A |
| Amber ramp | schedule ends ≤ 10 min, shrinks list | color/label switch to amber "Blocking" live, no Apply | N/A |
| Unchanged derived tuple | churn with no visible change | NO native call (dedupe) | N/A |
| Push before native build | `setBadgeState` precedes the build block | main-queue FIFO: build runs first; nil-guarded no-op if ever earlier | never crashes |
| Unknown `state` string at native | junk payload (defensive) | fails toward blocked red, mirroring `computeBadgeState`'s fail-safe | never neutral color |
| Second `startMenuBarMirror()` call | double mount/StrictMode | idempotent — subscriptions installed once | N/A |

</frozen-after-approval>

## Code Map

- `src/native/specs/NativeMenuBarSpec.ts:42-54` -- EDIT -- add exported `MenuBarBadgeState` type (`state: 'free' \| 'amber' \| 'blocked'`, `buttonTitle`, `rowTitle`) + `setBadgeState(badge)` method; codegen re-generates the protocol on the next native build.
- `src/native/menuBar.ts:19` -- EDIT -- add `setMenuBarBadge(badge)` forwarding wrapper (the 6.1 thin-adapter pattern).
- `src/domain/badgeState.ts:33-36` -- EDIT -- add the shared `badgeStateLabels` map (single source for the badge word).
- `src/components/StatusBadge.tsx:14-18` -- EDIT -- drop the local `STATUS_LABELS`, import `badgeStateLabels` (UI → domain; rendering unchanged).
- `src/domain/menuBarMirror.ts` -- NEW -- the third subscriber: `deriveMenuBarBadge()` pure derivation + `startMenuBarMirror()` module wiring (subscriptions to the three slices, timer-slot start/stop, deduped native push).
- `App.tsx:23-25` -- EDIT -- mount effect calls `initializeMenuBar()` then `startMenuBarMirror()`.
- `macos/Frosthalt-macOS/MenuBar.swift:91-126` -- EDIT -- `variableLength` status item; hold `badgeRow` reference; add `setBadgeState(_:)` (main-thread dispatch, attributed button title colored by state, row title update, blocked-fail-safe color default).
- `macos/Frosthalt-macOS/NativeMenuBar.mm:100-107` -- EDIT -- bridge `setBadgeState:` to the Swift impl.
- `src/domain/timerStore.ts:73-115` -- READ-ONLY -- `selectRemainingMs` / `formatMmSs` — the shared derivation the mirror reuses.
- `src/domain/store.ts:1600-1612` -- READ-ONLY -- the module-level subscription pattern (4.5/5.4 triggers) the mirror follows.
- `src/components/StatusHeader.tsx:166-217` -- READ-ONLY -- the reference consumer: same three slices, same normalisation, the behaviour the mirror must match.
- `__tests__/menuBar.test.ts` -- EDIT -- extend the spec mock with `setBadgeState`; add wrapper-forwarding coverage.
- `__tests__/App.test.tsx` -- EDIT -- add `setBadgeState` to the transitive mock (App mount now pushes a badge).
- `__tests__/menuBarMirror.test.ts` -- NEW -- pure derivation cases (free / live / expired / malformed / amber) + mirror wiring (initial push, dedupe, per-second countdown update, slot balance, idempotent start).

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeMenuBarSpec.ts` -- add `MenuBarBadgeState` + `setBadgeState` (codegen source of truth).
- [x] `src/native/menuBar.ts` -- add `setMenuBarBadge` forwarding wrapper.
- [x] `src/domain/badgeState.ts` + `src/components/StatusBadge.tsx` -- single-source the badge label words (domain map, UI imports).
- [x] `src/domain/menuBarMirror.ts` -- pure `deriveMenuBarBadge` + `startMenuBarMirror` (third subscriber, deduped push, own timer-slot).
- [x] `App.tsx` -- start the mirror on mount, after `initializeMenuBar()`.
- [x] `macos/Frosthalt-macOS/MenuBar.swift` -- `variableLength` + `badgeRow` ref + `setBadgeState` render.
- [x] `macos/Frosthalt-macOS/NativeMenuBar.mm` -- bridge the new method.
- [x] Tests: extend `menuBar.test.ts` / `App.test.tsx`, new `menuBarMirror.test.ts`.

**Acceptance Criteria:**
- Given the app is running, when block state changes (Apply, timer start/expire/end-early, schedule boundary), then the menu-bar button + first row mirror the in-window header's badge and countdown (same derivation, never independently computed).
- Given a live session, when the timer slice ticks, then the status-item title shows the live `mm:ss` in the badge-state color, updating per second, with no other UI tree re-rendering.
- Given no live timer, then the menu bar shows "Free" (green) and "Free · no active timer".
- Given the derived tuple is unchanged across store churn, then native `setBadgeState` is NOT called again (dedupe).
- Given `node_modules/.bin/tsc --noEmit` and the full jest suite, then both pass.

## Design Notes

- Button title shows the COUNTDOWN while a session is live (not the badge word): the countdown is the highest-value glance, and the attributed-title color carries the badge state in every state. Free/schedule-only states show the badge word.
- The native "fill" mirror is a foreground attributed color, not a pill: an `NSStatusItem` cannot cheaply render the in-window pill fill without a custom view/asset, and the glyph-asset question stays behind the Ask-First boundary. Same NSColor semantic names keep light/dark adaptation identical.
- The mirror holds its own timer-slice slot (start/stop keyed on the normalised end) rather than free-riding on StatusHeader's: the slice was designed for exactly three refcounted subscribers, and this keeps the mirror correct even if the header's lifecycle ever changes. Same `!= null && Number.isFinite` normalisation as the header, so mirror and header can never disagree about liveness.
- Dedupe key is the derived triple (state, buttonTitle, rowTitle) — a per-second tick during a live session legitimately fires one native call per second (cheap JSI + attributed-title set); churn that changes nothing fires none.
- Golden example: launch with a persisted live session → mount effect initialises the menu bar, starts the mirror → mirror acquires a timer-slot, derives "Blocked · 24:59", pushes once → menu-bar button reads "24:59" in red, ticking each second → session expires → 4.5 clears `activeTimer` → committed change re-derives → "Free · no active timer" in green.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- PASSED (clean, 2026-08-29).
- `node_modules/.bin/jest --watchman=false` -- PASSED: 38 suites / 838 tests, 3 snapshots (2026-08-29). The new `menuBarMirror.test.ts` contributes 11 tests (6 pure derivation + 5 wiring).

**Mid-build fix worth recording:** the first wiring run hit infinite recursion — `syncTimerSlot` booked `heldEndEpochMs` AFTER calling `start()`/`stop()`, so the action's internal `set()` re-entered `pushMirror` (this module's own slice subscription) with the STALE slot value, restarting the action forever. Fix: book the slot value BEFORE the store calls so the re-entrant guard reads the new value (comment at `menuBarMirror.ts` "RE-ENTRANCY"). The StatusHeader blast-radius allowlist guard (pinning the exact `useTimerStore`-referencing file list) also fired as designed, forcing the conscious addition of `src/domain/menuBarMirror.ts` to its expected array.

**Post-story native crash fix (found on the first real `pnpm macos` run):** the app segfaulted on launch (`EXC_BAD_ACCESS`, fault address `0x380004004`, deterministic across 5 crash reports) inside `-[NativeMenuBarModule setBadgeState:]` on the JS thread. Root cause: the hand-written glue declared the param as `(NSDictionary *)badge`, but because `MenuBarBadgeState` is a NAMED object type in the TS spec, TurboModule codegen generates the protocol method as `setBadgeState:(JS::NativeMenuBarSpec::MenuBarBadgeState &)badge` and installs a per-arg converter — the runtime then packs the C++ struct POINTER into the NSInvocation argument slot. ARC in the `NSDictionary *`-typed method treated that struct pointer as a strong ObjC object (`objc_storeStrong` on a non-object address) and crashed. This was the repo's FIRST typed-object TurboModule param — ConfigStore uses `NSString *`, ShellRunner `NSArray *`, so the trap had never been hit before. Fix: the glue now mirrors the generated protocol signature verbatim (C++ struct reference) and unpacks `state()`/`buttonTitle()`/`rowTitle()` into the NSDictionary the Swift renderer takes. JS contract unchanged. Lesson for future stories (6.3+): a named object type param in a TS spec means the native glue must take the generated `JS::<Spec>::<Type> &` struct — never `NSDictionary *`.

**Post-story native crash fix #2 (same first real run, unrelated to 6.2 — a pre-existing 3.2-era bug):** clicking "End early" with a password set SIGABRT'd the app. The gate's mount-only `fieldRef.current?.focus()` on its `secureTextEntry` field takes AppKit's PROGRAMMATIC focus path (`NSWindow _realMakeFirstResponder:` -> `NSTextField selectText:` -> `NSCell selectWithFrame:...` -> secure field editor session), and macOS 12+ asserts inside it: "NSSecureTextFieldCell is not secure because the secure field editor's delegate must be an NSSecureTextField!" (NSSecureTextField.m:514). react-native-macos's `RCTUISecureTextField` is a plain `RCTUITextField`/`NSTextField` subclass that only swaps the CELL to `RCTUISecureTextFieldCell` (the [PR #612](https://github.com/microsoft/react-native-macos/pull/612) design — [issue #423](https://github.com/microsoft/react-native-macos/issues/423) for background), so the delegate is never an NSSecureTextField and the assertion always fires on that path. The USER-CLICK edit path (`NSCell editWithFrame:...`) does not assert — typing into the secure SetPassword fields has always worked. Fix: removed the gate's mount auto-focus entirely (the user clicks the field, exactly like SetPassword where no focus call exists). No test asserted focus. Standing rule for all future stories: **never call `.focus()`/`autoFocus` on a `secureTextEntry` field on macOS** — plain-field mount focuses (Shell row-0, ScheduleEditor name field) are safe; the assertion is secure-editor-only.

**Post-story native crash fix #3 (same first real run; the OTHER half of the same root cause):** after removing the auto-focus, the gate opened without crashing, but typing in the secure field never enabled Verify. User-confirmed symptoms: dots appear in the field, but Verify stays disabled; clicking Show (plain field) and typing enables it. So the secure field editor renders fine but never notifies a non-`NSSecureTextField` delegate — `NSTextField textDidChange:` never runs, RN's adapter never hears the change, `onChangeText` never fires, React's controlled value stays empty. Same RN flaw as fix #2 (the [PR #612](https://github.com/microsoft/react-native-macos/pull/612) design), second symptom — and it affects EVERY `secureTextEntry` field in the repo (SetPassword, ChangePassword, gate), not just 3.2's gate. Fix: `macos/Frosthalt-macOS/SecureTextFieldFix.mm` — an app-target Obj-C category on `RCTUISecureTextField` that observes the public `NSTextDidChangeNotification` (posted by the field editor on every keystroke regardless of delegate wiring; the header is a public pod header, `Pods/Headers/Public/React-Core/React/RCTUISecureTextField.h`) and, when the posting editor is the field's own `currentEditor`, calls the field's `textDidChange:` — the exact `RCTUITextField` override AppKit would have invoked on the working plain-field path, which forwards into RN's adapter and re-fires the full onChange chain (including the native event-count bookkeeping for controlled values). A category adding a method the class does not implement (`initWithFrame:`) is deterministic — only replacing an existing same-class method via a category is undefined. Registered in project.pbxproj (the MenuBar/ShellRunner synthetic-ID pattern; `plutil -lint` verified). Known risk: if macOS's secure editor also suppresses `NSTextDidChangeNotification`, the fix is inert and the fallback is JS-side masking or a library patch. **User-confirmed working (2026-08-29):** after the rebuild, typing in the secure gate field enables Verify — the secure editor does post `NSTextDidChangeNotification`, so the notification-forwarding fix holds.

**Manual checks (run once locally outside the sandbox — same standing limitation as 6.1):**
- `pnpm macos` -- launch, start a focus session: menu-bar button shows the countdown in red, ticking; open the menu: first row "Blocked · mm:ss". End the session: button reverts to green "Free", row "Free · no active timer". With an active schedule: badge word + color follow the window live, including an amber ramp.
- Codegen note: the next native build regenerates the protocol from the spec's new `setBadgeState` — no pbxproj/Podfile changes needed (all touched files already registered).

## Suggested Review Order

1. The contract + wrapper: `NativeMenuBarSpec.ts` `setBadgeState` / `menuBar.ts` `setMenuBarBadge`.
2. Single-sourced labels: `badgeState.ts` map + `StatusBadge.tsx` import.
3. The mirror: `menuBarMirror.ts` derivation, subscriptions, slot balance, dedupe.
4. App wiring: `App.tsx` mount effect ordering.
5. Native render: `MenuBar.swift` attributed title + row update, fail-safe color; `NativeMenuBar.mm` bridge.
6. Tests: `menuBarMirror.test.ts` derivation matrix + wiring; extended mocks in `menuBar.test.ts` / `App.test.tsx`.