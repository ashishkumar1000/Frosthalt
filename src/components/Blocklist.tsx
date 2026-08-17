/**
 * Blocklist — the permanent blocklist surface (surface 0, Story 2.1).
 *
 * Renders the committed (or staged-draft) domains as `DomainRow`s with an
 * always-on checkbox each, plus the staged-then-Apply controls (Apply +
 * Cancel-staged) and the empty-state copy. Reads `useDomainStore` and calls
 * ONLY `stageAlwaysOnToggle` / `apply` / `cancelStaged` — no ports, no
 * `child_process`/`fs`/`os` (ports & adapters, one-way:
 * `UI -> domain (Zustand) -> adapters -> ports`).
 *
 * Optimistic toggle: rows render `staged ?? committed.domains` so a pending
 * toggle shows immediately; Apply commits config + hosts (the existing 1.6
 * serialized pipeline — no new privileged code here); Cancel discards the
 * staged draft back to last-committed. `effectiveBlocklist` already honours
 * `alwaysOn` (1.6), so toggle -> Apply -> `/etc/hosts` works end-to-end with
 * no new privileged code.
 *
 * Apply is disabled when `running || staged == null` (no redundant admin
 * prompt for a clean config — `stageAlwaysOnToggle`'s clean-revert keeps
 * `staged` null on a net-no-op toggle). Cancel is only shown when there is a
 * staged draft to discard.
 *
 * On mount, VoiceOver announces "Blocklist, N domains, M always-on" so the
 * surface's state is spoken on entry (the Shell's own "Blocklist, 0 domains"
 * announce stays hardcoded per the spec's Never clause — Story 2.5 owns the
 * Shell-side count).
 */

import React, { useEffect } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { useDomainStore } from '../domain/store';
import { tokens } from '../theme/tokens';
import { AddDomain } from './AddDomain';
import { ApplyButton } from './ApplyButton';
import { DomainRow } from './DomainRow';

/**
 * Empty-state copy. Story 2.2 adds the always-visible AddDomain field ABOVE
 * this copy (the field is reachable in both the empty and populated states),
 * so the copy now reads as a hint alongside the field rather than a standalone
 * placeholder.
 */
const EMPTY_STATE_TEXT = 'No domains yet. Add one to start blocking.';

export interface BlocklistProps {
  /**
   * A ref to the AddDomain field's `TextInput`, owned by the Shell so ⌘N can
   * focus it (`addFieldRef.current?.focus()`). Optional so tests / direct
   * renders can mount `<Blocklist/>` without one.
   */
  addFieldRef?: React.RefObject<TextInputType | null>;
}

export function Blocklist({ addFieldRef }: BlocklistProps): React.ReactElement {
  const committed = useDomainStore((s) => s.committed);
  const staged = useDomainStore((s) => s.staged);
  const applyStatus = useDomainStore((s) => s.applyStatus);
  const stageAlwaysOnToggle = useDomainStore((s) => s.stageAlwaysOnToggle);
  const apply = useDomainStore((s) => s.apply);
  const cancelStaged = useDomainStore((s) => s.cancelStaged);

  // The rendered list is the optimistic draft when one exists, else the
  // committed domains. Toggle -> stageAlwaysOnToggle -> re-render with the
  // flipped value immediately; Apply commits; Cancel reverts.
  const domains = staged ?? committed.domains;
  const running = applyStatus === 'running';
  const hasStaged = staged != null;
  const isEmpty = committed.domains.length === 0 && staged == null;

  // Mount announce: "Blocklist, N domains, M always-on". N is the rendered
  // list length (staged or committed), M is the always-on count from the same
  // list — what the user sees. Runs once on mount; later changes are spoken
  // by the toggle/Apply interactions themselves (this is the entry announce,
  // not a live counter — Story 2.5 owns the header count).
  useEffect(() => {
    const alwaysOnCount = domains.filter((d) => d.alwaysOn).length;
    AccessibilityInfo.announceForAccessibility(
      `Blocklist, ${domains.length} domains, ${alwaysOnCount} always-on`,
    );
    // Mount-only — we want the entry announce, not a re-announce on every
    // toggle. The toggle's own optimistic re-render already conveys the new
    // state to VoiceOver via the checkbox's `accessibilityState`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Blocklist</Text>
      {/* The add field is always visible — above the rows AND in the empty
          state, so it is reachable regardless of whether domains exist yet.
          ⌘N (Shell) focuses the field via the forwarded ref. */}
      <AddDomain ref={addFieldRef} />
      {isEmpty ? (
        <Text style={styles.body}>{EMPTY_STATE_TEXT}</Text>
      ) : (
        <>
          <View style={styles.list}>
            {domains.map((d) => (
              <DomainRow
                key={d.hostname}
                domain={d}
                onToggleAlwaysOn={stageAlwaysOnToggle}
                disabled={running}
              />
            ))}
          </View>
          <View style={styles.controls}>
            <ApplyButton
              label="Apply"
              onPress={() => {
                void apply();
              }}
              disabled={running || !hasStaged}
            />
            {hasStaged ? (
              <PressableGhost
                label="Cancel"
                onPress={cancelStaged}
                disabled={running}
              />
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * A borderless "ghost" button for the Cancel-staged action. Subdued text,
 * no fill — visually secondary to the primary-filled ApplyButton. Inline here
 * because Story 2.1 is its only consumer; if a later story needs a ghost
 * button it can extract this into a primitive at that point.
 */
function PressableGhost({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      focusable
      enableFocusRing
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.ghost,
        pressed && styles.ghostPressed,
        disabled && styles.ghostDisabled,
      ]}
    >
      <Text style={styles.ghostLabel}>{label}</Text>
    </Pressable>
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
  list: {
    flex: 1,
    flexDirection: 'column',
    gap: tokens.spacing.xs,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginTop: tokens.spacing.md,
  },
  ghost: {
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
  },
  ghostPressed: {
    opacity: 0.85,
  },
  ghostLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  ghostDisabled: {
    opacity: 0.4,
  },
});