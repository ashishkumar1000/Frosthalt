/**
 * Surface placeholders for the shell (Story 1.3).
 *
 * Each of the four sidebar surfaces (Blocklist / Timer / Schedule / Settings)
 * renders a presentational placeholder here — title via `tokens.typography.title`
 * + an empty-state body via `tokens.typography.body`. No real surface logic
 * lives in this story (real surfaces are Epics 2-5). The shell picks the
 * active placeholder from the selected surface index.
 *
 * `SURFACE_NAMES` is the single source of truth for the surface display names
 * used by the sidebar row labels, the VoiceOver announcement, and the
 * placeholder titles, so the three can never drift.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { tokens } from '../theme/tokens';

/**
 * The four sidebar surfaces, in the fixed sidebar order. Index 0 = Blocklist
 * (the default active surface on mount) through 3 = Settings.
 */
export const SURFACE_NAMES = [
  'Blocklist',
  'Timer',
  'Schedule',
  'Settings',
] as const;

export type SurfaceIndex = 0 | 1 | 2 | 3;

/** Per-surface empty-state copy. Presentational only — no domain state yet. */
const EMPTY_STATE_TEXT: Record<SurfaceIndex, string> = {
  0: 'No domains yet. Add one to start blocking.',
  1: 'No timer running. Start one to block on a countdown.',
  2: 'No schedule set. Create one to block on a recurring window.',
  3: 'App settings will appear here.',
};

export interface SurfacePlaceholderProps {
  surface: SurfaceIndex;
}

/**
 * Renders the active surface's placeholder (title + empty-state body). Pure
 * presentational — the shell swaps this in for the selected surface.
 */
export function SurfacePlaceholder({
  surface,
}: SurfacePlaceholderProps): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{SURFACE_NAMES[surface]}</Text>
      <Text style={styles.body}>{EMPTY_STATE_TEXT[surface]}</Text>
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