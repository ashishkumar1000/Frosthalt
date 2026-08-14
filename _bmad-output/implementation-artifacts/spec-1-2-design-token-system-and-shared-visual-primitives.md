---
title: 'Design token system and shared visual primitives'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: '2f18934dc6f8b1bb6fcfebaa56ab66890334ad51'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/ux-designs/ux-Frosthalt-2026-08-13/DESIGN.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Story 1.1 scaffold has no `src/` layer, no design tokens, and no shared components — so every later surface would reinvent colors, typography, spacing, and the `StatusBadge` + `ApplyButton` primitives, drifting from the calm-utility identity fixed in DESIGN.md.

**Approach:** Introduce the first `src/` layer: one design-token module that maps the brand palette to NSColor system semantic colors (adapting to light/dark + the user's Accent Color) and pins typography/radii/spacing from DESIGN.md, plus two shared primitives — `StatusBadge` (pill, white text over the status ramp) and `ApplyButton` (primary-filled default-intent button) — and a unit test asserting the badge fills map to the three status tokens.

## Boundaries & Constraints

**Always:**
- Map semantic brand colors to `PlatformColor` with NSColor names: `primary` → `controlAccentColor` (follows system accent), `status-free` / `status-amber` / `status-blocked` → `systemGreenColor` / `systemOrangeColor` / `systemRedColor`, `destructive` → `systemRedColor`. These adapt to light/dark + accent automatically; no manual appearance branching.
- Keep `primary-foreground` (#FFFFFF), `mono-bg` (#1E1E1E), `mono-fg` (#E6E6E6) as plain hex strings — static in both appearances; do NOT wrap them in `PlatformColor`.
- Pin typography (body 13/400, label 11/500, title 17/600, countdown 28/600 tabular-nums, mono SF Mono 12/400), rounded (sm 4 / md 6 / lg 10), spacing (xs 4 / sm 8 / md 16 / lg 24 / xl 32) exactly per the DESIGN.md frontmatter.
- Build `StatusBadge` and `ApplyButton` from RN primitives (`Pressable` / `View` / `Text`) — react-native-macos exposes no native sidebar/tab/button with the needed styling.
- Structure the token module so the semantic color **names** are exported as plain string constants (assertable in Jest without a native runtime), with `PlatformColor(...)` as a thin runtime wrapper over them.
- Use the existing `react-native` Jest preset; use **pnpm**; use relative imports only (no `@/` alias — none is configured in tsconfig/babel/metro).
- Keep `src/` free of `child_process` / `fs` / `os` imports (Hermes has no Node built-ins at runtime).

**Ask First:**
- Any deviation from a DESIGN.md token value or its NSColor mapping (e.g. choosing `systemBlueColor` instead of `controlAccentColor` for `primary`) — HALT and ask the human before proceeding.
- Introducing a path alias (`tsconfig.paths` + `babel-plugin-module-resolver` + a Metro resolver entry) — out of scope unless the human says otherwise.

**Never:**
- Do NOT hardcode a hex color where a system semantic color exists (the status ramp, `primary`).
- Do NOT use status colors (red / green / amber) for chrome, links, or decoration.
- Do NOT introduce Zustand, state management, TurboModules, native modules, or any privileged / hosts logic — those belong to stories 1.4–1.6.
- Do NOT build the window shell, sidebar, or status-header layout — that is Story 1.3. `App.tsx` is not wired to the new primitives in this story.
- Do NOT import Node built-ins (`child_process` / `fs` / `os`) anywhere in `src/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| StatusBadge free | `status="free"` | pill, `status-free` (systemGreen) fill, white "Free" text, radius full | N/A |
| StatusBadge amber | `status="amber"` | pill, `status-amber` (systemOrange) fill, white "Blocking" text | N/A |
| StatusBadge blocked | `status="blocked"` | pill, `status-blocked` (systemRed) fill, white "Blocked" text | N/A |
| StatusBadge unknown status | `status` not one of free/amber/blocked | renders nothing (returns `null`) — the badge is never decorative | N/A |
| ApplyButton idle | `label` + `onPress`, not disabled | primary (controlAccent) fill, primary-foreground white text, rounded.md, fires `onPress` on press | N/A |
| ApplyButton disabled | `disabled=true` | reduced-opacity, non-interactive; `onPress` does not fire | N/A |
| Appearance change | system light↔dark | all `PlatformColor` tokens adapt automatically; static hex tokens unchanged | N/A |
| Accent change | user changes System Settings Accent Color | `primary` (controlAccentColor) and the ApplyButton fill follow it | N/A |
| Jest runtime | unit test runs in node (no NSColor runtime) | test asserts the exported status NAME constants (plain strings), not `PlatformColor` mock objects | N/A |

</frozen-after-approval>

## Code Map

- `src/theme/tokens.ts` -- NEW. The single source of truth. Exports `statusColorNames` (`{ free: 'systemGreenColor', amber: 'systemOrangeColor', blocked: 'systemRedColor' }` — plain strings, for Jest), a `tokens` object (`primary`/status/`destructive` via `PlatformColor`; `primaryForeground`/`monoBg`/`monoFg` as plain hex; plus `typography`, `rounded`, `spacing`), and a `statusFill(status)` helper mapping a status key to its `PlatformColor`. Other DESIGN.md component specs (sidebar-row, countdown-ring, hosts-viewer, danger-zone) consume these tokens in later stories — not built here.
- `src/components/StatusBadge.tsx` -- NEW. Pill (`borderRadius` full), white text (label typography), fill from `statusColorNames` via tokens; props `status: 'free' | 'amber' | 'blocked'`; unknown → `null`. Accessible (role + accessibilityLabel).
- `src/components/ApplyButton.tsx` -- NEW. `Pressable` with primary (controlAccent) fill, primary-foreground text, rounded.md; props `label`, `onPress`, `disabled`. Visual primitive only — the window default-button pulse + Return binding is carried to Story 1.3 (see Design Notes).
- `__tests__/StatusBadge.test.tsx` -- NEW. Asserts `statusColorNames.free/amber/blocked` equal the three NSColor names, and that `StatusBadge` renders "Free" / "Blocking" / "Blocked" for each status (react-test-renderer + `act`, matching the existing `App.test.tsx` style). This is the AC-4 unit test.
- `App.tsx` -- NOT modified (the shell lands in 1.3; the primitives are library code consumed then).
- `tsconfig.json`, `babel.config.js`, `metro.config.js`, `jest.config.js` -- no change (no alias added; the jest preset is already pnpm-aware from Story 1.1).

## Tasks & Acceptance

**Execution:**
- [x] `src/theme/tokens.ts` -- create the token module: `statusColorNames` string constants + `tokens` (PlatformColor-wrapped semantic colors, static hex for primary-foreground/mono, plus typography/rounded/spacing) + `statusFill` helper -- the single source every later surface imports.
- [x] `src/components/StatusBadge.tsx` -- create the pill badge: white label text over the status-ramp fill, `status` prop, unknown → null, accessible -- satisfies the StatusBadge AC.
- [x] `src/components/ApplyButton.tsx` -- create the primary-filled button primitive (Pressable, controlAccent fill, white text, rounded.md, disabled state) -- satisfies the ApplyButton visual AC; default-button pulse/Return deferred to 1.3 (Design Notes).
- [x] `__tests__/StatusBadge.test.tsx` -- add the unit test asserting the three status name constants map to systemGreen/Orange/Red and each status renders its label -- satisfies AC 4 and the I/O Matrix badge rows. step-04 added a fill-wiring test (renders each status, asserts the badge's `backgroundColor` is identity-equal to `tokens.status[status]`) -- closes the AC-4 "badge fills map to the three status tokens" gap that the name-constant tests alone left open (changing `statusFill` or dropping the fill binding kept the suite green).
- [x] `__tests__/ApplyButton.test.tsx` -- add the unit test covering the I/O Matrix ApplyButton idle + disabled rows (renders label, fires onPress, disabled state wired, reduced-opacity on disabled) -- added during step-03 Matrix Test Audit to cover the ApplyButton matrix rows (the spec's single badge test had not covered them). step-04 added a pressed-opacity test (invokes the Pressable style callback with `pressed:true`, asserts opacity 0.85) -- covers the press-feedback affordance that the disabled-opacity test left unverified.
- [x] run the test suite green -- `__tests__/StatusBadge.test.tsx` (8: 3 name-constant + 3 render + 1 null + 1 fill-wiring) + `__tests__/ApplyButton.test.tsx` (3: idle + disabled + pressed) + `__tests__/App.test.tsx` (1) all pass (12/12); `tsc --noEmit` exits 0. Run via `./node_modules/.bin/jest --watchman=false` (watchman cannot start in the sandbox -- see Verification).

**Acceptance Criteria:**
- Given `src/theme/tokens.ts`, when the token module is inspected, then `primary` maps to `controlAccentColor` (follows system accent) and the status tokens map to `systemGreenColor` / `systemOrangeColor` / `systemRedColor`, all via `PlatformColor`, adapting to light/dark automatically.
- Given `StatusBadge` with `status="free"` / `"amber"` / `"blocked"`, when rendered, then it shows a pill with white "Free" / "Blocking" / "Blocked" text over the status-free / amber / blocked fill respectively.
- Given `ApplyButton` with a label, when rendered, then it shows a primary (controlAccent) fill, primary-foreground white text, rounded.md corners, and fires `onPress` when pressed; when `disabled`, it is non-interactive. (Window default-button pulse + Return binding land in Story 1.3 — see Design Notes.)
- Given the test suite, when `pnpm test` runs, then `__tests__/StatusBadge.test.tsx` passes and asserts the badge fills map to the three status tokens.
- Given `src/`, when inspected, then no `child_process` / `fs` / `os` imports exist and no Zustand / TurboModule / native-module code exists.

## Spec Change Log

<!-- Append-only. Populated by step-04 during review loops. Empty until the first bad_spec loopback. -->

## Design Notes

**Why `controlAccentColor` for `primary`, not `systemBlueColor`:** DESIGN.md's `#007AFF` is the nominal/fallback value; the intent ("follows the user's Accent Color preference") requires `controlAccentColor` (AppKit `NSColor.controlAccentColor`), which tracks System Settings → Accent Color at runtime. `systemBlueColor` is fixed blue and would NOT follow accent, contradicting the AC.

**Why static hex for `primary-foreground` / `mono-bg` / `mono-fg`:** These are the same in both appearances (white over saturated fills; the mono viewer is dark in both light and dark). `PlatformColor` is only for native semantic names; wrapping a fixed hex would be wrong. They also assert trivially in Jest.

**Why name-string constants + a thin `PlatformColor` wrapper:** `PlatformColor` returns an opaque object needing the native runtime to resolve. In Jest (node, `react-native` preset) it is mocked, and assertions on the mock object shape couple to the RN version. Exporting `statusColorNames` as plain strings makes the mapping the source of truth and assertable without a native runtime (AC 4); the `tokens` object wraps them in `PlatformColor(...)` for runtime.

**ApplyButton default-button behavior — carried to Story 1.3:** The AC's "window's default button (pulses, bound to Return)" is an AppKit `NSWindow.defaultButtonCell` concept. react-native-macos 0.81 does NOT expose a `defaultButton` / `keyEquivalent` / `pulse` prop on its `Button` (verified: `Button.d.ts` exposes only `title` / `color` / `onPress` / `disabled`); macOS key handling is via `View` keyboarding props (`keyDown` / `validKeysDown` / `onKeyEvent`), and there is no window shell until Story 1.3. So 1.2 delivers the visual primitive (colors / radius / text / press / disabled); the pulse + Return binding is delivered with the shell in 1.3, via the keyboarding API or a small native affordance if primitives prove insufficient. This is a planning decision — surfaced here for CHECKPOINT 1 approval.

## Verification

**Commands:**
- `./node_modules/.bin/jest --watchman=false` -- re-ran green after step-04 patches: 12/12 tests pass (`StatusBadge.test.tsx` 8, `ApplyButton.test.tsx` 3, `App.test.tsx` 1). The +2 over the pre-review 10/10 are the step-04 fill-wiring test (StatusBadge) and pressed-opacity test (ApplyButton). `watchman=false` is required in this sandbox: watchman cannot `fchmod` its state file under the sandbox's write allowlist, so jest's default watchman watcher crashes on startup with `Operation not permitted` (a sandbox limitation, not a test failure). `--ci` is an equivalent alternative. On the user's own machine `pnpm test` runs the same suite without this flag.
- `./node_modules/.bin/tsc --noEmit` -- ran green: exit 0, no type errors in the new `src/` files. (Bypassing `pnpm exec` avoids pnpm's deps-status check, which can wipe `node_modules` on an EPERM unlink under the sandbox.)

**Manual checks (visual confirmation, optional):**
- Temporarily mount `<StatusBadge status="amber" />` and `<ApplyButton label="Apply" onPress={() => {}} />` in `App.tsx`, run `pnpm run macos` (human-run), confirm the badge is a pill with white "Blocking" text on orange and the button is accent-filled with white text and rounded.md corners; then revert `App.tsx`. The unit test + `tsc` are the primary verification, so this is optional.

## Matrix Test Audit

Every I/O & Edge-Case Matrix row is accounted for below. Tests that ran green are marked with the test name; rows that are a native-runtime behavior (not unit-testable in node) are marked as such with their coverage path. No test disagreed with its matrix row; no row was ambiguous.

| Matrix row | Coverage |
|------------|----------|
| StatusBadge free | `StatusBadge renders "Free" for status="free"` (text "Free" + accessibilityLabel "Status: Free" + accessibilityRole "text" on the host node) covers the label/accessibility contract; `statusColorNames.free maps to systemGreenColor` covers the NSColor NAME; the fill binding (badge backgroundColor IS `tokens.status.free`) is covered by the step-04 fill-wiring test `StatusBadge fill maps each status to its status token` (identity-equal, not PlatformColor-shape). Ran + passed. |
| StatusBadge amber | `StatusBadge renders "Blocking" for status="amber"` (label) + `statusColorNames.amber maps to systemOrangeColor` (name) + fill-wiring test (badge backgroundColor IS `tokens.status.amber`). Ran + passed. |
| StatusBadge blocked | `StatusBadge renders "Blocked" for status="blocked"` (label) + `statusColorNames.blocked maps to systemRedColor` (name) + fill-wiring test (badge backgroundColor IS `tokens.status.blocked`). Ran + passed. |
| StatusBadge unknown status | `StatusBadge renders null for an unrecognised status` (`toJSON()` is null). Ran + passed. |
| ApplyButton idle | `ApplyButton renders its label and fires onPress when pressed` (label "Apply", `disabled=false`, `accessibilityState={disabled:false}`, `onPress` fires once) + step-04 `ApplyButton shows reduced opacity in the pressed state` (invokes the style callback with `pressed:true`, asserts opacity `0.85`) covers the press-feedback affordance. Ran + passed. |
| ApplyButton disabled | `ApplyButton disabled reflects the disabled state` (`disabled=true`, `accessibilityState={disabled:true}`, opacity style `0.4` present). Ran + passed. The "onPress does not fire" half is enforced by the native PressResponder at runtime, not by calling `onPress` directly in node; the disabled contract the responder reads (`disabled` prop + `accessibilityState`) is asserted. |
| Appearance change (light↔dark) | Native-runtime behavior, not unit-testable in node. Coverage: code review confirms `tokens.ts` uses `PlatformColor(...)` for every adaptive color (no manual appearance branching) and keeps `primaryForeground`/`monoBg`/`monoFg` as static hex -- so adaptation is inherent to PlatformColor, not code that could drift. Optional manual check confirms visually. |
| Accent change | Native-runtime behavior, not unit-testable in node. Coverage: `primary: PlatformColor('controlAccentColor')` in `tokens.ts` (code review) -- controlAccentColor follows the user's Accent Color at runtime. Optional manual check confirms. |
| Jest runtime | The three `statusColorNames.* maps to system<Color>Color` tests assert the plain-string name constants (not `PlatformColor` mock objects). The step-04 fill-wiring test asserts the badge's `backgroundColor` is identity-equal to `tokens.status[status]` (the same PlatformColor object `statusFill` returns), so it verifies the status→fill wiring without coupling to PlatformColor's opaque resolved shape. Ran + passed. |

**Test-quirk notes (why two assertions look the way they do):**
- `StatusBadge` render tests assert on the host node returned by `toJSON()` rather than `findAll(accessibilityLabel === ...)` counts. The RN jest preset's `View` mock's `render()` does `createElement('View', props, children)`, spreading the parent's props onto the host element it renders -- so an accessibility-label `findAll` matches both the mock class instance and the host node (two matches), which is a mock artifact, not the component's contract. The host node's props are the rendered contract.
- `ApplyButton` tests locate the Pressable by its contract props (`accessibilityRole: 'button'` + an `onPress` function) rather than `findByType(Pressable)`. Under pnpm + react-native 0.81's lazy component getters, the `Pressable` reference the test imports is not identity-equal to the one in the rendered tree, so `findByType(Pressable)` finds nothing. The prop-based query is stable and says exactly what we mean.

## Suggested Review Order

**Token source of truth**

- Plain-string NSColor names — the Jest-assertable mapping every fill derives from.
  [`tokens.ts:29`](../../src/theme/tokens.ts#L29)

- The runtime token object — `PlatformColor` wraps the names; static hex for the rest.
  [`tokens.ts:85`](../../src/theme/tokens.ts#L85)

- `statusFill` returns the shared status token, so the badge fill can never drift from the export.
  [`tokens.ts:141`](../../src/theme/tokens.ts#L141)

**StatusBadge primitive**

- The fill wiring — `backgroundColor` is `statusFill(status)`, the one construction site.
  [`StatusBadge.tsx:38`](../../src/components/StatusBadge.tsx#L38)

- Unknown status → `null`; the badge is never decorative (frozen I/O matrix).
  [`StatusBadge.tsx:33`](../../src/components/StatusBadge.tsx#L33)

**ApplyButton primitive**

- `Pressable` style as a function of interaction state — pressed + disabled affordances.
  [`ApplyButton.tsx:33`](../../src/components/ApplyButton.tsx#L33)

**Tests**

- Fill-wiring test — asserts the rendered badge fill IS the status token (closes the AC-4 gap).
  [`StatusBadge.test.tsx:85`](../../__tests__/StatusBadge.test.tsx#L85)

- Pressed-opacity test — invokes the style callback with `pressed:true`, asserts opacity `0.85`.
  [`ApplyButton.test.tsx:77`](../../__tests__/ApplyButton.test.tsx#L77)