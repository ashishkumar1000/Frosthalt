---
title: 'Quit-with-confirm and close-to-menu-bar keyboard bindings (Story 6.5)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: 1c04659
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** ⌘W and the red close button terminate Frosthalt entirely today (no `applicationShouldTerminateAfterLastWindowClosed:` override; Info.plist opts into automatic/sudden termination), so "close to menu bar" kills the running session. Separately, ⌘Q/Dock-quit bypass the JS quit handler (no `applicationShouldTerminate:`), so the quit-confirm deferred from 6.3 cannot exist anywhere.

**Approach:** Make `applicationShouldTerminate:` the single arbitration point: any quit attempt (⌘Q, Dock, storyboard/menu Quit, JS `quitApp()`) that is not yet JS-confirmed gets cancelled and re-raised as an `onQuitRequested` event. `menuBarActions.ts` — the timer-state owner — answers it: no live session → resume termination via a new `confirmQuit()`; live session → bring the window forward and show the repo's standard two-button `Alert.alert` confirm. `⌘W` itself is already wired in the storyboard; keeping the app alive is just the delegate override plus disabling the two auto-quit plist vectors.

## Boundaries & Constraints

**Always:**
- ALL terminate sources funnel through the new `applicationShouldTerminate:` (AppDelegate.mm) → Swift gate: quit already confirmed → consume the confirmed flag, return terminate (and reset the flag so the gate re-arms for next time); not confirmed → emit `onQuitRequested`, return cancel. Fail-open: if the event closure is nil (quit before JS subscribes) → terminate — a quitting app must never be bricked by a missing bridge.
- The confirm decision lives in JS, read at event time via `useDomainStore.getState()` (menuBarActions.ts:67 pattern). Gate = live session only (`committed.activeTimer != null` with finite `endEpochMs`, the Timer.tsx:191-196 normalisation). `applyStatus === 'running'` does NOT trigger the confirm — host writes are atomic (6.3 matrix).
- No-timer quit must not front the window or flash a dialog: JS calls `confirmQuit()` directly. `presentQuitConfirm()` (activate + deminiaturize + order main window front) is invoked only when a dialog is about to show.
- Dialog reuses the two-button `Alert.alert` shape (Blocklist.tsx:106-121 / Schedule.tsx:133-146 pattern): `Cancel` style `cancel` first, `Quit` style `destructive`. Esc dismisses via the native sheet's cancel mapping — no new JS keyboard listeners. Copy: plain, factual (state the situation and the choice; epic-6 UX rule — no dramatization).
- `confirmQuit()` terminates via `NSApp.terminate` only (never `exit()`/`os_crash`) so 6.4's `willTerminateNotification` frame flush still runs.
- Info.plist keys touched are exactly two: `NSSupportsAutomaticTermination=false`, `NSSupportsSuddenTermination=false` (the auto-quit/SIGKILL vectors that would skip `applicationShouldTerminate:` and the flush).
- Re-entrancy is flag-based: the JS-issued `NSApp.terminate` ride through the same delegate method with the flag set before the call. No bypass path.

**Ask First:**
- Any global hot-key registration (Carbon/NNAPI) or a JS-level keyboard listener — bindings stay AppKit menu key-equivalents.
- Replacing the JS Alert with a native NSAlert, or changing 6.4's close/terminate flush ordering.

**Never:**
- No background daemon — quitting ends all enforcement (epic-6 constraint).
- No new menu items, no reordering, no dynamic enable/disable of menu items, no changes to 6.2's rendering.
- No edits to ConfigStore/ShellRunner, `codegenConfig`, or Podfile.
- No JS/React-tree teardown on window close; window close never destroys state.
- Beyond extracting the fronting helper and the plist keys, no changes to 6.4's frame-capture logic.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ⌘W / red button, live timer | `performClose:` → last window closes | app stays alive in the menu bar; session keeps ticking; badge mirror continues; "Show window" re-fronts it | N/A |
| ⌘W, no timer | last window closes with no live session | app stays alive (delegate override); status item remains sole surface | N/A |
| ⌘Q, live timer | storyboard Quit (Main.storyboard:50-52) → `terminate:` → shouldTerminate | window fronted + `onQuitRequested` → plain confirm Alert; Esc/Cancel → terminate cancelled, app alive, pending flag reset | N/A |
| ⌘Q, no timer | same path | JS calls `confirmQuit()` immediately — no dialog, no window flash; flag set → terminate proceeds | N/A |
| Menu-bar "Quit", live timer | `onQuit` → `quitApp()` → `NSApp.terminate` → same delegate gate | confirm Alert, exactly one | N/A |
| Dock quit | Dock terminate → same gate | behaves as ⌘Q | N/A |
| Confirm pressed | dialog "Quit" button | pending reset + `confirmQuit()` → flag → terminate → 6.4 willTerminate flush runs | N/A |
| Double ⌘Q while dialog open | second terminate attempt mid-dialog | pending guard: no second dialog; second attempt cancels | N/A |
| Re-quit after confirm/cancel | a later ⌘Q with a live timer | gate re-armed (flag reset) — dialog returns | N/A |
| Quit before JS subscribes | nil event closure (startup window) | fail-open: terminate proceeds | N/A |
| Apply running + quit | `applyStatus==='running'`, no live timer | quits unconditional (no confirm; hosts left consistent by the apply pipeline) | N/A |

</frozen-after-approval>

## Code Map

- `macos/Frosthalt-macOS/AppDelegate.mm:19-118` -- EDIT -- add `applicationShouldTerminateAfterLastWindowClosed:` → NO; add `applicationShouldTerminate:` → `MenuBar.handleShouldTerminate()` (same Swift-call precedent as `[WindowPersistence attachShared]` at :39). Siblings of `applicationDidFinishLaunching`; provider/attach code untouched.
- `macos/Frosthalt-macOS/MenuBar.swift:62-64,139-146,199-216,224-242` -- EDIT -- add `@objc var onQuitRequested` closure (next to :62-64). Keep `quit()` (:139-146) as-is — it is now just a quit *entry*. Add: `handleShouldTerminate() -> Bool` (flag set → consume flag, return true; flag set to false after consuming; closure nil → return true (fail-open); else emit `onQuitRequested`, return false), `confirmQuit() -> [String: Any]` (set flag, main-queue `NSApp.terminate(nil)`, return `{ok:true}`), `presentQuitConfirm() -> [String: Any]` (main-queue call the new WindowPersistence fronting helper). Status-bar "Quit" item (:206) gains `keyEquivalent: "q"` + `.command` modifier mask — display parity only; the storyboard item owns real key handling.
- `macos/Frosthalt-macOS/WindowPersistence.swift:240-243,315-334,390-401` -- EDIT (helper only) / READ-ONLY -- add static `bringMainWindowToFront()` using the existing window resolution (:240-243 `mainWindow ?? keyWindow ?? autosave scan`) + the deminiaturize/activate body from MenuBar.swift:224-242 (dedupe; both callers use it). The close/terminate observers (:321-334) and `flushPendingCapture` (:390-401) are 6.4's and must keep running — the comment at :315-320 explicitly reserves this story.
- `src/native/specs/NativeMenuBarSpec.ts:101,131` -- EDIT -- add `confirmQuit(): MenuBarResult` + `presentQuitConfirm(): MenuBarResult` (after `quit()`) and `onQuitRequested: CodegenTypes.EventEmitter<void>` (spec-order after `onQuit`). Codegen regenerates on next build.
- `src/native/menuBar.ts:53-56` -- EDIT -- thin forwarders `confirmQuit()`, `presentQuitConfirm()` (no JS logic).
- `src/domain/menuBarActions.ts:38-41,79-86,115-129` -- EDIT -- in `startMenuBarActions()` subscribe `onQuitRequested`: module-level `quitDialogPending` guard; no live session → `confirmQuit()` (no dialog); live session → `presentQuitConfirm()` then `Alert.alert(title, body, [Cancel → reset pending, Quit → reset pending + confirmQuit()])`. Update 6.3's forward-reference JSDoc (:38-41, :121-125).
- `macos/Frosthalt-macOS/NativeMenuBar.mm:77-96,104-149` -- EDIT -- bridge the two new methods (plain-dict returns, void-arg — no struct lesson applies); wire the `onQuitRequested` closure per module creation (the NativeWindow.mm:76-85 bridge-reload re-wire pattern, NOT dispatch_once).
- `macos/Frosthalt-macOS/Info.plist:42-45` -- EDIT -- `NSSupportsAutomaticTermination` and `NSSupportsSuddenTermination` → `false`.
- `__tests__/menuBarActions.test.ts:42,50-55,115-123,299-319` -- EDIT -- mocks gain the two methods + event; flip the 6.3 "quit unconditional while live" expectation (:306-319); new handler tests per matrix.
- `__tests__/menuBar.test.ts:17-29`, `__tests__/App.test.tsx:34-47` -- EDIT -- spec mocks gain the new surface; App-mount asserts `onQuitRequested` subscribed exactly once (the 6-4 App-mount assertion style).
- Main.storyboard:50-52,86-88 -- READ-ONLY -- ⌘Q/⌘W already wired; no storyboard edits.

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeMenuBarSpec.ts` -- add 2 methods + 1 event -- codegen source of truth.
- [x] `src/native/menuBar.ts` -- 2 thin forwarders -- keep the port-adapter convention.
- [x] `MenuBar.swift` -- gate/confirm/present + flag + closure + Quit keyEquivalent, per Code Map -- the native quit gate.
- [x] `WindowPersistence.swift` -- extract static fronting helper; point `handleShowWindow` at it -- dedupe the activation body.
- [x] `NativeMenuBar.mm` -- bridge 2 methods; re-wire the new emitter per module creation -- bridge + reload survival.
- [x] `AppDelegate.mm` -- 2 delegate overrides -- the single terminate hook + close-keeps-alive.
- [x] `Info.plist` -- 2 keys false -- kill the auto-quit vectors.
- [x] `src/domain/menuBarActions.ts` -- the JS arbitration handler -- confirm decision in JS.
- [x] tests (`menuBarActions.test.ts`, `menuBar.test.ts`, `App.test.tsx`) -- matrix coverage + mount wiring.

**Acceptance Criteria:**
- Given a live session, when the window is closed (⌘W or red button), then the app stays in the menu bar with the timer ticking, and "Show window" re-fronts it.
- Given a live session and a quit from any source (⌘Q, Dock, either Quit item), then one plain confirm appears; Esc/Cancel keeps the app running; confirming quits and the 6.4 terminate flush still fires.
- Given no live session and a quit from any source, then the app quits immediately with no dialog and no window coming to front.
- Given a duplicate quit attempt while the dialog is open, then nothing double-fires; the gate re-arms afterwards.
- Given `node_modules/.bin/tsc --noEmit` and the full jest suite, then both pass.

## Design Notes

- **One arbitration point, JS decides.** Funneling every quit source through `applicationShouldTerminate:` is what actually repairs 6.3's defer: the storyboard's ⌘Q, Dock-quit, and the JS `quitApp()` path all run the same gate, so the confirm cannot be bypassed and cannot double-fire. The flag-based re-entrancy (set flag → `NSApp.terminate` → delegate sees flag → consume+reset → proceed) is the landmine avoided: without it, the JS-issued confirm termination would re-enter the same gate and loop.
- **Fail-open vs fail-closed:** a quit that must wait for JS which never arrives would make the app unquittable. Nil-closure → terminate. The JS-side pending guard (`quitDialogPending`) covers the mirror-image edge (two terminate attempts racing into one dialog).
- **Window fronting before the dialog:** RN macOS `Alert.alert` presents as a sheet on the RN window (Blocklist.tsx:106-121), which is invisible when the window is `orderOut` — hence `presentQuitConfirm()` runs before the Alert and only then. The no-timer path skips it so ⌘Q never flashes the window.
- **Plist keys:** `NSSupportsAutomaticTermination=true` lets the system terminate an app it deems idle once its windows close — an auto-quit vector that would break ⌘W entirely. `NSSupportsSuddenTermination=true` permits SIGKILL-style termination that skips both `applicationShouldTerminate:` and `willTerminateNotification`, breaking the confirm AND 6.4's flush. Both go off.
- Golden example: timer at 14:52 → ⌘W (window closes, status item still shows Blocked/14:51) → ⌘Q → window fronts, confirm "A focus session is running…" → Esc → nothing quits → ⌘Q again → "Quit" → app exits, hosts left as-is (blocks persist by design), window frame flushed.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- clean.
- `node_modules/.bin/jest --watchman=false` -- all suites pass, including the updated quit-routing tests.
- `xcrun swiftc -parse macos/Frosthalt-macOS/MenuBar.swift && xcrun swiftc -parse macos/Frosthalt-macOS/WindowPersistence.swift` -- parse-clean (syntax only).

**Manual checks (once, outside the sandbox; the first `pnpm macos` regenerates codegen for the new spec members):**
- mid-session: ⌘W → window closes, badge keeps counting down in the menu bar; "Show window" re-fronts it; ⌘Q → confirm appears; Esc → alive; ⌘Q → Quit → exits; no-session: ⌘Q quits instantly with no window flash; double ⌘Q mid-dialog does not stack dialogs.

## Spec Change Log

## Suggested Review Order

**The native quit gate — one arbitration point**

- Every quit source lands here; the Bool→enum mapping is load-bearing (enum values are inverted against Bool — do not "simplify" to a raw BOOL return).
  [`AppDelegate.mm:81`](../../macos/Frosthalt-macOS/AppDelegate.mm#L81)

- The gate itself: confirmed-flag consume+reset, fail-open on nil closure, emit + cancel otherwise. Base delegate implements neither terminate selector (checked) — noted in the comment.
  [`MenuBar.swift:246`](../../macos/Frosthalt-macOS/MenuBar.swift#L246)

- The restored `quit()` entry: a TurboModule forward that rides through this same gate (it was deleted by mistake in the first pass — NativeMenuBar.mm still bridges it).
  [`MenuBar.swift:278`](../../macos/Frosthalt-macOS/MenuBar.swift#L278)

**The JS confirm decision**

- Event-time store read, live-session-only gate, staleness-windowed pending guard (10 s orphaned-guard recovery — a sheet killed without a button press must not brick quitting).
  [`menuBarActions.ts:181`](../../src/domain/menuBarActions.ts#L181)

- No-timer quit skips fronting/dialog entirely; the confirm goes only when a dialog is about to show.
  [`menuBarActions.ts:160`](../../src/domain/menuBarActions.ts#L160)

**Bridge + module lifecycle**

- Emitter closures re-wired per module creation, all under one lock (JSI-thread writes vs main-thread reads in the gate).
  [`NativeMenuBar.mm:102`](../../macos/Frosthalt-macOS/NativeMenuBar.mm#L102)

- `-invalidate` nils the closures on bridge reload so the fail-open, not a stale non-nil closure, is what the gate sees until JS re-subscribes.
  [`NativeMenuBar.mm:130`](../../macos/Frosthalt-macOS/NativeMenuBar.mm#L130)

- Attach/detach + the lock snapshot in `handleShouldTerminate` (emit fires outside the lock).
  [`MenuBar.swift:120`](../../macos/Frosthalt-macOS/MenuBar.swift#L120)

**Window fronting**

- Fronts the RN window synchronously before returning — the sheet is window-attached and invisible on an ordered-out window; an async dispatch raced the Alert.
  [`MenuBar.swift:321`](../../macos/Frosthalt-macOS/MenuBar.swift#L321)

- The shared activation/fronting body both quit-confirm and Show-window use.
  [`WindowPersistence.swift:176`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L176)

**Close-to-menu-bar + reopen**

- ⌘W / red button keep the app alive (kills the auto-termination default).
  [`AppDelegate.mm:48`](../../macos/Frosthalt-macOS/AppDelegate.mm#L48)

- Dock click re-fronts the window — a path this story itself makes reachable.
  [`AppDelegate.mm:95`](../../macos/Frosthalt-macOS/AppDelegate.mm#L95)

- Both auto-quit vectors off so they can't skip the gate or the 6.4 flush.
  [`Info.plist:42`](../../macos/Frosthalt-macOS/Info.plist#L42)

**TurboModule contract + tests (peripherals)**

- New spec surface: 2 methods + 1 event (codegen regenerates on the first `pnpm macos`).
  [`NativeMenuBarSpec.ts:113`](../../src/native/specs/NativeMenuBarSpec.ts#L113)

- Thin forwarders, port-adapter convention.
  [`menuBar.ts:56`](../../src/native/menuBar.ts#L56)

- Matrix coverage incl. confirm-routes-Quit and the stale-guard recovery test.
  [`menuBarActions.test.ts:389`](../../__tests__/menuBarActions.test.ts#L389)

- Source drift-guards pinning the native gate invariants jest can't otherwise reach.
  [`menuBarActions.test.ts:634`](../../__tests__/menuBarActions.test.ts#L634)

- App-mount wires `onQuitRequested` exactly once.
  [`App.test.tsx:82`](../../__tests__/App.test.tsx#L82)