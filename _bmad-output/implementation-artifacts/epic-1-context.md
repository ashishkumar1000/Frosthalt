# Epic 1 Context: Foundation & Apply Pipeline

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Stand up the load-bearing wall of the app: a runnable macOS window (sidebar + persistent status-header shell), two of the three native TurboModules, the config store, and the single shared staged-then-Apply pipeline that every later epic calls rather than rebuilds. The pipeline is proven end-to-end on one domain — add it to config, Apply, verify the managed `/etc/hosts` section appears and the domain fails to load in a browser with DNS flushed — so the riskiest code (privileged write) is de-risked in isolation before any management UI is layered on top.

## Stories

- Story 1.1: Scaffold the react-native-macos app with New Architecture and Jest
- Story 1.2: Design token system and shared visual primitives
- Story 1.3: Sidebar navigation and status-header shell
- Story 1.4: ConfigStore TurboModule and config shape
- Story 1.5: ShellRunner TurboModule and hosts-file contract
- Story 1.6: Staged-then-Apply serialized pipeline, proven on one domain
- Story 1.7: Drift detection and user-initiated Restore section

## Requirements & Constraints

- Apply writes the managed `/etc/hosts` section from the current effective blocklist with exactly one OS admin prompt per apply. No always-on background daemon.
- The status header shell renders `[badge] · 0 domains · no active timer` (badge "Free", count placeholder). Countdown and real domain count land in later epics.
- System-wide blocking operates on `/etc/hosts` (not a browser extension), so it works across every browser.
- Hosts safety: only a marked `# BEGIN/END FROSTHALT` section is managed; existing hosts content is preserved; a backup (`/etc/hosts.fh.bak`) is taken before every change; `root:wheel` + `0644` restored after write.
- Injection safety: any variable content (domain names) placed into the privileged shell script is validated against a strict hostname regex and inserted via a quoted heredoc — never string-interpolated.
- UI stays responsive; privileged shell operations run off the main thread. Apply is batched behind one button to minimise prompts.
- Fully offline, no network calls. No third-party installer; the app runs as the user's own code.
- Two distinct gates, never conflated: (1) the OS admin prompt fires on every Apply that writes `/etc/hosts`; (2) the app self-discipline password (not built in this epic — Epic 3) gates escapes only.
- Drift (hand-edited or missing managed section) is reconciled only by a user-initiated "Restore section" — never automatically.

## Technical Decisions

**Stack:** `react-native-macos` 0.81.x with New Architecture (Fabric + TurboModules) enabled by default — do not set `RCT_NEW_ARCH_ENABLED=0`. Hermes JS engine. Zustand ^5 for client state. Swift business logic + Obj-C++ glue via codegen. macOS deployment target 14.0 (Sonoma). Node 20 LTS is toolchain only. Jest with the `react-native` preset is the test runner, pinned in Story 1.1 so the whole epic is test-first (New Architecture does not affect JS unit tests).

**Paradigm — ports & adapters:** `UI → domain (Zustand) → adapters → ports`, strictly one-way. Adapters never import each other or the UI; the domain is the only hub. The domain layer is the sole owner of effective-blocklist computation and the sole caller of `ShellRunner.writeHosts`. No `child_process`/`fs`/`os` imports anywhere in `src/` — Hermes has no Node built-ins at runtime.

**Two TurboModules built in this epic** (the third, MenuBar, is deferred to Epic 6). Each is authored as a TypeScript spec `specs/Native<Name>Spec.ts` → codegen → Obj-C++ implementation with Swift business logic via the adapter pattern (`-Swift.h` import + bridging header). No legacy `RCT_EXPORT_MODULE` bridge modules. Every method returns `{ ok: boolean, error?: string, data?: T }` over the JSI bridge.

- **ShellRunner (privileged)** — the ONLY module that elevates. One `osascript … do shell script "…" with administrator privileges` per Apply batches: backup → rewrite whole managed section → restore owner/mode → DNS flush. Dispatched off the main thread; resolves the JS Promise on completion.
- **ConfigStore (unprivileged)** — reads/writes `~/Library/Application Support/Frosthalt/config.json` via `NSSearchPathForApplicationSupportDirectory`; atomic write (temp file + rename). A missing/corrupt config is treated as empty (no crash); a missing directory is created.

**Hosts-file contract:** own one delimited `# BEGIN FROSTHALT` … `# END FROSTHALT` section; everything outside untouched. Block targets are `0.0.0.0` (IPv4) + `::` (IPv6) — not loopback, which can serve a local dev server. Each domain emits apex + `www.` (4 lines). Full-section-rewrite on every change (idempotent, self-healing on drift), never incremental edits. DNS flush = `dscacheutil -flushcache` + `killall -HUP mDNSResponder`.

**Staged-then-Apply:** block-affecting mutations are held in a Zustand staged-edits buffer (a draft copy of the editable slice). Apply is the only path that (a) commits staged → `config.json` via ConfigStore and (b) triggers the ShellRunner write + DNS flush. Cancel discards staged back to last-committed. Non-block-affecting UI state (menuBarEnabled, window prefs) may commit directly.

**Serialized, domain-owned Apply:** one atomic pipeline run in strict order — commit staged → config.json → compute effective blocklist → `ShellRunner.writeHosts`. Concurrent Apply intents queue and run strictly one-at-a-time, never in parallel. A failed write (admin denied) leaves staged edits intact for retry and does not advance the queue state.

**Revocable source-of-truth:** `config.json` is canonical intent; the `/etc/hosts` managed section is derived enforcement = `always-on ∪ active-timer ∪ active-schedule`, recomputed on Apply. No background daemon, no integrity re-add (deliberately not an irrevocable lock).

**config.json shape (epic-relevant subset):** `domains[] { hostname (PK, normalised lowercase apex), alwaysOn bool }`, `settings { menuBarEnabled bool }`, plus reserved slots `passwordHash`, `schedules[]`, `activeTimer` for later epics. camelCase keys.

**Error handling:** a denied admin prompt returns `{ ok: false, error: "admin-denied" }`, leaves `/etc/hosts` unchanged, and surfaces the toast "Couldn't update /etc/hosts. No changes made." with staged edits retained.

## UX & Interaction Patterns

**Design tokens** map to NSColor system semantic colors so they adapt to light/dark and the user's Accent Color: `primary` #007AFF (follows system accent), `status-free` #34C759, `status-amber` #FF9500, `status-blocked` / `destructive` #FF3B30, `mono-bg` #1E1E1E / `mono-fg` #E6E6E6. Typography: body 13px, label 11px/500, title 17px/600, countdown 28px/600 tabular-nums, mono SF Mono 12px. Rounded 4/6/10px. Spacing 4/8/16/24/32 on the 8pt grid. All unlisted tokens inherit NSColor system defaults.

**Left sidebar:** 4 rows (Blocklist / Timer / Schedule / Settings), ~180px fixed width, one row active at a time; selected row uses `primary` fill + primary-foreground text. `⌘1`–`⌘4` select the four surfaces. Built from RN primitives (no native sidebar).

**Persistent status header:** always visible above content across all surfaces; reads `[badge] · 0 domains · no active timer` in this epic. The `StatusBadge` is a pill ("Free"/"Blocking"/"Blocked", white text over the status-ramp fill) — never decorative.

**Apply button:** `primary` fill, the view's default button (bound to Return), pulses as the default. Exactly one per view.

**Keyboard-first:** `⌘1`–`⌘4` nav, `Return` fires the default button (Apply), `Esc` closes the topmost sheet/alert.

**Accessibility floor:** VoiceOver announces the surface on navigation ("Blocklist, 0 domains"); full keyboard operability with Tab order = reading order; focus rings visible; macOS checkboxes over iOS switches (idiomatic, discoverable). Visual contrast WCAG AA in both appearances.

**Platform:** `LSUIElement=false` (hybrid Dock + menu bar — the menu-bar item itself is wired in Epic 6). `Platform.OS === 'macos'` branching; no iOS/Android/web in v1. No in-app theme toggle (follows system light/dark + Accent Color).

## Cross-Story Dependencies

- Story 1.1 (scaffold + Jest) is the foundation every later story builds on test-first.
- Story 1.6 (the Apply pipeline) depends on both 1.4 (ConfigStore) and 1.5 (ShellRunner); it is the shared pipeline Epics 2–5 call rather than rebuild.
- Story 1.7 (drift / Restore section) depends on 1.5 (ShellRunner) and 1.6 (the Apply path) to rewrite the managed section.
- The MenuBar TurboModule (the third native module) is intentionally deferred to Epic 6; this epic builds only ShellRunner + ConfigStore.
- The app-password gate is not built here — Epic 3 owns it. This epic surfaces only the OS admin prompt (the first gate).