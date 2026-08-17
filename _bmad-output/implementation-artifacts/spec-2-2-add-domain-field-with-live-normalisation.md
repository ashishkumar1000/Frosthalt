---
title: 'Add-domain field with live normalisation'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
baseline_commit: '1e5a3f063bdd3e608533320f6860f6fa6995ec21'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-blocklist-surface-with-always-on-checkbox.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-staged-then-apply-serialized-pipeline-proven-on-one-domain.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 2-1 delivered the permanent blocklist surface with the always-on checkbox, but there is still no way to add a domain — the only entry path was the deleted 1.6 temp probe. Users cannot grow their blocklist.

**Approach:** Add an always-visible add-domain field to the Blocklist surface: `TextInput` + Add button, with a live normalised-form preview as the user types and inline errors for invalid/duplicate input. Add stays disabled until the input is clean (valid + non-duplicate). Pressing Add calls the existing 1.6 `stageDomainAdd` (normalises + stages `alwaysOn:true`); the field clears on success and the new row appears staged, committed by the existing 2-1 Apply button. No new privileged code.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way: `UI → domain (Zustand) → adapters → ports`. AddDomain reads `committed`/`staged` and calls `stageDomainAdd` only. No `child_process`/`fs`/`os` in `src/`.
- Adding a domain is a STAGED edit (`stageDomainAdd`); `apply()` (the 1.6 serialized pipeline, surfaced by 2-1's Apply button) is the ONLY path that commits `config.json` + writes `/etc/hosts`. No auto-Apply on Add.
- The live preview + validation reuse the existing pure `normaliseDomain` (`normalise.ts:59`) — no re-normalisation logic in the UI; the UI calls the same helper the store uses.
- The UI MUST gate Add on its own duplicate check: `(staged ?? committed.domains).some((d) => d.hostname === normalised)`. `stageDomainAdd` returns `{ok:true}` idempotently for duplicates (`store.ts:112-117`), so without a UI gate a duplicate Add would clear the field without adding.
- Add always stages with `alwaysOn:true` (`stageDomainAdd:119`) — the add field offers no alwaysOn choice; the row checkbox (2-1) handles toggle.
- On a successful Add (`{ok:true}` from a genuinely new domain), the field, preview, and error clear.

**Ask First:**
- The "Return fires Apply (staged edits)" half of UX-DR16 — wiring ApplyButton as the view's default button across focus contexts. 2-1 deferred ApplyButton's Return binding; propose 2-3 owns it. 2-2 wires only Return-in-field → Add (clean input).
- An "Add…" sheet/modal (UX-DR6 mentions an "Add…" button) — propose an always-visible inline field instead (simplest, supports ⌘N + live preview directly).

**Never:**
- No remove button / confirm-alert (2-4), no domain count in the status header (2-5), no hosts viewer / drift banner (2-6).
- No `alwaysOn:false` add path; no alwaysOn choice in the field.
- No auto-Apply on Add; no background re-add.
- No new privileged code (reuse 1.6 `stageDomainAdd` + `apply`).
- No PSL-aware www stripping / no Public Suffix List data file. The existing `normaliseDomain` strips a single leading `www.` (`normalise.ts:82-84`), which satisfies the epic's "strip www." normalisation. The code comment's "deferred to 2.2" PSL aspiration is out of scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty input | field empty | no preview, no error, Add disabled | N/A |
| Typing valid + new | `https://www.Example.COM/path` | preview `→ example.com`, no error, Add enabled | N/A |
| Typing invalid | `not a domain` | no preview, error `Invalid domain. Try \`example.com\`.`, Add disabled | N/A |
| Typing duplicate | `example.com` while `example.com` in committed/staged | preview `→ example.com`, error `Already in your list.`, Add disabled | N/A |
| Add (clean + new) | press Add (or Return) with clean non-duplicate input | `stageDomainAdd(raw)`; field+preview+error clear; new row appears staged (`alwaysOn:true`); Apply enabled | N/A |
| Add guarded | Add disabled for empty/invalid/duplicate — cannot fire | N/A | disabled button |
| ⌘N | press ⌘N | add field focused | N/A |
| Return in field (clean) | press Return with clean non-duplicate input | Add fires (same as pressing Add) | N/A |

</frozen-after-approval>

## Code Map

- `src/components/AddDomain.tsx` -- NEW. The add field: `TextInput` + Add button (`ApplyButton` reused, label "Add") + live normalised preview + inline invalid/duplicate error. Local `useState` for the raw input; derives `normalised = normaliseDomain(raw)` + `isDuplicate = (staged ?? committed.domains).some(...)`; Add disabled unless `normalised != null && !isDuplicate && raw non-empty`. Calls `stageDomainAdd(raw)` on Add; clears on `{ok:true}`. `forwardRef` exposes the `TextInput` ref for ⌘N focus.
- `src/components/Blocklist.tsx` -- EDIT. Render `<AddDomain ref={addFieldRef} />` at the top of the surface (above the rows AND in the empty state, so the field is always reachable). Accept + forward the `addFieldRef` prop from Shell. Keep the 2-1 rows / Apply / Cancel / empty-state copy.
- `src/components/Shell.tsx` -- EDIT. Add `addFieldRef = useRef<TextInput>(null)`; pass it to `<Blocklist addFieldRef={addFieldRef} />`. Add `{ key: 'n', metaKey: true }` to `keyDownEvents` and an `onKeyDown` branch: ⌘N → `addFieldRef.current?.focus()` (mirrors the `selectRow` ref-focus pattern at `Shell.tsx:48`). Leave the 2-1 ⌘1-⌘4 handling + hardcoded announce untouched.
- `src/domain/normalise.ts` -- read-only reuse: `normaliseDomain` (`:59`).
- `src/domain/store.ts` -- read-only reuse: `stageDomainAdd` (`:104-121`).
- `__tests__/AddDomain.test.tsx` -- NEW. `react-test-renderer`; mock native specs (the `store.test.ts:21-35` seam) + drive `useDomainStore.setState`. Cover every matrix row: empty/valid/invalid/duplicate preview+error+Add-gating, Add calls `stageDomainAdd` + clears on success, Return-in-field fires Add. Find the field by `accessibilityRole`/contract props, text via `extractText`.
- `__tests__/store.test.ts` -- EDIT. Add a `stageDomainAdd` NEW-array-ref assertion (the invariant the investigation flagged — only tested for the toggle today; the apply-queue retain-newer-draft invariant relies on it, `store.ts:182`). Seed two adds, assert the second `staged` ref differs from the first.
- `__tests__/Shell.test.tsx` -- EDIT. Assert ⌘N is declared in `keyDownEvents` (the focus call itself is native-runtime, not unit-testable in the node jest env — same caveat as the 2-1 row-focus tests).
- Reuse (read-only): `src/components/ApplyButton.tsx:21` (the Add button — `{label,onPress,disabled?}`), `src/components/SidebarRow.tsx:26` (forwardRef + focusable precedent), `src/theme/tokens.ts` (colors/typography/spacing/rounded), `src/config/types.ts:15` (`Domain`/`DEFAULT_CONFIG`).

## Tasks & Acceptance

**Execution:**
- [x] `src/components/AddDomain.tsx` -- NEW add field (TextInput + Add + live preview + inline invalid/duplicate error, local state, duplicate gate, clears on success, forwardRef for ⌘N) -- the add-domain entry point.
- [x] `src/components/Blocklist.tsx` -- render AddDomain at the top + forward the add-field ref -- wire the field into the surface.
- [x] `src/components/Shell.tsx` -- ⌘N keydown → focus the add field; pass the ref down -- the keyboard shortcut.
- [x] `__tests__/AddDomain.test.tsx` -- preview/error/Add-gating/clears-on-success/Return tests -- prove the field.
- [x] `__tests__/store.test.ts` -- stageDomainAdd new-array-ref test -- pin the mid-run-edit invariant for add.
- [x] `__tests__/Shell.test.tsx` -- ⌘N declared in keyDownEvents -- prove the shortcut is wired.

**Acceptance Criteria:**
- Given `pnpm test`, when the suite runs, then `AddDomain` + `store` + `Shell` suites pass with the specs mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given the Blocklist surface, then the add field + Add button render at the top.
- Given the user types a valid new domain, then the normalised preview shows and Add is enabled; given an invalid input, then `Invalid domain. Try \`example.com\`.` shows and Add disables; given a duplicate, then `Already in your list.` shows and Add disables.
- Given clean non-duplicate input, when the user presses Add or Return, then `stageDomainAdd` stages the domain (`alwaysOn:true`), the field clears, the new row appears, and Apply enables.
- Given ⌘N, then the add field receives focus.
- Given the field is empty, then Add is disabled.
- Given any domain-layer code, then it imports ShellRunner/ConfigStore only via the ports and never `child_process`/`fs`/`os`.

## Spec Change Log

<!-- Empty until the first bad_spec loopback. -->

## Design Notes

- **Why an always-visible inline field (not an "Add…" sheet):** simplest, supports ⌘N focus + live preview directly, and is reachable in both the empty and populated states. UX-DR6's "Add…" button is read as the field's Add affordance, not a separate sheet opener. Flag at CHECKPOINT 1.
- **Why the UI does its own duplicate check:** `stageDomainAdd` returns `{ok:true}` idempotently for a duplicate and leaves `staged` untouched (`store.ts:112-117`). Without a UI gate, a duplicate Add would clear the field and silently not add. The UI checks `(staged ?? committed.domains).some((d) => d.hostname === normalised)` and disables Add, so Add only fires for a genuinely new domain.
- **Scope judgment — Return → Apply (UX-DR16):** 2-2 wires Return-in-field → Add (clean input). The other half — "Return fires Apply (staged edits)" when the field is not focused — needs ApplyButton bound as the view's default button; 2-1 explicitly deferred that binding. Propose 2-3 (Apply integration) owns it. Flag at CHECKPOINT 1.
- **PSL-aware www stripping is out of scope:** `normaliseDomain` already strips a single leading `www.` (`normalise.ts:82-84`), satisfying the epic's "strip www." normalisation. PSL-aware stripping (`www2.`, `m.`, etc. via a Public Suffix List data file) is a separate data-dependency effort; the code comment's "deferred to 2.2" was aspirational, not an epic requirement.
- **Golden example** — type `https://www.Example.COM/path` → preview `→ example.com`, Add enabled; press Add → field clears, row `example.com` (checked) appears staged; type `example.com` again → `Already in your list.`, Add disabled; type `nope` → `Invalid domain. Try \`example.com\`.`, Add disabled.

## Verification

**Commands:**
- `pnpm typecheck` (`tsc --noEmit`) -- expected: exit 0.
- `pnpm test --watchman=false -- AddDomain store Shell` -- expected: the three suites pass.

**Manual checks (native — run outside the node sandbox):**
- `pnpm macos` -- build succeeds.
- On surface 0: type a domain, see the live normalised preview; type an invalid/duplicate, see the inline error + Add disabled; Add a clean new domain → row appears staged (checked) + Apply enabled; Apply (admin prompt) → `config.json` + `/etc/hosts` reflect the new domain (4 lines added). ⌘N focuses the field. **Back up `/etc/hosts` before, restore after.**

## Suggested Review Order

**The add field (entry point)**

- The Add gate is derived from `raw` + the store, so the UI can never drift from what `stageDomainAdd` would do.
  [`AddDomain.tsx:95`](../../src/components/AddDomain.tsx#L95)

- `normalised` reuses the store's pure `normaliseDomain` — one normalisation path, no re-normalisation in the UI.
  [`AddDomain.tsx:72`](../../src/components/AddDomain.tsx#L72)

- The UI duplicate gate: `stageDomainAdd` returns `{ok:true}` for dupes, so the UI must check itself to avoid a silent no-op Add.
  [`AddDomain.tsx:77`](../../src/components/AddDomain.tsx#L77)

- `handleAdd` passes the RAW input (the store normalises) and clears the field on `{ok:true}`.
  [`AddDomain.tsx:104`](../../src/components/AddDomain.tsx#L104)

- The field disables autocorrect/autocapitalize/autocomplete so domains enter verbatim.
  [`AddDomain.tsx:132`](../../src/components/AddDomain.tsx#L132)

- Return-in-field fires Add; `submitBehavior="submit"` keeps focus for stacking the next domain.
  [`AddDomain.tsx:123`](../../src/components/AddDomain.tsx#L123)

- The error `Text` is an alert region so VoiceOver announces validation errors as they appear.
  [`AddDomain.tsx:155`](../../src/components/AddDomain.tsx#L155)

- `forwardRef` exposes the `TextInput` ref so the Shell can focus it on ⌘N.
  [`AddDomain.tsx:60`](../../src/components/AddDomain.tsx#L60)

**Surface + shortcut wiring**

- Blocklist composes `<AddDomain>` at the top (above rows AND the empty state) and forwards the ref.
  [`Blocklist.tsx:99`](../../src/components/Blocklist.tsx#L99)

- Shell owns `addFieldRef` and passes it down to Blocklist → AddDomain.
  [`Shell.tsx:57`](../../src/components/Shell.tsx#L57)

- ⌘N focuses the add field and returns (no announce, no surface change); declared in `keyDownEvents` so the native layer forwards it.
  [`Shell.tsx:83`](../../src/components/Shell.tsx#L83)

**Peripherals — tests**

- `stageDomainAdd` produces a NEW staged ref each add — pins the mid-run-edit invariant for add (was only pinned for the toggle).
  [`store.test.ts:157`](../../__tests__/store.test.ts#L157)

- Composition: Blocklist renders + forwards AddDomain, and a clean Add stages a new DomainRow + enables Apply.
  [`Blocklist.test.tsx:530`](../../__tests__/Blocklist.test.tsx#L530)

- AddDomain present on surface 0 — the regression guard for the composition seam (AddDomain can't vanish silently).
  [`Shell.test.tsx:399`](../../__tests__/Shell.test.tsx#L399)

- ⌘N declared in `keyDownEvents` (the focus call itself is native-runtime, not unit-testable — same caveat as 2-1 row focus).
  [`Shell.test.tsx:358`](../../__tests__/Shell.test.tsx#L358)

- AddDomain field tests: preview/error/gating, clears on success, Return, whitespace, ref attaches — every I/O-matrix row.
  [`AddDomain.test.tsx:199`](../../__tests__/AddDomain.test.tsx#L199)