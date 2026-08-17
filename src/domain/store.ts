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
 *     staging on non-hostname input (no Apply, no prompt).
 *   - `stageAlwaysOnToggle(hostname)` — flip `alwaysOn` for the matching domain
 *     in the staged draft (built on `staged ?? committed.domains`). Produces a
 *     NEW `staged` array reference (spread) so the apply-queue's mid-run-edit
 *     detection still works. Clean-revert: if the resulting draft equals
 *     `committed.domains` (same hostnames + alwaysOn, order) `staged` is cleared
 *     to `null` so a net-no-op toggle fires no redundant admin prompt — mirroring
 *     `stageDomainAdd`'s no-redundant-Apply principle. Returns
 *     `{ ok: false, error: "not-found" }` without staging when `hostname` is not
 *     in the draft.
 *   - `cancelStaged()` — discard staged back to last-committed.
 *   - `apply()` — enqueue a serialized Apply run; returns its envelope.
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
import { readConfig } from '../config/configStore';
import { normaliseDomain } from './normalise';
import { runApply } from './apply';
import { effectiveHostsLines } from './effectiveBlocklist';
import { computeDrift } from './drift';
import type { DriftResult } from './drift';
import { readHostsSection, writeHosts } from '../hosts/shellRunner';
import type { WriteResult } from '../hosts/shellRunner';

export type ApplyStatus = 'idle' | 'running';

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
  cancelStaged: () => void;
  apply: () => Promise<WriteResult>;
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
}

export const useDomainStore = create<DomainState>()((set, get) => ({
  committed: readConfig(),
  staged: null,
  applyStatus: 'idle',
  lastResult: null,
  drift: null,

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
    set({ staged: [...base, { hostname: apex, alwaysOn: true }] });
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
    set({ drift: result });
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
        // sync, so the drift state is updated before the promise resolves.
        const read = readHostsSection();
        const drift = computeDrift(committed, read);
        set({ applyStatus: 'idle', lastResult: result, drift });
      } else {
        // Denied (or hard OS error): /etc/hosts unchanged, drift remains. The
        // warning stays; no auto-re-add loop (spec: Never). `lastResult` is set
        // so the UI status line reflects the denial.
        set({ applyStatus: 'idle', lastResult: result });
      }
      return result;
    });
  },
}));

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
 * Structural equality of two `Domain[]` drafts by `(hostname, alwaysOn)` in
 * order. Used by `stageAlwaysOnToggle`'s clean-revert: when the post-toggle
 * draft matches `committed.domains`, `staged` is cleared to `null` so a
 * net-no-op toggle fires no redundant admin prompt. Reference identity is NOT
 * checked — a freshly-spread draft that is value-equal to committed is the
 * whole point (the toggle produced a new ref but the same value).
 */
function draftEqualsCommitted(a: Domain[], b: Domain[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hostname !== b[i].hostname) return false;
    if (a[i].alwaysOn !== b[i].alwaysOn) return false;
  }
  return true;
}
