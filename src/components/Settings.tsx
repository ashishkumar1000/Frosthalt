/**
 * Settings — the Settings surface (surface 3, Story 3.1).
 *
 * A minimal shell mirroring `Blocklist`'s container/title. Branches on
 * `committed.passwordHash`: when unset, render `<SetPassword>` (the set-
 * password form); when set, render a neutral "Password set" status line PLUS
 * the Danger Zone section (Story 3-3) — a visually distinct grouping of
 * sensitive actions. Story 3-3 mounted `<ChangePassword>` here; Story 3-4
 * added `<Panic>` as a sibling (destructive clear-all affordance, gated by
 * the same password sheet). Each gated child owns its UI state
 * (component-local, NOT persisted); the Danger Zone is the extensible mount
 * point for the next gated action.
 *
 * The Danger Zone's two gated children both need to navigate to other
 * surfaces when their flow succeeds (Panic's success toast navigates to
 * Blocklist via the "Re-enable your blocklist" link). Surface state lives in
 * `Shell`, so Settings threads Shell's `selectRow` callbacks down through
 * typed props — no new store action, no new port op. The Blocklist row is
 * index 0 in `SURFACE_NAMES` (settings.tsx), so `selectBlocklist` is
 * `selectRow(0)`.
 *
 * Ports & adapters, one-way: reads `committed` from the Zustand store only —
 * no ports, no `child_process`/`fs`/`os`. `passwordHash === undefined` is the
 * clean "no password set yet" sentinel (the spec's Design Notes — do not
 * conflate `''` with unset; `DEFAULT_CONFIG` keeps it absent).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useDomainStore } from '../domain/store';
import { tokens } from '../theme/tokens';
import { ChangePassword } from './ChangePassword';
import { Panic } from './Panic';
import { SetPassword } from './SetPassword';

export interface SettingsProps {
  /**
   * Navigate to the Blocklist surface (row 0). Threaded down from Shell's
   * `selectRow(0)` so the Danger Zone's gated actions (Panic's success
   * toast "Re-enable your blocklist" link) can route the user back to
   * Blocklist without duplicating surface state. Component-local UI state
   * lives in the gated children; surface state lives in Shell — Settings is
   * the natural seam.
   */
  onNavigateBlocklist: () => void;
}

/** Neutral confirmation shown when a password is already set. */
const PASSWORD_SET_TEXT = 'Password set.';
/** The Danger Zone section header (destructive). */
const DANGER_ZONE_TITLE = 'Danger Zone';

export function Settings({
  onNavigateBlocklist,
}: SettingsProps): React.ReactElement {
  const passwordHash = useDomainStore((s) => s.committed.passwordHash);
  const hasPassword = passwordHash != null && passwordHash !== '';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      {hasPassword ? (
        <View>
          <Text style={styles.body}>{PASSWORD_SET_TEXT}</Text>
          {/* Danger Zone (Story 3-3) — the sensitive-actions surface. A
              visually distinct section: destructive header (a11y `header`
              role) + a labelled container, separated from the status line by
              `tokens.spacing.lg`. RN 0.81 has no `region`/`group` role, so the
              labelled container is the grouping affordance. Story 3-4 added
              `<Panic/>` as a sibling to `<ChangePassword/>` — the mounting
              point for the next gated action. The sibling `marginTop: md`
              keeps the destructive actions visually separated. */}
          <View style={styles.dangerZone} accessibilityLabel="Danger Zone">
            <Text style={styles.sectionHeader} accessibilityRole="header">
              {DANGER_ZONE_TITLE}
            </Text>
            <ChangePassword />
            <Panic
              onNavigateBlocklist={onNavigateBlocklist}
              style={styles.panicSpacing}
            />
          </View>
        </View>
      ) : (
        <SetPassword />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: tokens.spacing.lg,
  },
  title: {
    ...tokens.typography.title,
    marginBottom: tokens.spacing.sm,
  },
  body: {
    ...tokens.typography.body,
  },
  // The Danger Zone header: title typography tinted destructive so the section
  // reads as a distinct, sensitive region (the spec's Always — header in
  // `tokens.destructive`).
  sectionHeader: {
    ...tokens.typography.title,
    color: tokens.destructive,
    marginBottom: tokens.spacing.sm,
  },
  dangerZone: {
    marginTop: tokens.spacing.lg,
  },
  // Sibling spacing for the Danger Zone's second gated action (Story 3-4).
  // Applied to `<Panic/>` via its `style` prop so Panic itself owns no
  // spacing knowledge — it remains reusable elsewhere.
  panicSpacing: {
    marginTop: tokens.spacing.md,
  },
});