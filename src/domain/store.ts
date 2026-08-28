/**
 * The domain store — the sole hub between UI and the two ports (Story 1.6).
 *
 * Ports & adapters, strictly one-way: `UI -> domain (Zustand) -> adapters ->
 * ports`. The store is the ONLY caller of `ShellRunner.writeHosts` and
 * `ConfigStore.writeConfig`, and the sole owner of the staged-edits buffer and
 * the serialized Apply queue. Adapter/port modules never import each other or
 * the UI.
 *
 * State:
 *   - `committed`  — the last-committed `Config` (init from `readConfig()`).
 *   - `staged`     — the staged domain slice (`Domain[]`) or `null` when clean.
 *     Block-affecting mutations (domain add / `alwaysOn` toggle / schedules)
 *     write here; Apply is the only path that commits staged -> `config.json`
 *     and triggers the ShellRunner write + DNS flush. Cancel discards staged
 *     back to last-committed.
 *   - `applyStatus`— `'idle' | 'running'`; the UI uses this to disable the
 *     Apply button while a run is in flight.
 *   - `lastResult` — the most recent Apply envelope, for the UI status line.
 *
 * Actions:
 *   - `stageDomainAdd(raw)` — normalise + add a domain (alwaysOn true) to the
 *     staged draft; returns `{ ok: false, error: "invalid-domain" }` without
 *     staging on non-hostname input (no Apply, no prompt). Clean-revert (Story
 *     2.4): if the resulting draft equals `committed.domains` (order-agnostic)
 *     `staged` is cleared to `null` — the deferred-equality fix for the
 *     remove+re-add net-zero path (see `stageDomainRemove`).
 *   - `stageAlwaysOnToggle(hostname)` — flip `alwaysOn` for the matching domain
 *     in the staged draft (built on `staged ?? committed.domains`). Produces a
 *     NEW `staged` array reference (spread) so the apply-queue's mid-run-edit
 *     detection still works. Clean-revert: if the resulting draft equals
 *     `committed.domains` (order-agnostic) `staged` is cleared to `null` so a
 *     net-no-op toggle fires no redundant admin prompt — mirroring
 *     `stageDomainAdd`'s no-redundant-Apply principle. Returns
 *     `{ ok: false, error: "not-found" }` without staging when `hostname` is not
 *     in the draft.
 *   - `stageDomainRemove(hostname)` — remove the domain with the given hostname
 *     from the staged draft (built on `staged ?? committed.domains`). Produces a
 *     NEW `staged` array reference (filter) so the apply-queue's mid-run-edit
 *     detection still works. Clean-revert (order-agnostic) when the resulting
 *     draft equals `committed.domains`. Takes the STORED apex
 *     (`domain.hostname`, already normalised) and compares raw — does NOT
 *     re-normalise, matching `stageAlwaysOnToggle`'s convention. Returns
 *     `{ ok: false, error: "not-found" }` without staging when `hostname` is not
 *     in the draft (defensive — the UI only triggers remove from a rendered
 *     row). Removal is STAGED (Apply commits, not password-gated).
 *   - `cancelStaged()` — discard staged back to last-committed.
 *   - `apply()` — enqueue a serialized Apply run; returns its envelope.
 *   - `stageStartTimer({durationMs, selected})` (Story 4.2) — start a focus
 *     session: writes `{activeTimer:{endEpochMs,selectedDomains}}` to
 *     config.json, THEN `writeHosts(effectiveHostsLines(nextConfig))` —
 *     strict config-then-hosts order, ONE admin prompt. Re-uses the shared
 *     `enqueue`; mirrors `setPassword`'s run-time `committed` re-read and
 *     `restoreSection`'s hosts-write + `applyStatus` flip. Hosts-deny
 *     leaves `committed.activeTimer` null (retry-safe). Does NOT touch
 *     `staged` — Start is its own atomic config write.
 *   - `expireTimer()` (Story 4.5) — the auto-unblock on expiry: the MIRROR of
 *     `stageStartTimer`'s body with `activeTimer: null`. See its JSDoc below;
 *     Stories 4.6 (end-early) and 4.7 (launch re-arm) call it directly.
 *
 * Serialization: a single in-flight Promise + a micro-queue of pending
 * `apply()` intents; the queue drains one-at-a-time, never in parallel. This
 * just prevents two osascript prompts at once — `writeHosts` is already
 * off-main-thread (1.5), so UI responsiveness is unaffected. On admin-denied,
 * staged is retained for retry and the queue advances only once the denied run
 * settles (the next queued run re-attempts `writeHosts` idempotently).
 */

import { create } from 'zustand';
import type { Config, Domain } from '../config/types';
import { readConfig, writeConfig } from '../config/configStore';
import { hashPassword, GATE_MAX_ATTEMPTS, GATE_THROTTLE_MS } from '../config/password';
import { normaliseDomain } from './normalise';
import { runApply } from './apply';
import { effectiveHostsLines } from './effectiveBlocklist';
import { computeDrift } from './drift';
import type { DriftResult } from './drift';
import { readHostsSection, writeHosts } from '../hosts/shellRunner';
import type { WriteResult } from '../hosts/shellRunner';
import { useTimerStore } from './timerStore';

export type ApplyStatus = 'idle' | 'running';

/**
 * The failure toast copy (Story 4.5) — shared by BOTH expireTimer failure
 * branches (hosts deny + the defensive hosts-throw catch). Kept as a module
 * constant so the copy exists in exactly one place in this file. Panic's own
 * success toast copy in Panic.tsx is a SEPARATE, component-local string and
 * is deliberately not touched by this.
 */
const HOSTS_FAILURE_TOAST = "Couldn't update /etc/hosts. No changes made.";

/**
 * A runtime-only toast message (Story 4.5). NOT persisted to `config.json` and
 * NOT in `Config`/`types.ts` — the same precedent as Story 3.2's gate state
 * (runtime-only, resets on relaunch). `tone` selects the colour: `'info'` is
 * the neutral success copy, `'error'` is the destructive-coloured failure
 * copy. `null` when no toast is showing.
 */
export interface ToastState {
  message: string;
  tone: 'info' | 'error';
}

/**
 * The result of `verifyPassword` (Story 3.2). On success only `ok` is set;
 * on a wrong entry `triesLeft` is the remaining attempts before throttle; on
 * throttle (or a submit while throttled) `throttleMs` is the remaining wait.
 * The shape is the spec's contract: `{ ok, triesLeft?, throttleMs? }`.
 */
export interface VerifyResult {
  ok: boolean;
  triesLeft?: number;
  throttleMs?: number;
}

export interface DomainState {
  committed: Config;
  staged: Domain[] | null;
  applyStatus: ApplyStatus;
  lastResult: WriteResult | null;
  /**
   * The last drift result, or `null` when drift has not been checked yet
   * (unchecked). Set by `checkDrift` (and re-set on a successful Restore).
   */
  drift: DriftResult | null;
  /**
   * The verbatim on-disk managed-section body lines (`readHostsSection`'s
   * `section`) captured the last time `checkDrift` ran (and on a successful
   * Restore's post-write re-check). `null` when the section was absent OR drift
   * has not been checked yet. The read-only hosts viewer (Story 2.6) renders
   * THIS — the actual on-disk section — NOT `effectiveHostsLines(committed)`
   * (the intended/expected set), so drift is visible rather than hidden. No new
   * port call: `checkDrift`/`restoreSection` already read the section; this
   * field simply preserves what they fetched instead of discarding it.
   */
  lastReadSection: string[] | null;
  stageDomainAdd: (raw: string) => WriteResult;
  /**
   * Flip `alwaysOn` for the domain with the given hostname in the staged draft
   * (built on `staged ?? committed.domains`). Always produces a NEW staged
   * array reference when it mutates (spread), so the apply-queue's
   * mid-run-edit detection (`s.staged === stagedSnapshot`) still works. On a
   * net-no-op toggle (the resulting draft equals `committed.domains`) `staged`
   * is cleared to `null` so no redundant admin prompt fires on the next Apply.
   * Returns `{ ok: false, error: "not-found" }` without staging when the
   * hostname is not in the draft.
   */
  stageAlwaysOnToggle: (hostname: string) => WriteResult;
  /**
   * Remove the domain with the given hostname from the staged draft (built on
   * `staged ?? committed.domains`). Always produces a NEW staged array
   * reference when it mutates (filter), so the apply-queue's mid-run-edit
   * detection (`s.staged === stagedSnapshot`) still works. Clean-revert: if the
   * resulting draft equals `committed.domains` (order-agnostic) `staged` is
   * cleared to `null` so a net-no-op remove (e.g. removing the only staged
   * addition) fires no redundant admin prompt. Returns
   * `{ ok: false, error: "not-found" }` without staging when the hostname is not
   * in the draft.
   *
   * NOTE: takes the STORED apex (`domain.hostname`, already normalised) and
   * compares raw — it does NOT re-normalise, matching `stageAlwaysOnToggle`'s
   * convention (store.ts:128). Re-normalising would be dead code.
   */
  stageDomainRemove: (hostname: string) => WriteResult;
  cancelStaged: () => void;
  apply: () => Promise<WriteResult>;
  /**
   * Start a focus session (Story 4.2). Engine swap from 4.1's per-domain
   * `alwaysOn` flips: a SINGLE serialized run that writes
   * `{activeTimer: {endEpochMs, selectedDomains}}` to `config.json` THEN
   * `writeHosts(effectiveHostsLines(nextConfig))` — strict config-then-hosts
   * order, ONE admin prompt. Mirrors `setPassword`'s run-time `committed`
   * re-read (race-safe against an in-flight Apply) and `restoreSection`'s
   * `applyStatus: 'running'` flip + hosts-write + state transition.
   *
   * - On `writeConfig` failure -> `{ok:false, error:'config-write:<detail>'}`
   *   and return WITHOUT calling `writeHosts` / flipping `applyStatus` /
   *   mutating `committed` (strict order — no admin prompt, no state advance).
   * - On `writeConfig` ok -> flip `applyStatus:'running'`; compute
   *   `effectiveHostsLines(nextConfig)` (always-on ∪ timer-selected, deduped
   *   via `effectiveBlocklist`); call `writeHosts(lines)`.
   * - On `writeHosts` ok -> advance `committed` to `nextConfig` (carrying
   *   `activeTimer`), reset `applyStatus:'idle'`, set `lastResult`.
   * - On `writeHosts` deny -> `committed.activeTimer` STAYS at pre-Start
   *   value (null on fresh); reset `applyStatus:'idle'`; set `lastResult`.
   *   This is the same model as `apply()`'s hosts-deny path (store.ts:372):
   *   if `committed.activeTimer` advanced on denial, the UI would show
   *   "session running" that the disk state cannot back. A future re-arm
   *   (planned for Story 4.7) will resume from the disk state, so leaving
   *   the advance gated on hosts-write success is the cleanest invariant
   *   for this story. The on-disk config carries the `activeTimer` write as
   *   accepted drift (config = intent, hosts = derived enforcement; mirrors
   *   `apply.ts:13-16`); on next launch the planned 4.7 re-arm reads it,
   *   and a successful retry syncs in-memory.
   *
   * `endEpochMs` is computed INSIDE the enqueue (at run time, not call time)
   * so the user gets the full `durationMs` even after a queue wait. The
   * queue is FIFO; if a long Apply is in flight when the user taps Start,
   * `Date.now()` advances while we wait and the user's session is still the
   * full duration.
   *
   * Does NOT touch `staged`. Pending Blocklist edits remain staged for the
   * user's next Apply — Start is its own atomic config write, never a
   * side-effect on `staged`.
   *
   * Does NOT route through `requirePassword` — Start is friction-free per
   * OQ-1.
   *
   * Input-validation contract (Story 4.2 review — PATCH 1): invalid inputs
   * fail BEFORE enqueueing, so no admin prompt fires and no write is
   * attempted. Returns `{ok:false, error:'invalid-duration'}` when
   * `durationMs` is not a positive finite number (0 / negative / NaN /
   * Infinity would corrupt the persisted `endEpochMs` via `Date.now() +
   * durationMs`). Returns `{ok:false, error:'empty-selection'}` when
   * `selected` is empty OR not a `Set` instance (an Array would stringify;
   * null would throw on `Array.from`).
   */
  stageStartTimer: (input: {
    durationMs: number;
    selected: Set<string>;
  }) => Promise<WriteResult>;
  /**
   * Auto-unblock on expiry (Story 4.5) — the MIRROR of `stageStartTimer`'s
   * body (the `stageStartTimer: ({ durationMs, selected })` action below) with
   * `activeTimer: null`. Runs through the SAME
   * shared `enqueue` chain as every other privileged write (the spec's Always
   * clause: no parallel hosts-write path, no `runApply` reuse — `runApply`
   * never writes `activeTimer`).
   *
   * Queue-time guard (the spec's Always clause — the effective blocklist is
   * computed AT QUEUE TIME, never from a tick-time snapshot): the job re-reads
   * `committed` when it acquires the queue and only proceeds when
   * `committed.activeTimer != null && Number.isFinite(endEpochMs) &&
   * Date.now() >= endEpochMs`. Out-of-guard it returns
   * `{ok:false, error:'not-expired'}` WITHOUT touching any port (no config
   * write, no admin prompt, no `applyStatus` flip, no toast) — this is what
   * absorbs a superseding session (a NEW session queued ahead of the expiry
   * job presents a future `endEpochMs` at run time) and the double-fire of
   * the module-level trigger.
   *
   * Body order mirrors `stageStartTimer` exactly:
   *   1. `writeConfig({...committed, activeTimer: null})` FIRST. On failure ->
   *      `{ok:false, error:'config-write:<detail>'}` and return BEFORE any
   *      hosts write, BEFORE flipping `applyStatus`, BEFORE advancing
   *      `committed` (strict order — no admin prompt, no state change, no
   *      toast).
   *   2. Flip `applyStatus: 'running'`.
   *   3. `writeHosts(effectiveHostsLines(nextConfig))` in try/catch. Because
   *      `activeTimer` is null in `nextConfig`, `effectiveBlocklist`
   *      contributes the ALWAYS-ON loop alone — so an also-always-on domain
   *      REMAINS blocked purely by union precedence (no removal code path).
   *      On deny -> `committed.activeTimer` INTACT (memory keeps the expired
   *      session so 4.7's relaunch re-arm can converge; config.json on disk
   *      already says "no session" — the accepted-drift mirror of Start,
   *      over-blocking never a leak) + `applyStatus: 'idle'` + the error
   *      toast. On throw -> same + `hosts-throw:<detail>` envelope.
   *   4. On hosts ok -> advance `committed` to `nextConfig`, reset
   *      `applyStatus: 'idle'`, set `lastResult`, and raise the success toast
   *      "Session ended. Domains unblocked.".
   *
   * On success (and only then) the Shell-level toast is set:
   * `{ message: 'Session ended. Domains unblocked.', tone: 'info' }` on
   * success, `{ message: "Couldn't update /etc/hosts. No changes made.",
   * tone: 'error' }` on a hosts deny or throw. The toast is RUNTIME state
   * (never persisted); the Shell renders it and auto-dismisses it via
   * `clearToast()`.
   *
   * Fire-and-forget-safe: never rejects (the enqueue body is fully guarded +
   * caught), so the module-level trigger below can call it without a
   * `.catch`.
   *
   * JSDoc contract for later stories: Story 4.6 (end-early) and Story 4.7
   * (launch re-arm when `now >= end-time`) call THIS action directly — they
   * must not fork a parallel hosts-write path.
   */
  expireTimer: () => Promise<WriteResult>;
  /**
   * Clear the Shell-level toast (Story 4.5). Called by the Shell's 8 s
   * auto-dismiss timer. Runtime-only: no config write, no hosts write.
   */
  clearToast: () => void;
  /**
   * Sync: read the managed section (`readHostsSection`) + compare to committed
   * (`computeDrift`) + set `drift`. Returns the result. No admin prompt.
   */
  checkDrift: () => DriftResult;
  /**
   * Async: re-run the privileged `writeHosts` path with
   * `effectiveHostsLines(committed)` — ONE admin prompt — through the shared
   * serialized queue (never concurrent with an Apply; one prompt at a time).
   * On success re-checks drift -> in-sync; on denied drift remains. Restore
   * writes HOSTS only (config.json is canonical and unchanged by drift).
   */
  restoreSection: () => Promise<WriteResult>;
  /**
   * Set the self-discipline password (Story 3.1). Non-block-affecting direct
   * config commit (AD-6): builds `{...committed, passwordHash: hashPassword(pw)}`
   * and writes it to `config.json` via `writeConfig` — NOT through the staged-
   * Apply pipeline, does NOT touch `/etc/hosts`. Plaintext is hashed in the JS
   * layer and never persisted (AD-9).
   *
   * Race-safe vs Apply (the spec's Always constraint): the write is sequenced
   * through the SAME serialized queue the Apply pipeline uses, so a direct
   * `writeConfig` can never overlap (clobber) an in-flight Apply's `writeConfig`.
   * `committed` is re-read INSIDE the enqueue at run time (not captured at call
   * time) so the password write preserves any domains an ahead-of-it Apply just
   * committed — mirroring `restoreSection`'s run-time re-read. On `ok` the
   * `committed` state is advanced to the new config (carrying `passwordHash`);
   * on a `writeConfig` failure `committed` is left unchanged and the error
   * envelope is returned for the UI to surface.
   */
  setPassword: (pw: string) => Promise<WriteResult>;

  // ----- Story 3.2 — the reusable password gate (runtime-only state) -----
  //
  // The gate is built ONCE and reused by every gated action (3-3 change-
  // password, 3-4 Panic, 4-6 end-early). The Shell hosts the single
  // `<PasswordGate>` instance; callers invoke `requirePassword(action)` and
  // the store either short-circuits (no password set -> run `action()` right
  // away, no sheet) or opens the sheet (password set -> wait for `verifyPassword`).
  //
  // `gateAttempts` + `gateThrottleUntil` are RUNTIME state — NOT persisted to
  // `config.json`, NOT in `Config`/`types.ts`. They survive close/reopen within
  // a session (Esc does NOT reset the counter — otherwise the 5-try limit is
  // bypassed by reopening) and reset on relaunch. On success or throttle expiry
  // the counter resets to 0 (5 fresh tries).

  /** Whether the gate sheet is currently open (Shell renders `<PasswordGate>`). */
  gateOpen: boolean;
  /** The pending action to run on a successful verify. `null` when no gate is open. */
  gateAction: (() => void) | null;
  /** Consecutive wrong attempts in the current session. Resets on success/throttle expiry. */
  gateAttempts: number;
  /** Epoch ms when the throttle elapses, or `null` when not throttled. */
  gateThrottleUntil: number | null;
  /**
   * The Shell-level toast (Story 4.5): the current message + tone, or `null`
   * when nothing is showing. RUNTIME-ONLY — set by `expireTimer` (and later
   * stories' gated actions), cleared by the Shell's 8 s auto-dismiss via
   * `clearToast()`. NOT persisted to `config.json`, NOT in `Config`/`types.ts`
   * (same precedent as the gate state above); resets on relaunch.
   */
  toast: ToastState | null;
  /**
   * Open the gate for `action` when a password is set, or run `action()`
   * immediately when no password is set (the no-op short-circuit — the gate is
   * never an empty sheet). The single reusable entry point every gated caller
   * uses; do NOT fork per caller.
   */
  requirePassword: (action: () => void) => void;
  /**
   * Verify `pw` against `committed.passwordHash` (re-hash + compare — never
   * re-implement hashing). Throttle-gated: while throttled and not yet elapsed,
   * returns `{ ok: false, throttleMs }` without comparing. On match: resets
   * `gateAttempts`→0 + `gateThrottleUntil`→null and returns `{ ok: true }`.
   * On wrong: increments `gateAttempts`; at `GATE_MAX_ATTEMPTS` sets
   * `gateThrottleUntil = now + GATE_THROTTLE_MS` and returns
   * `{ ok: false, triesLeft: 0, throttleMs }`; below the limit returns
   * `{ ok: false, triesLeft }`. Does NOT touch `gateOpen`/`gateAction` — the
   * Shell's `onVerified` closes the gate after running the action.
   */
  verifyPassword: (pw: string) => VerifyResult;
  /**
   * Close the gate sheet: clear `gateOpen` + `gateAction`. PRESERVES
   * `gateAttempts` + `gateThrottleUntil` (Esc/cancel does NOT reset the
   * counter — the spec's Never clause). Called by the Shell's Esc branch and
   * the gate's Cancel button.
   */
  closeGate: () => void;
  /**
   * Clear the throttle: null `gateThrottleUntil` and reset `gateAttempts`→0
   * (5 fresh tries). Called by the gate's countdown `setInterval` when the
   * countdown hits 0. Also called defensively inside `verifyPassword` when a
   * submit lands at the exact expiry moment (race with the interval tick).
   */
  clearGateThrottle: () => void;
}

export const useDomainStore = create<DomainState>()((set, get) => ({
  committed: readConfig(),
  staged: null,
  applyStatus: 'idle',
  lastResult: null,
  drift: null,
  lastReadSection: null,
  // Story 3.2 — runtime-only gate state. Reset on relaunch (not persisted).
  gateOpen: false,
  gateAction: null,
  gateAttempts: 0,
  gateThrottleUntil: null,
  // Story 4.5 — runtime-only Shell-level toast. `null` when nothing is
  // showing; set by `expireTimer`, cleared by the Shell's auto-dismiss via
  // `clearToast`. Not persisted (same precedent as the gate state above).
  toast: null,

  stageDomainAdd: (raw) => {
    const apex = normaliseDomain(raw);
    if (apex == null) {
      // Non-hostname input is rejected without staging, Apply, or any prompt.
      return { ok: false, error: 'invalid-domain' };
    }
    // Stage on top of the current draft (or committed, if clean).
    const base = get().staged ?? get().committed.domains;
    if (base.some((d) => d.hostname === apex)) {
      // Already present (PK = hostname). Idempotent: leave the current draft
      // untouched. Crucially, when CLEAN (staged == null) this stays a true
      // no-op — staged is NOT set to `committed.domains`, otherwise a redundant
      // Apply would fire an admin prompt to write an identical config.
      return { ok: true };
    }
    const next = [...base, { hostname: apex, alwaysOn: true }];
    // Clean-revert (Story 2.4 — the deferred-equality fix): if the resulting
    // draft equals `committed.domains` (order-agnostic), clear `staged` to
    // `null`. This is the fix for the latent equality gap that `stageDomainRemove`
    // makes reachable: remove a domain then re-add it -> a reordered
    // value-equal draft that, without this check, is retained while
    // `stagedChangeCount` reports 0 -> "0 changes staged" + a pulsing Apply on
    // a net-zero draft. The shared order-agnostic `draftEqualsCommitted`
    // clears it, restoring `staged != null ⟹ stagedChangeCount >= 1`.
    // No 2.2 behaviour shifts: this only fires on the remove+re-add net-zero
    // (unreachable in 2.2 — a clean duplicate add is a true no-op above).
    if (draftEqualsCommitted(next, get().committed.domains)) {
      set({ staged: null });
      return { ok: true };
    }
    set({ staged: next });
    return { ok: true };
  },

  stageAlwaysOnToggle: (hostname) => {
    // Build on the current draft (or committed, if clean). Toggling is
    // optimistic: the user sees the pending toggle immediately; Apply commits;
    // Cancel reverts. Same staged-then-Apply model as 1.6.
    const base = get().staged ?? get().committed.domains;
    const idx = base.findIndex((d) => d.hostname === hostname);
    if (idx === -1) {
      // Unknown hostname (not in the draft). No staging, no Apply, no prompt.
      return { ok: false, error: 'not-found' };
    }
    // Produce a NEW array reference (spread + map) so the apply-queue's
    // mid-run-edit detection (`s.staged === stagedSnapshot`) still works: a
    // toggle that lands while an Apply is in flight is always a different
    // reference from the snapshot the running Apply captured, so the success
    // handler retains it rather than clobbering it.
    const next = base.map((d, i) =>
      i === idx ? { ...d, alwaysOn: !d.alwaysOn } : d,
    );
    // Clean-revert: if the resulting draft equals committed.domains (same
    // hostnames + alwaysOn, order), clear `staged` to `null`. This mirrors
    // `stageDomainAdd`'s no-redundant-Apply principle — a net-no-op toggle
    // (e.g. toggle a domain off then on) must NOT leave a dirty draft that
    // would force an admin prompt to write an identical `/etc/hosts`.
    if (draftEqualsCommitted(next, get().committed.domains)) {
      set({ staged: null });
      return { ok: true };
    }
    set({ staged: next });
    return { ok: true };
  },

  stageDomainRemove: (hostname) => {
    // Build on the current draft (or committed, if clean). Removal is
    // optimistic: the row vanishes immediately (the UI filters it out of the
    // rendered `staged ?? committed.domains`); Apply commits; Cancel reverts.
    // Same staged-then-Apply model as add/toggle. NOT password-gated (Epic 3).
    const base = get().staged ?? get().committed.domains;
    const idx = base.findIndex((d) => d.hostname === hostname);
    if (idx === -1) {
      // Unknown hostname (not in the draft). No staging, no Apply, no prompt.
      // Defensive — the UI only triggers remove from a rendered row, so this
      // is unreachable in practice.
      return { ok: false, error: 'not-found' };
    }
    // Produce a NEW array reference (filter) so the apply-queue's mid-run-edit
    // detection (`s.staged === stagedSnapshot`) still works: a remove that
    // lands while an Apply is in flight is always a different reference from
    // the snapshot the running Apply captured.
    const next = base.filter((d, i) => i !== idx);
    // Clean-revert: if the resulting draft equals committed.domains (order-
    // agnostic), clear `staged` to `null`. This mirrors the toggle/add
    // no-redundant-Apply principle — e.g. removing the ONLY staged addition
    // nets back to committed, so no admin prompt should fire on the next
    // Apply for an identical config.
    if (draftEqualsCommitted(next, get().committed.domains)) {
      set({ staged: null });
      return { ok: true };
    }
    set({ staged: next });
    return { ok: true };
  },

  cancelStaged: () => set({ staged: null }),

  apply: () => {
    // Capture the staged + committed snapshot at CALL time. This makes two
    // rapid Apply clicks both run (each carries its own intent) — the queue
    // then serializes them strictly one-at-a-time, never in parallel.
    const stagedSnapshot = get().staged;
    // A no-op Apply (nothing staged) short-circuits at CALL time, before
    // enqueue, so it neither queues behind an in-flight run nor flips
    // `applyStatus`. (A no-op queued behind a real run would just wait, then
    // resolve to { ok: true }; doing so at call time is strictly better.)
    if (stagedSnapshot == null) {
      return Promise.resolve({ ok: true });
    }
    const committedSnapshot = get().committed;
    return enqueue(async () => {
      set({ applyStatus: 'running' });
      const result = await runApply({
        committed: committedSnapshot,
        staged: stagedSnapshot,
      });
      if (result.ok) {
        // Commit: the staged slice becomes the new committed domains; clear
        // staged only if no NEW edits were staged while this run was in
        // flight. The reference-identity check (`s.staged === stagedSnapshot`)
        // is what distinguishes "no newer draft" (same array reference as
        // captured -> safe to clear) from "a newer edit arrived mid-run"
        // (a different array reference -> retain it, do not clobber). This
        // relies on `stageDomainAdd` always producing a NEW array reference
        // when it mutates the draft (it spreads `base`), so a newer draft is
        // always a different reference from `stagedSnapshot`. `runApply`
        // never rejects (the ports' never-throw/never-reject contracts), so
        // both branches below always run and `applyStatus` always resets.
        set((s) => ({
          committed: { ...s.committed, domains: stagedSnapshot },
          staged: s.staged === stagedSnapshot ? null : s.staged,
          applyStatus: 'idle',
          lastResult: result,
        }));
      } else {
        // Admin-denied or config-write failure: retain staged for retry. The
        // queue advances past this run only once it has settled; the next
        // queued Apply re-attempts `writeHosts` idempotently.
        set({ applyStatus: 'idle', lastResult: result });
      }
      return result;
    });
  },

  checkDrift: () => {
    // Sync: read the managed section (unprivileged, no admin prompt) + compare
    // to committed + set `drift`. Returns the result so the caller (the UI) can
    // branch on it immediately. No port throws (`readHostsSection` catches a
    // native throw into a `{ok:false,error}` envelope), so this never throws.
    const read = readHostsSection();
    const result = computeDrift(get().committed, read);
    // Preserve the verbatim on-disk body lines for the read-only viewer (Story
    // 2.6). `read.section` is `null` when the section is absent OR `ok:false`
    // (corrupt); in both cases `null` is the right value for the viewer's
    // empty-state. This adds no new port call — `readHostsSection` was already
    // invoked above; this just keeps what it returned instead of discarding it.
    set({ drift: result, lastReadSection: read.section ?? null });
    return result;
  },

  restoreSection: () => {
    // Restore writes HOSTS only (config.json is canonical and unchanged by
    // drift), so there is no staged snapshot and no config write — just
    // `writeHosts(effectiveHostsLines(committed))`. Routing through the shared
    // serialized queue guarantees Restore never runs concurrent with an Apply
    // (one osascript prompt at a time).
    //
    // committed is re-read INSIDE the enqueue callback (at run time), NOT
    // captured at call time. If an Apply was queued ahead of this Restore and
    // committed new domains while we waited, Restore must reconcile hosts to
    // the CURRENT committed — not the stale call-time snapshot, which would
    // clobber the Apply's just-written hosts and falsely report in-sync while
    // store.committed is new and /etc/hosts holds the old lines.
    return enqueue(async () => {
      set({ applyStatus: 'running' });
      const committed = get().committed;
      const lines = effectiveHostsLines(committed);
      const result = await writeHosts(lines);
      if (result.ok) {
        // Success: re-check drift -> should be in-sync. The read + compare are
        // sync, so the drift state is updated before the promise resolves. The
        // verbatim section is preserved into `lastReadSection` so the viewer
        // (Story 2.6) re-renders with the freshly-written on-disk body.
        const read = readHostsSection();
        const drift = computeDrift(committed, read);
        set({
          applyStatus: 'idle',
          lastResult: result,
          drift,
          lastReadSection: read.section ?? null,
        });
      } else {
        // Denied (or hard OS error): /etc/hosts unchanged, drift remains. The
        // warning stays; no auto-re-add loop (spec: Never). `lastResult` is set
        // so the UI status line reflects the denial.
        set({ applyStatus: 'idle', lastResult: result });
      }
      return result;
    });
  },

  setPassword: (pw) => {
    // Non-block-affecting direct config commit (AD-6): write `passwordHash`
    // straight to `config.json` via `writeConfig` — NOT through the staged-
    // Apply pipeline, does NOT touch `/etc/hosts` (no `writeHosts`, no admin
    // prompt). The hash is computed in the JS layer (`hashPassword` =
    // salt-free SHA-256, AD-9); plaintext is never persisted.
    //
    // Race-safety (the spec's Always constraint): route the write through the
    // SAME serialized queue Apply uses (`enqueue`), so a direct `writeConfig`
    // can never overlap an in-flight Apply's `writeConfig`. The queue is FIFO
    // and single-flight, so if an Apply is running when the user sets a
    // password, this write waits for the Apply to settle, then runs with the
    // Apply's just-committed domains already in `committed` — the password
    // write cannot clobber the Apply's `writeConfig` (the spec's AC).
    //
    // `committed` is re-read INSIDE the enqueue (at run time), NOT captured at
    // call time. If an Apply queued ahead of this write commits new domains
    // while we wait, the password write must build on the CURRENT committed —
    // not a stale call-time snapshot, which would clobber the Apply's just-
    // written domains (mirrors `restoreSection`'s run-time re-read at
    // store.ts:321). `writeConfig` serializes the WHOLE config, so the full
    // next `Config` is built here: `{...committed, passwordHash}`.
    //
    // `applyStatus` is NOT flipped: this is not an Apply run (no admin prompt,
    // no `/etc/hosts` write), so the Blocklist Apply button is not disabled by
    // a password save. `writeConfig` is a synchronous native call, so the
    // enqueued job settles in a single microtask; the UI awaits the returned
    // promise for its own saving/saved state.
    return enqueue(async () => {
      const committed = get().committed;
      const nextConfig: Config = {
        ...committed,
        passwordHash: hashPassword(pw),
      };
      const result = writeConfig(nextConfig);
      if (result.ok) {
        // Advance committed to the new config (carrying `passwordHash`). On
        // failure, leave committed unchanged and return the error envelope for
        // the UI to surface ("Couldn't save password. No changes made.").
        set({ committed: nextConfig });
      }
      return result;
    });
  },

  // ----- Story 4.2 — `stageStartTimer` (the timed-session engine swap) -----

  stageStartTimer: ({ durationMs, selected }) => {
    // Input guards (Story 4.2 review — PATCH 1): validate at the store layer
    // BEFORE enqueueing so a malformed call neither flips `applyStatus` nor
    // triggers an admin prompt nor writes to config.json / /etc/hosts.
    //   - `durationMs` must be a positive finite number. A 0 / negative / NaN
    //     / Infinity would flow through to `Date.now() + durationMs` and
    //     corrupt the persisted `endEpochMs`.
    //   - `selected` must be a non-empty Set. An empty Set would persist
    //     `selectedDomains: []` with no effect (the dedupe loop yields
    //     nothing); a non-Set (e.g. Array, null) would either stringify or
    //     throw on `Array.from`.
    // Both failures short-circuit BEFORE enqueue, returning a resolved
    // `WriteResult` envelope so the caller sees `{ok:false, error}` and the
    // UI can branch on it without unwrapping a thrown error.
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return Promise.resolve({ ok: false, error: 'invalid-duration' } as WriteResult);
    }
    if (!(selected instanceof Set) || selected.size === 0) {
      return Promise.resolve({ ok: false, error: 'empty-selection' } as WriteResult);
    }
    // Engine swap from 4.1's per-domain `alwaysOn` flips. The serialized run
    // body mirrors `setPassword`'s run-time re-read of `committed` (race-
    // safe against an in-flight Apply) + `restoreSection`'s hosts-write +
    // `applyStatus` flip pattern. Parallel queue body — NOT a reuse of
    // `runApply` — because we need a different `nextConfig` shape (carrying
    // `activeTimer`, NOT `domains = staged`); keeping the strict
    // config-then-hosts order auditable in one place.
    return enqueue(async () => {
      // Re-read committed at run time. If a long Apply was queued ahead of
      // this Start, its just-committed domains are now in `committed` —
      // building `nextConfig` on the run-time value preserves them in the
      // activeTimer write (the spec's race-vs-Apply AC).
      const committed = get().committed;
      const nextConfig: Config = {
        ...committed,
        // `endEpochMs` computed INSIDE the enqueue (at run time) so the user
        // gets the full `durationMs` even after a queue wait. The countdown
        // ring (4.3) reads `endEpochMs - Date.now()`; this matches.
        activeTimer: {
          endEpochMs: Date.now() + durationMs,
          selectedDomains: Array.from(selected),
        },
      };
      // 1. Write config.json FIRST (strict order). On failure -> short-circuit
      // BEFORE any elevation (no admin prompt, no `applyStatus` flip, no
      // `committed` advance). Mirrors `runApply`'s order at apply.ts:13-16
      // and `setPassword`'s `writeConfig`-only path at store.ts:467-481.
      const cfg = writeConfig(nextConfig);
      if (!cfg.ok) {
        return {
          ok: false,
          error: `config-write:${cfg.error ?? 'unknown'}`,
        } as WriteResult;
      }
      // 2. Flip `applyStatus` (gates the `liveApplyStatus` Start guard at
      // Timer.tsx:255-258 — prevents double-tap from queuing two prompts)
      // and compute the effective hosts lines from the just-committed
      // `nextConfig`. `effectiveBlocklist` walks always-on AND
      // `activeTimer.selectedDomains`, deduping by apex (Epic 4
      // contribution). The timer's union rides through automatically —
      // `effectiveHostsLines` is unchanged.
      set({ applyStatus: 'running' });
      // 3. Write the managed hosts section — ONE admin prompt. The native
      // promise resolves (never rejects) per shellRunner's contract; errors
      // ride inside the envelope. The try/catch wraps the post-`applyStatus`
      // portion (Story 4.2 review — PATCH 2) as a defensive guard: shellRunner
      // promises "never rejects", but JS Promises can still throw (e.g. a
      // TypeError from a downstream change). Without this catch, an
      // unexpected throw would leave `applyStatus === 'running'` forever and
      // the Start button permanently disabled. The catch resets `applyStatus`
      // and returns an envelope so the UI is recoverable.
      try {
        const lines = effectiveHostsLines(nextConfig);
        const result = await writeHosts(lines);
        if (result.ok) {
          // Hosts ok -> advance `committed` to `nextConfig` (carrying
          // `activeTimer`) + reset `applyStatus` + set `lastResult`. Same
          // model as `apply()`'s success path at store.ts:354-371.
          set({
            committed: nextConfig,
            applyStatus: 'idle',
            lastResult: result,
          });
        } else {
          // Hosts denied (or hard OS error) -> `committed.activeTimer` STAYS
          // at the pre-Start value (null on fresh) — the spec's hosts-deny
          // invariant. `applyStatus` resets to `idle`; `lastResult` carries
          // the envelope for the UI status line. `config.json` on disk may
          // carry the `activeTimer` write (accepted drift, mirrors
          // `apply.ts:13-16`); A future re-arm (planned for Story 4.7) will
          // resume from the disk state, and a successful retry syncs in-memory.
          set({ applyStatus: 'idle', lastResult: result });
        }
        return result;
      } catch (err) {
        // Defensive — shellRunner's contract says the promise never rejects,
        // but JS Promises can still throw; reset `applyStatus` so the UI is
        // recoverable.
        set({ applyStatus: 'idle' });
        return { ok: false, error: `hosts-throw:${String(err)}` } as WriteResult;
      }
    });
  },

  // ----- Story 4.5 — `expireTimer` (the auto-unblock on expiry) -----

  expireTimer: () => {
    // The MIRROR of `stageStartTimer`'s body (the `stageStartTimer:
    // ({ durationMs, selected })` action in this file — referenced by NAME,
    // not line range, so this comment does not rot as the file grows) with
    // `activeTimer: null`. Parallel queue body — NOT a reuse of `runApply`
    // (which never writes `activeTimer`) — keeping the strict
    // config-then-hosts order auditable in one place. Through the shared
    // `enqueue` chain only: no parallel hosts-write path, never concurrent
    // with an Apply (one osascript prompt at a time).
    return enqueue(async () => {
      // Queue-time guard + re-read (the spec's Always clause): `committed` is
      // read INSIDE the enqueue — at the moment this job ACQUIRES the queue,
      // never from a tick-time snapshot. Three conditions, all required:
      //   - `activeTimer != null` — no session, nothing to expire (absorbs
      //     the trigger's double-fire after a successful expiry).
      //   - `Number.isFinite(endEpochMs)` — a malformed (NaN/Infinity)
      //     end time can never count as expired.
      //   - `Date.now() >= endEpochMs` — the session has actually reached
      //     its end AT RUN TIME. A superseding session (a NEW Start queued
      //     ahead of this job) rewrites `activeTimer` with a FUTURE end; this
      //     re-read sees it and no-ops — the fresh session survives.
      // Out-of-guard: return WITHOUT touching any port (no config write, no
      // admin prompt, no `applyStatus` flip, no `committed` change, no toast).
      const committed = get().committed;
      const active = committed.activeTimer;
      if (
        active == null ||
        !Number.isFinite(active.endEpochMs) ||
        Date.now() < active.endEpochMs
      ) {
        return { ok: false, error: 'not-expired' } as WriteResult;
      }
      const nextConfig: Config = {
        ...committed,
        activeTimer: null,
      };
      // 1. Write config.json FIRST (strict order, mirrors `stageStartTimer`'s
      // accepted-drift order). On failure -> short-circuit BEFORE any
      // elevation: no admin prompt, NO `applyStatus` flip, NO `committed`
      // advance, NO toast. Over-blocking direction: a config-write failure
      // leaves everything exactly as it was — hosts still blocks the session
      // domains, memory still says the session runs.
      const cfg = writeConfig(nextConfig);
      if (!cfg.ok) {
        return {
          ok: false,
          error: `config-write:${cfg.error ?? 'unknown'}`,
        } as WriteResult;
      }
      // 2. Flip `applyStatus: 'running'` (the same UI gate the Start/Apply
      // paths use) and compute the effective hosts lines from the JUST-BUILT
      // `nextConfig` — always-on only, because the active-timer set lifts
      // (`effectiveBlocklist`'s Epic 4 loop contributes nothing when
      // `activeTimer == null`). The always-on loop alone keeps an
      // also-always-on domain blocked — union precedence by construction,
      // no removal code path.
      set({ applyStatus: 'running' });
      // 3. Write the managed hosts section — ONE admin prompt. The native
      // promise resolves (never rejects) per shellRunner's contract; the
      // try/catch is the same defensive guard `stageStartTimer` carries
      // (Story 4.2 review — PATCH 2): an unexpected throw must never leave
      // `applyStatus === 'running'` forever.
      try {
        const lines = effectiveHostsLines(nextConfig);
        const result = await writeHosts(lines);
        if (result.ok) {
          // Hosts ok -> advance `committed` to `nextConfig` (`activeTimer`
          // cleared) + reset `applyStatus` + set `lastResult` + raise the
          // success toast. The badge/countdown consumers derive everything
          // from `committed.activeTimer`, so they revert with zero changes
          // to the surfaces.
          set({
            committed: nextConfig,
            applyStatus: 'idle',
            lastResult: result,
            toast: { message: 'Session ended. Domains unblocked.', tone: 'info' },
          });
        } else {
          // Hosts denied (or hard OS error) -> `committed.activeTimer` INTACT
          // in memory (config.json on disk already says "no session" — the
          // accepted-drift mirror of Start; over-blocking, never a leak).
          // `applyStatus` resets to `idle`; `lastResult` carries the envelope;
          // the failure toast shows. Retry = relaunch (4.7 re-arm) or a new
          // session.
          set({
            applyStatus: 'idle',
            lastResult: result,
            toast: {
              message: HOSTS_FAILURE_TOAST,
              tone: 'error',
            },
          });
        }
        return result;
      } catch (err) {
        // Defensive — shellRunner's contract says the promise never rejects,
        // but JS Promises can still throw; reset `applyStatus`, keep
        // `committed.activeTimer` intact, raise the failure toast.
        set({
          applyStatus: 'idle',
          toast: {
            message: HOSTS_FAILURE_TOAST,
            tone: 'error',
          },
        });
        return { ok: false, error: `hosts-throw:${String(err)}` } as WriteResult;
      }
    });
  },

  clearToast: () => {
    // Runtime-only: clear the Shell-level toast. Called by the Shell's 8 s
    // auto-dismiss timer. No config write, no hosts write.
    set({ toast: null });
  },

  // ----- Story 3.2 — the reusable password gate actions -----

  requirePassword: (action) => {
    // No password set: run `action()` immediately, no sheet. The gate is a
    // no-op, never an empty sheet (the spec's Always clause). `passwordHash`
    // absent OR empty-string both count as "no password set" — matches
    // `Settings.tsx`'s sentinel (`passwordHash != null && passwordHash !== ''`).
    const hash = get().committed.passwordHash;
    if (hash == null || hash === '') {
      action();
      return;
    }
    // Password set: open the sheet and stash the action for `onVerified`.
    set({ gateOpen: true, gateAction: action });
  },

  verifyPassword: (pw) => {
    // Throttle-gated: while the throttle is active and not yet elapsed, refuse
    // without comparing (the spec's "field+submit disabled until it elapses" —
    // the UI disables submit during throttle, so this is a defensive guard for
    // a race or a direct store caller). Return the remaining wait so the UI
    // can keep its countdown in sync.
    const now = Date.now();
    const throttleUntil = get().gateThrottleUntil;
    if (throttleUntil != null && now < throttleUntil) {
      // `triesLeft: 0` keeps the throttled-result shape consistent with the
      // 5th-wrong branch below (both carry `triesLeft` + `throttleMs`) so a
      // caller reading `triesLeft` on a throttle result never sees `undefined`.
      return { ok: false, triesLeft: 0, throttleMs: throttleUntil - now };
    }
    // If the throttle has elapsed but the countdown interval hasn't ticked yet
    // (a submit landing at the exact expiry moment), clear it here for 5 fresh
    // tries. This mirrors `clearGateThrottle` and keeps `verifyPassword`
    // self-contained — the next wrong entry starts from attempts=0.
    if (throttleUntil != null && now >= throttleUntil) {
      set({ gateAttempts: 0, gateThrottleUntil: null });
    }
    // Re-hash the entry and compare to `committed.passwordHash` (the spec's
    // Always clause — reuse `hashPassword`, never re-implement). No
    // `writeConfig`, no `writeHosts`, no new native module.
    const committedHash = get().committed.passwordHash;
    if (committedHash == null || committedHash === '') {
      // Defensive: `requirePassword` short-circuits when no password is set,
      // so the gate never opens without a hash. If a caller reaches here
      // anyway (e.g. a test seeding `gateOpen:true` with no hash), treat it as
      // verified so the user isn't locked out by a misconfiguration.
      return { ok: true };
    }
    if (hashPassword(pw) === committedHash) {
      // Success: reset attempts + throttle (the spec's I/O matrix — "correct
      // entry -> gateAttempts→0, gateThrottleUntil→null"). Does NOT touch
      // `gateOpen`/`gateAction` — the Shell's `onVerified` closes the gate
      // after running the action.
      set({ gateAttempts: 0, gateThrottleUntil: null });
      return { ok: true };
    }
    // Wrong: increment attempts. At `GATE_MAX_ATTEMPTS` engage the throttle.
    const attempts = get().gateAttempts + 1;
    if (attempts >= GATE_MAX_ATTEMPTS) {
      set({
        gateAttempts: attempts,
        gateThrottleUntil: now + GATE_THROTTLE_MS,
      });
      return { ok: false, triesLeft: 0, throttleMs: GATE_THROTTLE_MS };
    }
    set({ gateAttempts: attempts });
    return { ok: false, triesLeft: GATE_MAX_ATTEMPTS - attempts };
  },

  closeGate: () => {
    // Clear `gateOpen` + `gateAction`. PRESERVE `gateAttempts` +
    // `gateThrottleUntil` (Esc/cancel does NOT reset the counter — the spec's
    // Never clause: "Reset the attempt counter on Esc/close" is a Never). The
    // counter resets only on success (`verifyPassword`) or throttle expiry
    // (`clearGateThrottle`).
    set({ gateOpen: false, gateAction: null });
  },

  clearGateThrottle: () => {
    // Null the throttle + reset attempts to 0 (5 fresh tries). Called by the
    // gate's countdown `setInterval` when the countdown hits 0, and on mount
    // when the gate re-opens with a throttle timestamp already in the past.
    // Guarded: a no-op when NOT throttled — otherwise a stray call after a few
    // wrong tries (but before the throttle engages) would wipe `gateAttempts`
    // and bypass the 5-try limit. The countdown tick only fires while
    // throttled, so this guard does not block the legitimate expiry path.
    if (get().gateThrottleUntil == null) {
      return;
    }
    set({ gateAttempts: 0, gateThrottleUntil: null });
  },
}));

// ---------------------------------------------------------------------------
// Story 4.5 — the expiry trigger (module-level slice subscription).
// ---------------------------------------------------------------------------

/**
 * Whether the scoped timer slice is parked ON an expired session: a session is
 * mirrored (`endEpochMs != null`, finite) AND the wall-clock mirror has caught
 * up to or passed it. This is exactly the state the slice's driver SELF-PARKS
 * into (`timerStore.ts:175-188` — the tick that observes `now >= end` clears
 * the driver and parks `nowMs` AT `endEpochMs`), and also the state
 * `start()` parks an already-expired `endEpochMs` into at mount (`timerStore.ts:151-161`)
 * — which is why an expired-at-launch session re-arms through this same
 * trigger (Story 4.7 layers the launch UX on this path).
 *
 * Derived here (NOT added to the slice) deliberately: the spec's Ask-First
 * forbids changing the timer slice's state shape, and the trigger only needs
 * this one boolean.
 */
function sliceExpiredParked(s: { endEpochMs: number | null; nowMs: number }): boolean {
  return (
    s.endEpochMs != null && Number.isFinite(s.endEpochMs) && s.nowMs >= s.endEpochMs
  );
}

// The expiry trigger. A module-level subscription on the scoped slice that
// fires `expireTimer()` ONCE on the expired-parked false->true transition —
// not on every tick (the driver self-park is a one-time state change; the
// transition detector is what keeps this from re-firing per second).
//
// Why here and not in a component: expiry is a privileged write — it belongs
// in the domain layer. The Timer surface unmounts and the driver parks
// regardless of surfaces; the SLICE, not the view tree, knows the moment. The
// import is ONE-WAY (store -> timerStore; timerStore imports nothing from
// store), so there is no cycle.
//
// Fire-and-forget: `expireTimer` never rejects (the enqueue body is guarded +
// caught), and the toast carries the outcome. Duplicate fires are absorbed by
// the queue-time guard (after a successful expiry `activeTimer` is null; a
// superseding session presents a future `endEpochMs`).
useTimerStore.subscribe((state, prev) => {
  if (sliceExpiredParked(state) && !sliceExpiredParked(prev)) {
    void useDomainStore.getState().expireTimer().catch(() => {
      // Defensive — the enqueue body never rejects, but a fire-and-forget
      // trigger must never surface an unhandled rejection.
    });
  }
});

// ---------------------------------------------------------------------------
// Serialized Apply queue (module-private).
// ---------------------------------------------------------------------------

// A single always-settled promise chain. Each `apply()` call appends a run to
// `runChain` via `enqueue`; runs execute strictly one after the previous
// settles, never in parallel.
let runChain: Promise<WriteResult> = Promise.resolve({ ok: true });

function enqueue(run: () => Promise<WriteResult>): Promise<WriteResult> {
  // `.then(run, run)` runs `run` after the previous run settles whether it
  // resolved or rejected (runApply never rejects, but the guard makes the
  // queue robust to an unexpected throw).
  const next = runChain.then(run, run);
  // Keep the INTERNAL chain always-settled so a failed run does not poison
  // subsequent queued runs. The caller still receives the real result via
  // `next` (success or failure); only the internal scheduling chain is
  // normalised.
  runChain = next.then(
    () => ({ ok: true }) as WriteResult,
    () => ({ ok: false }) as WriteResult,
  );
  return next;
}

/**
 * Structural equality of two `Domain[]` drafts by `(hostname, alwaysOn)`,
 * ORDER-AGNOSTIC (hostname-set equality). Used by the staging actions'
 * clean-revert (`stageAlwaysOnToggle` / `stageDomainRemove` / `stageDomainAdd`):
 * when the post-edit draft matches `committed.domains`, `staged` is cleared to
 * `null` so a net-no-op edit fires no redundant admin prompt. Reference
 * identity is NOT checked — a freshly-spread draft that is value-equal to
 * committed is the whole point (the edit produced a new ref but the same
 * value).
 *
 * Order-agnostic since Story 2.4: `hostname` is the PK (unique, deduped at
 * add), so length-equal + per-hostname `(hostname, alwaysOn)` match implies
 * set equality. This aligns with the already-order-agnostic
 * `stagedChangeCount` sibling and preserves
 * `staged != null ⟹ stagedChangeCount >= 1` once `stageDomainRemove` makes
 * reordered value-equal drafts reachable (remove a middle domain, then re-add
 * it -> a reordered net-zero draft). Does NOT call `normaliseDomain` — raw
 * apex compare, matching `stageAlwaysOnToggle`/`stageDomainRemove`'s
 * convention. No existing test relies on order-sensitivity (the clean-revert
 * tests use same-order value-equal drafts).
 */
function draftEqualsCommitted(a: Domain[], b: Domain[]): boolean {
  if (a.length !== b.length) return false;
  // Index `b` by hostname so each `a` entry can be matched in O(1), regardless
  // of order. Hostname is the PK (unique), so a per-hostname match is set
  // equality once lengths are equal.
  const bByHost = new Map<string, boolean>();
  for (const d of b) {
    bByHost.set(d.hostname, d.alwaysOn);
  }
  for (const d of a) {
    const match = bByHost.get(d.hostname);
    if (match === undefined) return false;
    if (match !== d.alwaysOn) return false;
  }
  return true;
}
