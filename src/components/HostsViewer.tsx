/**
 * HostsViewer — a read-only overlay showing the managed /etc/hosts section
 * verbatim, with a drift warning banner (Story 2.6).
 *
 * Ports & adapters, one-way: the viewer reads ONLY `useDomainStore` — `drift`,
 * `lastReadSection`, `checkDrift`, `restoreSection`, `applyStatus`. It MUST NOT
 * import `shellRunner.ts`/`readHostsSection` (the AD-5 rule: the domain is the
 * sole caller of the hosts ports). The verbatim body comes from
 * `lastReadSection` (the actual on-disk `string[]` between the markers) — NEVER
 * `effectiveHostsLines(committed)` (the intended set, which would always look
 * in-sync and hide drift).
 *
 * Read-only by construction: the body is a `Text` inside a `ScrollView` — no
 * `TextInput`, no edit affordance. "Restore section" is a repair action through
 * a store action, not a content edit.
 *
 * Fresh read on open: the viewer calls `checkDrift()` on mount (the hosts file
 * may have drifted since the last check), populating both `drift` and
 * `lastReadSection`.
 *
 * Drift banner branches on `drift.reason` (`drift.ts`):
 *   - `missing` / `mismatch` -> "Managed section not found…" + a "Restore
 *     section" `ApplyButton` bound to `restoreSection` (busy when
 *     `applyStatus === 'running'`).
 *   - `corrupt` -> the SAME banner headline + corrupt guidance + NO Restore
 *     button (1.7's known gap: `writeHosts` pre-scan refuses malformed markers,
 *     so Restore cannot repair `corrupt`).
 *
 * The viewer is an OVERLAY (Shell-owned `viewerOpen`), not a 5th sidebar
 * surface. Esc closes it (Shell's `KEY_DOWN_EVENTS` + `onKeyDown` branch). It
 * must NOT register as a sidebar surface or touch `SURFACE_NAMES`.
 */

import React, { useEffect } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { tokens } from '../theme/tokens';
import { useDomainStore } from '../domain/store';
import { ApplyButton } from './ApplyButton';

export interface HostsViewerProps {
  /** Called when the user closes the viewer (Esc or the close button). */
  onClose: () => void;
}

// The shared banner headline for any drift reason (missing/mismatch/corrupt).
// The spec's AC names exactly this string for the drift case.
const DRIFT_HEADLINE =
  'Managed section not found — your hosts file may have been edited outside Frosthalt.';

// The `corrupt` guidance — `writeHosts` pre-scan refuses malformed markers, so
// Restore cannot repair a corrupt section. The user must edit /etc/hosts
// manually then reopen (which re-runs checkDrift).
const CORRUPT_GUIDANCE =
  'The managed section is corrupt and can’t be auto-repaired. Edit /etc/hosts manually, then reopen this viewer.';

const TITLE = 'Hosts — managed section';

export function HostsViewer({ onClose }: HostsViewerProps): React.ReactElement {
  const drift = useDomainStore((s) => s.drift);
  const lastReadSection = useDomainStore((s) => s.lastReadSection);
  const checkDrift = useDomainStore((s) => s.checkDrift);
  const restoreSection = useDomainStore((s) => s.restoreSection);
  const applyStatus = useDomainStore((s) => s.applyStatus);

  // Fresh read on open: the hosts file may have drifted since the last check.
  // `checkDrift` is sync (readHostsSection is sync + computeDrift is pure), so
  // the banner + body reflect the current /etc/hosts by the time the first
  // paint commits. Run exactly once on mount.
  useEffect(() => {
    checkDrift();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = applyStatus === 'running';
  const hasDrift = drift?.drift === true;
  const reason = drift?.reason;
  const restoreEnabled = reason === 'missing' || reason === 'mismatch';

  // Empty-state: section absent (null) or empty array. Covers both a missing
  // section (drift.reason='missing') and an empty-but-present one (e.g. empty
  // committed + markers-only section, which is in-sync). The viewer shows the
  // banner above for drift cases; for the in-sync empty case it shows the
  // empty-state line and no banner.
  const bodyLines = lastReadSection ?? [];
  const bodyEmpty = bodyLines.length === 0;

  return (
    <View style={styles.scrim} accessibilityLabel="Hosts viewer overlay">
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>{TITLE}</Text>
          <Pressable
            onPress={onClose}
            disabled={running}
            accessibilityRole="button"
            accessibilityLabel="Close"
            accessibilityState={{ disabled: running }}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.closePressed,
              running && styles.closeDisabled,
            ]}
          >
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        {hasDrift ? (
          <View
            style={[
              styles.banner,
              reason === 'corrupt' ? styles.bannerDestructive : styles.bannerAmber,
            ]}
            accessibilityRole="alert"
            accessibilityLabel="Drift warning"
          >
            <Text style={styles.bannerHeadline}>{DRIFT_HEADLINE}</Text>
            {reason === 'corrupt' ? (
              <Text style={styles.bannerGuidance}>{CORRUPT_GUIDANCE}</Text>
            ) : null}
            {restoreEnabled ? (
              <ApplyButton
                label="Restore section"
                onPress={restoreSection}
                disabled={running}
                busy={running}
              />
            ) : null}
          </View>
        ) : null}

        <ScrollView style={styles.body} focusable>
          {bodyEmpty ? (
            <Text style={styles.emptyState}>
              No managed section present. Add a domain and Apply to create one.
            </Text>
          ) : (
            bodyLines.map((line, i) => (
              <Text key={i} style={styles.line}>
                {line}
              </Text>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // A dim scrim focuses attention on the panel. The viewer is an overlay, so
    // it covers the whole window while open.
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  panel: {
    // The overlay panel. Mono background (tokens.monoBg) so the verbatim body
    // reads as a hosts file in both light and dark appearances.
    backgroundColor: tokens.monoBg,
    borderRadius: tokens.rounded.lg,
    width: '80%',
    maxWidth: 640,
    maxHeight: '80%',
    padding: tokens.spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.md,
  },
  title: {
    ...tokens.typography.title,
    color: tokens.monoFg,
  },
  banner: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    marginBottom: tokens.spacing.md,
  },
  bannerAmber: {
    backgroundColor: tokens.status.amber,
  },
  bannerDestructive: {
    backgroundColor: tokens.destructive,
  },
  bannerHeadline: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
  },
  bannerGuidance: {
    ...tokens.typography.body,
    color: tokens.primaryForeground,
    marginTop: tokens.spacing.xs,
  },
  body: {
    // Mono foreground on the mono background — the verbatim hosts lines read
    // as a hosts file. SF Mono via tokens.typography.mono.
    backgroundColor: tokens.monoBg,
    borderRadius: tokens.rounded.md,
    padding: tokens.spacing.md,
  },
  line: {
    ...tokens.typography.mono,
    color: tokens.monoFg,
  },
  emptyState: {
    ...tokens.typography.body,
    color: tokens.monoFg,
    fontStyle: 'italic',
  },
  closeButton: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    backgroundColor: tokens.monoBg,
  },
  closeText: {
    ...tokens.typography.body,
    color: tokens.monoFg,
  },
  closePressed: {
    opacity: 0.85,
  },
  closeDisabled: {
    opacity: 0.4,
  },
});