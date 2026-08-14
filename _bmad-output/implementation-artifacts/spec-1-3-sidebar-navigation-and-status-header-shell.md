---
title: 'Sidebar navigation and status-header shell'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f361bff766500a4ea69d5b780d3416ab36741f15'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Frosthalt-2026-08-13/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.1's `App.tsx` still renders the default `@react-native/new-app-screen` scaffold — there is no window shell, no sidebar, no status header. Every later surface (Blocklist/Timer/Schedule/Settings from Epics 2–5) needs the shell to hang on, and the user has no way to move between surfaces or see glanceable state.

**Approach:** Build the window shell inside `App.tsx`: a fixed-width left sidebar with four navigation rows (Blocklist/Timer/Schedule/Settings), a persistent status header above the content showing `[StatusBadge "Free"] · 0 domains · no active timer` (placeholders), and a content area that swaps per selected surface — reusing the Story 1.2 `tokens` + `StatusBadge` as-is. Wire `⌘1`–`⌘4` keyboard nav, focus rings + programmatic focus, and VoiceOver surface announcements using shipped react-native-macos View props + `AccessibilityInfo` — no native TurboModule.

## Boundaries & Constraints

**Always:**
- Reuse `tokens` (`primary`/`primaryForeground`/`spacing.*`/`rounded.*`/`typography.*`, `src/theme/tokens.ts`) and `StatusBadge` (`src/components/StatusBadge.tsx`, `<StatusBadge status="free" />`) from Story 1.2 unchanged.
- Sidebar: exactly four rows in this order — Blocklist, Timer, Schedule, Settings — ~180px fixed width; one row active at a time; the selected row uses `tokens.primary` fill + `tokens.primaryForeground` text; unselected rows use the default surface.
- Status header: always visible above the content across all four surfaces; renders `[StatusBadge status="free"]` · `"0 domains"` · `"no active timer"` (these are static placeholders — the real domain count lands in Epic 2, the countdown in Epic 4).
- Content area: swaps to a placeholder for the selected surface (title + empty-state text); no real surface logic.
- `⌘1`–`⌘4` select rows 0–3. Wire keyboard handling with `onKeyDown` + `keyDownEvents` on a `focusable` View, gating on `e.nativeEvent.metaKey` (the ⌘ key) AND `e.nativeEvent.key` in `1`–`4`. The selected row receives keyboard focus via `ref.focus()` and shows the native focus ring (`enableFocusRing` + `focusable`). On mount, focus row 0 (a `useEffect` calling `rowRefs[0].current?.focus()`) so ⌘-keys work before any click.
- On every navigation (click or ⌘ key), call `AccessibilityInfo.announceForAccessibility("<Surface>, 0 domains")` so VoiceOver speaks the surface.
- Keep the `SafeAreaProvider` + `StatusBar` + `useColorScheme` wrapper from 1.1's `App.tsx` (`App.tsx:15-24`); only the `AppContent` body (`App.tsx:26-37`) is replaced. Drop the `@react-native/new-app-screen` import.
- The active-surface state is local `useState` in the shell component (no Zustand — see Design Notes). Use relative imports only (no `@/` alias). Use **pnpm**.

**Ask First:**
- Any deviation from DESIGN.md's sidebar/status-header layout (row order, the ~180px width, the status-header content/order).
- Introducing a native module/TurboModule for any of the keyboard/focus/VoiceOver ACs — the investigation confirms shipped View props + `AccessibilityInfo` cover all three, so HALT before adding native code if a prop turns out not to fire at runtime.
- Introducing Zustand (not needed — see Design Notes).

**Never:**
- Do NOT build the real Blocklist/Timer/Schedule/Settings surfaces — placeholders only (real surfaces are Epics 2–5).
- Do NOT add an `ApplyButton`, the default-button pulse, or Return-fires-Apply — that is Story 1.6 / 2.1. (The Story 1.2 Design Notes said the default-button "lands in 1.3"; that was incorrect — 1.3's AC has no Apply button. 1.3 does NOT import `ApplyButton`.)
- Do NOT add the MenuBar TurboModule or any TurboModule/native module (ShellRunner/ConfigStore are 1.4/1.5; MenuBar is Epic 6).
- Do NOT wire a real domain count or countdown — the status header shows the static placeholders `"0 domains"` and `"no active timer"`.
- Do NOT import `child_process` / `fs` / `os` anywhere in `src/`.
- Do NOT use `accessibilityLiveRegion` (Android-only) for VoiceOver — use `AccessibilityInfo.announceForAccessibility`.
- Do NOT use the prop names `keyDown` / `validKeysDown` / `onKeyEvent` — they do NOT exist in react-native-macos 0.81 (the Story 1.2 Design Notes named them wrong). The real props are `onKeyDown` / `onKeyUp` + `keyDownEvents` / `keyUpEvents`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Sidebar row click | click a row | row becomes active (`primary` fill + `primaryForeground` text), content swaps to that surface, exactly one row active, focus moves to the row, VoiceOver announces "<Surface>, 0 domains" | N/A |
| ⌘1–⌘4 nav | `metaKey` + key `1`/`2`/`3`/`4` | selects row 0/1/2/3, focus moves to it (focus ring visible), content swaps, VoiceOver announces "<Surface>, 0 domains" | N/A |
| ⌘ with non-1-4 key | `metaKey` + key e.g. `5` or `b` | no row change, no announce (handler ignores keys outside 1–4) | N/A |
| Plain number (no ⌘) | key `1`–`4`, `metaKey` false | no navigation (must require ⌘) | N/A |
| Initial mount | app starts | Blocklist (row 0) is the default active surface and receives keyboard focus on mount (so ⌘-keys work before any click); status header shows the placeholders | N/A |
| Status header on every surface | any selected surface | header renders `[StatusBadge "Free"] · "0 domains" · "no active timer"` above the content | N/A |
| Appearance change (light↔dark) | system light↔dark | all `PlatformColor` tokens adapt; static hex unchanged | N/A |
| Accent change | user changes Accent Color | selected-row `primary` fill follows `controlAccentColor` | N/A |
| VoiceOver off | no screen reader | `announceForAccessibility` is a no-op; app stays fully keyboard-usable | N/A |

</frozen-after-approval>

## Code Map

- `App.tsx` -- REWIRE. Keep `SafeAreaProvider`/`StatusBar`/`useColorScheme` (`App.tsx:15-24`); replace the `AppContent` body (`App.tsx:26-37`, currently `<NewAppScreen>`) with `<Shell/>`. Drop the `@react-native/new-app-screen` import (`App.tsx:8`). The shell holds the active-surface `useState`, the `rowRefs`, the `onKeyDown`/`keyDownEvents` handler, and renders `<Sidebar/>` + `<StatusHeader/>` + the active surface placeholder.
- `src/theme/tokens.ts` -- REUSE, unchanged. `tokens.primary`/`primaryForeground`/`spacing`/`rounded`/`typography` (`tokens.ts:85-131`); `statusFill` (`tokens.ts:141`).
- `src/components/StatusBadge.tsx` -- REUSE, unchanged. `<StatusBadge status="free" />` renders the "Free" pill for the status header.
- `src/components/Sidebar.tsx` -- NEW. Four `SidebarRow`s in a ~180px fixed-width `View`; selected row: `backgroundColor: tokens.primary`, text color `tokens.primaryForeground`; each row `focusable` + `enableFocusRing` + a `ref` (for `ref.focus()` on select) + `accessibilityRole="button"` + `accessibilityLabel={surfaceName}` + `onPress`.
- `src/components/SidebarRow.tsx` -- NEW. One row (label + selected styling + focus props). May be inlined into `Sidebar` if that reads cleaner.
- `src/components/StatusHeader.tsx` -- NEW. Renders `<StatusBadge status="free" />` followed by the static strings `"0 domains"` and `"no active timer"` (label typography); always present above the content.
- `src/components/surfaces.tsx` (or `BlocklistPlaceholder.tsx` etc.) -- NEW. One placeholder per surface (title via `tokens.typography.title` + empty-state text via `tokens.typography.body`). Pure presentational; the shell picks the active one. (Implemented as `.tsx` — it contains JSX; a `.ts` file would not parse under the RN tsconfig.)
- `__tests__/Shell.test.tsx` -- NEW. Renders the shell, asserts: 4 sidebar rows render, clicking a row selects it + swaps content, `onKeyDown` with `{nativeEvent:{metaKey:true,key:'2'}}` selects row 1 + calls `announceForAccessibility`, the status header renders the "Free" badge + placeholders. Reuse the 1.2 helper patterns (assert on `toJSON()` host nodes; locate rows by contract props `onPress`+`accessibilityRole:'button'`, NOT `findByType` — see Design Notes).
- `tsconfig.json` -- EDIT. Add `"baseUrl": "."` and `"paths": {"react-native": ["node_modules/react-native-macos"]}` to `compilerOptions`. This makes `tsc` resolve the `react-native` TYPES to `react-native-macos`, which ships the macOS-augmented `ViewProps` (`onKeyDown`/`keyDownEvents`/`enableFocusRing`/`focusable` + the `KeyEvent` payload). TS-types-only — runtime is unaffected (the macOS CLI/metro already swaps `react-native`→`react-native-macos` at build time, which is why 1.1's app runs). Verified: 0 `tsc` errors across the whole project with this alias (all 1.2 code + tests still type-check).

**Read-only evidence (verified API anchors for step-03, do not edit these node_modules files):**
- `onKeyDown` / `onKeyUp` / `keyDownEvents` / `keyUpEvents` / `enableFocusRing` -- `node_modules/react-native-macos/Libraries/Components/View/ViewPropTypes.d.ts:135-151` (`ViewPropsMacOS`, merged into `ViewProps`).
- `KeyEvent` / `NativeKeyEvent` (carries `metaKey` = ⌘, `key` = charactersIgnoringModifiers) / `HandledKeyEvent` -- `node_modules/react-native-macos/Libraries/Types/CoreEventTypes.d.ts:271-308`.
- `focusable` / `tabIndex` -- `ViewPropTypes.d.ts:118,129`.
- `ref.focus()` / `ref.blur()` (`NativeMethods`) -- `node_modules/react-native-macos/types/public/ReactNativeTypes.d.ts:102-111`; wired on macOS Fabric at `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm:1721`.
- `AccessibilityInfo.announceForAccessibility(announcement: string)` -- wired for macOS (`NSAccessibilityAnnouncementRequestedNotification`, high priority) at `React/CoreModules/RCTAccessibilityManager.mm:430-444`. `accessibilityLiveRegion` is NOT the macOS path (Android-only).
- The event fires only at the first responder and bubbles up the React tree — put `onKeyDown` on a parent `focusable` container; declare `keyDownEvents={[{key:'1',metaKey:true},{key:'2',metaKey:true},{key:'3',metaKey:true},{key:'4',metaKey:true}]}` to mark ⌘1–⌘4 as handled (blocks the native default).

## Tasks & Acceptance

**Execution:**
- [x] `tsconfig.json` -- add `baseUrl` + `paths` alias `react-native`→`react-native-macos` -- unblocks the macOS View prop types (`enableFocusRing`/`keyDownEvents`/`onKeyDown`/`focusable`); runtime-neutral; verified 0 tsc errors.
- [x] `src/components/Sidebar.tsx` + `SidebarRow.tsx` -- four rows (Blocklist/Timer/Schedule/Settings), ~180px, one active, selected row `primary` fill + `primaryForeground` text, each row `focusable`+`enableFocusRing`+`ref`+`onPress`+`accessibilityRole="button"`+`accessibilityLabel` -- sidebar nav AC.
- [x] `src/components/StatusHeader.tsx` -- `<StatusBadge status="free" />` · `"0 domains"` · `"no active timer"` (label typography) -- status-header AC.
- [x] `src/components/surfaces.ts` (or per-surface files) -- one placeholder per surface (title + empty-state body) -- content-swap AC.
- [x] `App.tsx` -- rewire to `<Shell/>`: keep `SafeAreaProvider`/`StatusBar`/`useColorScheme`, replace `AppContent` body, drop `@react-native/new-app-screen`; hold active-surface `useState` + `rowRefs`; `onKeyDown`+`keyDownEvents` for ⌘1–⌘4 (gate on `metaKey`+key in 1–4) → `setSurface` + `rowRefs[idx].current?.focus()` + `AccessibilityInfo.announceForAccessibility("<Surface>, 0 domains")`; render `<Sidebar/>` + `<StatusHeader/>` + active surface -- keyboard/focus/a11y ACs.
- [x] `__tests__/Shell.test.tsx` -- unit-test the I/O Matrix rows: 4 rows render, click selects + swaps content, ⌘N selects + announce called, status header renders, plain-number (no ⌘) does not navigate -- matrix coverage.
- [x] run tests green + `tsc --noEmit` exit 0.

**Acceptance Criteria:**
- Given the app window, when rendered, then a left sidebar with four rows (Blocklist/Timer/Schedule/Settings, ~180px) and a status header above the content render.
- Given a sidebar row, when clicked, then it becomes the active row (`primary` fill + `primaryForeground` text), the content swaps to that surface, and exactly one row is active.
- Given the window, when `⌘1`/`⌘2`/`⌘3`/`⌘4` is pressed, then the corresponding row is selected, receives keyboard focus (focus ring visible), and VoiceOver announces "<Surface>, 0 domains"; a plain `1`–`4` (no ⌘) does not navigate.
- Given any selected surface, when rendered, then the status header shows `[StatusBadge "Free"] · 0 domains · no active timer` above the content.
- Given the test suite, when `pnpm test` runs, then `__tests__/Shell.test.tsx` passes and `tsc --noEmit` exits 0.
- Given `src/`, when inspected, then there are no `child_process`/`fs`/`os` imports, no Zustand, no TurboModule/native-module code, no `ApplyButton` import, and no use of `keyDown`/`validKeysDown`/`onKeyEvent`.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until the first bad_spec loopback. -->

## Design Notes

**The tsconfig type-resolution gap (why the `paths` alias is needed):** The project has `react-native@0.81.2` (upstream) AND `react-native-macos@^0.81.9` as deps. At runtime the macOS CLI/metro swaps `react-native`→`react-native-macos` (so 1.1's app runs). But `tsc` resolves `import { View } from 'react-native'` to the UPSTREAM types, which lack the macOS View props — `enableFocusRing` errors (`Property 'enableFocusRing' does not exist on type ViewProps`), and `onKeyDown`'s `nativeEvent` is `any` so `metaKey`/`key` aren't safe. `react-native-macos` ships the augmented types in its `types/` dir (package.json `types: "types"`). Adding `"paths": {"react-native": ["node_modules/react-native-macos"]}` makes `tsc` use those. Verified: 0 `tsc` errors across the whole project with the alias, including all 1.2 code + tests (it's a superset of the upstream types). This is the standard react-native-macos TS setup — it is NOT the source `@/` path alias that Story 1.2's Boundaries gated; it touches only types, and `baseUrl`+`paths` need no babel/metro change.

**Correction to the Story 1.2 Design Notes:** (a) The keyboard props named there — `keyDown`/`validKeysDown`/`onKeyEvent` — do NOT exist in react-native-macos 0.81. The real props are `onKeyDown`/`onKeyUp` + `keyDownEvents`/`keyUpEvents`, with `NativeKeyEvent` carrying `metaKey` (⌘) + `key` (`charactersIgnoringModifiers`). (b) The 1.2 Design Notes also said the default-button pulse + Return "lands in 1.3" — that is wrong per the story breakdown: 1.3's AC has no Apply button; the default-button behavior lands in Story 1.6 / 2.1 with the Apply pipeline. 1.3 does not import `ApplyButton`. (These are recorded here so step-04 does not re-litigate them; the 1.2 spec is done and is not reopened.)

**Why `useState`, not Zustand:** 1.3 has no domain state — the blocklist, timer, and config are later stories (1.4/1.6, Epic 2/4). The active surface is UI-chrome state. The ports-and-adapters paradigm (epic context) keeps UI-chrome state in the view layer; the domain store is introduced when domain state first appears (the staged-edits buffer in 1.6). Zustand is not installed, and adding it now for one `useState` is speculative scaffolding. Local `useState` in the shell is the simplest correct choice.

**Container vs row focus ring (implementation decision):** The focusable root `View` carries `enableFocusRing={false}`; the native focus ring belongs on the selected *row* (`SidebarRow` sets `enableFocusRing`), not around the entire shell. The container is `focusable` so the bubbled key events reach `onKeyDown` from the focused row, but a ring around the whole shell when the container is the first responder would be a visual bug. The wiring sketch below shows `enableFocusRing` on the container for brevity; the implemented code correctly puts the ring on the row. (Recorded so step-04 does not relitigate it.)

**Keyboard/focus wiring sketch:**
```tsx
const [surface, setSurface] = useState(0); // 0=Blocklist … 3=Settings
const rowRefs = [useRef<View>(null), useRef<View>(null), useRef<View>(null), useRef<View>(null)];
const NAMES = ['Blocklist', 'Timer', 'Schedule', 'Settings'];
const selectRow = (i: number) => {
  setSurface(i);
  rowRefs[i].current?.focus();
  AccessibilityInfo.announceForAccessibility(`${NAMES[i]}, 0 domains`);
};
// on a focusable container:
<View focusable enableFocusRing
  keyDownEvents={[{key:'1',metaKey:true},{key:'2',metaKey:true},{key:'3',metaKey:true},{key:'4',metaKey:true}]}
  onKeyDown={(e) => {
    const k = e.nativeEvent.key;
    if (e.nativeEvent.metaKey && k >= '1' && k <= '4') selectRow(Number(k) - 1);
  }}>
```

**Test-quirk notes (carry over from 1.2):** Locate `Pressable`/row elements by contract props (`onPress` fn + `accessibilityRole:'button'`), not `findByType` — under pnpm + RN 0.81 lazy getters the imported component is not identity-equal to the rendered one. Assert on `toJSON()` host nodes, not `findAll(accessibilityLabel)` counts (the RN jest preset's `View` mock spreads parent props onto the host node, double-matching). For `onKeyDown`, invoke the handler directly with a synthetic `{nativeEvent:{metaKey,key}}` and assert the resulting surface/announce — do not attempt a real key event in node. `AccessibilityInfo.announceForAccessibility` is mocked to a `jest.fn()`; assert it was called with the expected string.

## Verification

**Commands:**
- `./node_modules/.bin/jest --watchman=false` -- expected: Shell tests green (watchman=false is required in this sandbox — watchman cannot `fchmod` its state file under the write allowlist; `--ci` is equivalent; on the user's machine `pnpm test` runs without the flag). See the 1.2 spec for the same limitation.
- `./node_modules/.bin/tsc --noEmit` -- expected: exit 0. The `tsconfig.json` `paths` alias MUST be in place or the macOS prop types (`enableFocusRing`/`keyDownEvents`/`onKeyDown`) fail to resolve.

**Manual checks (optional, human-run):**
- Run `pnpm run macos`. Confirm: sidebar (4 rows, ~180px) + status header render; clicking a row selects it (accent fill) and swaps the content; `⌘1`–`⌘4` switch surfaces with a visible focus ring on the selected row; with VoiceOver on, navigation announces "<Surface>, 0 domains". The unit test + `tsc` are the primary verification, so this is optional.

## Matrix Test Audit

Every I/O & Edge-Case Matrix row is accounted for below. Tests that ran green are marked with the test name; rows that are a native-runtime behavior (not unit-testable in node) are marked as such with their coverage path. No test disagreed with its matrix row; no row was ambiguous. Verification: `tsc --noEmit` exit 0; `jest --watchman=false` 4 suites / 24 tests pass (including the 12 Shell tests).

| Matrix row | Coverage |
|------------|----------|
| Sidebar row click | `clicking a sidebar row selects it and swaps the content to that surface` — clicks Timer (idx 1) then Settings (idx 3); asserts the content swaps ("No timer running" / "App settings will appear here"), exactly one row selected, and the clicked row is the selected one. Ran + passed. |
| ⌘1–⌘4 nav | `⌘1 selects row 0 (Blocklist)` + `⌘2 selects row 1 (Timer)` + `⌘3 selects row 2 (Schedule)` + `⌘4 selects row 3 (Settings)` — each invokes `onKeyDown` with `{nativeEvent:{metaKey:true,key:'1'|'2'|'3'|'4'}}` (the ⌘1 test first navigates away via ⌘2 so the ⌘1 change is real, not a no-op on the already-selected default), asserts the right row is selected, exactly one active, and `announceForAccessibility` was called with `"<Surface>, 0 domains"`. Ran + passed. |
| ⌘ with non-1-4 key | `⌘ with a key outside 1-4 does not navigate` — `onKeyDown` with `{metaKey:true,key:'b'}`; row 0 stays selected, no announce. Ran + passed. |
| Plain number (no ⌘) | `a plain number key without ⌘ does not navigate` — `onKeyDown` with `{metaKey:false,key:'2'}`; row 0 stays selected, no announce. Ran + passed. |
| Initial mount | `Shell mounts with Blocklist (row 0) active and exactly one row selected` — row 0 `accessibilityState.selected === true`, exactly one selected row. Ran + passed. The "receives keyboard focus on mount" half is a native-runtime behavior: `ref.focus()` is a `NativeMethod` (a no-op in the jest node env), so it is not unit-testable; covered by code review — the mount `useEffect` at `Shell.tsx:56-61` calls `rowRefs[0].current?.focus()`. The optional manual check confirms the ring. |
| Status header on every surface | `the status header renders the Free badge and the static placeholders` + `the status header is present on every selected surface` — asserts "Free" + "0 domains" + "no active timer" are present, and stay present after each of ⌘1–⌘4. Ran + passed. |
| Appearance change (light↔dark) | Native-runtime behavior, not unit-testable in node. Coverage: code review — `Shell`/`Sidebar`/`SidebarRow`/`StatusHeader` consume `tokens` (PlatformColor for adaptive colors, static hex for `primaryForeground`); there is no manual appearance branching, so adaptation is inherent to PlatformColor. Optional manual check confirms visually. |
| Accent change | Native-runtime behavior, not unit-testable in node. Coverage: `tokens.primary` = `PlatformColor('controlAccentColor')` is the `SidebarRow` selected fill (code review) — `controlAccentColor` follows the user's Accent Color at runtime. Optional manual check confirms. |
| VoiceOver off | Native-runtime behavior, not unit-testable in node. Coverage: `AccessibilityInfo.announceForAccessibility` is inherently a no-op when VoiceOver is off (an AccessibilityInfo implementation detail); the ⌘-key handler does not depend on VoiceOver, so the app stays fully keyboard-usable. Optional manual check confirms. |

**Test-quirk notes (why the Shell tests look the way they do):**
- Rows are located by contract props (`onPress` fn + `accessibilityRole:'button'`), not `findByType(Pressable)` — the same pnpm + RN 0.81 lazy-getter identity mismatch the 1.2 `ApplyButton` test hit. The `keyDown` container is located by its `onKeyDown` + `keyDownEvents` + `focusable` triple (the `View` mock's spread-prop quirk means `findAll` can double-match the root and its spread descendant; `matches[0]` is the outermost root).
- The shell reads safe-area insets via `useSafeAreaInsets`, so the test renders it inside a `SafeAreaProvider` with `initialSafeAreaInsets` set to zero insets — otherwise the provider renders `null` children while `insets` is null (the preset's `onInsetsChange` never fires in node). `App.test.tsx` gets this for free from `App`'s own provider; the Shell test makes it explicit so the subtree is present for assertions.
- `AccessibilityInfo.announceForAccessibility` is auto-mocked by the RN preset as a `jest.fn()`, but the react-native-macos TS type is `(announcement: string) => void` (no mock members); the test casts it once to `jest.Mock` so `.mockClear()` / `.toHaveBeenCalledWith(...)` type-check.
## Suggested Review Order

**Window shell & keyboard wiring**

- Entry point — owns the active-surface `useState` and the four `rowRefs`; the focusable root carries `⌘1`-`⌘4`.
  [`Shell.tsx:35`](../../src/components/Shell.tsx#L35)

- One place does setSurface + `ref.focus()` + `announceForAccessibility` — the whole nav design intent in a single function.
  [`Shell.tsx:45`](../../src/components/Shell.tsx#L45)

- `onKeyDown` gates on `metaKey` AND key in `1`-`4`; a plain digit (no ⌘) is deliberately ignored.
  [`Shell.tsx:63`](../../src/components/Shell.tsx#L63)

- Root `View` is `focusable` and declares the four ⌘-keys as handled via `keyDownEvents` so the native default doesn't swallow them.
  [`Shell.tsx:72`](../../src/components/Shell.tsx#L72)

**Sidebar composition**

- Maps `SURFACE_NAMES` to four rows, fixed 180px width, hands the shell-owned `rowRefs` down to each row.
  [`Sidebar.tsx:33`](../../src/components/Sidebar.tsx#L33)

- `forwardRef` Pressable: `accessibilityRole="button"`, selected row = `tokens.primary` fill + `primaryForeground` text, native focus ring on the row.
  [`SidebarRow.tsx:26`](../../src/components/SidebarRow.tsx#L26)

**Status header**

- Static `StatusBadge "free"` · `"0 domains"` · `"no active timer"`, present unchanged on every surface.
  [`StatusHeader.tsx:18`](../../src/components/StatusHeader.tsx#L18)

**Surface model**

- `SURFACE_NAMES` is the single source of truth for labels; `SurfaceIndex` + `EMPTY_STATE_TEXT` drive the placeholder.
  [`surfaces.tsx:23`](../../src/components/surfaces.tsx#L23)

**App wiring & tsconfig alias**

- `<Shell/>` replaces the scaffold body inside the existing 1.1 `SafeAreaProvider` + `StatusBar` wrapper.
  [`App.tsx:13`](../../App.tsx#L13)

- `paths` alias resolves `react-native` types to `react-native-macos` (TS-types only, runtime-neutral).
  [`tsconfig.json:1`](../../tsconfig.json#L1)

**Tests**

- Twelve tests cover the full I/O matrix: rows/order, clicks, `⌘1`-`⌘4`, plain-key + out-of-range gating, header persistence, and the `focusable`/`keyDownEvents` declaration.
  [`Shell.test.tsx:102`](../../__tests__/Shell.test.tsx#L102)
