/**
 * Settings — the Settings surface (surface 3, Story 3.1).
 *
 * A minimal shell mirroring `Blocklist`'s container/title. Branches on
 * `committed.passwordHash`: when unset, render `<SetPassword>` (the set-
 * password form); when set, render a neutral "Password set" state. Change-
 * password, the Danger Zone section, and Panic are Stories 3-3/3-4 — do NOT
 * build them here. The shell is intentionally simple so 3-3 can extend it
 * (Danger Zone section below) without reworking the layout.
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
import { SetPassword } from './SetPassword';

/** Neutral confirmation shown when a password is already set. */
const PASSWORD_SET_TEXT = 'Password set.';

export function Settings(): React.ReactElement {
  const passwordHash = useDomainStore((s) => s.committed.passwordHash);
  const hasPassword = passwordHash != null && passwordHash !== '';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      {hasPassword ? (
        // Neutral "Password set" state. Change-password (Story 3-3) will add
        // the Danger Zone section + change-password form here; for 3.1 this
        // is a single confirmation line.
        <Text style={styles.body}>{PASSWORD_SET_TEXT}</Text>
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
});