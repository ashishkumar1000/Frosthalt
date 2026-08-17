---
title: 'Remove domain with confirm-alert (staged removal + order-agnostic clean-revert)'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '542937d'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-effective-blocklist-computation-and-apply-integration.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-add-domain-field-with-live-normalisation.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-blocklist-surface-with-always-on-checkbox.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-staged-then-apply-serialized-pipeline-proven-on-one-domain.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Users can add and toggle domains but cannot remove one. The epic requires removal via a confirm-alert — single-item removal is a config edit, not an "escape", so it is NOT password-gated (that gate is Epic 3). Removal is STAGED (committed only via Apply), mirroring add/toggle. Separately, 2-4's remove makes a latent equality bug reachable: remove a domain then re-add it → a reordered value-equal draft that `stageDomainAdd` retains (it has NO clean-revert, store.ts:119) while `stagedChangeCount` reports 0 → "0 changes staged" + a pulsing Apply on a net-zero draft. 2-4 owns this fix (deferred-work from 2-3).

**Approach:** Four parts. (1) `stageDomainRemove(hostname)` — a staged removal (filter the domain out of the draft) with clean-revert, mirroring `stageAlwaysOnToggle`. (2) `DomainRow` gains a remove control revealed on row-hover OR button-focus (always mounted so Tab/VoiceOver reach it). (3) `Blocklist` wires remove → `Alert.alert` confirm (Cancel / Remove-destructive); only on confirm → `stageDomainRemove`. Esc cancels the native sheet for free — no Shell change. (4) Fix the deferred equality gap: make `draftEqualsCommitted` order-agnostic (hostname-set equality) and add a clean-revert check to `stageDomainAdd`, so all three staging actions consistently clean-revert via the shared equality — restoring `staged != null ⟹ stagedChangeCount ≥ 1`.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way, unchanged: 2-4 only reads store state and calls `stageDomainRemove` / `apply` / `cancelStaged` (existing). No new ports; no `child_process`/`fs`/`os` in `src/`.
- Removal is STAGED: `stageDomainRemove(hostname)` filters the domain out of `staged ?? committed.domains`, producing a NEW array ref (preserves the `apply()` mid-run-edit ref-identity guard, store.ts:187). The row vanishes immediately (optimistic); Apply commits to `config.json` + `/etc/hosts`; Cancel-staged reverts. NOT password-gated.
- Confirm-alert gates the STAGING, not the commit: clicking remove opens `Alert.alert`; only the Remove button's `onPress` calls `stageDomainRemove`. Cancel/Esc → no staging. The alert is the native macOS sheet (`Alert.alert`, `RCTAlertManager.macos` → `RCTAlertManager.ios`) — Esc cancels it natively via the cancel-style button and it captures keyboard focus, so the Shell's Return→Apply gate is inert while it is open. NO change to `Shell.tsx` / `KEY_DOWN_EVENTS`.
- Every staging action (add/toggle/remove) clean-reverts `staged` to `null` when the resulting draft value-equals `committed.domains`, via the shared `draftEqualsCommitted`. This already holds for toggle (store.ts:146-149); 2-4 adds it to `stageDomainAdd` (after the append) and `stageDomainRemove`, and makes `draftEqualsCommitted` ORDER-AGNOSTIC (a `Map<hostname, alwaysOn>` set-equality — hostname is the PK and unique, so length-equal + per-hostname match ⇒ equal). This restores `staged != null ⟹ stagedChangeCount ≥ 1` once 2-4's remove makes reordered value-equal drafts reachable (remove a middle domain → re-add → reordered net-zero).
- Remove control is always MOUNTED (keyboard-Tab-reachable + VoiceOver-visible) and visually revealed on row-hover OR button-focus (opacity 0 → 1); satisfies UX-DR6 (reveal on hover) + UX-DR17 (Tab order checkbox→domain→remove, focus ring). `disabled={running}` (no staging during Apply), matching the checkbox.
- `stageDomainRemove` takes the STORED apex (`domain.hostname`, already normalised) — raw compare, matching `stageAlwaysOnToggle` (store.ts:128); it does NOT re-normalise. Unknown hostname → `{ ok: false, error: 'not-found' }` (unreachable via the UI — only rendered rows trigger remove; defensive).

**Ask First:**
- Right-click context menu (Remove / Toggle always-on) from UX-DR16: 2-4 delivers the hover-reveal remove control as the trigger; the context menu is an alternate path needing RN-macos context-menu API verification. Propose DEFER to a polish story. Flag at CHECKPOINT 1.
- The remove control visual (trash glyph vs "Remove" text): no icon library exists in the repo. Propose a borderless `Pressable` with `accessibilityLabel={\`Remove ${hostname}\`}` + a subdued glyph/text (implementer's choice). Flag at CHECKPOINT 1 only if a trash glyph renders poorly on macOS.
- 2-4 MODIFIES `stageDomainAdd` (a 2-2 action) to add the clean-revert check. Required for correctness (the remove+re-add net-zero path) and is the deferred-work item assigned to 2-4 — noted for visibility, not optional.

**Never:**
- No password gate (Epic 3); no immediate removal (removal is staged, Apply commits); no remove during Apply (button disabled when `running`).
- No custom modal/sheet — use native `Alert.alert`; no `Escape` in `KEY_DOWN_EVENTS`; no `Shell.tsx` change.
- No `applyStatus` beyond idle/running; no apply-failure surfacing (2.5); no domain count in the status header (2.5); no hosts viewer (2.6).
- No re-implementation of the serialized Apply pipeline / Cancel / `effectiveBlocklist` — all reused.
- No `stageDomainRemove` that mutates `committed` directly (staged-only); no normalisation inside `stageDomainRemove` (raw apex compare).
- No new privileged code / ports.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| remove a committed domain | `staged == null`, remove a committed row | confirm alert; on Remove → `stageDomainRemove` → `staged` = committed minus row, row vanishes, "1 change staged", Apply enabled + pulsing | N/A |
| cancel remove (Esc / Cancel) | confirm alert open | no staging; row stays; `staged` unchanged | N/A |
| remove the only staged addition (clean-revert) | `staged` = committed + [addedX], remove addedX | `stageDomainRemove` → draft = committed → clean-revert → `staged` null, added row gone, no hint, Apply disabled | N/A |
| remove from a multi-edit draft | `staged` has add + toggle, remove one | `staged` = draft minus row, `stagedChangeCount` adjusts, hint updates | N/A |
| remove during Apply | `applyStatus === 'running'` | remove button disabled → no confirm | N/A |
| remove + re-add (reorder net-zero) | committed [a,b,c], remove b, re-add b | remove → `staged` [a,c] (1 change); re-add → `stageDomainAdd` clean-revert (order-agnostic) → `staged` null, no hint (deferred-gap fix) | N/A |
| remove unknown hostname | `stageDomainRemove('ghost')` (not via UI) | `{ ok: false, error: 'not-found' }`, `staged` unchanged | defensive — UI unreachable |
| hover-reveal | pointer hovers a row | remove control opacity 0 → 1; hover-out → 0 | N/A |
| keyboard remove | Tab to remove control, activate | control visible (focus), `onPress` → confirm alert | N/A |
| confirm alert + Return gate | alert open, `staged != null`, bare Return | native alert captures focus → Shell Return→Apply inert (no double action) | N/A |

</frozen-after-approval>

## Code Map

- `src/domain/store.ts` -- EDIT. Add `stageDomainRemove: (hostname: string) => WriteResult` to the state shape (~:68-95) and implement it mirroring `stageAlwaysOnToggle` (123-152): `base = get().staged ?? get().committed.domains`; `idx = base.findIndex((d) => d.hostname === hostname)`; not-found → `{ ok: false, error: 'not-found' }`; `next = base.filter((d, i) => i !== idx)` (NEW ref); clean-revert via `draftEqualsCommitted(next, get().committed.domains)` → `set({ staged: null })` else `set({ staged: next })`. Add the SAME clean-revert check to `stageDomainAdd` (104-121) after the append at :119 (mirror 146-149). Make `draftEqualsCommitted` (282-289) ORDER-AGNOSTIC: length guard, then build `Map<hostname, alwaysOn>` from `b` and walk `a` matching each hostname+alwaysOn. Do NOT call `normaliseDomain` (raw apex compare).
- `src/components/DomainRow.tsx` -- EDIT. Add `onRemove: (hostname: string) => void` to `DomainRowProps` (28-36). Wrap the row root in `Pressable` (replacing `View`) with `onHoverIn`/`onHoverOut` → `hovered` useState (no `onPress` — hover container only; the checkbox keeps its own press). Add a remove `Pressable` after `styles.labelWrap` (which has `flex:1`, pushing it right): `onPress={() => onRemove(domain.hostname)}`, `disabled={disabled}`, `focusable` + `enableFocusRing`, `onFocus`/`onBlur` → `focused` useState, `accessibilityRole="button"` + `accessibilityLabel={\`Remove ${domain.hostname}\`}`, style opacity = `(hovered || focused) ? 1 : 0`. The docblock (16-18) + `DomainRowHostRef` (:70) already stage this.
- `src/components/Blocklist.tsx` -- EDIT. Read `stageDomainRemove = useDomainStore((s) => s.stageDomainRemove)`. Add `handleRemove(hostname)` → `Alert.alert(\`Remove ${hostname}?\`, 'Removing it from your blocklist. This takes effect when you Apply.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => stageDomainRemove(hostname) }])`. Pass `onRemove={handleRemove}` to `<DomainRow>` (126-133). Keep `disabled={running}`. Remove is NOT `isPreferred` (Cancel is the safe Esc/cancel target).
- `src/components/Shell.tsx` -- UNCHANGED (read-only). The native `Alert.alert` sheet captures focus and honours Esc; no `Escape` in `KEY_DOWN_EVENTS`, no Return-gate change. Noted so the implementer does not touch Shell.
- `__tests__/store.test.ts` -- EDIT. `stageDomainRemove`: remove a committed domain stages (count 1 via `stagedChangeCount`); remove from a draft; clean-revert (remove the only staged addition → `staged` null); not-found; NEW array ref. Clean-revert across actions: `stageDomainAdd` clean-revert (remove + re-add → `staged` null); order-agnostic reorder clean-revert (committed [a,b,c], remove b → `staged` [a,c], re-add b → `staged` null — the deferred-gap regression). Mirror `beforeEach` (55-79) + mock setup (21-35).
- `__tests__/DomainRow.test.tsx` -- NEW. Remove control renders; `onPress` → `onRemove(domain.hostname)`; `disabled` propagates; opacity 0 by default → 1 on `onHoverIn` and on `onFocus`; Tab order checkbox→domain→remove; a11y label. Mock the native specs (same seam as `Blocklist.test.tsx`).
- `__tests__/Blocklist.test.tsx` -- EDIT. `jest.mock('react-native', ...)` to stub `Alert.alert` (capture args + expose button `onPress`). Click remove → `Alert.alert` called with title `Remove <host>?` + Cancel/Remove buttons; invoke Remove `onPress` → `stageDomainRemove` called with hostname; Cancel → not called. Remove disabled when `running`. `onRemove` passed to `DomainRow`.
- Reuse (read-only): `src/domain/stagedChangeCount.ts` (already order-agnostic — now ALIGNED with the order-agnostic `draftEqualsCommitted`), `src/domain/normalise.ts` (NOT used by remove), `src/domain/effectiveBlocklist.ts` (unchanged — fed at Apply time), `src/theme/tokens.ts`, `src/config/types.ts:14-20` (`Domain`).

## Tasks & Acceptance

**Execution:**
- [x] `src/domain/store.ts` -- add `stageDomainRemove` (staged filter + clean-revert), add `stageDomainAdd` clean-revert, make `draftEqualsCommitted` order-agnostic -- staged removal + the deferred-equality fix.
- [x] `src/components/DomainRow.tsx` -- remove control (hover/focus reveal, always mounted) + `onRemove` prop -- the remove trigger.
- [x] `src/components/Blocklist.tsx` -- `Alert.alert` confirm → `stageDomainRemove` wiring + pass `onRemove` -- the confirm gate.
- [x] `__tests__/store.test.ts` -- `stageDomainRemove` + clean-revert across add/remove (incl. remove+re-add reorder regression).
- [x] `__tests__/DomainRow.test.tsx` -- remove control reveal/disabled/onRemove/Tab order.
- [x] `__tests__/Blocklist.test.tsx` -- confirm flow (Alert mock) + disabled-running.

**Acceptance Criteria:**
- Given `pnpm test`, then `store` + `DomainRow` + `Blocklist` suites pass with the native specs mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given a committed domain, when the user clicks remove then confirms, then the row vanishes, "1 change staged" shows, Apply pulses; given Cancel/Esc, then no staging.
- Given the only staged change is an added domain, when the user removes it, then `staged` clean-reverts to null (no hint, Apply disabled).
- Given committed [a,b,c], when the user removes b then re-adds b, then `staged` reverts to null — no "0 changes staged" + no pulsing Apply on a net-zero draft (the deferred-gap fix).
- Given a row, when the pointer hovers it OR the remove control is focused, then the control is visible; Tab reaches it with a focus ring; given `applyStatus === 'running'`, then the control is disabled.
- Given `Alert.alert`, then it is the native macOS sheet; Esc cancels (manual native check); `Shell.tsx` is unchanged.
- Given `draftEqualsCommitted`, then it is order-agnostic and agrees with `stagedChangeCount` on a reordered value-equal pair.

## Spec Change Log

<!-- Empty until the first bad_spec loopback. -->

## Design Notes

- **Scope:** 2-4 = remove + confirm-alert + the deferred-equality fix that remove makes reachable. No context menu (deferred — Ask First), no password gate (Epic 3), no apply-failure surfacing (2.5).
- **Why native `Alert.alert` not a custom sheet:** free Esc + focus capture (the Shell Return-gate stays inert), macOS-native appearance, and zero modal infra (the repo has none). A custom sheet would need a focus-trap + Esc wiring + styling — all free with the native alert. Trade-off: native appearance (not themeable via tokens) — acceptable for a system confirm.
- **Why `stageDomainRemove` takes the stored apex (raw compare):** the row passes `domain.hostname` (already the normalised apex), matching `stageAlwaysOnToggle`'s convention (store.ts:128). Re-normalising would be dead code; the 2-2 deferred note on `stageAlwaysOnToggle`'s raw-compare asymmetry applies here (document the "must be the stored apex" precondition).
- **Why a clean-revert in `stageDomainAdd` now:** remove makes remove+re-add reachable, producing a reordered value-equal draft. Without the check, `stageDomainAdd` retains it → `stagedChangeCount` 0 → "0 changes staged" + pulsing Apply on net-zero. The check (shared order-agnostic `draftEqualsCommitted`) clears `staged` to null. This touches a 2-2 action but is mandated by the deferred-work item assigned to 2-4; no 2-2 behaviour shifts (the check only fires on the remove+re-add net-zero, unreachable in 2-2).
- **Why order-agnostic `draftEqualsCommitted`:** hostname is the PK (unique, deduped at add). length-equal + per-hostname (hostname, alwaysOn) match ⇒ set equality. Aligns the two siblings (`stagedChangeCount` was already order-agnostic) and preserves `staged != null ⟹ stagedChangeCount >= 1`. No existing test relies on order-sensitivity (the clean-revert tests use same-order value-equal drafts).
- **Why reveal on hover OR focus (not hover-only):** hover is pointer-only; UX-DR17 requires Tab to reach the remove control with a focus ring. Always-mounted + `opacity: hovered || focused ? 1 : 0` satisfies both; opacity-0 keeps layout and Tab order stable.
- **Golden example** — committed [example.com]. Hover its row → remove control appears; click → "Remove example.com?" alert; Remove → row vanishes, "1 change staged", Apply pulses; Apply → gone from config + /etc/hosts. Add social.com then remove it → clean-revert (`staged` null, no hint). Committed [a.com, b.com, c.com]: remove b.com → "1 change staged"; re-add b.com → `staged` null (reorder net-zero clean-revert).

## Verification

**Commands:**
- `node_modules/.bin/tsc --noEmit` -- expected: exit 0. (The `pnpm` wrapper is sandbox-broken in this environment; use the direct binary. `pnpm typecheck` is the canonical human-facing command.)
- `node_modules/.bin/jest --watchman=false -- store DomainRow Blocklist` -- expected: the three suites pass. (Same `pnpm` caveat; `pnpm test` is the canonical command.)

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds. Hover a committed row → remove control appears; click → "Remove <host>?" alert; press Esc → cancels (native sheet); click Remove → row vanishes + "1 change staged" + pulsing Apply; Apply → `config.json` + `/etc/hosts` reflect the removal. Remove a just-added domain → clean-revert (no hint). Remove a middle domain then re-add it → no "0 changes staged" (the deferred-gap fix). Tab to the remove control → visible with a focus ring. **Back up `/etc/hosts` before, restore after.**

## Suggested Review Order

**Staged removal + clean-revert**

- New staged-removal action: filter + clean-revert, mirrors toggle.
  [`store.ts:198`](../../src/domain/store.ts#L198)

- `stageDomainAdd` gains clean-revert — fixes the remove+re-add net-zero.
  [`store.ts:159`](../../src/domain/store.ts#L159)

**Order-agnostic equality**

- `draftEqualsCommitted` now hostname-set equality; aligns with `stagedChangeCount`.
  [`store.ts:370`](../../src/domain/store.ts#L370)

**Confirm-alert gate**

- Native `Alert.alert` (Cancel / Remove-destructive) → `stageDomainRemove`; gates staging, not commit.
  [`Blocklist.tsx:107`](../../src/components/Blocklist.tsx#L107)

- `onRemove` wired to each rendered `DomainRow`.
  [`Blocklist.tsx:155`](../../src/components/Blocklist.tsx#L155)

**Remove control (hover/focus reveal)**

- Always-mounted remove `Pressable`; opacity reveals on hover OR focus.
  [`DomainRow.tsx:105`](../../src/components/DomainRow.tsx#L105)

- Row-root hover container; `focusable={false}` keeps the Tab order.
  [`DomainRow.tsx:68`](../../src/components/DomainRow.tsx#L68)

**Tests**

- `stageDomainRemove` + clean-revert + remove+re-add reorder regression.
  [`store.test.ts:577`](../../__tests__/store.test.ts#L577)

- `stagedChangeCount` invariant asserted (staged ⟹ count ≥ 1).
  [`store.test.ts:451`](../../__tests__/store.test.ts#L451)

- Reveal on hover/focus, disabled, Tab order, `focusable` pin.
  [`DomainRow.test.tsx:242`](../../__tests__/DomainRow.test.tsx#L242)

- Confirm flow (Alert spy): confirm stages, cancel doesn't, disabled-running.
  [`Blocklist.test.tsx:825`](../../__tests__/Blocklist.test.tsx#L825)