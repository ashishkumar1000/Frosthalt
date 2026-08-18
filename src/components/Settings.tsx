/**
 * Settings — the Settings surface (surface 3, Story 3.1).
 *
 * A minimal shell mirroring `Blocklist`'s container/title. Branches on
 * `committed.passwordHash`: when unset, render `<SetPassword>` (the set-
 * password form); when set, render a neutral "Password set" status line PLUS
 * the Danger Zone section (Story 3-3) — a visually distinct grouping of
 * sensitive actions whose first occupant is `<ChangePassword>`. The Danger
 * Zone is extensible for 3-4 (Panic) — add `<Panic/>` as a sibling to
 * `<ChangePassword/>`. No abstraction needed yet.
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
import { SetPassword } from './SetPassword';

/** Neutral confirmation shown when a password is already set. */
const PASSWORD_SET_TEXT = 'Password set.';
/** The Danger Zone section header (destructive). */
const DANGER_ZONE_TITLE = 'Danger Zone';

export function Settings(): React.ReactElement {
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
              labelled container is the grouping affordance. Extensible for
              3-4 (Panic) — add `<Panic/>` as a sibling to `<ChangePassword/>`. */}
          <View style={styles.dangerZone} accessibilityLabel="Danger Zone">
            <Text style={styles.sectionHeader} accessibilityRole="header">
              {DANGER_ZONE_TITLE}
            </Text>
            <ChangePassword />
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
});