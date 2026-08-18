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

/**
 * Index of the Blocklist surface in `SURFACE_NAMES`. Exported as a named
 * constant so callers that need to navigate to Blocklist (Panic's success
 * toast "Re-enable" link, threaded through Settings) don't depend on the
 * literal `0` — fragile to reordering of `SURFACE_NAMES`.
 */
export const BLOCKLIST_SURFACE_INDEX: SurfaceIndex = 0;

/** Per-surface empty-state copy. Presentational only — no domain state yet. */
const EMPTY_STATE_TEXT: Record<SurfaceIndex, string> = {
  0: 'No domains yet. Add one to start blocking.',
  1: 'No timer running. Start one to block on a countdown.',
  2: 'No schedule set. Create one to block on a recurring window.',
  // Surface 3 (Settings) is a real screen as of Story 3.1 — the placeholder
  // copy is intentionally absent here so the placeholder is never rendered
  // for it (the Shell routes surface 3 to <Settings/>). The registry
  // (`SURFACE_NAMES`) stays intact so the sidebar label + VoiceOver announce
  // are unchanged.
  3: '',
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