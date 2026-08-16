---
title: 'Staged-then-Apply serialized pipeline, proven on one domain'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '7ce3f1793a3470f00ce731a10aeb4be253c1d563'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-shellrunner-turbomodule-and-hosts-file-contract.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** ShellRunner (1.5) can write validated lines to `/etc/hosts` and ConfigStore (1.4) can persist `config.json`, but nothing connects them — there is no domain layer owning normalisation, effective-blocklist computation, the staged-then-Apply buffer, or the serialized pipeline. Every later epic (2–5) calls this pipeline rather than rebuilds it, so it must exist and be proven end-to-end on one domain first.

**Approach:** Build the domain layer (a Zustand store) as the sole hub between UI and the two ports: it owns a staged-edits buffer (draft of the block-affecting slice), `normaliseDomain` + effective-blocklist + apex/`www.` line production, and a serialized Apply pipeline (commit staged → `writeConfig` → compute effective → `writeHosts`, one run at a time; admin-denied leaves staged intact for retry). Proven on one domain via a temporary in-app driver (deleted after acceptance, mirroring 1.5) + Jest. No permanent management UI — that is Epic 2.

## Boundaries & Constraints

**Always:**
- Ports & adapters, one-way: `UI → domain (Zustand) → adapters → ports`. The domain store is the sole owner of `normaliseDomain` + effective-blocklist + line production and the sole caller of `ShellRunner.writeHosts` and `ConfigStore.writeConfig`. Adapter/port modules never import each other or the UI.
- Apply pipeline runs in strict order: commit staged → `config.json` (`ConfigStore.writeConfig`) → compute effective blocklist → produce apex+`www.` lines (`0.0.0.0` + `::`) → `ShellRunner.writeHosts`. One atomic run at a time; concurrent Apply intents queue and run strictly sequentially, never in parallel.
- Staged-then-Apply: block-affecting mutations (domain add / `alwaysOn` toggle / schedules) are held in a staged-edits buffer (a draft copy of the editable slice); Apply is the only path that commits staged → `config.json` and triggers the ShellRunner write + DNS flush. Cancel discards staged back to last-committed.
- On admin-denied `{ok:false,error:"admin-denied"}`: `/etc/hosts` unchanged (ShellRunner guarantee); staged edits retained for retry; the queue does not advance past the failed run. Per the strict order `config.json` is already written, so a denied Apply leaves `config.json` ahead of `/etc/hosts` — that drift is reconciled only by the 1.7 user-initiated Restore, never automatically.
- `normaliseDomain`: lowercase, trim, strip scheme/path/port, strip a single leading `www.`, strip trailing dot → apex; return `null` on non-hostname input. Line production: apex + `www.`apex on `0.0.0.0` + `::` = 4 lowercase lines per domain. Real PSL-based apex detection is Story 2.2; 1.6's normaliser is pragmatic.
- Effective blocklist (Epic 1): `domains.filter(alwaysOn)` normalised + deduped; active-timer and active-schedule contributions are reserved for later epics and contribute nothing yet.
- The `{ok,error?}` envelope flows through the store to the caller; the store never throws.

**Ask First:**
- Any reordering of the Apply pipeline steps (e.g. writing `/etc/hosts` before `config.json` to avoid the denied-Apply drift), or any design that persists staged edits to `config.json` on a path other than Apply.

**Never:**
- No permanent blocklist management UI — no add-domain field, no always-on checkbox, no remove, no domain count in the status header (all Epic 2: 2-1/2-2/2-3/2-4/2-5). 1.6 proves via a temporary driver deleted after acceptance.
- No `child_process`/`fs`/`os` imports in `src/` — the domain calls only the two ports.
- No background daemon, no auto-reconciliation of config/hosts drift, no `readHostsSection`/`restoreSection` (1.7).
- No schedules/activeTimer contribution to the effective blocklist yet (Epic 4/5).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy add + apply | stage `example.com` (alwaysOn), apply | `writeConfig({domains:[{example.com,true}]})`; `writeHosts([0.0.0.0 example.com, :: example.com, 0.0.0.0 www.example.com, :: www.example.com])`; committed updated, staged cleared; `{ok:true}` | N/A |
| Admin denied | apply, user cancels prompt | `/etc/hosts` unchanged; `config.json` written (strict order); staged retained; `{ok:false,error:"admin-denied"}`; queue does not advance | retry re-attempts `writeHosts` (idempotent config re-write) |
| Invalid domain | stage `not a domain` / `0.0.0.0; rm -rf /` | `normaliseDomain`→`null`; not staged; store reports invalid (no Apply, no prompt) | N/A |
| Concurrent apply | two `apply()` calls while one running | second queues; runs only after the first resolves; never parallel | N/A |
| Config write fails | `writeConfig` returns `{ok:false}` | staged retained; `{ok:false,error:"config-write:<detail>"}`; `writeHosts` not called | retryable |

</frozen-after-approval>

## Code Map

- `src/domain/normalise.ts` -- NEW. `normaliseDomain(raw): string|null` (lowercase apex; strip scheme/path/port/leading-`www.`/trailing-dot; pragmatic, PSL in 2.2) + `toHostsLines(hostname): string[]` (apex+`www.` on `0.0.0.0`+`::`). Pure, unit-tested.
- `src/domain/effectiveBlocklist.ts` -- NEW. `effectiveBlocklist(config: Config): string[]` — Epic 1: `domains.filter(alwaysOn).map(hostname)`, normalised + deduped. Pure, unit-tested; structured so timer/schedule contributions slot in later.
- `src/domain/apply.ts` -- NEW. `runApply({committed, staged}): Promise<{ok,error?}>` — commits staged → `ConfigStore.writeConfig` → `effectiveBlocklist` → `toHostsLines` → `ShellRunner.writeHosts`, strict order. One atomic run (no queue here — the queue is the store's). Calls only the two ports.
- `src/domain/store.ts` -- NEW. Zustand ^5 store: state `{committed: Config, staged: Domain[]|null, applyStatus}`; actions `{stageDomainAdd(raw), cancelStaged(), apply()}`. `apply()` wraps `runApply` in a serialized queue (one at a time); on admin-denied staged retained, queue does not advance. Initial `committed = readConfig()`. The sole hub; imports the two ports + the three domain modules.
- `__tests__/normalise.test.ts` -- NEW. `normaliseDomain` golden + invalid cases; `toHostsLines` 4-line shape.
- `__tests__/effectiveBlocklist.test.ts` -- NEW. `alwaysOn` filter + dedupe; empty config → `[]`.
- `__tests__/apply.test.ts` -- NEW. mock both specs (factory pattern from `shellRunner.test.ts:27-35`); assert strict order (`writeConfig` before `writeHosts`), happy path, admin-denied (staged retained), config-write failure short-circuits `writeHosts`.
- `__tests__/store.test.ts` -- NEW. mock specs; assert queue serialization (two `apply()` → `writeHosts` called twice, never overlapping), `cancelStaged` discards, `stageDomainAdd` rejects invalid.
- `src/components/ApplyProbe.tsx` -- NEW TEMP. One text input + "Stage" + Apply (wired to `store.apply`, reusing `ApplyButton`) + status line. Rendered in `Shell` for surface 0 in place of `SurfacePlaceholder` during acceptance; deleted after, `Shell` reverted (mirrors 1.5 `ShellRunnerProbe`).
- `src/components/Shell.tsx:87-95` -- EDIT (temp). Branch surface 0 → `<ApplyProbe/>` instead of `<SurfacePlaceholder/>`; reverted after acceptance.
- `package.json` -- EDIT. add `zustand: ^5` to dependencies.
- Reuse (read-only): `src/hosts/shellRunner.ts:48` (`writeHosts` port), `src/config/configStore.ts:36,100` (`readConfig`/`writeConfig` ports), `src/config/types.ts:15-67` (`Domain`/`Config`/`DEFAULT_CONFIG`, deep-frozen), `src/components/ApplyButton.tsx:21` (Apply button primitive the probe reuses), `src/components/surfaces.tsx:48` (`SurfacePlaceholder` — the swap point).

## Tasks & Acceptance

**Execution:**
- [x] `package.json` -- add `zustand: ^5`; `pnpm install` (user runs) -- domain state lib.
- [x] `src/domain/normalise.ts` -- `normaliseDomain` + `toHostsLines` -- domain-owned line production (1.5 contract consumer).
- [x] `src/domain/effectiveBlocklist.ts` -- `effectiveBlocklist(config)` -- Epic-1 `alwaysOn` filter, structured for later epics.
- [x] `src/domain/apply.ts` -- `runApply` strict-order pipeline (commit→writeConfig→effective→lines→writeHosts) -- sole path that touches both ports.
- [x] `src/domain/store.ts` -- Zustand store: staged buffer + serialized apply queue + actions -- the domain hub.
- [x] `__tests__/{normalise,effectiveBlocklist,apply,store}.test.ts` -- unit tests mocking the two specs -- pipeline logic proven in JS.
- [x] `src/components/ApplyProbe.tsx` + `src/components/Shell.tsx` -- temp driver wired to the store -- live one-domain proof vehicle; deleted/reverted after acceptance.

**Acceptance Criteria:**
- Given `pnpm test`, when the suite runs, then `normalise`/`effectiveBlocklist`/`apply`/`store` all pass with the specs mocked.
- Given `pnpm typecheck` (`tsc --noEmit`), then exit 0.
- Given the running app with the temp ApplyProbe, when the user stages `example.com` and clicks Apply and approves the prompt, then `/etc/hosts` gains the 4-line managed section (apex+`www.` on `0.0.0.0`+`::`), `root:wheel` `0644`, DNS flushed, and `example.com`/`www.example.com` fail to load in a browser. Back up + restore `/etc/hosts` after.
- Given a denied prompt on Apply, then `{ok:false,error:"admin-denied"}`, `/etc/hosts` unchanged, staged retained, retry succeeds.
- Given two rapid Apply clicks, then the pipeline runs them strictly one-at-a-time, never in parallel.
- Given any domain-layer code, then it imports ShellRunner/ConfigStore only via the ports and never `child_process`/`fs`/`os` (AD-3/AD-5).

## Design Notes

- **Why the store owns both ports:** ports-&-adapters makes the domain the only hub; UI never sees the ports. Effective-blocklist + line production live in the domain (not the native ShellRunner) so they are Jest-testable without the native module — ShellRunner stays a dumb validated-line writer (1.5's contract).
- **Golden example — one domain `example.com`:** staged = `[{hostname:'example.com', alwaysOn:true}]`; effective = `['example.com']`; lines = `['0.0.0.0 example.com',':: example.com','0.0.0.0 www.example.com',':: www.example.com']`; managed section (per 1.5 contract):
  ```
  # BEGIN FROSTHALT
  0.0.0.0 example.com
  :: example.com
  0.0.0.0 www.example.com
  :: www.example.com
  # END FROSTHALT
  ```
- **Denied-Apply drift:** per the epic's strict order `config.json` is written before `/etc/hosts`, so a denied prompt leaves config ahead of hosts. This is accepted (config = intent, hosts = derived enforcement) and reconciled only by 1.7 Restore; staged retention lets retry re-run `writeHosts` idempotently. Reordering is Ask First.
- **Serialization:** a single in-flight Promise + a micro-queue of pending `apply()` intents; the queue drains one-at-a-time. UI responsiveness is unaffected (`writeHosts` is already off-main-thread in 1.5); the queue just prevents two osascript prompts at once.

## Verification

**Commands:**
- `pnpm typecheck` -- expected: exit 0 (domain + store typecheck against react-native-macos types via the tsconfig `react-native`→`react-native-macos` path).
- `pnpm test --watchman=false -- normalise effectiveBlocklist apply store` -- expected: the four new suites pass.

**Manual checks (native — run outside the node sandbox):**
- `pnpm install` (adds zustand) then `pnpm macos` -- build succeeds.
- On the running app (temp ApplyProbe): stage `example.com` → Apply → approve → `/etc/hosts` shows the 4-line managed section, `ls -l /etc/hosts` = `root:wheel` `0644`, browser cannot load `example.com`/`www.example.com` (DNS flushed). Deny → `{ok:false,error:"admin-denied"}`, `/etc/hosts` unchanged, staged retained, retry works. **Back up `/etc/hosts` before and restore after.** Then delete `ApplyProbe` + revert `Shell`.

## Suggested Review Order

**Domain hub & serialized Apply**

- The sole hub: staged-edits buffer + serialized Apply queue (call-time snapshot, retain-newer-draft invariant).
  [`store.ts:82`](../../src/domain/store.ts#L82)

- The strict-order pipeline (commit→writeConfig→effective→lines→writeHosts); never rejects via the ports.
  [`apply.ts:53`](../../src/domain/apply.ts#L53)

**Normalisation & line production**

- `normaliseDomain` (pragmatic apex) + the all-numeric-label IP-literal guard + `toHostsLines` (4-line payload).
  [`normalise.ts:49`](../../src/domain/normalise.ts#L49)

- Effective blocklist: `alwaysOn` filter, normalised + deduped, structured for later timer/schedule steps.
  [`effectiveBlocklist.ts:28`](../../src/domain/effectiveBlocklist.ts#L28)

**Temp driver (deleted after acceptance)**

- The in-app proof vehicle: text input + Stage + Apply (reusing `ApplyButton`) + status line, wired to the store.
  [`ApplyProbe.tsx:19`](../../src/components/ApplyProbe.tsx#L19)

- `Shell` surface-0 branch → `<ApplyProbe/>` on macOS only (lazy require + `Platform` gate keeps tests green).
  [`Shell.tsx:78`](../../src/components/Shell.tsx#L78)

**Tests**

- Store: serialization (one-at-a-time), retain-newer-draft, dirty-draft no-op, never-reject-on-port-reject.
  [`store.test.ts:82`](../../__tests__/store.test.ts#L82)

- Apply: strict order, golden payload, admin-denied, config-write failure, end-to-end never-reject.
  [`apply.test.ts:65`](../../__tests__/apply.test.ts#L65)

- Normalise: golden + invalid (incl. IP fragments) + `toHostsLines` shape.
  [`normalise.test.ts:17`](../../__tests__/normalise.test.ts#L17)

- Effective blocklist: `alwaysOn` filter + dedupe + empty config.
  [`effectiveBlocklist.test.ts:1`](../../__tests__/effectiveBlocklist.test.ts#L1)

**Dependency**

- Adds `zustand: ^5` (domain state lib).
  [`package.json:1`](../../package.json#L1)