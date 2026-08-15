---
title: 'ConfigStore TurboModule and config shape'
type: 'feature'
created: '2026-08-15'
status: 'done'
review_loop_iteration: 0
baseline_commit: '086308fc2c317f6ee8d731ad150d5e5ba6adeeed'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-Frosthalt-2026-08-13/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no persistent config yet — every later epic (Blocklist, Timer, Schedule, the Apply pipeline) needs `config.json` to be the canonical, revocable source of truth, and Hermes has no Node `fs` at runtime so persistence must go through a native adapter.

**Approach:** Build the unprivileged `ConfigStore` TurboModule — a TS spec → codegen → Obj-C++ + Swift adapter that reads/writes `~/Library/Application Support/Frosthalt/config.json` atomically — plus the full AR-15 config shape as TS types and a thin stateless typed JS port that owns JSON parse/serialize and the missing/corrupt→empty resilience. No Zustand, no domain layer, no UI (those land in 1.6 / Epic 2+).

## Boundaries & Constraints

**Always:**
- TS spec at `src/native/specs/NativeConfigStoreSpec.ts`: `import type { TurboModule } from 'react-native'` + `export interface Spec extends TurboModule` + `export default TurboModuleRegistry.getEnforcing<Spec>('NativeConfigStore')`. Two methods: `readConfig(): ConfigResult` (data = raw file string, or null when the file is missing) and `writeConfig(json: string): ConfigResult` (no data). `ConfigResult = { ok: boolean; error?: string; data?: string }`.
- Enable app-level codegen via a `codegenConfig` block in `package.json` (`{ name: 'FrosthaltSpecs', type: 'modules', jsSrcsDir: 'src/native/specs' }`). New Arch is already on by default — do NOT set `RCT_NEW_ARCH_ENABLED=0`.
- Native impl in `macos/Frosthalt-macOS/`: `NativeConfigStore.mm` (Obj-C++, `RCT_EXPORT_MODULE(NativeConfigStore)`, conforms to the codegen-generated spec protocol) + `ConfigStore.swift` (`@objc(NativeConfigStore)`, the real logic), glued via the `-Swift.h` import + the Xcode-generated bridging header (this is the first Swift file in the macOS target → Xcode creates `Frosthalt-macOS-Bridging-Header.h`).
- Config path: `~/Library/Application Support/Frosthalt/config.json` resolved via `NSSearchPathForApplicationSupportDirectory`. Write is atomic: write to a temp file then rename. A missing `Frosthalt` directory is created on write.
- Native is a dumb string-file adapter: it does NOT know the config shape, does NOT parse/validate JSON. It returns the raw file string (or null if missing) on read; it writes the string it's given on write. Every native method returns `{ ok, error?, data? }` over JSI (AC 4).
- TS config shape (`src/config/types.ts`), full AR-15, camelCase: `Config { passwordHash?: string; domains: Domain[]; schedules: Schedule[]; settings: Settings; activeTimer?: ActiveTimer | null }`, where `Domain { hostname: string; alwaysOn: boolean }`, `Schedule { id: string; name: string; weekdays: number[]; startTime: string; endTime: string; enabled: boolean }` (weekdays 0=Mon..6=Sun, times `HH:mm`), `Settings { menuBarEnabled: boolean }`, `ActiveTimer { endEpochMs: number; selectedDomains: string[] }`. Export a `DEFAULT_CONFIG: Config` with `domains: []`, `schedules: []`, `settings: { menuBarEnabled: false }`, `activeTimer: null`, `passwordHash` unset.
- Stateless typed JS port (`src/config/configStore.ts`): `readConfig(): Config` — calls the native spec; if `!ok` or `data == null` returns `DEFAULT_CONFIG`; else `JSON.parse` (on throw → `DEFAULT_CONFIG`). Never throws (AC 3). `writeConfig(config: Config): { ok: boolean; error?: string }` — `JSON.stringify(config)` → native `writeConfig`. No in-memory state, no subscriptions, no staged buffer.
- Jest: mock the TurboModule spec default export in `__tests__/configStore.test.ts` via `jest.mock('../native/specs/NativeConfigStoreSpec', ...)` (no native runtime in node); test every I/O Matrix row.
- pnpm. Relative imports only. No `child_process` / `fs` / `os` imports anywhere in `src/` (AD-1) — file I/O is native-only.

**Ask First:**
- Any deviation from the architecture spine's adapter/codegen pattern (AD-2) or the `~/Library/Application Support/Frosthalt/config.json` path (AD-5).
- Splitting the stateless JS port out of 1.4 (i.e. native-only, defer the typed port to 1.6) — it is intentionally included here so AC 3 resilience is implemented and Jest-verifiable in this story.

**Never:**
- No Zustand, no in-memory config mirror, no staged-edits buffer, no Apply orchestration — that is Story 1.6 (the serialized Apply pipeline depends on 1.4 + 1.5).
- No UI of any kind — 1.4 is headless native + types + port.
- No `child_process` / `fs` / `os` in `src/` (AD-1).
- No legacy `RCT_EXPORT_MODULE` *bridge* module — the `.mm` must conform to the codegen-generated TurboModule spec protocol (AD-2), not the old RCT bridge.
- No domain logic / effective-blocklist computation (the domain layer, 1.6).
- No hostname normalisation or validation (Story 2.2) — 1.4 persists whatever `Config` it is given.
- No `RCT_NEW_ARCH_ENABLED=0` (AD-2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Read valid config | file has valid AR-15 JSON | `readConfig()` returns the parsed `Config` | N/A |
| Read missing file | `config.json` absent | `readConfig()` returns `DEFAULT_CONFIG`, no crash | native returns `{ok:true, data:null}` |
| Read corrupt config | file has invalid JSON or is empty | `readConfig()` returns `DEFAULT_CONFIG`, no crash | `JSON.parse` throws → caught → `DEFAULT_CONFIG` |
| Write config | a `Config` | atomic write (temp + rename) to `config.json`; file content = `JSON.stringify(config)` | N/A |
| Write with missing dir | `Application Support/Frosthalt` absent | dir is created, then file written atomically | N/A |
| Native IO error on write | disk/permission error | `writeConfig()` returns `{ok:false, error}`; target file unchanged (temp discarded, no rename) | caller (1.6) surfaces |
| Round-trip | `writeConfig(c)` then `readConfig()` | `readConfig()` returns a deep-equal `Config` | N/A |

</frozen-after-approval>

## Code Map

- `package.json` -- EDIT. Add `codegenConfig` (`name: FrosthaltSpecs`, `type: modules`, `jsSrcsDir: src/native/specs`) so `use_native_modules!`/`react_native_post_install` discover + codegen the app-level spec; add a `"typecheck": "tsc --noEmit"` script (none exists today). New Arch is already on by default (`macos/Podfile:20` `:fabric_enabled => true`; `macos/Frosthalt-macOS/Info.plist:46-47` `RCTNewArchEnabled=true`) — no flag to add.
- `src/native/specs/NativeConfigStoreSpec.ts` -- NEW. The TurboModule TS spec (codegen input + JS contract): `Spec extends TurboModule` with `readConfig`/`writeConfig` returning `ConfigResult`, `export default TurboModuleRegistry.getEnforcing<Spec>('NativeConfigStore')`. No `specs/` dir or `codegenConfig` exists today (confirmed) — this creates both.
- `macos/Frosthalt-macOS/ConfigStore.swift` -- NEW. `@objc(NativeConfigStore)` class: `NSSearchPathForApplicationSupportDirectory` path resolution, `FileManager` read, atomic write (temp + `replaceItem`/rename), create missing dir, return `{ok, error?, data?}` as an `NSDictionary`/`NSString`. The real business logic.
- `macos/Frosthalt-macOS/NativeConfigStore.mm` -- NEW. Obj-C++ TurboModule: `RCT_EXPORT_MODULE(NativeConfigStore)`, conforms to the codegen-generated `<NativeConfigStoreSpec>` protocol, delegates each method to the Swift class via `#import "<product>-Swift.h"`. The first TurboModule in the repo — becomes the template for ShellRunner (1.5) / MenuBar (Epic 6).
- `macos/Frosthalt-macOS/Frosthalt-macOS-Bridging-Header.h` -- NEW (Xcode auto-creates when the first `.swift` is added to the target; likely empty). The `.mm` imports the generated `-Swift.h`, not this header.
- `macos/Frosthalt-macOS.xcodeproj/project.pbxproj` -- EDIT (via Xcode) to add `NativeConfigStore.mm`, `ConfigStore.swift`, and the bridging header to the macOS target so they compile/link. `pod install` does NOT add app-target files — this is a manual Xcode step.
- `src/config/types.ts` -- NEW. Full AR-15 `Config` + `Domain` / `Schedule` / `Settings` / `ActiveTimer` types + `DEFAULT_CONFIG` (AC 2).
- `src/config/configStore.ts` -- NEW. Stateless typed port: `readConfig()` (resilient) + `writeConfig(config)` (honest). Owns JSON parse/serialize + missing/corrupt→empty. Imports the native spec default export (port → adapter direction; AD-11).
- `__tests__/configStore.test.ts` -- NEW. `jest.mock` the spec default export; exercise every matrix row (valid/missing/corrupt read, write, round-trip, missing-dir, IO error). The repo has zero native-module mocks today — this establishes the pattern.
- `tsconfig.json` -- REUSE, unchanged. The Story 1.3 `paths` alias already resolves `react-native` types to `react-native-macos`, which covers `TurboModule` / `TurboModuleRegistry`.
- `src/theme/tokens.ts`, `src/components/*` -- REUSE, unchanged. 1.4 touches none of the 1.2/1.3 chrome.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `codegenConfig` (FrosthaltSpecs / modules / `src/native/specs`) + `typecheck` script -- enable app-level codegen for the spec and give the repo a typecheck command.
- [x] `src/native/specs/NativeConfigStoreSpec.ts` -- author the TurboModule TS spec (`readConfig`/`writeConfig` → `ConfigResult`, `getEnforcing('NativeConfigStore')`) -- the codegen input and JS-side contract (AC 1 Given, AC 4).
- [x] `src/config/types.ts` -- define the full AR-15 `Config` shape + sub-types + `DEFAULT_CONFIG` -- AC 2.
- [x] `src/config/configStore.ts` -- implement the stateless typed port (resilient `readConfig`, honest `writeConfig`, JSON parse/serialize) -- AC 1/3 JS surface, AC 4.
- [x] `__tests__/configStore.test.ts` -- `jest.mock` the spec + test every I/O Matrix row -- AC 3 resilience + round-trip, Jest-verifiable without a native runtime.
- [x] `macos/Frosthalt-macOS/ConfigStore.swift` -- Swift adapter: path resolution, atomic write (temp + rename), missing-dir create, `{ok, error?, data?}` returns -- AC 1/3 native logic.
- [x] `macos/Frosthalt-macOS/NativeConfigStore.mm` -- Obj-C++ TurboModule: `RCT_EXPORT_MODULE(NativeConfigStore)` (Obj-C++ class named `NativeConfigStoreModule` to avoid colliding with the Swift `@objc(NativeConfigStore)` class at the Obj-C runtime; JS-visible module name stays `NativeConfigStore`), conform to the codegen spec protocol (`NativeConfigStoreSpecSpec`), delegate to Swift via `Frosthalt-Swift.h` -- AC 1/4, AD-2.
- [x] `macos/Frosthalt.xcodeproj/project.pbxproj` -- add the new `.mm`/`.swift` to the macOS target in Xcode (the actual project file is `Frosthalt.xcodeproj`, not `Frosthalt-macOS.xcodeproj`; Xcode auto-creates the bridging header when the first `.swift` is added) -- **manual Xcode step, outside the node sandbox**; required for the native files to compile and link into the app. Done: the `.mm`/`.swift`/bridging headers were added to the macOS target and a clean `pod install && pnpm macos` builds + links.

**Acceptance Criteria:**
- Given a clean checkout, when `cd macos && pod install` then `pnpm macos` run, then the app builds — codegen generates the `NativeConfigStore` spec header and the Swift/Obj-C++ compile and link.
- Given any JS call to `NativeConfigStore`, when `readConfig`/`writeConfig` execute, then the call returns `{ ok, error?, data? }` over the JSI bridge (AC 4).
- Given the config dir/file is missing, when `readConfig()` is called, then `DEFAULT_CONFIG` is returned with no crash; when `writeConfig(c)` is called, then the `Frosthalt` directory is created and `config.json` is written atomically (temp + rename) (AC 3).
- Given the TS `Config` type, then it matches the full AR-15 shape — all five top-level keys (`passwordHash`, `domains`, `schedules`, `settings`, `activeTimer`), camelCase (AC 2).

## Spec Change Log

- 2026-08-16 — Native round-trip verified on-device; documented the two required native hooks (`getModuleProvider:` in AppDelegate for registration, `getTurboModule:` in the module class for JSI binding) under Design Notes; marked the manual Xcode step done.

## Design Notes

- **Why native is a dumb string adapter and TS owns shape + resilience:** keeps the native module isolated (AD-11 — it imports nothing and knows no domain shape); the TS port owns `JSON.parse`/`stringify` and the missing/corrupt→empty rule (AC 3), which is exactly what makes the story Jest-testable by mocking the spec. The Zustand config mirror + Apply orchestration that *calls* this port is Story 1.6.
- **Why a stateless JS port is in 1.4, not 1.6:** AC 3 (resilience) must be implemented and verifiable in this story, and the port is the only surface Jest can exercise (no native runtime in node). It is strictly stateless — no in-memory state, no subscribers, no staged buffer — so it is not the 1.6 domain layer.
- **Spec location `src/native/specs/`** resolves the architecture spine's structural seed (`src/native/ConfigStore/specs/…`) to a single flat codegen dir while honoring the "native namespace" intent. The spine's source-tree layout is seed (non-binding per the spine's own rule); the code owns it once written. `codegenConfig.jsSrcsDir` takes a single dir, so a flat `src/native/specs/` is the simplest home for all future TurboModule specs (ShellRunner 1.5, MenuBar Epic 6).
- **`codegenConfig` in `package.json`** (not a `react-native.config.js`) is the documented app-level codegen path (RN docs); one less config file.
- **`menuBarEnabled` defaults to `false`** — the menu-bar status item is wired in Epic 6; off until then. Minor, revisit in Epic 6.
- **Native build verification can't run in the node sandbox** (pod install + `pnpm macos` need the macOS toolchain + network). The sandbox-runnable bar is the JS layer (`tsc` + `jest` with the mock); the native compile is a manual check.
- **Two native hooks an app TurboModule needs on react-native-macos 0.81 (bridgeless):** codegen from `codegenConfig` only generates the spec headers + the `*SpecJSI` C++ wrapper — it does NOT register the app's own module with the `RCTTurboModuleManager`, and there is no `RCT_EXPORT_MODULE` bridge fallback. Two hooks close the gap, both verified during the 1.4 round-trip:
  1. **`getModuleProvider:` in `AppDelegate`** (registration). On the bridgeless RN 0.81 path the manager resolves a name via `RCTInstance` → `RCTReactNativeFactory` → the `RCTAppDelegate` delegate's `getModuleProvider:`. Autolinking's generated `RCTModuleProviders` map lists only real dependencies, so an app module is invisible there → `TurboModuleRegistry.getEnforcing(<name>)` throws "could not be found ... registered in the native binary". The fix is a `getModuleProvider:` override that returns a fresh instance of the module class for its name (`AppDelegate.mm` resolves the class at runtime via `NSClassFromString` because the `.mm`'s class interface is private — no public header to import). Add a branch per module name; this is the template for ShellRunner (1.5) and MenuBar (Epic 6).
  2. **`getTurboModule:` in the hand-written module class** (JSI method binding). The codegen `*SpecBase` class only implements `setEventEmitterCallback:` — it does NOT supply `getTurboModule:`. The manager's `provideTurboModule:` asks `respondsToSelector:@selector(getTurboModule:)` and, without it, never constructs the `*SpecJSI` wrapper whose constructor populates `methodMap_` with the `readConfig`/`writeConfig` host functions. Symptom: `getEnforcing` finds the module object but its methods are `undefined` ("X is not a function"). The fix is the standard codegen TurboModule pattern — the hand-written impl implements `getTurboModule:` returning `std::make_shared<…SpecJSI>(params)`. Every hand-written TurboModule impl must do this.
- **Round-trip verified on-device:** with both hooks in place, a clean-machine `readConfig()` returns `DEFAULT_CONFIG`, `writeConfig(DEFAULT_CONFIG)` writes `~/Library/Application Support/Frosthalt/config.json` (84 bytes), and a follow-up `readConfig()` round-trips (the app is not sandboxed, so writes hit the real Application Support dir). Relaunch note: `open`/`react-native run-macos` only *focuses* an already-running app — `pkill -f "Frosthalt.app/Contents/MacOS/Frosthalt"` before `pnpm macos` so the freshly-built binary actually starts.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: exit 0 (spec + types + port type-check against react-native-macos types via the tsconfig `paths` alias).
- `pnpm test --watchman=false -- configStore` -- expected: the `configStore` suite passes (every I/O Matrix row: valid/missing/corrupt read, write, round-trip, missing-dir, IO error).

**Manual checks (native — run outside the node sandbox):**
- `cd macos && pod install` then `pnpm macos` -- expected: build succeeds; codegen generates the `NativeConfigStore` spec header; `ConfigStore.swift` + `NativeConfigStore.mm` compile and link into the macOS target (after the new files are added to the target in Xcode).
- On a running app (or a one-line JS driver): `readConfig()` on a clean machine → `DEFAULT_CONFIG`; `writeConfig(DEFAULT_CONFIG)` → `~/Library/Application Support/Frosthalt/config.json` appears; `readConfig()` again → deep-equal round-trip.

## Suggested Review Order

**Resilient read path**

- Entry point — the resilient `readConfig`: never throws, missing/corrupt → empty (AC 3).
  [`configStore.ts:36`](../../src/config/configStore.ts#L36)

- Envelope guard: a `null`/`undefined` native return can't crash the `.ok`/`.data` access.
  [`configStore.ts:49`](../../src/config/configStore.ts#L49)

- Shape guard: valid-JSON-non-`Config` (`null`/`42`/`[]`/`{}`) falls back to defaults, not a crash.
  [`configStore.ts:66`](../../src/config/configStore.ts#L66)

**Config shape & safe defaults**

- Canonical `Config` interface — full AR-15 shape, camelCase (AC 2).
  [`types.ts:61`](../../src/config/types.ts#L61)

- `DEFAULT_CONFIG` deep-frozen so a caller's `readConfig().domains.push(...)` can't poison future returns.
  [`types.ts:79`](../../src/config/types.ts#L79)

- `Schedule.weekdays` tightened to `Weekday[]` (compile-time rejects 7/-1/out-of-range).
  [`types.ts:32`](../../src/config/types.ts#L32)

**TurboModule contract (codegen)**

- The TS spec — `Spec extends TurboModule`, two methods, `getEnforcing('NativeConfigStore')` (AC 1/4).
  [`NativeConfigStoreSpec.ts:43`](../../src/native/specs/NativeConfigStoreSpec.ts#L43)

**Native adapter**

- Swift real logic: path resolve, atomic write (temp + rename), missing-dir create (AC 3 native side).
  [`ConfigStore.swift:55`](../../macos/Frosthalt-macOS/ConfigStore.swift#L55)

- Atomic write via `Data.WritingOptions.atomic` — temp file then rename; a failed write discards the temp, target unchanged.
  [`ConfigStore.swift:106`](../../macos/Frosthalt-macOS/ConfigStore.swift#L106)

- Obj-C++ TurboModule glue: `RCT_EXPORT_MODULE(NativeConfigStore)`, delegates each method to Swift (AD-2).
  [`NativeConfigStore.mm:44`](../../macos/Frosthalt-macOS/NativeConfigStore.mm#L44)

- Nil-`json` guard in `writeConfig:` — a nil `NSString` can't bridge to a Swift non-optional `String`.
  [`NativeConfigStore.mm:78`](../../macos/Frosthalt-macOS/NativeConfigStore.mm#L78)

**Honest write path**

- `writeConfig`: serialize → native, honest `{ ok, error }` on IO failure (the 1.6 caller surfaces it).
  [`configStore.ts:100`](../../src/config/configStore.ts#L100)

**Build wiring**

- App-level `codegenConfig` in `package.json` — discovers + codegens the spec into the `FrosthaltSpecs` umbrella.
  [`package.json:14`](../../package.json#L14)

**Tests**

- `jest.mock` the spec default export + every I/O Matrix row + the new resilience guards (no native runtime in node).
  [`configStore.test.ts:21`](../../__tests__/configStore.test.ts#L21)