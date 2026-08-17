---
title: 'Domain count in the status header (effective blocked count + tabular figures + on-change announce)'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c1832b8'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-effective-blocklist-computation-and-apply-integration.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-sidebar-navigation-and-status-header-shell.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-4-remove-domain-confirm-alert.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The status header (`StatusHeader.tsx`, rendered by Shell at `Shell.tsx:147`) is still Story 1.3 placeholders: a hardcoded `<StatusBadge status="free"/>`, a literal `"0 domains"` Text, and `"no active timer"`. The user cannot see at a glance how many domains are effectively blocked. The Shell nav announce (`Shell.tsx:88-90`) also hardcodes `"0 domains"`, so it lies.

**Approach:** Make the domain count real: `N = effectiveBlocklist(committed).length` — the always-on set actually enforced in `/etc/hosts` (reuse Story 2.3's pure helper; `committed` updates only on Apply success). Render it with `fontVariant: ['tabular-nums']` (the proven `countdown` pattern) and singular/plural ("1 domain" / "N domains"). Add a VoiceOver on-change announce in `StatusHeader` (skip the initial mount — the Blocklist surface already announces on entry). Fix the Shell nav announce to use the same effective count. The badge stays `free` in Epic 2 (no timer/schedule sessions yet — Epic 4 wires it); the count carries the blocking info. `"no active timer"` is untouched (Epic 4).

## Boundaries & Constraints

**Always:**
- The count is the EFFECTIVE blocked count: `effectiveBlocklist(committed).length` — only always-on domains actually written to `/etc/hosts` (2.3's helper filters `alwaysOn`, `effectiveBlocklist.ts:33-49`). NOT `committed.domains.length` (raw config over-counts non-always-on) and NOT `staged` (pending/unapplied). `committed` changes only on Apply success (`store.ts:262-267`), so the count reflects what is enforced right now; staged edits do not move it until Applied.
- Ports & adapters, one-way, unchanged: `StatusHeader` reads store state (`committed`) and reuses the pure `effectiveBlocklist` helper. No new ports; no `child_process`/`fs`/`os` in `src/`. No store changes — compute the count in the component.
- Tabular figures: the count numeral uses `fontVariant: ['tabular-nums']` (the established pattern from `tokens.typography.countdown`, `tokens.ts:120`) so digit width is fixed and the header doesn't jitter as the count changes. Applied via a style override on the count `Text` (reusing the proven pattern).
- VoiceOver on-change announce: a `useEffect` in `StatusHeader` keyed on `count` calls `AccessibilityInfo.announceForAccessibility` (plain API — no `…WithOptions` exists in the codebase) when the count changes. It SKIPS the initial mount via a ref first-run guard (the app launches on surface 0 = Blocklist, whose mount-announce `Blocklist.tsx:127-136` already speaks the list on entry; a second announce on launch would double up). The count changes only when `committed` changes (Apply success), so the announce fires after an Apply commits.
- Shell nav announce (`Shell.tsx:88-90`) uses the SAME effective count (replacing the hardcoded `"0 domains"`), so the spoken nav cue and the visible status header agree — single source of truth. Singular/plural applies here too.
- Badge stays `free` in Epic 2 — there are no timer/schedule sessions (`epic-2-context.md`), so "Free when no timer/schedule active" (the AC) is correctly `Free`. Epic 4 wires the badge to real session state. 2.5 does NOT touch the badge.

**Ask First:**
- None requiring human gating. The badge semantics (stay `Free` in Epic 2) is resolved per the epic AC + the user's choice; the count source, tabular-figures, and skip-mount announce all follow established codebase patterns.

**Never:**
- No counting `staged` (pending) or raw `committed.domains.length` — the count is the effective (always-on, applied) blocked set only.
- No badge change / no badge wiring to a session selector in 2.5 (Epic 4 owns badge ↔ timer/schedule). The badge stays the 1.3 `free` placeholder.
- No `"no active timer"` change (Epic 4 owns the countdown).
- No new privileged code / ports / store changes — reuse `effectiveBlocklist` and read `committed`.
- No announce on mount (skip the initial run — avoids double-announce with the Blocklist surface entry announce).
- No apply-failure surfacing — the 2.4 spec's Never clause pointed at "(2.5)", but FR-17 + the epic-2 context scope 2.5 as the count + badge only; apply-failure surfacing is not allocated to any Epic 2 story (AR-7 retains `staged` on failure, already in the store). Excluded.
- No re-implementation of `effectiveBlocklist`, the Apply pipeline, or `StatusBadge`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| committed always-on domains | committed.domains = [{a,true},{b,true},{c,false}] | count = `effectiveBlocklist(committed).length` = 2; header "2 domains" (tabular-nums), badge Free | N/A |
| committed empty / no always-on | committed.domains = [] (or all alwaysOn:false) | count 0; header "0 domains", badge Free | N/A |
| staged edit, not yet applied | staged != null (pending add/remove/toggle); committed unchanged | count unchanged (still effective of committed); header reflects applied state, not pending | N/A |
| Apply success | apply() commits staged → committed updates (store.ts:262-267) | count changes; header re-renders; useEffect fires → VoiceOver announces the new count | N/A |
| singular count | effective count === 1 | header reads "1 domain" (singular); nav announce likewise | N/A |
| nav announce | user presses ⌘1–⌘4 (selectRow) | announce `${SURFACE_NAMES[i]}, <count> domain(s)` with the real effective count (not hardcoded 0) | N/A |
| initial mount | app launch; StatusHeader mounts (surface 0 = Blocklist) | NO announce from StatusHeader (skip mount; Blocklist entry announce covers the initial count) | N/A |

</frozen-after-approval>

## Code Map

- `src/components/StatusHeader.tsx` -- EDIT. Today stateless: imports only `tokens` (line 12); JSX lines 16-25 with hardcoded `<StatusBadge status="free"/>` (18), literal `"0 domains"` (20), `"no active timer"` (22); styles 27-44 use `tokens.typography.label` (no `fontVariant`). Changes: import `useDomainStore`, `effectiveBlocklist`, `useEffect`, `AccessibilityInfo`. Read `const committed = useDomainStore((s) => s.committed);` and `const count = effectiveBlocklist(committed).length;`. Replace the literal `"0 domains"` Text (20) with `` `${count} ${count === 1 ? 'domain' : 'domains'}` ``, adding `fontVariant: ['tabular-nums']` to its style (override `styles.text` or a new style; reuse the `tokens.typography.countdown` pattern at `tokens.ts:120`). Add `useEffect` keyed on `count` with a `useRef(true)` first-run guard that skips mount and otherwise calls `AccessibilityInfo.announceForAccessibility(`${count} ${count === 1 ? 'domain' : 'domains'} blocked`)`. Badge (18) and "no active timer" (22) UNCHANGED.
- `src/components/Shell.tsx` -- EDIT. Nav announce at lines 88-90 hardcodes `${SURFACE_NAMES[i]}, 0 domains`. Read `committed` from `useDomainStore` (already imported line 32) and compute `effectiveBlocklist(committed).length` at announce time; replace `"0 domains"` with the real count + singular/plural. Keep the announce structure; only the count becomes real. (Blocklist.tsx:25-26 defers this Shell-side count to 2.5.)
- `src/domain/effectiveBlocklist.ts` -- REUSE (read-only). `effectiveBlocklist(config: Config): string[]` (line 28); returns always-on apex hostnames (33-49). Count = `.length`. Do NOT add timer/schedule logic (51-53 reserved).
- `src/domain/store.ts` -- REUSE (read-only). `committed` (line 72) updates only on Apply success (262-267). No new selector — `StatusHeader` computes from `committed`.
- `src/components/StatusBadge.tsx` -- REUSE (read-only). Supports `free|amber|blocked` (14-18, 24, 38). 2.5 passes no new status (stays `free`).
- `src/theme/tokens.ts` -- REFERENCE. `fontVariant: ['tabular-nums']` proven on `countdown` (line 120); `StatusKey`/`statusFill` (29-35, 141-143).
- `__tests__/Shell.test.tsx` -- EDIT. Status-header assertions (384-405) currently assert static `toContain('0 domains')`/`Free`/`no active timer`. Seed `committed` via the `seedForReturn`-style `useDomainStore.setState` (562-573) wrapped in `act`; assert the real EFFECTIVE count via `extractText` (189-204): seed e.g. 3 always-on + 1 non-always-on → assert `toContain('3 domains')` (effective = 3, NOT 4 raw). Add: a count-change test (seed committed, simulate Apply committing a new committed via `setState`, assert the new count + that `announceForAccessibility` (mocked 91-92) was called with the new count). Assert singular "1 domain". Assert the nav announce uses the real count (`mockClear` announce, ⌘1, assert called with the real count, not "0 domains"). Assert NO announce on the initial mount render. ApplyButton stays mocked (42-68 — the re-render version-mismatch caveat).

## Tasks & Acceptance

**Execution:**
- [x] `src/components/StatusHeader.tsx` -- read `committed`, compute `effectiveBlocklist(committed).length`, render with tabular-nums + singular/plural, add on-change VoiceOver announce (skip mount) -- the live effective count.
- [x] `src/components/Shell.tsx` -- nav announce uses the real effective count (replace hardcoded "0 domains") -- a truthful nav cue.
- [x] `__tests__/Shell.test.tsx` -- seed committed, assert effective count (not raw), count-change announce, singular, nav announce, no-mount-announce, staged-not-applied count-unchanged, tabular-nums pin -- regression coverage.

**Acceptance Criteria:**
- Given `committed` has always-on domains (and possibly non-always-on ones), when `StatusHeader` renders, then it shows "N domains" where N = `effectiveBlocklist(committed).length` (always-on only), with tabular-nums; non-always-on domains are NOT counted.
- Given staged edits exist but are not applied, then the header count is unchanged (reflects `committed`/applied, not `staged`).
- Given Apply succeeds (`committed` updates), then the header count updates and VoiceOver announces the new count; given app launch, then `StatusHeader` does NOT announce on mount.
- Given effective count 1, then the header reads "1 domain" (singular); given 0 or >1, "N domains".
- Given the user navigates (⌘1–⌘4), then the nav announce speaks the real effective count (not "0 domains").
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0; given `pnpm test` (Shell suite), then the count + announce assertions pass.
- The badge stays "Free" in Epic 2 (no timer/schedule); "no active timer" is unchanged (Epic 4).

## Spec Change Log

<!-- Empty until the first bad_spec loopback. -->

## Design Notes

- **Why `committed` not `staged`:** "effectively blocked" = what's enforced in `/etc/hosts` now. `committed` updates only on Apply success (`store.ts:262-267`); `staged` is the pending/cancellable draft — counting it would report domains as blocked before they are. The count moves only when the hosts file actually changes.
- **Why `effectiveBlocklist` not `committed.domains.length`:** the helper filters `alwaysOn` (`effectiveBlocklist.ts:33-49`) — a non-always-on (timer/schedule-only) domain is not written by this epic's Apply, so it is not "effectively blocked" now. The raw config length would over-count.
- **Why the badge stays `Free`:** the epic AC ties the badge to active timer/schedule sessions (Free when none, Blocked when one). Epic 2 has no sessions, so Free is correct. Wiring the badge to a live state is Epic 4's job (when the countdown lands). The "N domains" count carries the blocking info in Epic 2.
- **Why skip the mount announce:** the Blocklist surface's mount-announce (`Blocklist.tsx:127-136`) already speaks "Blocklist, N domains, M always-on" on entry. `StatusHeader` is persistent across surfaces; announcing on mount would double-up on app launch (surface 0 = Blocklist). The AC says "on change" — so announce only when the count changes (after Apply), via a `useRef(true)` first-run guard.
- **Why tabular-nums:** fixed digit width so the header doesn't shift as the count changes (9 → 10). Proven on `tokens.typography.countdown` (`tokens.ts:120`).
- **apply-failure surfacing:** the 2.4 spec's Never clause pointed at "(2.5)", but FR-17 + the epic-2 context scope 2.5 as the count + badge only. Apply-failure surfacing is not allocated to any Epic 2 story (AR-7 retains `staged` on failure, already in the store). Excluded from 2.5.
- **Golden example:** committed `[{example.com,true},{social.com,true},{dev.local,false}]` → header "Free · 2 domains · no active timer" (tabular-nums on the "2"). Apply a removal of example.com → committed drops it → header "Free · 1 domain · no active timer" + VoiceOver announces "1 domain blocked". Stage an add of news.com (not applied) → header unchanged ("1 domain"). ⌘2 (Settings) → announce "Settings, 1 domain" (real count, not "0 domains").

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: exit 0. (The `pnpm` wrapper is sandbox-broken in this environment; use the direct binary. `pnpm typecheck` is the canonical human-facing command.)
- `node_modules/.bin/jest --watchman=false -- Shell` -- expected: the Shell suite passes. (Same `pnpm` caveat; `pnpm test` is the canonical command.)

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds. With committed always-on domains, the status header reads "Free · N domains · no active timer" with tabular-nums on the numeral; a non-always-on domain is NOT counted. Apply a removal → the count drops and VoiceOver speaks the new count. Stage an edit (not applied) → the header count stays. ⌘1–⌘4 → the nav announce speaks the real count. The badge stays "Free" (Epic 4 wires it).

## Suggested Review Order

A focused, click-through review path from the smallest load-bearing change to the regression net.

1. [`src/components/StatusHeader.tsx`](../../src/components/StatusHeader.tsx) -- the core change. Reads `committed`, computes `effectiveBlocklist(committed).length`, renders `"N domain(s)"` with `fontVariant: ['tabular-nums']` (`styles.count`), and adds the on-change `useEffect` VoiceOver announce with the `useRef(true)` first-run guard that skips the initial mount. Badge + "no active timer" untouched.
2. [`src/components/Shell.tsx`](../../src/components/Shell.tsx) -- `selectRow` (lines ~94-101) now derives `count = effectiveBlocklist(committed).length` and announces `${SURFACE_NAMES[i]}, <count> domain(s)` instead of the hardcoded `"0 domains"`. `committed` selector added at line ~79.
3. [`src/domain/effectiveBlocklist.ts`](../../src/domain/effectiveBlocklist.ts) -- REUSE, read-only. The pure helper the count derives from (`effectiveBlocklist.ts:28-49`): filters `alwaysOn`, normalises, dedupes by apex. No edit this story.
4. [`__tests__/Shell.test.tsx`](../../__tests__/Shell.test.tsx) -- regression net. Start with the effective-not-raw count test (~line 416), then staged-not-applied (~615), count-change announce (~517), no-mount-announce (~592), singular (~492), nav-real-count (~559) + nav-singular (~707), tabular-nums pin (~659), and the dedupe-by-apex test (~739). `styleFontVariant` helper (~216) and the `afterEach` store reset (~114) are the test-infra additions.

### Verification (re-run)

- `node_modules/.bin/tsc --noEmit` -- exit 0.
- `node_modules/.bin/jest --watchman=false -- Shell` -- the Shell suite passes (15 suites, 283 tests total).
- `pnpm typecheck` / `pnpm test` are the canonical human-facing commands (the `pnpm` wrapper is sandbox-broken here; the direct binaries above are the equivalent).