# Epic 2 Context: Permanent Blocklist

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Build the permanent blocklist management surface on top of Epic 1's trusted Apply pipeline. Users can add domains with live normalisation, toggle always-on, remove with a confirm-alert, see the live blocked-domain count in the status header, and view the exact managed `/etc/hosts` section verbatim in a read-only viewer that warns on drift. No new privileged code — only the management UI and the always-on path of effective-blocklist computation. After this epic, permanent blocking across all browsers is fully usable end-to-end.

## Stories

- Story 2.1: Blocklist surface with always-on checkbox
- Story 2.2: Add-domain field with live normalisation
- Story 2.3: Effective blocklist computation and Apply integration
- Story 2.4: Remove domain (confirm-alert)
- Story 2.5: Domain count in the status header
- Story 2.6: Read-only hosts viewer with drift warning

## Requirements & Constraints

- Add a domain by typing it; the app validates format and normalises it (strip `https://`/`http://`, strip `www.`, remove any path, lowercase) before it enters config. Duplicates and invalids are rejected inline; Add stays disabled until input is clean.
- Each entry blocks the apex domain and the `www.` subdomain on both IPv4 `0.0.0.0` and IPv6 `::` (4 lines per domain). `0.0.0.0`+`::`, not loopback, so a local dev server on `127.0.0.1`/`::1` keeps working.
- Each domain can be marked always-on (persistently blocked) or left for timer/schedule-only use. A non-always-on domain is NOT written by this epic's Apply — timer and schedule are empty here.
- Remove a domain via a confirm-alert only — single-item removal is a config edit, not an escape, so it is NOT password-gated (gate lands in Epic 3). Adding blocks is friction-free and exempt from any gate.
- The status header shows the count of effectively-blocked domains (not the raw config count), with the badge reflecting free vs blocked state.
- A read-only hosts viewer shows the exact `# BEGIN/END FROSTHALT` section verbatim; on drift (section missing/corrupt) it shows a warning banner and an admin-gated, user-initiated "Restore section" offer. No automatic re-add.
- This epic's stories carry their own keyboard + accessibility acceptance criteria — not deferred to a later polish epic.

## Technical Decisions

**No new privileged code.** This epic calls Epic 1's serialized staged-then-Apply pipeline; it adds only the blocklist surface and the always-on branch of effective-blocklist computation. The domain layer stays the sole owner of effective-blocklist computation and the sole caller of `ShellRunner.writeHosts`.

**Staged edits for the blocklist.** Add, remove, and always-on toggle are block-affecting mutations held in the Zustand staged-edits buffer (a draft copy of `domains[]`). Apply is the only path that commits staged → `config.json` and triggers the privileged write + DNS flush. Cancel discards staged. The Apply button pulses with an "N changes staged" hint while uncommitted edits exist.

**Effective blocklist (epic-relevant subset).** `always-on ∪ active-timer ∪ active-schedule` — only `always-on` is non-empty here. Always-on domains are written as apex + `www.` on `0.0.0.0` + `::`; a `alwaysOn = false` domain is not written by this Apply (no timer/schedule yet). Existing hosts content outside the marked section is preserved; DNS is flushed on every Apply.

**config.json shape (epic-relevant).** `domains[] { hostname (PK, normalised lowercase apex), alwaysOn bool }`. camelCase keys. Reads/writes go through ConfigStore (atomic, missing/corrupt → empty).

**Normalisation is pure and unit-tested.** Strip protocol, strip `www.`, remove path, lowercase, then validate against a strict hostname regex. Reused on every add; the same normalised form is what the live preview shows and what enters config.

**Drift / Restore section** is built in Epic 1 (Story 1.7) and surfaced in this epic's hosts viewer: the warning banner and the admin-gated Restore offer reuse that path. Drift is reconciled only by a user-initiated action — never automatically.

## UX & Interaction Patterns

**Blocklist surface (UX-DR6):** rows render as `[checkbox] domain.com [remove]`. The checkbox is a macOS-style checkbox (not an iOS switch) toggling `alwaysOn` optimistically; remove is a borderless trash button revealed on hover (no edit-in-place — remove and re-add instead). Empty state: "No domains yet. Add one to start blocking." with a primary "Add…" button.

**Add-domain field (UX-DR7):** single text field + Add button; live normalised-form preview below the field as the user types; inline errors for invalid ("Invalid domain. Try `example.com`.") and duplicate ("Already in your list."); Add disabled until clean; field clears on success and the edit is staged ("Apply to take effect").

**Apply button (UX-DR9):** `primary` fill, the view's default button (bound to Return), pulses when staged edits exist with an "N changes staged" hint; Cancel reverts staged-but-uncommitted.

**Read-only hosts viewer (UX-DR11):** the managed section shown verbatim in `mono-bg`/`mono-fg`, SF Mono, scrollable, no edit affordances (read-only by construction — no way to mutate state from this view). On drift: a warning banner ("Managed section not found — your hosts file may have been edited outside Frosthalt.") + an admin-gated "Restore section" offer. Reachable from Settings or the status-header "View hosts" link.

**Keyboard (UX-DR16):** `⌘1` opens Blocklist, `⌘N` focuses the add field (context-aware), `Return` fires Add (clean input) or Apply (staged edits), `Esc` cancels the confirm alert / closes the viewer, right-click row → context menu (Remove / Toggle always-on), hover reveals the remove button.

**Accessibility (UX-DR17):** VoiceOver announces "Blocklist, N domains, M always-on" on entry and the count on change; Tab order = reading order (checkbox → domain → remove); focus rings visible; checkboxes over switches; domain-count numeral uses tabular figures.

## Cross-Story Dependencies

- Whole epic depends on Epic 1: the serialized Apply pipeline (1.6), ConfigStore (1.4), ShellRunner hosts contract (1.5), and drift/Restore section (1.7). No privileged code is added here.
- Story 2.3 (effective blocklist + Apply integration) depends on 2.1 (surface) and 2.2 (add field) producing staged `domains[]` edits, then routes them through the Epic 1 pipeline.
- Story 2.5 (domain count in status header) depends on the effective-blocklist computation from 2.3 — the count is of effectively-blocked domains, not the raw config length.
- Story 2.6 (read-only hosts viewer + drift warning) depends on Epic 1's Story 1.7 (drift detection and the user-initiated Restore section path) for its warning banner and Restore offer.
- The app-password gate is not built here — Epic 3 owns it. Single-item removal in 2.4 uses a confirm-alert only; the gate covers escapes (end-early, Panic, change-password) in later epics.