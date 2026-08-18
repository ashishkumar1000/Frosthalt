/**
 * Panic — the password-gated "clear all blocks" flow (Story 3-4).
 *
 * The Danger Zone's most destructive action: clears ALL blocked hosts in one
 * shot. Lives alongside ChangePassword in the Danger Zone (only when a
 * password is set — parent Settings branches on `hasPassword`). Self-contained:
 * owns its `confirmOpen`, `clearing`, `error`, and `toast` UI state, and a
 * single 8-second auto-dismiss timer for the success toast.
 *
 * Gate-first flow (mirrors 3-3's ChangePassword): the trigger is an OUTLINED
 * destructive button (border + text in `tokens.destructive`, never filled —
 * so it can never be the window default + pulse). `onPress` calls
 * `requirePassword(() => setConfirmOpen(true))` — the UI state flip the gate
 * runs on verify. The action is NEVER a re-entrant `requirePassword` call
 * (the spec's Always clause, avoids the deferred E1/B3 double-open per
 * deferred-work.md L203-206): the gate verifies once, closes, the flip runs,
 * and the inline confirm opens.
 *
 * Confirm -> Clear: `handleClear` stages empty via `setState({ staged: [] })`
 * and calls the existing `apply()` (store.ts:335-380). The apply pipeline
 * already handles `effectiveHostsLines([])` -> markers-only `writeHosts([])`
 * (one admin prompt, one serialization queue entry — the spec's Reuse
 * constraint: zero new store actions, zero new port ops). `clearing` flips on
 * for the duration to disable the Confirm button (a double-tap is a no-op).
 *
 * Outcomes (the spec's matrix):
 *  - `result.ok === true`: dismiss the confirm, raise the success toast with
 *    "All blocks cleared." + a "Re-enable your blocklist" Pressable link.
 *    The toast auto-dismisses after TOAST_AUTO_DISMISS_MS (8s, per the
 *    proposed Ask-First choice) but the link is always tappable in that
 *    window — clicking it navigates to Blocklist via the
 *    `onNavigateBlocklist` prop the parent Settings threads down from Shell.
 *  - `result.ok === false` (writeConfig OR writeHosts admin-deny): keep the
 *    confirm open, surface the standard copy "Couldn't update /etc/hosts. No
 *    changes made." and leave `staged: []` in place (mirrors
 *    `ChangePassword.tsx:308-315`'s `SAVE_FAILED_MSG` handling). The user
 *    can retry.
 *  - `.catch` safety net (the port contract is never-throw, but a UI must
 *    never leave `clearing=true` stuck on an unforeseen rejection): flip
 *    `clearing` off + show the same error copy.
 *
 * Ports & adapters, one-way: reads `requirePassword` + `apply` from the
 * Zustand store and calls them only — no ports, no `child_process`/`fs`/`os`.
 *
 * VoiceOver: the trigger carries a label with the consequence ("Clear all
 * blocked hosts — requires password"); the confirm prompt text carries
 * `accessibilityRole="alert"` (mirrors ChangePassword's error rows); the
 * toast is a plain grouped region.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useDomainStore } from '../domain/store';
import type { WriteResult } from '../hosts/shellRunner';
import { tokens } from '../theme/tokens';

/** Trigger button label (also the visible text). */
const TRIGGER_LABEL = 'Clear all blocked hosts';
/** VoiceOver label for the trigger — leads with the action + consequence. */
const TRIGGER_A11Y_LABEL = 'Clear all blocked hosts — requires password';
/** Destructive confirm prompt text (announced as `alert`). */
const CONFIRM_PROMPT = 'Clear all blocks? This cannot be undone.';
const CONFIRM_LABEL = 'Clear all blocks';
const CANCEL_LABEL = 'Cancel';
/** Standard apply-failure copy (mirrors `ChangePassword`'s `SAVE_FAILED_MSG`). */
const CLEAR_FAILED_MSG = "Couldn't update /etc/hosts. No changes made.";
/** Success toast headline. */
const CLEARED_TOAST_MSG = 'All blocks cleared.';
/** Success toast link label (also the a11y label). */
const REENABLE_LINK_LABEL = 'Re-enable your blocklist';
/** Re-enable link destination surface name (used for the toast a11y hint). */
const REENABLE_LINK_HINT = 'Opens the Blocklist surface';
/** Auto-dismiss timeout for the success toast (per the spec's Ask-First: 8s). */
const TOAST_AUTO_DISMISS_MS = 8000;

export interface PanicProps {
  /**
   * Called when the user taps the "Re-enable your blocklist" toast link.
   * Shell threads this down to Settings -> Panic so the link navigates to
   * Blocklist (surface 0) via the existing `selectRow(0)`. Component-local
   * navigation is not an option here — the surface state lives in Shell.
   */
  onNavigateBlocklist: () => void;
  /** Optional outer-container style (used by Settings to add sibling spacing). */
  style?: StyleProp<ViewStyle>;
}

export function Panic({
  onNavigateBlocklist,
  style,
}: PanicProps): React.ReactElement {
  // The trigger calls `requirePassword` lazily through `getState` (the proven
  // 3-3 pattern at ChangePassword.tsx:121 — `useDomainStore.getState()` inside
  // the handler keeps the closure stale-free and is exactly what 3-3 does).
  // We don't subscribe to `requirePassword` from the store — pressing the
  // trigger is an event, not a render — so no `useDomainStore` selector is
  // needed here.

  // `confirmOpen` is the UI state flip the gate runs on verify. Component-
  // local — NOT persisted to `config.json`/`Config`/`types.ts` (the spec's
  // Never clause).
  const [confirmOpen, setConfirmOpen] = useState(false);
  // `clearing` is true between Confirm-tap and apply settlement. Disables the
  // Confirm button for double-press protection (the spec's matrix: "Confirm,
  // double-press -> second tap is a no-op").
  const [clearing, setClearing] = useState(false);
  // Apply-failure copy. `null` when no error is present. `setError(...)` is
  // also called when re-opening the confirm after a failure (the stale error
  // is cleared).
  const [error, setError] = useState<string | null>(null);
  // Success-toast visibility. `true` after a successful Apply; auto-dismisses
  // after `TOAST_AUTO_DISMISS_MS`. Tapping the "Re-enable" link also dismisses
  // it (and navigates).
  const [toastVisible, setToastVisible] = useState(false);

  // `useRef` for the auto-dismiss timer so a re-render doesn't restart it.
  // The timer is cleared on unmount + on every toast re-show.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // P2 review patch — stale-resolve guard for `handleClear`'s apply
  // promise. If the user cancels the confirm BEFORE the apply promise
  // resolves, the original `.then` would still flip `confirmOpen` closed
  // and raise a stale toast. Capture a monotonic token at start of every
  // confirm flow; in the resolve handlers, only act when the latest
  // token is still ours. `useRef<number>` so consecutive triggers don't
  // accumulate, just stamp a new value.
  const confirmTokenRef = useRef<number>(0);
  const bumpConfirmToken = (): number => {
    confirmTokenRef.current = confirmTokenRef.current + 1;
    return confirmTokenRef.current;
  };

  // Gate-first trigger handler. The gated action is a UI state flip
  // (`() => setConfirmOpen(true)`), NEVER a re-entrant `requirePassword`
  // call (the spec's Always clause).
  //
  // P15: double-tap guard. A second tap while the gate is mid-verification
  // would call `requirePassword` again, which would overwrite the stashed
  // `gateAction` with a fresh `() => setConfirmOpen(true)` — same target
  // here so the bug would be invisible, but a guard costs nothing and
  // pins the invariant. Early-return.
  //
  // P14: only hide the toast when `requirePassword` actually runs (i.e.
  // when the action flips `confirmOpen`). Tapping the trigger while a
  // success toast is up should keep the toast visible until the user
  // explicitly clears it — the gate verify happens on its own schedule;
  // a benign re-open hides a still-useful toast. So the toast-hide is
  // moved INTO the `requirePassword` callback (which only fires on the
  // gate-open path; the no-password short-circuit calls `action()`
  // synchronously, but in that case `confirmOpen` is already false after
  // the action runs, so the toast stays visible until either the
  // re-render clears it or the next user action does).
  const onPressTrigger = () => {
    if (useDomainStore.getState().gateOpen) {
      return;
    }
    setError(null);
    // P3: defensive requirePassword guard. In production the store
    // always installs `requirePassword`, but the action is the seam we
    // call into — `undefined` is a cheap check that costs nothing and
    // protects against a future test harness that forgets to install it.
    const req = useDomainStore.getState().requirePassword;
    if (typeof req !== 'function') {
      setError(CLEAR_FAILED_MSG);
      return;
    }
    req(() => {
      // From here the flip runs (either immediately on the no-password
      // short-circuit or after a successful gate verify). Hide the toast
      // here, not at the top of `onPressTrigger`, per P14.
      setToastVisible(false);
      if (toastTimerRef.current != null) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      setConfirmOpen(true);
    });
  };

  // Cancel closes the confirm prompt with no apply. Clears the error so a
  // re-open from the trigger does not show a stale "Couldn't update" line —
  // mirrors ChangePassword.tsx:184-191 (`onCancel` clears `status` + the
  // fields). Does NOT touch `staged` — that lives in the store, untouched by
  // cancel.
  //
  // P2: also bump the confirm token so a late-resolving apply promise
  // becomes a no-op. Per the spec's "Cancel button always available", a
  // Cancel tap while `clearing` is true is allowed — the late-resolve
  // guard prevents the resulting stale toast / flip.
  const onCancel = () => {
    bumpConfirmToken();
    setConfirmOpen(false);
    setError(null);
    setClearing(false);
  };

  // The clear handler. Stages empty + calls `apply()`. The apply pipeline
  // already writes `domains: staged` -> `effectiveHostsLines([])` ->
  // `writeHosts([])` -> markers-only managed section (apply.ts:79-85).
  // Routing through `apply()` keeps all writes in the shared `enqueue` queue
  // (the spec's Always: "The `apply()` call already goes through it; do not
  // bypass.").
  const handleClear = () => {
    if (clearing) {
      // Double-press protection — a Confirm tap while `clearing` is true is
      // a no-op (the spec's matrix). The button is also `disabled` while
      // `clearing`, so this branch is defensive — a native tap that lands
      // before the disabled prop applies will hit it.
      return;
    }
    setClearing(true);
    setError(null);
    // Bump the token so a Cancel tap can invalidate THIS confirm flow's
    // late-resolving .then / .catch. P2 review patch.
    const myToken = bumpConfirmToken();
    // `setState` is captured on the live store instance; the next `apply()`
    // reads it via `get().staged` at enqueue time. EMPTY staged array (NOT
    // `null`) — `null` would short-circuit Apply at call time
    // (store.ts:344-346); we want a real run that commits + writes.
    useDomainStore.setState({ staged: [] });
    useDomainStore
      .getState()
      .apply()
      .then((result: WriteResult) => {
        // Stale-resolve guard (P2): if Cancel ran (or another Confirm
        // flow started), the token no longer matches — drop the late
        // resolution. Touching state here would re-flip the toast
        // (visible after close) or re-open the confirm we already closed.
        if (confirmTokenRef.current !== myToken) {
          return;
        }
        setClearing(false);
        // P5: treat mixed-shape `WriteResult` (the codebase's envelope
        // is `{ ok: bool, error?: string }`) as success only when
        // `ok === true && !error`. A non-empty error with `ok: true`
        // is not a success — surface the standard copy so the user can
        // decide what to do, never declare victory on a write that
        // returned a message.
        if (result?.ok === true && !result?.error) {
          // Success: dismiss the confirm, raise the toast. The toast is a
          // grouped region with the headline + a tappable link; clicking the
          // link calls `onNavigateBlocklist` (from Shell) and clears the
          // toast. Auto-dismisses after TOAST_AUTO_DISMISS_MS.
          setConfirmOpen(false);
          setToastVisible(true);
          if (toastTimerRef.current != null) {
            clearTimeout(toastTimerRef.current);
          }
          toastTimerRef.current = setTimeout(() => {
            setToastVisible(false);
            toastTimerRef.current = null;
          }, TOAST_AUTO_DISMISS_MS);
        } else {
          // Failure (writeConfig error OR writeHosts admin-deny, OR
          // mixed-shape `{ok:true, error:'...'}`): keep the confirm
          // open + surface the standard error copy. `staged: []` is
          // retained by the apply pipeline's failure branch
          // (store.ts:372-377), so the user can retry.
          setError(CLEAR_FAILED_MSG);
        }
      })
      .catch(() => {
        // P2: stale-resolve guard for the catch safety net too.
        if (confirmTokenRef.current !== myToken) {
          return;
        }
        // `.catch` safety net — the port contract never throws, but a UI
        // must never leave `clearing=true` stuck on an unforeseen
        // rejection. Flip `clearing` off + show the same error copy.
        setClearing(false);
        setError(CLEAR_FAILED_MSG);
      });
  };

  // The toast link tap: dismiss the toast (also clears the timer so a
  // late-firing auto-dismiss doesn't run after navigation) + call the
  // navigation prop the parent Settings threaded down from Shell.
  //
  // P4 review patch: wrap the navigation in try/catch. The Shell-level
  // handler is the one piece of code we don't own — a future caller
  // could throw, and we must not surface a toast failure for a navigation
  // that has already visually worked. The user already saw the success
  // toast headline; the link is best-effort. On error, hide the toast (so
  // it does not linger past a failed nav) and swallow.
  const onReenablePress = () => {
    if (toastTimerRef.current != null) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastVisible(false);
    try {
      onNavigateBlocklist();
    } catch {
      // Navigation is best-effort; success was already shown. Hide the
      // toast so it does not linger past a failed navigation attempt.
      setToastVisible(false);
    }
  };

  // Closed state: render the destructive trigger (+ the success toast when
  // visible). The trigger is an OUTLINED destructive button (border + text in
  // `tokens.destructive`), never a filled primary — so it is never the window
  // default (never pulses), per the spec's Never clause.
  if (!confirmOpen) {
    return (
      <View style={[styles.container, style]}>
        <Pressable
          onPress={onPressTrigger}
          accessibilityRole="button"
          accessibilityLabel={TRIGGER_A11Y_LABEL}
          style={({ pressed }) => [
            styles.trigger,
            { borderColor: tokens.destructive },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.triggerLabel, { color: tokens.destructive }]}>
            {TRIGGER_LABEL}
          </Text>
        </Pressable>
        {toastVisible ? (
          // P12 review patch — toast is an accessibility live region
          // (polite) so VoiceOver announces the success headline on
          // appear. The trigger is gated by a manual press; the toast
          // appears after the user already tapped Confirm, so a polite
          // announce (vs an `alert` interrupt) matches user intent
          // without interrupting their next move.
          <View
            style={styles.toast}
            accessibilityLabel="Panic cleared toast"
            accessibilityLiveRegion="polite"
          >
            <Text style={styles.toastText}>{CLEARED_TOAST_MSG}</Text>
            <Pressable
              onPress={onReenablePress}
              accessibilityRole="link"
              accessibilityLabel={REENABLE_LINK_LABEL}
              accessibilityHint={REENABLE_LINK_HINT}
              style={({ pressed }) => [
                styles.toastLink,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.toastLinkLabel}>{REENABLE_LINK_LABEL}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  // Open state: render the inline destructive confirm prompt under the
  // trigger (the trigger is hidden while the confirm is open — mirrors
  // ChangePassword's closed-vs-open branches at L198-222 / L224-345). The
  // confirm is a `View` group; the destructive copy is a plain Text (no
  // `accessibilityRole="alert"` — P13 review patch, see below); Cancel
  // + Confirm sit below.
  return (
    <View style={[styles.container, style]}>
      <View style={styles.confirmGroup}>
        {/* P13 review patch: drop `accessibilityRole="alert"` from the
            prompt text. The destructive prompt is rendered after the
            user just tapped the trigger, so re-announcing as an alert
            is noise — the trigger's own label already led with the
            consequence. The error copy below keeps the `alert` role:
            an unexpected failure deserves to interrupt; the expected
            open does not. */}
        <Text style={styles.confirmPrompt}>{CONFIRM_PROMPT}</Text>
        {/* P7 review patch — warn the user when clearing will also
            discard a pending Blocklist staged edit. The store's
            `staged` is the active draft; if non-null/non-empty,
            `setState({ staged: [] })` in `handleClear` will silently
            clobber it. Show an inline note when that is the case so
            the user is not surprised. Computed at render time from a
            `getState()` read (no selector subscription needed — the
            staged array does not move while the confirm is open). */}
        {(() => {
          const staged = useDomainStore.getState().staged;
          const count = Array.isArray(staged) ? staged.length : 0;
          if (count === 0) {
            return null;
          }
          return (
            <Text style={styles.stagedNote}>
              Note: you have {count} pending blocklist{' '}
              {count === 1 ? 'change' : 'changes'} that will also be
              discarded.
            </Text>
          );
        })()}
        <View style={styles.actions}>
          <Pressable
            onPress={handleClear}
            disabled={clearing}
            accessibilityRole="button"
            accessibilityLabel={CONFIRM_LABEL}
            accessibilityState={{ disabled: clearing, busy: clearing }}
            style={({ pressed }) => [
              styles.confirm,
              { borderColor: tokens.destructive },
              pressed && styles.pressed,
              clearing && styles.disabled,
            ]}
          >
            <Text style={[styles.confirmLabel, { color: tokens.destructive }]}>
              {clearing ? 'Clearing…' : CONFIRM_LABEL}
            </Text>
          </Pressable>
          {/* P1 review patch — Cancel stays ENABLED even while
              clearing is true. The spec's frozen block says "Cancel
              button always available." Disabling Cancel while clearing
              hides the user's escape from a slow admin prompt; if the
              user genuinely wants to abandon mid-flight, they're
              allowed to. The P2 stale-resolve guard in `handleClear`
              keeps the resulting race safe (no stale toast, no
              stale-flip). */}
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={CANCEL_LABEL}
            style={({ pressed }) => [
              styles.cancel,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.cancelLabel}>{CANCEL_LABEL}</Text>
          </Pressable>
        </View>
        {error != null ? (
          // Apply-failure copy. `accessibilityRole="alert"` so VoiceOver
          // announces it on appear; mirrors `ChangePassword.tsx:308-315`
          // (its `SAVE_FAILED_MSG` rendering). Confirm stays open + user
          // can retry without re-staging (the store retains `staged: []`
          // across Apply failures — store.ts:372-377).
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    gap: tokens.spacing.md,
  },
  // The destructive trigger: an OUTLINED button (border + text in
  // `tokens.destructive`), never a filled primary. A plain Pressable does not
  // bind to the native default-button, so it never pulses — per the spec's
  // Never ("No destructive button is ever the window default"). Mirrors
  // `ChangePassword.tsx:399-408`.
  trigger: {
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    alignSelf: 'flex-start',
  },
  triggerLabel: {
    ...tokens.typography.body,
  },
  // The confirm-prompt group: prompt text + Cancel/Confirm pair + error copy.
  confirmGroup: {
    flexDirection: 'column',
    gap: tokens.spacing.sm,
  },
  confirmPrompt: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
  },
  // The Confirm button is ALSO outlined (border + text in `tokens.destructive`,
  // no fill) — never a primary, never the window default. The Cancel sibling
  // is a plain primary-colored label button (no destructive color).
  confirm: {
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  confirmLabel: {
    ...tokens.typography.body,
  },
  cancel: {
    borderRadius: tokens.rounded.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  cancelLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  // P7 review patch — the "you have N pending changes that will also be
  // discarded" note below the confirm prompt. Body typography in the
  // destructive colour so the warning reads at the same weight as the
  // prompt itself. (No animation / no border — a plain Text line, so it
  // does not compete with the existing prompt copy visually.)
  stagedNote: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
  // Apply-failure copy (mirrors `ChangePassword.tsx:386-388`'s error style).
  error: {
    ...tokens.typography.body,
    color: tokens.destructive,
  },
  // The success toast: a compact grouped View with the headline + the
  // tappable link. Component-local (no Shell-level toast infra for v1 per
  // the spec's Code Map note).
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.rounded.md,
    borderWidth: 1,
    borderColor: tokens.primary,
  },
  toastText: {
    ...tokens.typography.body,
  },
  toastLink: {
    paddingHorizontal: tokens.spacing.xs,
    paddingVertical: tokens.spacing.xs,
  },
  toastLinkLabel: {
    ...tokens.typography.body,
    color: tokens.primary,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.4,
  },
});
