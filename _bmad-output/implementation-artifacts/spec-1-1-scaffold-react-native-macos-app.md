---
title: 'Scaffold the react-native-macos app with New Architecture and Jest'
type: 'chore'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c3ab4fa88cdf5f39caacd22b723d3ee8bf5bb078'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A `react-native-macos` 0.81.x scaffold already exists in the repo (commit f7419d5), but it does not yet satisfy the Story 1.1 acceptance criteria: New Architecture is gated behind an env var instead of on by default, and there is no `npm run macos` script. The macOS deployment target is already 14.0 (matching RN 0.81.9's minimum floor — the architecture spine's earlier 13.0 pin was superseded; see Spec Change Log). Jest is already configured correctly. This story brings the existing scaffold up to the pinned, known-good foundation every later story builds on.

**Approach:** Adjust the existing scaffold in place — enable Fabric/New Architecture by default in the macOS Podfile, add the `macos` run script, fix the malformed `package.json` devDependency, then re-install Pods and verify the app launches and Jest runs green. The deployment target stays at 14.0 (RN 0.81.9's declared minimum). No new application code is written in this story.

## Boundaries & Constraints

**Always:**
- Stay on the `react-native-macos` 0.81.x line (currently resolved at 0.81.9 via Podfile.lock; `react-native` 0.81.2, `react` 19.1.0 — all valid 0.81.x). Do not churn these versions to match the architecture spine's suggested exact pin; the AC is "0.81.x".
- Keep Hermes as the JS engine (the 0.81 default; do not switch).
- Keep `jest.config.js` using `preset: 'react-native'` (satisfies AR-17; the `@react-native/jest-preset` is not needed on 0.81.x).
- Keep `app.json` name `Frosthalt` and the existing `App.tsx`/`index.js`/`tsconfig.json` as-is.
- New Architecture must be enabled **by default** — the macOS target must build with Fabric + codegen without requiring `RCT_NEW_ARCH_ENABLED=1` to be set externally.
- Keep the macOS deployment target at 14.0 (RN 0.81.9's declared minimum; the architecture spine's earlier 13.0 pin was superseded — see Spec Change Log).

**Ask First:**
- If `pod install` or `xcodebuild`/`npm run macos` cannot run in this environment (network or sandbox restrictions), HALT and ask the human to run them rather than silently skipping verification.
- Removing the unused `ios/` and `android/` targets — out of scope for this story unless the human says otherwise.

**Never:**
- Do NOT set `RCT_NEW_ARCH_ENABLED=0` or otherwise disable New Architecture.
- Do NOT introduce `zustand`, native TurboModules, a `src/` layer structure, or any application/UI code — those belong to stories 1.2–1.7.
- Do NOT import Node built-ins (`child_process`, `fs`, `os`) anywhere — Hermes has none.
- Do NOT delete the existing `__tests__/App.test.tsx` sample test; it is the green-test proof.

</frozen-after-approval>

## Code Map

- `package.json` — scripts block has `android`/`ios`/`lint`/`start`/`test` but NO `macos` script (must add `"macos": "react-native run-macos"`). Also contains a malformed duplicate line `"react-native-macos":"0.81.0",` inside `devDependencies` (no leading space, wrong version, and `react-native-macos` already correctly listed in `dependencies` as `^0.81.9`) — remove the malformed devDependency entry. `test` script is already `jest` (good).
- `macos/Podfile` — one change: the `use_react_native!` call sets `:fabric_enabled => ENV['RCT_NEW_ARCH_ENABLED'] == '1'`, which leaves Fabric OFF unless the env var is exported — changed so Fabric is on by default (`:fabric_enabled => true`). `platform :macos` stays `'14.0'` (the scaffold default and RN 0.81.9's minimum; an earlier 13.0 pin was reverted — see Spec Change Log). `prepare_react_native_project!` and `use_native_modules!` stay.
- `macos/Podfile.lock` — currently locked to React 0.81.9 / hermes-engine 0.81.6 pods, with `RCT-Folly/Fabric` present (Fabric subspec already resolved). After Podfile edits, `pod install` must be re-run to regenerate this consistently.
- `macos/Frosthalt.xcodeproj/project.pbxproj` — `MACOSX_DEPLOYMENT_TARGET` stays `14.0` (Debug + Release); not lowered.
- `jest.config.js` — `module.exports = { preset: 'react-native' }` — already correct, no change.
- `__tests__/App.test.tsx` — existing sample test using `react-test-renderer`; no change, used as the green-test proof.
- `App.tsx`, `index.js`, `app.json`, `tsconfig.json`, `babel.config.js`, `metro.config.js` — default scaffold config, all valid; no change required in this story.
- `ios/`, `android/` — present from the generic init but unused in v1 (macOS-only); leave in place (removal deferred — see Ask First).

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `"macos": "react-native run-macos"` to `scripts` and remove the malformed `"react-native-macos":"0.81.0",` devDependency line -- wires the run command the AC requires and fixes a broken duplicate that could confuse installs.
- [x] `macos/Podfile` -- make Fabric enabled by default (set `:fabric_enabled => true`, removing the `ENV['RCT_NEW_ARCH_ENABLED'] == '1'` gating) and confirm `platform :macos` stays `'14.0'` (RN 0.81.9 minimum) -- satisfies the "New Architecture enabled by default" AC.
- [x] `macos/Frosthalt.xcodeproj/project.pbxproj` -- confirm `MACOSX_DEPLOYMENT_TARGET` stays `14.0` (Debug + Release) -- keeps the Xcode target at RN's supported floor.
- [x] re-run `pod install` in `macos/` (succeeded; `Pods/Manifest.lock` matches `Podfile.lock`) -- regenerated Pods with Fabric enabled at the 14.0 target.
- [x] verify `npm test` runs green (`__tests__/App.test.tsx` passes; pnpm-aware `transformIgnorePatterns` added to `jest.config.js` so the react-native preset finds RN's ESM setup under the pnpm `node_modules/.pnpm` layout -- see Spec Change Log) -- confirms the Jest foundation (AC 3 & 4).
- [x] verify `npm run macos` launches a native macOS window (human-run -- the sandbox cannot run xcodebuild; verified after a clean `pod install` re-staged the missing `Pods/Headers/Public/glog` + third-party C++ header dirs -- see Spec Change Log) -- confirms the runnable-app AC (AC 2).

**Acceptance Criteria:**
- Given the edited scaffold, when New Architecture status is inspected (Podfile + build), then Fabric + TurboModules/codegen are enabled and the build does not require `RCT_NEW_ARCH_ENABLED=1` to be set.
- Given the edited scaffold, when `npm run macos` is executed, then a native macOS window launches.
- Given the edited scaffold, when `npm test` is executed, then Jest runs with the `react-native` preset and the sample test passes (green).
- Given the repo, when inspected, then `npm test` is the `test` script in `package.json` and a `__tests__/` directory with a passing test exists.

## Verification

**Commands:**
- `npm test` -- expected: Jest runs the `react-native` preset, `__tests__/App.test.tsx` passes, exit code 0.
- `npm run macos` -- expected: Metro bundles and a native macOS window opens (xcodebuild + app launch). If the environment cannot run xcodebuild/pod install, ask the human to run this and report the result.

**Manual checks (if no CLI):**
- Open `macos/Podfile` and confirm `platform :macos, '14.0'` and that Fabric is enabled (`:fabric_enabled => true`) without an `RCT_NEW_ARCH_ENABLED` env-var requirement.
- After `pod install`, confirm `macos/Podfile.lock` still lists the Fabric subspec (`RCT-Folly/Fabric`) and React 0.81.9.

## Spec Change Log

<!-- Append-only. Records frozen-intent changes authorized mid-implementation: the finding that triggered the change, what was amended, the known-bad state the amendment avoids, and any KEEP instructions. -->

### 1. Deployment target 13.0 → 14.0 (human-authorized, 08-14-2026)

**Finding:** The architecture spine and epic-1-context pinned the macOS deployment target at 13.0, and the original frozen Intent + Code Map + Tasks here said to lower the scaffold's 14.0 to 13.0. But RN 0.81.9's pods declare **14.0** as their minimum (`s.platform.deployment_target = 14.0` in the react-native-macos podspecs). Building against 13.0 produced 86 CocoaPods compatibility warnings, and the resulting binary would not run on a real macOS 13.0 machine. The frozen block was internally inconsistent — "0.81.x" and "13.0" cannot both hold.

**Amendment:** Per the standing "ask the human on frozen-intent changes" rule, this was surfaced via AskUserQuestion before touching the frozen block. The human chose **macOS 14.0**. The Podfile + `project.pbxproj` were kept at 14.0 (reverted from an interim 13.0 edit), `pod install` re-run clean (no warnings), and this spec's Intent, Boundaries Always, Code Map, Tasks, and Verification were updated to 14.0. The architecture spine + epic-1-context are carried back to 14.0 separately.

**Known-bad state avoided:** 86 CocoaPods platform warnings + a binary that fails to launch on macOS 13.0; a spec that contradicts its own pinned stack.

**KEEP:** `jest.config.js` carries a pnpm-aware `transformIgnorePatterns` (added during this story). The repo is installed with **pnpm** (`node_modules/.pnpm` symlink store, no `package-lock.json`), and the react-native Jest preset's default ignore pattern assumes a flat `node_modules` — so RN's ESM `jest/setup.js` was not transformed, causing "Cannot use import statement outside a module." The added pattern keeps the preset's allow-list but also matches the pnpm nested layout. It is harmless under a flat `npm install`. **Risk flag:** the same pnpm symlink layout is a known cause of intermittent CocoaPods `pathname contains null byte` errors (react-native-macos GitHub #12866) and may trip RN CLI / Metro autolinking. If `npm run macos` fails on missing native modules or a re-run of `pod install` flakes, the robust remedy is a flat `npm install` (needs network — human-run). Pods are currently consistent (`Manifest.lock` == `Podfile.lock`), so the build should not need to re-run `pod install`.

## Suggested Review Order

**New Architecture enablement**

- Fabric on by default — removes the env-var gate so the macOS target builds with codegen unconditionally.
  [`Podfile:20`](../../macos/Podfile#L20)

**macOS run command**

- Wires `npm run macos` to the RN macOS launcher — the AC 2 entry point.
  [`package.json:9`](../../package.json#L9)

**Test runner (pnpm compat)**

- Keeps the react-native Jest preset but widens the ignore pattern for the pnpm nested layout — fixes "Cannot use import statement outside a module" under `.pnpm`.
  [`jest.config.js:12`](../../jest.config.js#L12)

**Dependency hygiene**

- The real `react-native-macos` dep at `^0.81.9`; the malformed `0.81.0` devDependency duplicate was removed.
  [`package.json:17`](../../package.json#L17)

**Lock regeneration (peripheral)**

- Only the checksum moved — confirms the Fabric pods were already resolved; no pod set changed.
  [`Podfile.lock:2621`](../../macos/Podfile.lock#L2621)