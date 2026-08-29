---
title: 'MenuBar TurboModule (NSStatusItem + NSMenu) (Story 6.1)'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
baseline_commit: c6eb6bdc19f45ad864a43566438ce0058a644169
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing in the app owns a system menu-bar presence — the two existing native modules (ConfigStore, ShellRunner) only handle config I/O and privileged hosts writes, and no TurboModule in this codebase has ever emitted an event to JS, so there is no way yet to glance block state or act on Frosthalt without the main window.

**Approach:** Add a third native TurboModule (`NativeMenuBar`) that builds one `NSStatusItem` + `NSMenu` on an idempotent `initialize()` call — a placeholder badge/countdown label row, a separator, then "Start 25-min focus" / "Show window" / "Quit" — and fires a dedicated codegen `EventEmitter<void>` per actionable item on click. Live badge/countdown content (6.2) and actual click handling (6.3) are out of scope; this story only stands up the module, the menu skeleton, and the event-emission plumbing, and calls it once from app startup.

## Boundaries & Constraints

**Always:**
- One `NSStatusItem` + one `NSMenu`, both created inside `initialize()`, guarded by a private `isInitialized` flag — a second call is a no-op returning `{ok:true}`.
- Menu order top-to-bottom: disabled placeholder label row ("Free · no active timer" — 6.2 swaps the text, not the item), separator, "Start 25-min focus", "Show window", "Quit".
- All `NSStatusItem`/`NSMenu` creation and mutation dispatched onto the main thread.
- Each actionable item fires the matching codegen `EventEmitter<void>` (`onQuickStart` / `onShowWindow` / `onQuit`) — no payload, no JS listener needs to exist yet.
- Match the two existing modules' conventions: TS spec uses `type` (never `interface`) for the `{ok, error?}` alias; files named `NativeMenuBar.mm` / `MenuBar.swift`; Swift class `@objc(NativeMenuBar) final class MenuBar: NSObject`; `AppDelegate.mm` gets the third branch its own comment already reserves.
- `App.tsx` calls a new `initializeMenuBar()` wrapper exactly once on mount.
- `Info.plist` keeps no `LSUIElement` key.

**Ask First:**
- Status-item glyph/asset — default to a plain text title if no icon asset exists; confirm before adding new asset files.

**Never:**
- No live badge/countdown wiring (6.2) or click-handling logic (6.3) — emitted events may stay unlistened here.
- No window persistence (6.4), no ⌘W/⌘Q bindings (6.5).
- No edits to `ConfigStore.swift`/`.mm` or `ShellRunner.swift`/`.mm`, no `codegenConfig`/Podfile changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First `initialize()` call | app launch | status item + menu created on main thread, returns `{ok:true}` | N/A |
| Second `initialize()` call | already initialized | no duplicate status item, returns `{ok:true}` | N/A |
| Click "Start 25-min focus" | menu open | JS receives `onQuickStart` (no payload) | N/A |
| Click "Show window" | menu open | JS receives `onShowWindow` | N/A |
| Click "Quit" | menu open | JS receives `onQuit` | N/A |
| App mounts | `App.tsx` render | `initializeMenuBar()` called exactly once | N/A |

</frozen-after-approval>

## Code Map

- `src/native/specs/NativeConfigStoreSpec.ts:1-66` -- READ-ONLY -- pattern to mirror: sync methods, `type` alias for the result shape, `TurboModuleRegistry.getEnforcing` default export.
- `src/native/specs/NativeMenuBarSpec.ts` -- NEW -- `initialize(): {ok: boolean; error?: string}` + `readonly onQuickStart/onShowWindow/onQuit: EventEmitter<void>` — first event-emitter TurboModule in the repo, no existing JS-side precedent.
- `package.json:14-18` -- READ-ONLY -- `codegenConfig` already scans `src/native/specs`; auto-discovers the new spec, no edit needed.
- `macos/Frosthalt-macOS/NativeConfigStore.mm:39-97` -- READ-ONLY -- structural template: class/`RCT_EXPORT_MODULE`/`getTurboModule:`/`dispatch_once` Swift singleton/method bridge.
- `macos/Frosthalt-macOS/NativeMenuBar.mm` -- NEW -- mirrors that template; bridges `initialize()` to Swift and forwards each menu-click callback to `emitOnQuickStart`/`emitOnShowWindow`/`emitOnQuit`.
- `macos/Frosthalt-macOS/ConfigStore.swift:1-113` -- READ-ONLY -- `@objc(NativeConfigStore) final class` structural template.
- `macos/Frosthalt-macOS/MenuBar.swift` -- NEW -- `@objc(NativeMenuBar) final class MenuBar: NSObject` owning the `NSStatusItem`/`NSMenu`; `initialize()` builds it on `dispatch_async(main)`, idempotent via `isInitialized`; item target/actions forward to the `.mm` emit bridge.
- `macos/Frosthalt-macOS/AppDelegate.mm:74-89` -- EDIT -- add the `NativeMenuBar` branch its own comment reserves.
- `macos/Frosthalt-macOS/Info.plist` -- VERIFY -- no `LSUIElement` key present; do not add one.
- `src/native/menuBar.ts` -- NEW -- thin `initializeMenuBar()` wrapper calling the spec's `initialize()`.
- `App.tsx:11-24` -- EDIT -- add a mount-only `useEffect` calling `initializeMenuBar()`.
- `__tests__/configStore.test.ts:21-55` -- READ-ONLY -- `jest.mock` pattern to mirror (no `__mocks__` dir; mocks are inline per-file).
- `__tests__/menuBar.test.ts` -- NEW -- mock `NativeMenuBarSpec`; assert `initializeMenuBar()` forwards/returns correctly and mounting `<App/>` calls it exactly once.

## Tasks & Acceptance

**Execution:**
- [x] `src/native/specs/NativeMenuBarSpec.ts` -- create the TS spec (`initialize()` + 3 `EventEmitter<void>` properties) -- codegen source of truth.
- [x] `macos/Frosthalt-macOS/MenuBar.swift` -- create the Swift class owning the status item/menu, idempotent `initialize()`, main-thread dispatch, 3 target/action selectors -- native business logic.
- [x] `macos/Frosthalt-macOS/NativeMenuBar.mm` -- create the Obj-C++ bridge (spec-base subclass, `RCT_EXPORT_MODULE`, `dispatch_once` Swift singleton, `initialize()` bridge, emit forwarding) -- TurboModule glue.
- [x] `macos/Frosthalt-macOS/AppDelegate.mm` -- add the `NativeMenuBar` branch to `getModuleProvider:` -- module registration.
- [x] `src/native/menuBar.ts` -- create `initializeMenuBar()` -- JS entry point.
- [x] `App.tsx` -- call `initializeMenuBar()` once on mount -- wires the module into app startup.
- [x] `__tests__/menuBar.test.ts` -- mock the native spec, test the wrapper and mount-once behavior -- unit coverage for the JS-testable half.

**Acceptance Criteria:**
- Given a TypeScript spec and codegen, when MenuBar is implemented, then it owns one `NSStatusItem` + one `NSMenu` containing the placeholder label row, a separator, and the three actionable items.
- Given `initialize()` is called more than once, then no duplicate status item is created and both calls return `{ok:true}`.
- Given any of the three actionable items is clicked, then the matching `EventEmitter` fires to JS with no payload, from the main thread.
- Given `node_modules/.bin/tsc --noEmit` and the full jest suite (native specs mocked), then both pass.
- Given the app launches, then `Info.plist` still has no `LSUIElement` key and the Dock icon, main window, and menu-bar item all appear together.

## Design Notes

- A disabled placeholder row (not live content) keeps this story scoped to the module + menu skeleton; 6.2 swaps in the Zustand-driven badge/countdown without touching this structure.
- Three separate `EventEmitter<void>` (vs. one emitter + an action string) match RN's New Architecture codegen typed-event convention and let 6.3 subscribe to each independently.
- Golden example: app launches → mount effect calls `initializeMenuBar()` → native `initialize()` builds the status item once → user opens the icon, sees the 5-row menu, clicks "Show window" → `onShowWindow` fires to JS (unlistened here; 6.3 adds the handler). NSMenu clicks aren't Jest-drivable, so this path is verified manually.

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: no type errors.
- `node_modules/.bin/jest --watchman=false` -- expected: full suite green, no regressions; record actual counts.

**Manual checks:**
- `pnpm macos` -- launch, confirm a menu-bar icon appears alongside the Dock icon and window; open the menu, confirm all 5 rows render and each of the 3 actionable items is clickable without crashing; trigger `initialize()` twice (e.g. reload) and confirm no second status item appears.
- **Not run this session** (sandbox cannot create Xcode's DerivedData/build-log stores even under a redirected, allow-listed path — two independent `xcodebuild` attempts both failed on `Operation not permitted` before compiling a single source file, unrelated to the new code). `tsc`/`jest` are green and a code-review pass found no defects, but the actual native build + the manual checks above are unverified and should be run once, locally, outside this sandbox.

## Suggested Review Order

**The TurboModule contract**

- New codegen contract: `initialize()` plus the repo's first three event emitters (`onQuickStart`/`onShowWindow`/`onQuit`).
  [`NativeMenuBarSpec.ts:47`](../../src/native/specs/NativeMenuBarSpec.ts#L47)

**Native menu construction (Swift)**

- `initialize()` dispatches the build onto the main thread and returns `{ok:true}` immediately — fire-and-forget, no I/O to fail.
  [`MenuBar.swift:79`](../../macos/Frosthalt-macOS/MenuBar.swift#L79)

- Idempotent skeleton build: placeholder row, separator, three actionable items — guarded by `isInitialized`, evaluated only on the main thread.
  [`MenuBar.swift:91`](../../macos/Frosthalt-macOS/MenuBar.swift#L91)

- Each menu click forwards to a plain closure rather than touching JSI directly — keeps this class ignorant of TurboModule/JSI.
  [`MenuBar.swift:136`](../../macos/Frosthalt-macOS/MenuBar.swift#L136)

**Obj-C++ bridge and event wiring**

- `dispatch_once` Swift singleton wires each closure to the codegen `emitOn...` methods exactly once, matching the ConfigStore/ShellRunner template.
  [`NativeMenuBar.mm:77`](../../macos/Frosthalt-macOS/NativeMenuBar.mm#L77)

- `getTurboModule:` returns the codegen JSI wrapper — without it `initialize` would resolve as `undefined` on the JS side.
  [`NativeMenuBar.mm:63`](../../macos/Frosthalt-macOS/NativeMenuBar.mm#L63)

- `AppDelegate.mm` gets the third module-name branch, the exact slot its own comment reserved for MenuBar.
  [`AppDelegate.mm:87`](../../macos/Frosthalt-macOS/AppDelegate.mm#L87)

**App wiring**

- Mount-only effect calls `initializeMenuBar()` exactly once so the status item exists as soon as the app launches.
  [`App.tsx:23`](../../App.tsx#L23)

- Thin JS wrapper forwards to the native spec untouched — no shape logic needed since `initialize()` takes no payload.
  [`menuBar.ts:19`](../../src/native/menuBar.ts#L19)

**Peripherals**

- Xcode project registration for the two new native files, mirroring the existing ConfigStore/ShellRunner entries.
  [`project.pbxproj:82`](../../macos/Frosthalt.xcodeproj/project.pbxproj#L82)

- JS-testable coverage: wrapper forwarding + mount-once behavior (NSMenu clicks themselves aren't Jest-drivable).
  [`menuBar.test.ts`](../../__tests__/menuBar.test.ts)
