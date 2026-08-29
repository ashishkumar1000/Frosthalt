---
title: 'Menu Bar Quick-Start, Show Window, and Quit Actions (Story 6.3)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: db3aa3d
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The 6.1 menu-bar items ("Start 25-min focus", "Show window", "Quit") are enabled but wired to nothing on the JS side — native emits `onQuickStart`/`onShowWindow`/`onQuit` into the void, so the menu bar cannot actually start a session, surface the window, or quit the app. Acting on Frosthalt still requires bringing the main window forward.

**Approach:** Make the three click events real. A new domain module (`menuBarActions.ts`) subscribes to the emitters via the existing `src/native/menuBar.ts` adapter (same domain → adapter direction as 6.2's mirror): `onQuickStart` reuses the Epic 4 start path verbatim — `stageStartTimer({ durationMs: 25 min, selected: all committed domains })`, inheriting the store's validation, serialized apply queue, and the one admin prompt inside the ShellRunner write; `onQuit` routes to a new native `quit()` method so 6.5 can insert its confirm dialog before it. "Show window" stays fully native (AppKit window activation in Swift) and `onShowWindow` remains fired-but-unlistened — no JS decision to make, no round-trip. 25 and the preset list are single-sourced by hoisting `PRESET_MINUTES` from the components file into the domain layer (the 6.2 label-hoist pattern).

## Boundaries & Constraints

**Always:**
- Quick-start goes through the EXISTING `stageStartTimer` action (store.ts:318) — one admin prompt via the privileged hosts write, per OQ-1 "Start is friction-free": no password gate, no confirm sheet, no new privileged logic.
- Quick-start gates replicate `handleStart`'s: no-op when a session is already live (`committed.activeTimer != null`), when an Apply is running (`applyStatus === 'running'`), or when `committed.domains` is empty. Selection defaults to ALL committed domain hostnames (the Timer UI's own fallback) since `activeTimer.selectedDomains` does not exist when no session runs.
- 25 minutes and the preset list come from ONE hoisted domain constant; `TimerDurationPicker`/`Timer` import it — UI → domain only (6.2's `badgeStateLabels` pattern).
- Native menu-bar module stays unprivileged and dumb: it gains only a main-thread-dispatched `NSApp.terminate` quit; "Show window" is pure AppKit activation in the Swift click handler. Every module mutation stays on the main queue; the new `quit()` returns `{ ok, error? }` like every other method.
- Dependency direction: `menuBarActions.ts` imports `store.ts` one-way (store does not import it) and the native adapter — same rule as `menuBarMirror.ts`; handlers read state via `useDomainStore.getState()` at event time, never cached.
- `startMenuBarActions()` is idempotent (installed-once guard, 6.2 mirror pattern); App.tsx calls it in the same mount effect ordering after `initializeMenuBar()`.

**Ask First:**
- Any persisting of a "last used domain set" as a settings field (a real schema addition, 6.4/settings territory — out of scope unless renegotiated; "last-used set" here means the all-domains fallback the Timer UI already uses).
- Any change to apply-blocking surfaces in the RN tree or a toast/notification for menu-initiated starts (the menu bar has no toast surface; the badge mirror is the visible feedback).
- Disabling/greying the menu items dynamically based on state (needs `setBadgeState` to carry item-enabled flags — new contract surface).

**Never:**
- No quit-confirm dialog, no ⌘W/⌘Q bindings, no window close-to-menu-bar behavior (all 6.5); no window size/position persistence (6.4). `onQuit` ends in an unconditional `terminate` in this story.
- No reimplementation of session starting: no direct config writes, no separate hosts pipeline, no new domain action for quick-start.
- No JS listener for `onShowWindow` — window activation never routes through JS.
- No edits to `ConfigStore`/`ShellRunner` native files, no `codegenConfig`/Podfile changes; `NativeMenuBar` is already registered in AppDelegate's module provider.
- No dynamic menu-item enable/disable, no new menu items, no badge/label changes to 6.2's rendering.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Quick-start, idle app | menu click, no active timer, Apply idle, domains ≥ 1 | `stageStartTimer({durationMs: 25\*60_000, selected: all committed hostnames})` runs; admin prompt; on success badge flips to Blocked countdown | start failure (admin deny) → WriteResult `{ok:false}`; nothing crashes, badge stays Free (committed unchanged) |
| Quick-start, session live | `committed.activeTimer != null` | no-op — store NOT called | N/A |
| Quick-start, Apply running | `applyStatus === 'running'` | no-op — store NOT called | N/A |
| Quick-start, zero domains | `committed.domains` empty | no-op — store NOT called (store's `empty-selection` guard never reached) | N/A |
| Show window | menu click, app in background / window hidden | Swift activates app + orders main window front/key; `onShowWindow` emitted (unlistened) | nil-guard: no main window → activation only, no crash |
| Quit, no timer | menu click | JS handler calls native `quit()` → `NSApp.terminate` on main queue | N/A |
| Quit while timer runs | live session | still quits unconditionally (6.5 owns the confirm) | N/A |
| Quit during running Apply | `applyStatus === 'running'` | terminates; hosts state left consistent by the apply pipeline's own atomicity | N/A |
| Double `startMenuBarActions()` | double mount / StrictMode | idempotent — handlers registered once | N/A |
| Clicks before JS subscribes | event fires with no listener (6.1 contract) | harmless — emitters tolerate zero listeners | N/A |

</frozen-after-approval>

## Code Map

- `src/native/specs/NativeMenuBarSpec.ts:73-110` -- EDIT -- add `quit(): MenuBarResult` to `Spec` (after `setBadgeState`, spec-order: initialize, setBadgeState, quit). Events already exist (`onQuickStart` :97, `onShowWindow` :103, `onQuit` :109, all `EventEmitter<void>`) — no event changes.
- `src/native/menuBar.ts:34` -- EDIT -- add only a `quitApp(): MenuBarResult` forwarding wrapper (thin-forwarder style; no JS logic). JS listens to the emitters via the spec's default export directly, as `menuBarActions.ts` will do.
- `src/domain/menuBarActions.ts` -- NEW -- `startMenuBarActions()`: installed-once guard; `NativeMenuBar.onQuickStart(handler)` → guard chain (`isEmpty` / `hasActiveTimer` / `applyStatus==='running'`, same normalisation as Timer.tsx:208-209,189-194) → `void useDomainStore.getState().stageStartTimer({ durationMs: PRESET_MINUTES[0] * 60_000, selected: new Set(committed.domains.map(d => d.hostname)) })` (result intentionally un-announced); `NativeMenuBar.onQuit(handler)` → `quitApp()`. JSDoc the 6.5 forward-reference (confirm-before-quit lands there).
- `src/domain/timerPresets.ts` -- NEW -- hoist `PRESET_MINUTES = [25, 45, 60] as const` out of `src/components/TimerDurationPicker.tsx:37`.
- `src/components/TimerDurationPicker.tsx:37` -- EDIT -- import `PRESET_MINUTES` from domain (UI → domain; delete the local copy).
- `src/components/Timer.tsx:148` -- EDIT -- re-point `PRESET_MINUTES[0]` import likewise (rendering unchanged).
- `App.tsx:29-32` -- EDIT -- mount effect also calls `startMenuBarActions()` (after `initializeMenuBar()`, mirroring the 6.2 FIFO-in-order comment).
- `macos/Frosthalt-macOS/MenuBar.swift:199-209` -- EDIT -- `handleShowWindow` performs activation: `NSApp.activate(ignoringOtherApps: true)` + `mainWindow?.makeKeyAndOrderFront(nil)` (nil-guarded). Add `quit() -> [String: Any]`: main-queue `NSApp.terminate(nil)` (after emitting nothing — JS already decided). `handleQuickStart`/`handleQuit` closures stay as-is.
- `macos/Frosthalt-macOS/NativeMenuBar.mm:104-107` -- EDIT -- bridge `quit` → the Swift impl (plain dictionary return — no struct lesson applies to void args; the :109-124 crash comment stays accurate).
- `src/domain/timerStore.ts`, `src/domain/store.ts:1038-1145` -- READ-ONLY -- the start path being reused: input guards :1052-1057, enqueued apply :1065-1144, admin prompt inside `writeHosts` :1110-1111.
- `src/components/Timer.tsx:418-474` -- READ-ONLY -- the reference gates/normalisations quick-start replicates.
- `macos/Frosthalt-macOS/AppDelegate.mm:85-96` -- READ-ONLY -- `NativeMenuBar` already in the module provider; no registration work.
- `__tests__/menuBarActions.test.ts` -- NEW -- handler registration/idempotency; quick-start args (durationMs, selected set), guard no-ops (live timer / running apply / empty domains), quit calls `quitApp`.
- `__tests__/menuBar.test.ts`, `__tests__/App.test.tsx` -- EDIT -- spec mock gains `quit`; event mocks return `({ remove: jest.fn() })` (App mount now subscribes).

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeMenuBarSpec.ts` -- add `quit(): MenuBarResult` -- codegen source of truth.
- [x] `src/native/menuBar.ts` -- add `quitApp()` wrapper -- keep the thin-adapter convention.
- [x] `src/domain/timerPresets.ts` + re-point `TimerDurationPicker`/`Timer` -- single-source the presets in the domain layer.
- [x] `src/domain/menuBarActions.ts` -- the three-event subscriber with guards and quick-start reuse.
- [x] `App.tsx` -- start actions on mount.
- [x] `macos/Frosthalt-macOS/MenuBar.swift` + `NativeMenuBar.mm` -- show-window activation + bridged `quit`.
- [x] Tests: new `menuBarActions.test.ts`; extend `menuBar.test.ts` / `App.test.tsx` mocks.

**Acceptance Criteria:**
- Given the menu is open and no session runs, when "Start 25-min focus" is clicked, then a 25-minute session starts over all committed domains through `stageStartTimer` (admin prompt included), and the badge mirror flips to the Blocked countdown without any window interaction.
- Given a session is live, an Apply is running, or no domains exist, then quick-start clicks are no-ops (store action never invoked).
- Given "Show window" is clicked while the app is in the background, then the main window comes to front and key, with no JS involvement.
- Given "Quit" is clicked, then the app terminates via the JS handler → native `quit()` (confirm is 6.5's).
- Given `node_modules/.bin/tsc --noEmit` and the full jest suite, then both pass.

## Design Notes

- "Last-used domain set" resolves to the Timer UI's own fallback (all committed domains): the app persists no selection outside a live session (`activeTimer.selectedDomains` dies with the session), and a menu quick-start typically happens while idle — so all-domains is both the only workable reading and parity with what Start does on first use. A persisted set would be a settings-schema addition → Ask First.
- Show-window stays native-on-click while Quick-start/Quit route through JS, asymmetrically on purpose: show-window is pure AppKit with nothing for JS to decide (no state, no gating), whereas quit's future confirm dialog must live in JS/DOM — so its decision point routes through JS now, and 6.5 only extends the handler.
- Quick-start results are intentionally not announced in the window: the menu bar is the feedback surface — the 6.2 mirror re-derives and flips the badge the moment `committed` changes (single source of truth, no new status channel). A quiet `{ok:false}` (admin deny, store error) just leaves the badge at Free, identical to how a denied in-window start leaves the header.
- Golden example: window hidden, 3 domains committed → "Start 25-min focus" → admin prompt allows → hosts rewritten → committed.activeTimer set → mirror pushes Blocked/25:00, ticking → "Show window" brings the window forward showing the live header → "Quit" → JS handler → `quit()` → app exits.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- PASSED (clean, 2026-08-29).
- `node_modules/.bin/jest --watchman=false` -- PASSED: 39 suites / 850 tests, 3 snapshots (2026-08-29). The new `menuBarActions.test.ts` contributes 11 tests: registration/idempotency + "Show window" never subscribed, quick-start args, three guard no-ops, malformed `endEpochMs` idle, event-time state read, quit routing (idle + live session), one integration pass through the REAL store start path (config write + exactly ONE hosts write).
- `xcrun swiftc -parse macos/Frosthalt-macOS/MenuBar.swift` -- parse-clean (syntax only; no link/type check against the generated header).

**Matrix audit (step-03):** every I/O row is covered by at least one ran+passed test — rows 1-4, 9 by the named tests above; rows 6-8 (quit unconditional, incl. Apply-running) by the quit tests (the handler has no guard distinguishing those states); rows 5 and 10 (show-window native activation, no-listener tolerance) are native/AppKit behavior verified via the "Show window never subscribed" JS test + the standing `pnpm macos` manual check below.

**Step-04 review patches (all applied, re-verified 2026-08-29):** (1) stale event JSDocs in `NativeMenuBarSpec.ts` rewritten to present-tense (quick-start/quit listened by `menuBarActions.ts`; show-window deliberately native-only, never listened); (2) `menuBarActions.test.ts` now derives `QUICK_START_MS` from the imported `PRESET_MINUTES[0]` instead of a hand-mirrored constant; (3) `MenuBar.swift` `handleShowWindow` deminiaturizes a Dock-minimized main window before ordering it front; (4) the App-mount test asserts `onQuickStart`/`onQuit` subscribed exactly once and `onShowWindow` never (dropping `startMenuBarActions()` from `App.tsx` now fails the suite); (5) trailing newlines added and prettier applied (single-quote style, repo-consistent) to the three new files. After the patch round: `tsc --noEmit` clean; jest 39 suites / 850 tests / 3 snapshots pass; `swiftc -parse` clean. Review found no frozen-intent deviation — no loopback, `review_loop_iteration` stays 0. Defers logged in `deferred-work.md`: standard quit paths (⌘Q/Dock/`applicationShouldTerminate:`) bypass the JS quit handler — 6.5's confirm must hook all terminate sources (and give the menu Quit its `⌘Q` equivalent); native-side behavior has no XCTest layer (manual verification only).

**Known left-over (expected, per spec):** the native build was NOT run (sandbox limitation) — the first `pnpm macos` regenerates the codegen protocol from the edited spec (that step makes the hand-written `- (NSDictionary *)quit` satisfy the generated `NativeMenuBarSpecSpec` protocol) and compiles the Swift/Obj-C changes. `swiftc -parse` is a syntax check only.

**Manual checks (run once locally outside the sandbox — same standing limitation as 6.1/6.2):**
- `pnpm macos` -- click each menu item: quick-start starts a session (admin prompt, badge flips live), with a session already running the item does nothing; "Show window" fronts the window from another app; "Quit" exits the app.

## Suggested Review Order

**The click-path design (entry point)**

- Entry point: the once-only installer — subscriptions, guard chain, and quit routing live here
  [`menuBarActions.ts:115`](../../src/domain/menuBarActions.ts#L115)

- Quick-start single-sources 25 min from the hoisted preset — menu value ties to the Timer chips by construction
  [`menuBarActions.ts:57`](../../src/domain/menuBarActions.ts#L57)

- Guard chain: event-time `getState()` + the three no-ops (empty / live session / Apply running)
  [`menuBarActions.ts:66`](../../src/domain/menuBarActions.ts#L66)

- Quit routes through JS on purpose — 6.5's confirm dialog extends exactly this handler
  [`menuBarActions.ts:126`](../../src/domain/menuBarActions.ts#L126)

**The contract (codegen source of truth)**

- `quit()` joins `initialize`/`setBadgeState` in the spec — codegen regenerates the protocol on next build
  [`NativeMenuBarSpec.ts:101`](../../src/native/specs/NativeMenuBarSpec.ts#L101)

- The three emitters, docs now present-tense: quick-start/quit listened, show-window deliberately native-only
  [`NativeMenuBarSpec.ts:112`](../../src/native/specs/NativeMenuBarSpec.ts#L112)

- Thin `quitApp()` forwarder — keeps the port adapter convention
  [`menuBar.ts:43`](../../src/native/menuBar.ts#L43)

**Native side**

- Show-window: AppKit activation with the review-patch `deminiaturize` for a Dock-minimized main window
  [`MenuBar.swift:224`](../../macos/Frosthalt-macOS/MenuBar.swift#L224)

- `quit()`: main-queue-dispatched `NSApp.terminate`, returns `{ok: true}`
  [`MenuBar.swift:140`](../../macos/Frosthalt-macOS/MenuBar.swift#L140)

- The struct-param crash lesson from 6.2 doesn't apply — no-arg bridge, plain dictionary
  [`NativeMenuBar.mm:146`](../../macos/Frosthalt-macOS/NativeMenuBar.mm#L146)

**Preset hoist (single source)**

- The hoisted constant — `PRESET_MINUTES` now lives in the domain layer
  [`timerPresets.ts:1`](../../src/domain/timerPresets.ts#L1)

- Components re-point to the domain import; rendering unchanged
  [`TimerDurationPicker.tsx:34`](../../src/components/TimerDurationPicker.tsx#L34)
  [`Timer.tsx:150`](../../src/components/Timer.tsx#L150)

**App wiring**

- The FIFO-ordered mount effect: initialize → mirror → actions, in that order
  [`App.tsx:32`](../../App.tsx#L32)

**Tests**

- Full click-path matrix + the real-store integration pass (one config write, ONE hosts write)
  [`menuBarActions.test.ts:326`](../../__tests__/menuBarActions.test.ts#L326)

- App-mount now asserts the subscriptions exactly once (verification-gap patch)
  [`menuBar.test.ts:153`](../../__tests__/menuBar.test.ts#L153)