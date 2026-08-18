# Epic 4 Context: Focus Timer

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Add a timed focus-session capability on top of Epics 1–3. The user picks a duration (presets 25 / 45 / 60 min, plus a custom minute input), picks a subset of their blocklist domains, and starts a session that adds those domains to the effective blocklist for the chosen duration. A live hybrid countdown (shrinking ring + tabular-numeral `mm:ss`) shows time remaining across the status header and the Timer surface. The session ends automatically at expiry (unless a domain is also always-on), persists across an app close as an absolute epoch end-time, and is ended-early only after re-entering the app password. Closed-mid-session is preserved as anti-cheat; on next launch the session re-arms (resume if not yet expired, auto-unblock if past expiry). After this epic, blocking covers always-on + timer-driven + (later, Epic 5) scheduled.

## Stories

- Story 4.1: Timer surface with duration presets and domain selection
- Story 4.2: Start focus session (block + persist epoch end-time)
- Story 4.3: Live countdown (hybrid ring + scoped slice)
- Story 4.4: Countdown in the status header
- Story 4.5: Auto-unblock on expiry (unless also always-on)
- Story 4.6: End-early (password-gated)
- Story 4.7: Closed-mid-session persistence and re-arm on launch

## Requirements & Constraints

- The timer is a per-session selection of domains from the user's blocklist, not a new top-level source of intent. Always-on domains are unchanged by timer start/end; scheduled domains do not exist yet (Epic 5).
- An active session is persisted as an absolute epoch end-time `activeTimer: { endEpochMs, selectedDomains }` — not a relative remaining — so that a closed-app duration is computable on re-arm.
- Effective blocklist while a timer is active: `always-on ∪ active-timer-domains` (schedules contribute in Epic 5: `∪ active-schedule`). Selected non-always-on domains are written only for the duration; always-on domains stay written throughout.
- The countdown lives in a SCOPED Zustand slice subscribed to by exactly three consumers at this epic: the Timer surface (4.3) and the status header (4.4). The third consumer — the menu bar — is wired in Epic 6 from the same slice. Per-second ticks must NOT re-render unrelated surfaces.
- Adding a domain to a session is friction-free. Starting a timer is friction-free (mild: one OS admin prompt, the same one Apply always fires). Ending a session early is friction-by-design (password-gated) because it is an escape.
- Auto-unblock on expiry is local-only while the app is running: re-arming on next launch covers `now < end-time` (resume) vs `now ≥ end-time` (unblock via Apply). No `launchd`, no enforcement while the app is closed (PRD §10 / AR-14 deferred).
- A session that overlaps a previously-running session supersedes it cleanly (stale config trimmed at start time, never lingering `selectedDomains` from a prior run).
- All native results retain the `{ ok, error?, data? }` envelope. An admin-denied Apply during Start OR End OR Expiry surfaces the standard toast "Couldn't update /etc/hosts. No changes made." and leaves intent (`activeTimer` / staged edits) intact for retry.
- This epic's stories carry their own keyboard + accessibility acceptance criteria — not deferred to a later polish epic.

## Technical Decisions

**Persist the timer as an absolute epoch (AR-9 / AD-7).** `config.json` carries `activeTimer: { endEpochMs: number, selectedDomains: string[] }` (0..1). `endEpochMs` is computed at Start time as `Date.now() + durationMs` and persisted via the same ConfigStore shared queue as `setPassword` (race-safe against an in-flight Apply). On launch, the re-arm comparison `Date.now() vs endEpochMs` is fully deterministic — wall-clock skew during a sleep/resume is the user's machine, not ours.

**Effective blocklist on the domain layer is still the SOLE entry to `ShellRunner.writeHosts` (AR-8).** Timer start computes `always-on ∪ active-timer-domains`, stages via the same Apply mechanism Epics 1 and 2 use, calls `writeHosts` exactly once. Timer expiry and end-early each follow the same Apply path: compute the new effective blocklist (`always-on` only, because the active-timer set lifts), commit, `writeHosts`. No parallel "remove timer domains" code path; the next effective-blocklist is the source of truth.

**Countdown lives in a scoped Zustand slice that DOES NOT live on the same store as `committed` / `staged` / `applyStatus`.** Three reasons: (a) the status header and Timer surface need the live mm:ss without re-rendering the blocklist row tree; (b) the menu-bar (Epic 6) will be the third consumer; (c) keeping the timer in a separate slice avoids polluting any Apply-stage state. The slice exposes: `nowMs` (wall-clock simulation reference), `endEpochMs` (mirrored from `committed.activeTimer.endEpochMs` whenever it changes), and a single `setInterval(1000)` driver started/stopped on active-timer transitions.

**Timer start IS staged-then-Apply (AR-6).** Starting a timer is block-affecting; the new `activeTimer` write is held in the same staged-edits buffer alongside any in-flight domain edits and committed only on Apply. Stories 4.1 and 4.2 together prove the wiring on a chosen subset. End-early and auto-unblock each run through Apply with the computed next-effective-blocklist.

**Re-arm on launch lives in the store init path.** When `init()` reads config and sees a non-null `activeTimer`, it compares `Date.now()` to `endEpochMs`. If `now >= end-time`, it clears `activeTimer` AND triggers an Apply that rewrites the managed section to `always-on` only (re-using Story 4.5's expiry path). If `now < end-time`, it leaves `activeTimer` intact — the per-second countdown resumes on first `setInterval` start, which happens on the store side the moment the consumer subscribers mount.

**Scoped-subscription protocol.** Only the Timer surface, the status header, and (later) the menu bar subscribe to the timer slice via `useTimerStore(selector)`. They re-render on the slice's `nowMs` change. The blocklist / settings / schedule / staged-edits paths do NOT subscribe to `nowMs`. Tabular figures make the numeral stable; the ring is rendered via inline SVG with a single `stroke-dasharray` transition driven from `1 - remainingMs / totalMs`.

**Race handling for in-flight Apply at expiry.** If a timer expires while a user-initiated Apply (e.g. adding a domain) is running on the same serialized queue, the expiry action waits behind it. Expiry computes the EFFECTIVE blocklist at the moment it acquires the queue (not at `endEpochMs` itself) so it always sees the user's most-recent staged intent before deciding what to write. This sidesteps a "did the expiry land before or after the user's domain add?" question.

**Dependencies reused, not duplicated.** Story 4.6 (end-early) calls the Epic 3 `PasswordGate` sheet — same mechanism as Panic and Change password. No per-gate stubs. Story 4.5 (auto-unblock) calls the same `apply()` Epic 1 owns. Story 4.7 (re-arm on launch) reads the same `init()` Epic 1 uses.

## UX & Interaction Patterns

**Timer surface when Free (no active timer, UX-DR15).** Surface title "Timer". A row of three preset chips ("25 min" / "45 min" / "60 min") plus a numeric minute input for custom durations. A "Domains in this session" list with one macOS checkbox per domain from the user's blocklist; domains from the last completed session are pre-checked (reuse-last; first-run default is all-checked). The Start button is the view's default (bound to Return); an inline line beneath reads "Start blocks the chosen domains for the chosen duration. End early needs your password." Empty blocklist state renders "Add some domains on Blocklist first." with a "Open Blocklist" button.

**Timer surface when Blocked (timer running, UX-DR15).** A hybrid countdown at the top of the surface: ring on the left (`status-blocked` track, `primary` remaining arc), tabular-numeral `mm:ss` on the right — left-aligned per the UX spine (never centred/anxious). Below it, a single-line "Locked until HH:mm. End early needs your password." underneath. The presets + checkbox list are hidden and replaced by an "End early" destructive-styled button (not the window default; password-gated).

**Hybrid countdown ring (UX-DR5).** `status-blocked` track + `primary` remaining arc. `stroke-dasharray` is the canonical shrinking-ring mechanism; rotation `-90deg` to start at 12 o'clock. Width 4px on the Timer surface (64×64), width 1.5px on the status header mini ring (16×16). Single slow transition, no pulse.

**Duration picker.** Three preset chips styled like Blocklist surface chips (border + `bg-chip` background when idle, `primary` fill with `primary-fg` text when selected). The custom input below them accepts minutes (positive integer) with an `accessibilityLabel="Custom duration in minutes"`. Switching between a preset and custom selects one-or-the-other exclusively; pre-checked duration mirrors the last-run choice when present, falls back to "25 min".

**Domain selection list.** One row per blocklist domain, macOS checkbox + hostname. `Tab` order = reading order; VoiceOver announces "Selected: twitter.com" / "Not selected: youtube.com". Pre-checked set comes from the last session's `selectedDomains` if present, else all domains selected.

**Status header integration (UX-DR3).** When the timer is active the header reads `[Blocked badge] · N domains · mm:ss` where N is the live effective-blocklist count and `mm:ss` is the countdown from the scoped slice. When no timer is active the header returns to its Epic 2 form: `[badge] · N domains · no active timer`. The countdown is tabular-numerals on the same row, and a 16×16 mini ring sits to its right.

**Keyboard (UX-DR16).** `⌘2` opens Timer; `Return` fires Start (Free) or Apply (when any user-mutation is staged); `Space` fires Start when focus is on the Start button (alternative activation, not a "pause" — no pause in v1); `Esc` closes the running-timer's prompt confirm dialog if any; the End-early button is reachable via Tab but never bound to Return.

**Accessibility (UX-DR17).** VoiceOver announces "Timer, free" / "Timer running, 14 minutes 23 seconds remaining" on surface mount and on every minute rollover (NOT every tick — minutes via `setInterval(60000)` or per-tick interval computed via the slice). The countdown numeral is `accessibilityLabel="Time remaining"` with `accessibilityLiveRegion="polite"` to announce rollover. Preset chips carry `accessibilityRole="button"` and `accessibilityState={{ selected: true|false }}`. The custom minute input is `accessibilityLabel="Custom duration in minutes"` with `keyboardType="number-pad"`.

**Toast variants.** Start deny: "Couldn't start the block. No changes made." Expiry: "Session ended. Domains unblocked." End-early: "Session ended. N domains unblocked." Apply-deny during end-early or expiry: same "Couldn't update /etc/hosts. No changes made." as elsewhere.

## Cross-Story Dependencies

- Depends on Epic 1: the serialized Apply pipeline (1.6), the staged-then-Apply mechanism (AR-6), ShellRunner hosts contract (1.5), ConfigStore (1.4), init() path (1.6). No new privileged code in this epic.
- Depends on Epic 2: `domains[]` is the source list rendered on the Timer surface, `effectiveBlocklist` (2.3) is what the per-tick status-header count reads, "N domains" in the header uses 2.5's count derivation. Always-on semantics are owned by 2.3 and Timer must compute-with-not-overlap-them.
- Depends on Epic 3: the `PasswordGate` sheet (3.2) is what End-early (4.6) calls. No per-gate stubs; no new gate code in this epic.
- Story 4.2 depends on 4.1 — the surface picks duration + domains; 4.2 starts the session from those inputs.
- Story 4.3 depends on 4.2's persisted `activeTimer` — the countdown needs an `endEpochMs` source.
- Story 4.4 depends on 4.3 — the status-header countdown is a second subscriber to the scoped slice.
- Story 4.5 depends on 4.4 — expiry is a timer-slice transition that 4.4 routes through Apply; the path runs an in-app re-arm and clears `activeTimer`.
- Story 4.6 depends on 4.2 (active session exists, has selected domains) + Epic 3 gate (3.2).
- Story 4.7 depends on 4.5 (expiry path: unblock via Apply when `now >= end-time` on launch).
- Feeds Epic 6: the timer slice's third subscriber (menu bar mirror + countdown) is wired in 6.2. No Epic 4 code change needed; the slice is shaped for three subscribers from 4.3 onward.
- Feeds Epic 5: scheduled domains join the effective-blocklist union (`always-on ∪ active-timer ∪ active-schedule`). The Timer slice and the effective-blocklist computation cooperate; Epic 5 reads `activeTimer` as one of two optional contributors (the other being `active-schedule`).
