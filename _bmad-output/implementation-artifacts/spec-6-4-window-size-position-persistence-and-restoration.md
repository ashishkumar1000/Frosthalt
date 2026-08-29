---
title: 'Window Size/Position Persistence and Restoration (Story 6.4)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: a1974f6
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The window opens at whatever size/position React Native's default gave it; nothing enforces min/max bounds, zoom fills the screen, and the app makes no own guarantee that size and position survive a relaunch — UX-DR18's "single utility window … size+position persisted and restored" is undelivered.

**Approach:** Persist the main window frame in `settings.windowFrame` (config.json via the existing ConfigStore port — AR-6 names window prefs as direct-commit, never /etc/hosts). Restore happens NATIVELY at launch (the window is on-screen before the JS bundle runs, so a JS-driven restore would visibly jump and ConfigStore reads only happen in JS). Persistence flows the established direction: native detects frame changes and emits `onWindowFrameChanged` → a domain subscriber commits via a new setPassword-style direct store action. Min/max bounds and a `windowShouldZoom`-overridden zoom (app-standard ⇄ user-custom) are AppKit properties set on the RN-created window. React Native's own frame autosave (`RCTAppDelegateMainWindow`) is switched off so config.json is the single persistence source.

## Boundaries & Constraints

**Always:**
- Frame lives at `settings.windowFrame` (new additive, OPTIONAL field: `{x, y, width, height}` numbers or absent). Missing field = never-persisted (NOT corrupt — first post-6.4 launch falls back to whatever RN's autosave already restored, one-shot migration). Corrupt (wrong types / non-finite / non-positive w or h) → native applies the pinned app-standard size and JS normalises the value to null at read. `configStore.ts`'s whole-config reject gate is NOT touched — a corrupt frame must never reject an otherwise-valid config (the `Schedule.domains` per-field-defensive precedent, types.ts).
- Restore path is native + launch-time: `WindowPersistence.attach()` called from `applicationDidFinishLaunching` AFTER `super` (window is on-screen; same-render-cycle setFrame = no visible jump). It reads config.json via a shared read helper refactored out of `ConfigStore.swift` — its PUBLIC contract and "dumb string adapter" behaviour are unchanged; the `settings.windowFrame` field-lookup is the deliberate, documented stretch (defensive numeric checks only, no schema knowledge).
- Persistence capture: observe `NSWindow.didEndLiveResizeNotification` + `NSWindow.didMoveNotification`, DEBOUNCED (one emission ~500 ms after the last change), then emit `onWindowFrameChanged{frame}` from the new TurboModule; the domain subscriber validates + fires `commitWindowFrame(frame)` at event time. `commitWindowFrame` copies `setPassword`'s exact discipline: shared serialised `enqueue`, re-read `committed` INSIDE the enqueue at run time, `writeConfig` ONLY (never `writeHosts`), `applyStatus` never flipped, on ok `set({committed: next})`, otherwise leave `committed` unchanged and return the envelope.
- RN's window frame autosave is disabled: `window.frameAutosaveName = ""` in `attach()` (AppKit stops writing `RCTAppDelegateMainWindow` to NSUserDefaults going forward; any legacy value is simply never read again).
- All four size constants (app-standard size, min, max) are single-sourced in `src/domain/windowFrame.ts` and passed to native by JS; native pins ONLY the standard-size fallback for the corrupt-restore case with a "must match `src/domain/windowFrame.ts`" comment (it runs before JS exists).
- New TurboModule follows the fixed shape: TS spec → codegen → Obj-C++ glue → Swift (`src/native/specs/NativeWindowSpec.ts`, `NativeWindow.mm`, `WindowPersistence.swift`) — mirror `NativeMenuBar` (adapter pattern, `{ok, error?}` envelopes, main-thread NSWindow mutations). Typed object params in the glue take the generated `JS::<Spec>::<Type> &` struct, never `NSDictionary *` (6.2's segfault lesson). Register in `AppDelegate.mm getModuleProvider:` + project.pbxproj by hand.
- Zoom: set a `WindowPersistence`-owned NSWindowDelegate implementing `windowShouldZoom(_:toFrame:) -> false` and instead setFrame to the toggle target (size swaps app-standard ⇄ user-custom, origin preserved) — zoom never reaches Apple's fill-the-screen zoom. The RN window has no delegate today, so owning it is safe. Zoom transitions suppress the capture path (a zoom must not overwrite the user's custom size; toggle state derives from frame-vs-standard comparison, not a stored flag).

**Ask First:**
- Any Settings-surface UI for window options, or wiring `menuBarEnabled`'s toggle in the same story (the new `commitWindowFrame` is the first `settings` writer — generalising it to a multi-field settings action is separate renegotiation).
- Persisting full-screen/collection-behavior state, or any multi-display workspace save/restore feature.

**Never:**
- No JS-driven frame application at launch (no `applyFrame-from-JS` on mount) — that restores after the window is shown.
- No changes to `ConfigStore`'s public `{ok, error?, data?}` contract, to `configStore.ts`'s whole-config gate, or to anything Apply/hosts-related.
- No storyboard edits, no removing/overriding RN's `loadReactNativeWindow:`, no styleMask `.fullScreen`, no app-restart/relaunch UX, no `LSUIElement` change.
- No frame capture during zoom, first-launch-with-no-saved-frame, or while the window is miniaturized/no-main-window states (nil-guard everything — the `handleShowWindow` lesson).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First launch after upgrading from pre-6.4 | config.json has no `settings.windowFrame`; RN autosave key exists | restore is SKIPPED (kept whatever RN's autosave restored — one-shot migration); `frameAutosaveName` cleared so autosave stops writing | N/A |
| Normal relaunch, valid frame | `settings.windowFrame` = 4 finite numbers, w/h > 0 | native setFrame before/with first paint — no visible jump; JS-side value loads unchanged | N/A |
| Corrupt frame | e.g. `{width: "big"}`, NaN, Infinity, negative/zero w or h, array, string | native: standard-size fallback applied; JS: `normaliseWindowFrame` → null (never crashes, never rejects the config in configStore) | treated as absent for writing; next real move persists a valid frame |
| Missing `settings` object entirely | malformed config | UNCHANGED pre-existing whole-config reject path in configStore — out of scope | per-field rule does not weaken the gate |
| Resize | live resize ends | didEndLiveResize observed → debounce (≈500 ms trailing) → ONE `onWindowFrameChanged` → `commitWindowFrame` writes config only | write failure → `{ok:false}` envelope, `committed` unchanged; no crash |
| Move (drag) | window dragged, possibly many intermediate frames | intermediate frames coalesced by the debounce — single write with the final frame | same as resize |
| Zoom on a custom (non-standard) frame | green button / titlebar double-click | setFrame to app-standard size, origin preserved; capture SUPPRESSED (custom size survives in settings) | capture suppression flag is cleared even if setFrame throws (no stuck suppression) |
| Zoom on standard frame | same | restores the last user-custom framing — the frame from the last persisted/committed state; if none exists, stays standard | N/A |
| Dragging beyond bounds | user drags edge past min/max | AppKit clamps live during the drag (minSize/maxSize) — drag stops, never snap-back | N/A |
| Resize while Apply running | `applyStatus === 'running'` | commitWindowFrame still commits (non-block-affecting, direct path — no Apply gate) | N/A |
| No main window / miniaturized | `NSApp.mainWindow` nil, attach before window available, zoom while docked | every window access nil-guarded; attach targets the RN main window instance captured at launch; debounce fires nothing without a frame | no crash (handleShowWindow lesson) |
| Double `startWindowFrameSync()` | StrictMode / remount | idempotent — configure + subscription once | N/A |
| Event before JS subscribes | native emits with zero JS listeners | harmless — codegen emitters tolerate zero listeners (6.1 contract) | N/A |


## Code Map

- `src/config/types.ts:52-98` -- EDIT -- add `Settings.windowFrame?: WindowFrame` ({x,y,width,height} numbers) + DEFAULT null; per-field-defensive precedent lives in the `Schedule.domains` comment just above.
- `src/config/configStore.ts:36-87,100-120` -- READ-ONLY -- the whole-config gate (settings non-null object) stays; per-field normalisation happens in the domain, not here.
- `src/domain/windowFrame.ts` -- NEW -- constants (WINDOW_RULES: min/max + app-standard), `normaliseWindowFrame(unknown) -> WindowFrame | null`, `startWindowFrameSync()` (installed-once; calls the native configure once, subscribes `onWindowFrameChanged` → event-time validate → `commitWindowFrame`).
- `src/domain/store.ts:479,991-1034` -- EDIT -- `commitWindowFrame(frame)` cloned from `setPassword`'s direct-commit template (declaration + AD-6 doc).
- `src/domain/store.ts:1802-1815` -- READ-ONLY -- the shared `enqueue`/`runChain` serialiser the action must use.
- `src/native/specs/NativeWindowSpec.ts` -- NEW -- `Spec { configureWindow(rules: WindowRules): WindowResult; onWindowFrameChanged: EventEmitter<WindowFramePayload> }`.
- `src/native/window.ts` -- NEW -- thin forwarder (mirror `src/native/menuBar.ts`).
- `App.tsx:29-36` -- EDIT -- add `startWindowFrameSync()` to the FIFO-ordered mount effect (after the menu-bar trio; ordering only guarantees install, no ordering hazard).
- `macos/Frosthalt-macOS/ConfigStore.swift:54-71` -- EDIT -- extract the JSON-read-into-NSDictionary internals into a shared, target-internal helper so `WindowPersistence` can reuse the same file path/parse without public-contract change.
- `macos/Frosthalt-macOS/WindowPersistence.swift` -- NEW -- `@objc(WindowPersistence)` singleton: `attach()` (find window, bounds + standard-size fallback if corrupt, autosave clear, delegate, notification observers); `windowShouldZoom` toggle; debounce; emits frame via a plumbable callback the TurboModule wires to the codegen emitter (mirror MenuBar's event plumbing).
- `macos/Frosthalt-macOS/NativeWindow.mm` -- NEW -- glue per the ConfigStore/MenuBar template (`getTurboModule:`, typed struct params).
- `macos/Frosthalt-macOS/AppDelegate.mm:17-26,76-96` -- EDIT -- call `attach()` after `super` in `applicationDidFinishLaunching`; add the provider branch.
- `macos/Frosthalt-macOS/WindowPersistence+File.swift` or same file -- the shared read helper consumer.
- `macos/Frosthalt-macOS.xcodeproj/project.pbxproj` -- hand-add the two new native files (the MenuBar.swift precedent, :43-47 of that file's header comment).
- `macos/Frosthalt-macOS/MenuBar.swift:224-242` -- READ-ONLY -- the nil-guarded window-access + main-thread dispatch idiom to copy.
- `__tests__/windowFrame.test.ts` -- NEW -- normalise guard tests; registration/idempotency; event→commit call-through (spy the action; invalid frame dropped); configure called once with the domain constants.
- `__tests__/store.test.ts`, `__tests__/menuBar.test.ts` -- EDIT -- commitWindowFrame cases (writeConfig-only, committed advance/hold, no applyStatus, no hosts); spec mocks gain the window module.

## Tasks & Acceptance

**Execution:**
- [x] `src/config/types.ts` -- add WindowFrame type + optional Settings.windowFrame + DEFAULT null -- additive schema per AR-15's settings extension point.
- [x] `src/domain/windowFrame.ts` -- new domain module: constants, normalise, start synced subscriber -- single source for sizes and the only JS→native configurator.
- [x] `src/domain/store.ts` -- `commitWindowFrame` direct-commit action -- first `settings` writer, setPassword discipline.
- [x] `src/native/specs/NativeWindowSpec.ts` + `src/native/window.ts` -- spec + thin adapter -- codegen source of truth.
- [x] `App.tsx` -- start the sync on mount -- mirrors the menu-bar FIFO pattern.
- [x] `macos/Frosthalt-macOS/ConfigStore.swift` -- extract internal read helper -- enables the launch-time native restore.
- [x] `macos/Frosthalt-macOS/WindowPersistence.swift` -- NEW -- attach/restore/zoom/debounce, corrupt→standard fallback, nil-guards.
- [x] `macos/Frosthalt-macOS/NativeWindow.mm` + `AppDelegate.mm` + project.pbxproj -- glue, provider, build wiring -- the fixed module shape.
- [x] Tests -- `windowFrame.test.ts` (matrix) + store/menuBar mock extensions -- jest-free proof of the JS half; native half is manual.

**Acceptance Criteria:**
- Given a resizing/moved window and quit, when the app relaunches, then the window restores to the last size and position before the first React paint.
- Given min/max rules configured, when the user drags the window edge or corner, then AppKit clamps inside the bounds (drag stops, not snap).
- Given the green/zoom button (or titlebar double-click), then the window toggles app-standard size ⇄ user-custom size, position preserved, and the validated frame change never writes /etc/hosts or flips applyStatus.
- Given a corrupt `settings.windowFrame` in config.json, when the app launches, then the window falls back to the app-standard size and the rest of the config (domains, schedules) still loads.
- Given `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/jest --watchman=false`, then both pass.

## Design Notes

- Why native restore: the RN window is created AND made key inside `applicationDidFinishLaunching` (RCTAppDelegate's `loadReactNativeWindow:`), before the JS bundle parses — so a JS restore would render default-then-jump. `attach()` after `super` lands in the same launch tick, and config.json is the one file that already exists with the data.
- Why clear RN's autosave: RN 0.81 already frame-autosaves/restores via the `RCTAppDelegateMainWindow` NSUserDefaults key. Leaving it on means two persistence layers that would fight (restored ⟶ overwritten ⟶ resaved on every move). We keep the RN-era stored frame as the one-shot matching state for users upgrading from pre-6.4 (field absent → we don't touch anything).
- Zoom is derived, not stored: the toggle compares the current frame against the app-standard constant within a 1pt tolerance, so no extra settings field and no desync. That is also why zoom intentionally does not emit a capture (committing a standard-size frame would destroy the user's custom size).
- Pinned sizes (planner decision, UX-DR18 leaves them numeric-free): app-standard 1280×720 (parity with what the app opens at today), min 880×560 (sidebar + status header fit comfortably), max 2560×1440. Adjusting them later is a one-line domain-constant change.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: clean exit 0.
- `node_modules/.bin/jest --watchman=false` -- expected: all suites pass, including the new windowFrame/store cases.
- `xcrun swiftc -parse macos/Frosthalt-macOS/WindowPersistence.swift` -- expected: parse-clean (syntax only).

**Manual checks (run once locally outside the sandbox — codegen protocol for the new module regenerates on first `pnpm macos`):**
- Move/resize the window, quit, relaunch → frame restored, no default-then-jump flash.
- Now drag past the bounds / attempt to shrink below them and back → clamped inside the min/max, no stuck state.
- Green/zoom button then resize to a custom size then zoom again → toggles standard ⇄ custom, never fills screen.
- Hand-edit config.json's `settings.windowFrame` to `"nonsense"` → app launches at the standard size, domains/schedules intact, and subsequent moves persist a fresh valid frame.
- Quit and relaunch again with a valid frame → restored (repeat-check that the commit path wrote a loadable frame).
- With a config.json lacking `settings.windowFrame` (pre-6.4 style), relaunch → RN-autosaved frame kept, no jump (upgrade-branch).

**Matrix audit (step-03):** all 14 rows are covered by at least one ran+passed test or by the named manual check above. Rows 3 (JS half: wrong-typed/non-finite/non-positive/non-plain-object/partial-field corrupt cases, 10, and the commit/drop seam rows (5-6, commitWindowFrame writeConfig-only + queued-behind-Apply race) are covered by `__tests__/windowFrame.test.ts` (12 tests) and the Story 6.4 cases in `__tests__/store.test.ts` (5 tests); rows 13-14 (double-start idempotency, zero-listener tolerance) by the idempotency test and the 6.1 codegen emitter contract. Rows 1-2, 3's native fallback half, 7-9, and 11 are native AppKit/restore-branch behavior with no jest layer — verified by the manual checks above (each manual bullet maps: relaunch→row 2, upgrade relaunch→row 1, corrupt hand-edit→row 3 native half + row 4, bounds drag→row 9, zoom→rows 7-8, App idle while live→row 10's non-interference, nil-guards→row 11). Nothing was edited to make a test agree with the matrix; `review_loop_iteration` remains 0.

**Step-04 review patches (all applied, re-verified 2026-08-29):** three reviewers (blind-hunter / edge-case / verification-gap) produced 24+8+3 raw findings → 9 patch items, 1 defer, rest rejected (platform-standard off-screen behaviour, spec-mandated native⇄JS corrupt asymmetry, repo-idiom duplication, parity with the fire-and-forget precedent). Applied: (1) `attach()` resolves the window as `mainWindow ?? keyWindow ?? autosave-name scan` (scan runs before the name is cleared) — a nil `mainWindow` can no longer silently disable the feature; (2) the zoom-suppression `defer` race is gone — suppression is now a self-clearing `suppressUntil` deadline (1.2 s ≥ debounce + animation) checked at debounce-fire, so neither zoom leg can commit over the custom size; (3) restored frames clamp into [min,max] via six pinned numbers (standard + min + max) under one must-match comment; (4) `shared` access is `NSLock`-guarded and the mm glue re-wires the emitter closure on every module creation (bridge-reload safe); (5) pending capture flushes on `willTerminateNotification` + main-window `willCloseNotification` (resize-then-⌘Q no longer loses the frame; no `applicationShouldTerminate:` — that stays 6.5's); (6) `startWindowFrameSync` sets `started` only after both installs succeed; (7) NO try/catch added around `writeConfig` in `commitWindowFrame` — `writeConfig` is a never-throw port and `setPassword` (the discipline to match) carries none either, so wrapping would diverge the pair (documented in a comment instead of code); (8) new tests: App-mount now asserts `configureWindow(WINDOW_RULES)` + `onWindowFrameChanged` on mount (deleting the App.tsx call fails the suite — reviewer-demonstrated gap closed), a drift-guard test reads `WindowPersistence.swift` via fs and asserts all six pinned literals equal `WINDOW_RULES`, a min≤standard≤max invariant test, and `flushMicrotasks` parity in the event-round-trip assertions; (9) hygiene: "three size pairs" wording unified, `debounceInterval` constant, `ConfigStoreFile.readRawConfig()` is now the single read path shared by `readConfig` (envelopes byte-identical), the skip-branch comment documents all not-a-dictionary paths, `deinit` removes observers. After the patch round: `tsc --noEmit` clean; jest 40 suites / 869 tests / 3 snapshots pass; `swiftc -parse` clean on WindowPersistence.swift and ConfigStore.swift. No frozen-intent deviation survived the triage — no loopback, `review_loop_iteration` stays 0.

## Spec Change Log


## Suggested Review Order

**Launch-time restore (the design intent — start here)**

- Entry point: window resolve (`mainWindow` → `keyWindow` → autosave-name scan) then a same-launch-tick native restore
  [`WindowPersistence.swift:135`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L135)

- Restored size clamps into [min,max] via six pinned numbers (hand-edited 1×1 / 5000×3000 can't survive a relaunch)
  [`WindowPersistence.swift:272`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L272)

- RN's own `RCTAppDelegateMainWindow` autosave cleared — config.json becomes the single persistence source
  [`WindowPersistence.swift:253`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L253)

- `attachShared` after `super` — the fix that puts restore inside the launch tick
  [`AppDelegate.mm:39`](../../macos/Frosthalt-macOS/AppDelegate.mm#L39)

**Zoom + capture (the frozen-boundary machinery)**

- `windowShouldZoom → false` + derived toggle: standard ⇄ custom, origin preserved, never screen-fill
  [`WindowPersistence.swift:435`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L435)

- Suppression is a self-clearing DEADLINE, not a defer — the review-patch fix for the animated-`setFrame` re-arm race
  [`WindowPersistence.swift:465`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L465)

- Debounce-fire gate: suppressUntil checked where capture actually emits; coalesces move/resize into one write
  [`WindowPersistence.swift:411`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L411)

- Termination flush — resize-then-⌘Q no longer loses the final frame (no `applicationShouldTerminate:` — 6.5's)
  [`WindowPersistence.swift:395`](../../macos/Frosthalt-macOS/WindowPersistence.swift#L395)

**JS contract (codegen source of truth)**

- `configureWindow(rules)` + the debounced `onWindowFrameChanged` emitter — the whole cross-layer surface
  [`NativeWindowSpec.ts:84`](../../src/native/specs/NativeWindowSpec.ts#L84)

- Thin forwarder, the 6.3 adapter convention
  [`window.ts:22`](../../src/native/window.ts#L22)

- mm glue: generated `JS::NativeWindowSpec::WindowRules &` struct param (6.2 lesson) + emitter closure re-wired on EVERY module creation (bridge-reload safe — review patch)
  [`NativeWindow.mm:99`](../../macos/Frosthalt-macOS/NativeWindow.mm#L99)

**Domain layer**

- The single source for the three size pairs (standard/min/max) JS hands native
  [`windowFrame.ts:64`](../../src/domain/windowFrame.ts#L64)

- `normaliseWindowFrame`: the per-field defensible guard — corrupt → null, never a config reject
  [`windowFrame.ts:94`](../../src/domain/windowFrame.ts#L94)

- Installed-once sync: configure native, subscribe, event-time validate → direct commit
  [`windowFrame.ts:155`](../../src/domain/windowFrame.ts#L155)

- `commitWindowFrame` — first `settings` writer, exact `setPassword` clone (writeConfig only, never hosts, applyStatus untouched)
  [`store.ts:1068`](../../src/domain/store.ts#L1068)

- Additive schema: optional `windowFrame`, per-field-defensive comment
  [`types.ts:85`](../../src/config/types.ts#L85)

**App wiring**

- One line in the FIFO mount effect — now pinned by test (see below)
  [`App.tsx:42`](../../App.tsx#L42)

**Native plumbing (peripherals)**

- `ConfigStoreFile.readRawConfig()` — the single read path, envelopes byte-identical (review-patch convergence)
  [`ConfigStore.swift:110`](../../macos/Frosthalt-macOS/ConfigStore.swift#L110)

- Provider branch + hand-added pbxproj entries (MenuBar precedent)
  [`AppDelegate.mm:108`](../../macos/Frosthalt-macOS/AppDelegate.mm#L108)
  [`project.pbxproj:24`](../../macos/Frosthalt.xcodeproj/project.pbxproj#L24)

**Tests**

- App-mount assertions: `configureWindow(WINDOW_RULES)` verbatim + subscription — deleting the App.tsx call now fails the suite
  [`menuBar.test.ts:197`](../../__tests__/menuBar.test.ts#L197)

- Constant-drift guard: jest reads the Swift pinned literals and asserts they equal `WINDOW_RULES`
  [`windowFrame.test.ts:145`](../../__tests__/windowFrame.test.ts#L145)

- The `commitWindowFrame` block: writeConfig-only discipline, queued-behind-Apply race, committed advance/hold
  [`store.test.ts:1465`](../../__tests__/store.test.ts#L1465)
