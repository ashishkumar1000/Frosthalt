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
import type { WriteResult } from '../hosts/shellRunner';

export type ApplyStatus = 'idle' | 'running';

export interface DomainState {
  committed: Config;
  staged: Domain[] | null;
  applyStatus: ApplyStatus;
  lastResult: WriteResult | null;
  stageDomainAdd: (raw: string) => WriteResult;
  cancelStaged: () => void;
  apply: () => Promise<WriteResult>;
}

export const useDomainStore = create<DomainState>()((set, get) => ({
  committed: readConfig(),
  staged: null,
  applyStatus: 'idle',
  lastResult: null,

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