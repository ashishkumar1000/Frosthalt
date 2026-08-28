# Epic 5 Context: Scheduled Blocking

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Add recurring weekly blocking: the user defines named schedules — a set of domains, weekdays, and a start/end time — and during an enabled schedule's window its domains block automatically across all browsers, lifting again when the window ends. This makes blocking automatic for predictable hours (e.g. "block Twitter 9:00–17:00 Mon–Fri") instead of requiring a manual timer each time. Windows take effect live while the app is running; enforcement while the app is closed is explicitly out of scope for v1.

## Stories

- Story 5.1: Schedule surface with enable toggle and summary
- Story 5.2: Schedule editor sheet
- Story 5.3: Active-window blocking (schedule in effective blocklist)
- Story 5.4: Live schedule transitions while app running
- Story 5.5: Schedule enable/disable and removal (confirm-alert, not password)

## Requirements & Constraints

- A schedule consists of a name, a set of domains chosen from the blocklist, days of the week, a start time and end time, and an enabled/disabled toggle.
- While an enabled schedule's window is active, its domains are blocked; outside the window they are not.
- Schedule start/end transitions take effect while the app is running. There is NO enforcement while the app is closed (no `launchd` agent in v1) — a window that passes while closed is not enforced until the next launch, when the effective blocklist recomputes from the current time. This is an accepted v1 limitation, not a gap; it must be stated plainly to the user.
- The effective blocklist is the union `always-on ∪ active-timer ∪ active-schedule`. A schedule's end therefore never unblocks a domain still covered by an active timer, another active schedule, or an always-on flag.
- Schedule create/edit/enable-toggle are block-affecting mutations: they go through the staged-edits buffer and the Apply pipeline — never a direct commit to config or hosts.
- Schedule disable and removal use a confirm alert only, NOT the app password (they are config edits, not escapes). Adding a schedule and enabling a disabled schedule are entirely exempt from the gate.
- A unit test must assert the schedule-window evaluation (weekday + time range) for inside/outside cases.

## Technical Decisions

- Config shape (`schedules[]` in `config.json`, camelCase): `{ id: slug (PK), name, weekdays: int[] (0=Mon..6=Sun), startTime: HH:mm, endTime: HH:mm, enabled: bool }`. Times are local time; weekday + `HH:mm`, not epoch timestamps.
- Schedule evaluation is pure domain logic (`domain/scheduleEval`). The domain layer remains the SOLE owner of effective-blocklist computation and the SOLE caller of `ShellRunner.writeHosts`; UI dispatches Apply intents, never touches hosts itself.
- Reuse Epic 1's staged-then-Apply serialized pipeline unchanged — no new privileged code, no new native modules. Window transitions recompute the effective blocklist and write via the same Apply path; the OS admin prompt fires per Apply as usual.
- No background daemon, no launchd, no automatic integrity re-add — the running app re-evaluates active schedules in-process.
- The date/time picker mechanism for the editor is an open library choice, pinned in Story 5.2's spec (auxiliary libs are chosen by the story that needs them, not upfront).
- Dependency direction holds strictly: UI → domain (Zustand) → adapters → ports; no `child_process`/`fs`/`os` imports in `src/`; native methods return `{ ok, error?, data? }`, and admin-denied shows the standard toast with staged edits retained.

## UX & Interaction Patterns

- Schedule surface rows: `[enable-checkbox] Schedule name · plain-English summary · [edit] [delete]`. The summary derives live from state ("Every Mon–Fri, 09:00–17:00"). The enable control is a macOS checkbox, not an iOS switch.
- Empty state: "No schedules yet. Add one to block on a recurring weekly window." with a primary "Add…" button.
- Editor sheet (modal depth one level): name field, weekday multi-select chips (Mon–Sun), start/end time pickers, domain selection from the blocklist, and a live plain-English summary line updating as the user edits. Save stages via Apply; Cancel discards; `Esc` closes. `⌘N` opens the add editor while on the Schedule surface.
- Multiple independent named schedules, each individually toggleable with its own summary — never one global schedule.
- Apply button on the Schedule surface is the default (Return-bound) and pulses with an "N changes staged" hint when edits are staged; Cancel reverts staged-but-uncommitted edits.
- Badge behaviour: "Blocked" while a window is active; it ramps to amber as a window approaches its end — with no surprise alert (stated rule, calm utility).
- Tab order on rows is enable → name → edit → delete; `Esc` cancels confirms and closes sheets; VoiceOver announces each schedule and its summary.
- Microcopy states the rule and end condition plainly ("Locked until 17:00..."); no gamification or celebratory copy.

## Cross-Story Dependencies

- Depends on Epic 1: the staged-then-Apply serialized pipeline, hosts contract, and admin-prompt handling are all reused as-is.
- Depends on Epic 2: the blocklist supplies the domains selectable in a schedule, and the status header's domain count/badge plumbing is extended for schedule states.
- Does NOT depend on Epic 3's password gate — schedule disable/removal is deliberately a confirm-alert per the resolved gate scope (escapes only).
- Internal order: surface + editor (5.1, 5.2) come before active-window blocking (5.3), which live transitions (5.4) build on.
- Epic 6 later mirrors schedule badge state into the menu bar; nothing here needs to be built for that beyond keeping badge state in the shared slice.