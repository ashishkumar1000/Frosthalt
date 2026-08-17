/**
 * The Apply pipeline — the sole path that touches BOTH ports (Story 1.6).
 *
 * Strict order, one atomic run at a time (the queue is the store's, not here):
 *
 *   1. commit staged -> `config.json`            (ConfigStore.writeConfig)
 *   2. compute the effective hosts lines          (effectiveHostsLines =
 *      effectiveBlocklist(config).flatMap(toHostsLines) — apex + `www.` on
 *      `0.0.0.0` + `::`, in effective-blocklist order)
 *   3. rewrite the managed `/etc/hosts` section  (ShellRunner.writeHosts)
 *
 * Because `config.json` is written BEFORE `/etc/hosts` (the strict order), a
 * denied admin prompt leaves `config.json` ahead of `/etc/hosts`. That drift is
 * accepted (config = intent, hosts = derived enforcement) and reconciled only
 * by 1.7's user-initiated Restore — never automatically. Reordering is Ask
 * First.
 *
 * `runApply` does NOT mutate store state — it takes a snapshot
 * `{committed, staged}` and returns the `{ok, error?}` envelope. The store
 * decides how to transition state (commit + clear staged on success; retain
 * staged on denial / config-write failure). It calls only the two ports
 * (AD-3/AD-5) and never imports `child_process`/`fs`/`os` (AD-1).
 */

import type { Config, Domain } from '../config/types';
import { writeConfig } from '../config/configStore';
import { writeHosts } from '../hosts/shellRunner';
import { effectiveHostsLines } from './effectiveBlocklist';
import type { WriteResult } from '../hosts/shellRunner';

/** The snapshot the store hands to `runApply`. */
export interface ApplyInput {
  /** The last-committed config (before this Apply). */
  committed: Config;
  /**
   * The staged domain slice to commit, or `null` when nothing is staged. A
   * `null` staged slice short-circuits to `{ ok: true }` without touching
   * either port — Apply is a no-op when there is nothing to commit.
   */
  staged: Domain[] | null;
}

/**
 * Run one Apply pipeline. Always resolves (never rejects) — errors ride inside
 * the `{ ok, error? }` envelope, consistent with the ports' never-throw
 * contract.
 *
 * - `staged == null` -> `{ ok: true }` (no-op; neither port called).
 * - `writeConfig` fails -> `{ ok: false, error: "config-write:<detail>" }`;
 *   `writeHosts` is NOT called.
 * - `writeHosts` envelope -> returned verbatim (e.g. `admin-denied`).
 */
export async function runApply({
  committed,
  staged,
}: ApplyInput): Promise<WriteResult> {
  if (staged == null) {
    // Nothing staged -> no-op; neither port is called (no admin prompt).
    return { ok: true };
  }

  // 1. Commit staged -> config.json.
  const nextConfig: Config = { ...committed, domains: staged };
  const cfg = writeConfig(nextConfig);
  if (!cfg.ok) {
    // Strict order: a failed config write short-circuits before any elevation.
    // Staged is retained by the store for retry (writeHosts never ran).
    return { ok: false, error: `config-write:${cfg.error ?? 'unknown'}` };
  }

  // 2. Compute the effective hosts lines from the just-committed config:
  //    the effective blocklist (alwaysOn domains, normalised + deduped)
  //    expanded via `toHostsLines` (apex + `www.` on `0.0.0.0` + `::`, in
  //    effective-blocklist order). This is the single DRY helper shared
  //    with `computeDrift` and `restoreSection` (Story 1.7) so the three
  //    never drift on how the expected lines are produced.
  const lines = effectiveHostsLines(nextConfig);

  // 3. Rewrite the managed /etc/hosts section (one admin prompt; idempotent
  //    full-section rewrite per the 1.5 contract). An empty `lines` writes the
  //    markers with no domain lines -> unblocks all. `runApply` never rejects:
  //    `writeHosts` is the shellRunner port, which catches any native throw /
  //    rejection and returns a `{ ok, error? }` envelope (1.5's never-reject
  //    contract), so errors ride inside the envelope rather than rejecting here.
  return writeHosts(lines);
}