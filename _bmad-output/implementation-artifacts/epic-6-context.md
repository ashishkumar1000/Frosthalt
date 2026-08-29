# Epic 6 Context: Menu Bar & Window Restoration

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic adds an additive polish layer on top of the fully working blocking app from Epics 1-5: a native menu-bar item that mirrors block state at a glance and offers quick actions without bringing the window forward, plus a window that remembers its size and position across launches. It introduces no new functional requirements — it delivers the menu-bar item and window/platform persistence, and it depends on everything built so far existing and working (Apply pipeline, domain layer, timer slice).

## Stories

- Story 6.1: MenuBar TurboModule (NSStatusItem + NSMenu)
- Story 6.2: Menu bar badge mirror and countdown
- Story 6.3: Menu bar quick-start, show window, and quit actions
- Story 6.4: Window size/position persistence and restoration
- Story 6.5: Quit-with-confirm and close-to-menu-bar keyboard bindings

## Requirements & Constraints

- The menu bar is the third and final native TurboModule (alongside the privileged shell module and the config-store module) — the JS runtime has no built-in way to own an `NSStatusItem`/`NSMenu`, so this must be native.
- The menu bar shows: block badge, countdown, "Start 25-min focus" quick-start, "Show window", and "Quit". It must never drift out of sync with the in-window status header — both read the same state.
- Quick-start reuses the existing focus-session start path (including the admin/password prompt where applicable) — no new privileged logic is introduced here.
- The window has explicit min/max bounds; it cannot be resized outside them. Zoom toggles between an app-standard size and the user's custom size — it never fills the screen.
- Restored window state persists via the existing settings store; a corrupt restore value falls back to the default size rather than failing.
- `⌘W` hides the window but keeps the app (and any running timer) alive in the menu bar; `⌘Q` quits, prompting for confirmation only if a timer is currently running; `Esc` cancels that confirm.
- Schedule transitions and timers still only run while the app process is alive (no background daemon) — the menu bar does not change this; it only surfaces state, it doesn't add enforcement while the app is fully quit.

## Technical Decisions

- Native modules follow one fixed shape: a TypeScript spec (`specs/Native<Name>Spec.ts`) → codegen → an Obj-C++ implementation that calls into Swift business logic via an adapter pattern (bridging header). No legacy bridge modules. Every native method returns `{ ok, error?, data? }` over the bridge — the menu-bar module follows this exact convention, matching the two existing native modules.
- All `NSStatusItem`/`NSMenu` mutations must happen on the main thread (dispatched explicitly); menu-item clicks emit events to JS through the TurboModule's event emitter rather than JS polling native state.
- `LSUIElement` stays `false` — Dock icon, main window, and menu-bar item all coexist (hybrid mode), not a menu-bar-only background app.
- Dependency direction is one-way: UI → domain (Zustand) → native adapters → system ports. The menu-bar adapter must not import the shell or config-store adapters, or the UI, directly — the domain layer is the only hub it talks to, same as the other two adapters.
- Badge and countdown text in the menu bar must be driven from the same Zustand timer slice the in-window status header already reads — this slice was deliberately scoped to a small, fixed set of subscribers (to avoid re-rendering the whole app every second); the menu bar becomes a third subscriber, not a new state source. One source of truth, two renderers, never independently computed.
- Config mutations split into two kinds: block-affecting changes (domains, schedules, timer) go through the staged-edits + Apply pipeline and eventually write `/etc/hosts`. Menu-bar-enabled state and window size/position are non-block-affecting — they commit straight to the settings store and never touch `/etc/hosts` or go through Apply.
- The current settings schema only defines a `menuBarEnabled` flag; a window-bounds/position field is not yet defined anywhere in the planning docs and will need to be added additively to that same settings area — nothing to carry over from source material here beyond "it goes in settings, alongside menuBarEnabled."

## UX & Interaction Patterns

- Menu-bar dropdown order/content: badge + countdown text, then "Start 25-min focus", "Show window", "Quit" as separate menu items.
- When no timer is active, the menu bar shows the Free badge and a plain "no active timer" line — no countdown chrome.
- Quit-confirm copy should be plain and factual (state the situation and the choice), not dramatized — avoid phrasing like exaggerated "are you REALLY sure" style prompts.
- General a11y floor carried into this epic's own menu-bar/keyboard ACs: full keyboard operability, a visible focus indicator, destructive actions are never the pre-selected/default choice in a dialog, and `Esc` always cancels a confirm. In-window surfaces already have their own a11y/keyboard ACs from Epics 1-5; this epic only needs to cover the menu bar and window-level shortcuts (`⌘W`, `⌘Q`, `Esc`).

## Cross-Story Dependencies

- Story 6.1 (the TurboModule itself) is a prerequisite for 6.2 and 6.3 — badge/countdown mirroring and menu actions need the module and its menu items to exist first.
- Story 6.3's quick-start action depends on the focus-timer start logic already built in Epic 4 (same start path, same admin-prompt behavior) — it does not reimplement session starting.
- Story 6.2's single-source-of-truth requirement depends on the Zustand timer slice already created in Epic 4 for the in-window status header; this epic adds the menu bar as its third consumer.
- Story 6.5's close-to-menu-bar behavior (`⌘W`) depends on the menu-bar item already existing (6.1) as the fallback place the app "lives" once the window is hidden.
- Story 6.4 (window persistence) is largely independent of the other four — it reads/writes settings via the existing config-store adapter and does not depend on the menu bar module.
