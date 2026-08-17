/**
 * StatusHeader — the persistent status bar above the content (Story 1.3).
 *
 * Always visible across all four surfaces. Renders the "Free" `StatusBadge`
 * followed by the live effectively-blocked domain count (Story 2.5) and the
 * static "no active timer" placeholder (Epic 4 owns the countdown).
 *
 * The count is the EFFECTIVE blocked count — `effectiveBlocklist(committed).
 * length` — only the always-on domains actually enforced in `/etc/hosts` right
 * now (Story 2.3's pure helper filters `alwaysOn`, `effectiveBlocklist.ts`).
 * `committed` updates only on Apply success (`store.ts`), so the count
 * reflects what is enforced; staged edits do not move it until Applied.
 *
 * The count numeral uses `fontVariant: ['tabular-nums']` (the proven
 * `tokens.typography.countdown` pattern, `tokens.ts:120`) so digit width is
 * fixed and the header does not jitter as the count changes (9 -> 10).
 *
 * VoiceOver on-change announce: a `useEffect` keyed on `count` calls
 * `AccessibilityInfo.announceForAccessibility` when the count changes, SKIPPING
 * the initial mount via a `useRef(true)` first-run guard. The app launches on
 * surface 0 = Blocklist, whose mount-announce (`Blocklist.tsx`) already speaks
 * the list on entry; a second announce on launch would double up. The count
 * changes only when `committed` changes (Apply success), so the announce fires
 * after an Apply commits.
 *
 * The badge stays `free` in Epic 2 (no timer/schedule sessions yet — Epic 4
 * wires it); the count carries the blocking info. "no active timer" is
 * untouched (Epic 4).
 */

import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { tokens } from '../theme/tokens';
import { StatusBadge } from './StatusBadge';
import { useDomainStore } from '../domain/store';
import { effectiveBlocklist } from '../domain/effectiveBlocklist';

export interface StatusHeaderProps {
  /**
   * Called when the user clicks the "View hosts" link — opens the read-only
   * hosts viewer overlay (Story 2.6). The Shell owns the `viewerOpen` state.
   */
  onViewHosts: () => void;
}

export function StatusHeader({ onViewHosts }: StatusHeaderProps): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  const count = effectiveBlocklist(committed).length;
  const countLabel = `${count} ${count === 1 ? 'domain' : 'domains'}`;

  // On-change VoiceOver announce (skip the initial mount). The app launches on
  // surface 0 = Blocklist, whose mount-announce (`Blocklist.tsx`) already
  // speaks the list on entry; a second announce on launch would double up. The
  // count changes only when `committed` changes (Apply success), so this fires
  // after an Apply commits. The `useRef(true)` first-run guard skips the
  // initial mount; every subsequent count change announces.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    AccessibilityInfo.announceForAccessibility(
      `${count} ${count === 1 ? 'domain' : 'domains'} blocked`,
    );
  }, [count]);

  return (
    <View style={styles.container}>
      <StatusBadge status="free" />
      <Text style={styles.separator}>·</Text>
      <Text style={styles.count}>{countLabel}</Text>
      <Text style={styles.separator}>·</Text>
      <Text style={styles.text}>no active timer</Text>
      <Text style={styles.separator}>·</Text>
      <Pressable
        onPress={onViewHosts}
        accessibilityRole="button"
        accessibilityLabel="View hosts"
      >
        <Text style={styles.link}>View hosts</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    // DESIGN.md: compact bar pinned above the content area. Pad with the
    // 8pt-grid spacing scale; a single `md` (16px) horizontal pad keeps the
    // header aligned with the content column.
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    gap: tokens.spacing.sm,
  },
  text: {
    ...tokens.typography.label,
  },
  count: {
    ...tokens.typography.label,
    // Tabular figures so the digit width is fixed and the header does not
    // jitter as the count changes (9 -> 10). Reuses the proven
    // `tokens.typography.countdown` pattern (`tokens.ts:120`).
    fontVariant: ['tabular-nums'],
  },
  separator: {
    ...tokens.typography.label,
  },
  link: {
    ...tokens.typography.label,
    color: tokens.primary,
  },
});