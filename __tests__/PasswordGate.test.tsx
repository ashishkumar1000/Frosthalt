/**
 * Story 3.2 — the PasswordGate sheet tests.
 *
 * Renders the gate with `react-test-renderer` against a seeded `useDomainStore`
 * state (the store is a real Zustand store; the two NATIVE specs are mocked so
 * `readConfig()` at module-eval time falls back to DEFAULT_CONFIG — see the
 * store.test.ts:21-35 / SetPassword.test.tsx pattern).
 *
 * Covers the spec's I/O-matrix + Acceptance Criteria:
 *   - Renders the field with `secureTextEntry` + password a11y attrs.
 *   - Show/Hide toggle flips `secureTextEntry` and its VoiceOver label.
 *   - Wrong entry (tries 1-4): field clears + "That didn't match. N tries left."
 *     shows with no plaintext leakage.
 *   - 5th wrong entry: throttle countdown shows + field + submit disabled.
 *   - Correct entry: `onVerified` fires + field clears (the gate closes via
 *     the Shell's runGateAction, simulated here by a jest.fn `onVerified`).
 *   - Cancel (the component's close affordance, equivalent to Esc handled by
 *     the Shell) calls `onClose`.
 *
 * Mocking `verifyPassword`: the same `jest.fn` wrapper via `setState` pattern
 * `SetPassword.test.tsx` uses for `setPassword`. `seedState` always restores
 * the REAL action (captured once at module load) so a mock can never leak.
 *
 * The Esc key itself is handled by the Shell (not the gate component), so the
 * "Esc -> onClose" path is tested here via the Cancel button (the component's
 * close affordance) and via a Shell-level Esc test in `Shell.test.tsx`.
 */

jest.mock('../src/native/specs/NativeConfigStoreSpec', () => ({
  __esModule: true,
  default: {
    readConfig: jest.fn(),
    writeConfig: jest.fn(),
  },
}));

jest.mock('../src/native/specs/NativeShellRunnerSpec', () => ({
  __esModule: true,
  default: {
    writeHosts: jest.fn(),
    readHostsSection: jest.fn(),
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { PasswordGate } from '../src/components/PasswordGate';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import { hashPassword, GATE_MAX_ATTEMPTS } from '../src/config/password';
import type { VerifyResult } from '../src/domain/store';

// The REAL `verifyPassword` + `clearGateThrottle`, captured once at module
// load. `seedState` always restores these so a `jest.fn` wrapper installed by
// a test can never leak.
const REAL_VERIFY = useDomainStore.getState().verifyPassword;
const REAL_CLEAR_THROTTLE = useDomainStore.getState().clearGateThrottle;

/** Walks a react-test-renderer JSON tree concatenating text nodes. */
function extractText(node: unknown): string {
  if (node == null) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('');
  }
  if (typeof node === 'object' && 'children' in node) {
    return extractText((node as { children: unknown }).children);
  }
  return '';
}

/**
 * Find the password field by its `accessibilityLabel` ('Gate password'). Same
 * prop-based query pattern as `SetPassword.test.tsx` (find by props, not
 * `findByType`, because the imported `TextInput` is not identity-equal to the
 * one in the rendered tree under pnpm + RN 0.81).
 */
function findField(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string' &&
      node.props.accessibilityLabel === 'Gate password',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find the submit button by accessibilityLabel 'Verify'. */
function findSubmit(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Verify',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find the Cancel button by accessibilityLabel 'Cancel'. */
function findCancel(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Cancel',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find the Show/Hide toggle by accessibilityLabel 'Show password'/'Hide password'. */
function findToggle(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      (node.props.accessibilityLabel === 'Show password' ||
        node.props.accessibilityLabel === 'Hide password'),
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Locate the tries-left alert by `accessibilityRole: 'alert'` + text match. */
function findTriesLeftAlert(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityRole === 'alert' &&
      extractText(node).includes("didn't match"),
  )[0];
}

/** Locate the throttle alert by `accessibilityRole: 'alert'` + 'Too many attempts'. */
function findThrottleAlert(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityRole === 'alert' &&
      extractText(node).includes('Too many attempts'),
  )[0];
}

/** Seeds the store state and restores the real gate actions. */
function seedState(overrides: {
  passwordHash?: string;
  gateAttempts?: number;
  gateThrottleUntil?: number | null;
}): void {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      passwordHash:
        overrides.passwordHash ?? hashPassword('secret123'),
    },
    staged: null,
    applyStatus: 'idle',
    lastResult: null,
    drift: null,
    lastReadSection: null,
    gateOpen: true,
    gateAction: null,
    gateAttempts: overrides.gateAttempts ?? 0,
    gateThrottleUntil: overrides.gateThrottleUntil ?? null,
    // Always restore the real actions so a previous test's mock can't leak.
    verifyPassword: REAL_VERIFY,
    clearGateThrottle: REAL_CLEAR_THROTTLE,
  });
}

let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
  // Restore the real actions after every test so a mock can never leak into a
  // later suite that shares the module-level store instance.
  useDomainStore.setState({
    verifyPassword: REAL_VERIFY,
    clearGateThrottle: REAL_CLEAR_THROTTLE,
    gateOpen: false,
    gateAction: null,
    gateAttempts: 0,
    gateThrottleUntil: null,
    committed: { ...DEFAULT_CONFIG },
  });
});

function renderGate(
  onVerified = jest.fn(),
  onClose = jest.fn(),
): {
  renderer: ReturnType<typeof ReactTestRenderer.create>;
  onVerified: jest.Mock;
  onClose: jest.Mock;
} {
  let renderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PasswordGate onVerified={onVerified} onClose={onClose} />,
    );
  });
  currentRenderer = renderer;
  return { renderer, onVerified, onClose };
}

/** Type into the field by dispatching `onChangeText`. */
function typeInto(
  field: ReactTestRenderer.ReactTestInstance,
  text: string,
) {
  ReactTestRenderer.act(() => {
    field.props.onChangeText(text);
  });
}

/** Press the submit button. */
function pressSubmit(
  root: ReactTestRenderer.ReactTestInstance,
) {
  ReactTestRenderer.act(() => {
    findSubmit(root).props.onPress();
  });
}

// ---------------------------------------------------------------------------
// Renders one secure field with the right a11y attrs
// ---------------------------------------------------------------------------

test('renders one secureTextEntry field with password a11y attrs + Verify + Cancel', () => {
  seedState({});
  const { renderer } = renderGate();
  const field = findField(renderer.root);

  // secureTextEntry is the contract for a password field.
  expect(field.props.secureTextEntry).toBe(true);
  // Disable every form of OS-level text rewriting so a typed password reaches
  // verifyPassword verbatim. Paste is left enabled (no override).
  expect(field.props.autoCapitalize).toBe('none');
  expect(field.props.autoCorrect).toBe(false);
  expect(field.props.spellCheck).toBe(false);
  expect(field.props.autoComplete).toBe('off');
  // VoiceOver label on the field itself.
  expect(field.props.accessibilityLabel).toBe('Gate password');
  // maxLength caps a paste so the pure-JS SHA-256 can't be made to churn.
  expect(field.props.maxLength).toBe(1024);

  // The Verify + Cancel buttons are present.
  expect(findSubmit(renderer.root)).toBeDefined();
  expect(findCancel(renderer.root)).toBeDefined();
  // The panel container carries its label but NO `accessibilityRole="alert"`
  // — `alert` on the container would make VoiceOver re-announce the whole
  // panel on every countdown tick. The dynamic tries-left + throttle messages
  // below carry their own `alert` role (asserted in their own tests).
  const panel = renderer.root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityLabel === 'Password gate' &&
      node.props.accessibilityRole == null,
  );
  expect(panel.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Empty field: submit disabled, no tries-left message
// ---------------------------------------------------------------------------

test('empty field: submit disabled and no tries-left message on a fresh gate', () => {
  seedState({ gateAttempts: 0 });
  const { renderer } = renderGate();
  const submit = findSubmit(renderer.root);
  expect(submit.props.disabled).toBe(true);
  // No tries-left message on a fresh gate (gateAttempts === 0).
  expect(findTriesLeftAlert(renderer.root)).toBeUndefined();
  // No throttle message either.
  expect(findThrottleAlert(renderer.root)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Show/Hide toggle flips secureTextEntry + VoiceOver label
// ---------------------------------------------------------------------------

test('the Show/Hide toggle flips secureTextEntry and its VoiceOver label', () => {
  seedState({});
  const { renderer } = renderGate();
  // Initially hidden -> label is "Show password".
  const toggleBefore = findToggle(renderer.root);
  expect(toggleBefore.props.accessibilityLabel).toBe('Show password');
  expect(findField(renderer.root).props.secureTextEntry).toBe(true);

  ReactTestRenderer.act(() => {
    toggleBefore.props.onPress();
  });

  // After press -> revealed -> label is "Hide password" and the field is open.
  const toggleAfter = findToggle(renderer.root);
  expect(toggleAfter.props.accessibilityLabel).toBe('Hide password');
  expect(findField(renderer.root).props.secureTextEntry).toBe(false);
});

// ---------------------------------------------------------------------------
// Wrong entry (tries 1-4): field clears + "That didn't match. N tries left."
// ---------------------------------------------------------------------------

test('a wrong entry clears the field and shows "That didn\'t match. N tries left." with no plaintext leakage', () => {
  seedState({ gateAttempts: 0 });
  const { renderer } = renderGate();
  const field = findField(renderer.root);
  typeInto(field, 'wrong-password');
  expect(field.props.value).toBe('wrong-password');

  pressSubmit(renderer.root);

  // The field cleared (the spec's "Field cleared" on wrong entry).
  const fieldAfter = findField(renderer.root);
  expect(fieldAfter.props.value).toBe('');
  // The tries-left alert shows with N = GATE_MAX_ATTEMPTS - 1 (1st wrong).
  const alert = findTriesLeftAlert(renderer.root);
  expect(alert).toBeDefined();
  const text = extractText(alert);
  expect(text).toContain("That didn't match.");
  expect(text).toContain(`${GATE_MAX_ATTEMPTS - 1}`);
  // No plaintext leakage: the wrong password is NOT in the rendered tree.
  const fullText = extractText(renderer.toJSON());
  expect(fullText).not.toContain('wrong-password');
});

test('the tries-left count decrements with each wrong entry (N = 5 - attempts)', () => {
  // Seed 2 prior wrong attempts -> the 3rd wrong shows "2 tries left".
  seedState({ gateAttempts: 2 });
  const { renderer } = renderGate();
  // On reopen with prior attempts, the tries-left message shows immediately
  // (the counter persists across close/reopen — the spec's AC).
  const alertBefore = findTriesLeftAlert(renderer.root);
  expect(alertBefore).toBeDefined();
  expect(extractText(alertBefore)).toContain(
    `${GATE_MAX_ATTEMPTS - 2}`,
  );

  // 3rd wrong -> "2 tries left" (attempts 2 -> 3, triesLeft = 5 - 3 = 2).
  typeInto(findField(renderer.root), 'wrong3');
  pressSubmit(renderer.root);
  const alertAfter = findTriesLeftAlert(renderer.root);
  expect(alertAfter).toBeDefined();
  expect(extractText(alertAfter)).toContain(
    `${GATE_MAX_ATTEMPTS - 3}`,
  );
});

// ---------------------------------------------------------------------------
// 5th wrong entry: throttle countdown shows + field + submit disabled
// ---------------------------------------------------------------------------

test('the 5th wrong entry engages the throttle: countdown shows, field + submit disabled', () => {
  // Seed 4 prior wrong attempts; the 5th wrong engages the throttle.
  seedPasswordAndThrottle();
  const { renderer } = renderGate();
  typeInto(findField(renderer.root), 'wrong5');
  pressSubmit(renderer.root);

  // The throttle alert shows with the headline + a seconds countdown.
  const throttle = findThrottleAlert(renderer.root);
  expect(throttle).toBeDefined();
  const throttleText = extractText(throttle);
  expect(throttleText).toContain('Too many attempts.');
  expect(throttleText).toContain('Try again in');
  expect(throttleText).toMatch(/\d+s/);

  // The field is disabled (editable=false) during the throttle.
  expect(findField(renderer.root).props.editable).toBe(false);
  // The submit button is disabled during the throttle.
  expect(findSubmit(renderer.root).props.disabled).toBe(true);
  // The tries-left alert is NOT shown while throttled (the countdown replaces it).
  expect(findTriesLeftAlert(renderer.root)).toBeUndefined();
});

/**
 * Seed a password + 4 prior wrong attempts (so the NEXT wrong is the 5th and
 * engages the throttle). Used by the 5th-wrong test.
 */
function seedPasswordAndThrottle(): void {
  seedState({ gateAttempts: GATE_MAX_ATTEMPTS - 1 });
}

// ---------------------------------------------------------------------------
// Correct entry: onVerified fires + field clears
// ---------------------------------------------------------------------------

test('a correct entry fires onVerified and clears the field', () => {
  seedState({ gateAttempts: 0 });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  typeInto(findField(renderer.root), 'secret123');
  pressSubmit(renderer.root);

  // onVerified fired exactly once.
  expect(onVerified).toHaveBeenCalledTimes(1);
  // The store's gateAttempts reset to 0 (verifyPassword resets on success).
  expect(useDomainStore.getState().gateAttempts).toBe(0);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
  // No tries-left or throttle alert on success.
  expect(findTriesLeftAlert(renderer.root)).toBeUndefined();
  expect(findThrottleAlert(renderer.root)).toBeUndefined();
  // No plaintext leakage: the correct password is NOT in the rendered tree.
  expect(extractText(renderer.toJSON())).not.toContain('secret123');
});

test('a correct entry after wrong attempts fires onVerified and resets the counter', () => {
  // 3 prior wrong attempts; a correct entry resets + fires onVerified.
  seedState({ gateAttempts: 3 });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  typeInto(findField(renderer.root), 'secret123');
  pressSubmit(renderer.root);

  expect(onVerified).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateAttempts).toBe(0);
  expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
});

// ---------------------------------------------------------------------------
// Cancel (the component's close affordance, equivalent to Esc) calls onClose
// ---------------------------------------------------------------------------

test('pressing Cancel calls onClose (the component close affordance, equivalent to the Shell Esc branch)', () => {
  seedState({ gateAttempts: 0 });
  const onClose = jest.fn();
  const { renderer } = renderGate(jest.fn(), onClose);
  const cancel = findCancel(renderer.root);
  ReactTestRenderer.act(() => {
    cancel.props.onPress();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Cancel preserves the attempt counter (Esc/cancel does NOT reset it)', () => {
  // The spec's AC: "Given the gate is open, when the user presses Esc, then
  // the sheet closes, the action does NOT fire, and the attempt counter is
  // preserved." The component's Cancel button is the close affordance; the
  // counter is preserved because `onClose` (the Shell's `closeGate`) preserves
  // `gateAttempts`. Here we verify the component does NOT touch the store's
  // `gateAttempts` when Cancel is pressed.
  seedState({ gateAttempts: 2 });
  const onClose = jest.fn();
  const { renderer } = renderGate(jest.fn(), onClose);
  const cancel = findCancel(renderer.root);
  ReactTestRenderer.act(() => {
    cancel.props.onPress();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  // The store's gateAttempts is UNCHANGED — the component did not reset it.
  expect(useDomainStore.getState().gateAttempts).toBe(2);
});

// ---------------------------------------------------------------------------
// Throttle countdown: the interval calls clearGateThrottle at 0
// ---------------------------------------------------------------------------

test('when the throttle elapses, the countdown interval calls clearGateThrottle and re-enables the field', () => {
  // Seed an active throttle that expires in 1ms. Use jest fake timers so the
  // 1s interval tick is deterministic. The countdown effect's first tick runs
  // immediately (synchronously inside the act create), so we seed a ~1ms
  // throttle and advance fake timers past it.
  jest.useFakeTimers();
  try {
    const now = Date.now();
    seedState({
      gateAttempts: GATE_MAX_ATTEMPTS,
      gateThrottleUntil: now + 1, // expires almost immediately
    });
    const { renderer } = renderGate();

    // The throttle is showing on mount.
    expect(findThrottleAlert(renderer.root)).toBeDefined();
    expect(findField(renderer.root).props.editable).toBe(false);

    // Advance fake timers past the 1s interval tick. The tick recomputes
    // remaining = throttleUntil - Date.now() <= 0 -> calls clearGateThrottle.
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1100);
    });

    // The throttle cleared: attempts reset to 0, throttleUntil null.
    expect(useDomainStore.getState().gateAttempts).toBe(0);
    expect(useDomainStore.getState().gateThrottleUntil).toBeNull();
    // The throttle alert is gone, the field is re-enabled.
    expect(findThrottleAlert(renderer.root)).toBeUndefined();
    expect(findField(renderer.root).props.editable).toBe(true);
    // The submit button is enabled (empty field still disables it, but the
    // throttle is no longer the blocker).
    expect(findSubmit(renderer.root).props.disabled).toBe(true); // empty entry
  } finally {
    jest.useRealTimers();
  }
});

// ---------------------------------------------------------------------------
// Submit is a no-op when disabled (empty field or throttled)
// ---------------------------------------------------------------------------

test('pressing the disabled submit on an empty field does NOT call onVerified', () => {
  seedState({ gateAttempts: 0 });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  const submit = findSubmit(renderer.root);
  expect(submit.props.disabled).toBe(true);
  ReactTestRenderer.act(() => {
    submit.props.onPress();
  });
  expect(onVerified).not.toHaveBeenCalled();
});

test('pressing submit while throttled does NOT call onVerified (disabled)', () => {
  // Seed an active throttle 10s in the future.
  seedState({
    gateAttempts: GATE_MAX_ATTEMPTS,
    gateThrottleUntil: Date.now() + 10_000,
  });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  // Type a correct password — but the field is disabled (editable=false), so
  // onChangeText won't fire in the native runtime. In the test we can still
  // set the value via onChangeText (the test renderer doesn't enforce
  // editable). But the submit button is disabled (throttle), so pressing it
  // is a no-op.
  const submit = findSubmit(renderer.root);
  expect(submit.props.disabled).toBe(true);
  ReactTestRenderer.act(() => {
    submit.props.onPress();
  });
  expect(onVerified).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// onSubmitEditing (Return in the field) calls handleSubmit
// ---------------------------------------------------------------------------

test('pressing Return on the field with a correct entry fires onVerified (onSubmitEditing wires handleSubmit)', () => {
  seedState({ gateAttempts: 0 });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  typeInto(findField(renderer.root), 'secret123');
  ReactTestRenderer.act(() => {
    findField(renderer.root).props.onSubmitEditing({
      nativeEvent: { text: 'secret123' },
    });
  });
  expect(onVerified).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Review patch (step-04): the gate trims before verify, matching 3-1
// ---------------------------------------------------------------------------

test('a correct entry with accidental surrounding spaces still verifies (the gate trims before hash, matching 3-1)', () => {
  // 3-1's SetPassword trims at submit before hashing, so the stored hash is
  // sha256(trimmed). The gate must trim the entry the same way — otherwise a
  // password typed with leading/trailing spaces would never verify and the
  // user would be locked out of their own account (the 3-1 deferred item:
  // "3-2 gate must match 3-1's trim-before-hash").
  seedState({ gateAttempts: 0 });
  const onVerified = jest.fn();
  const { renderer } = renderGate(onVerified);
  typeInto(findField(renderer.root), '  secret123  ');
  pressSubmit(renderer.root);
  expect(onVerified).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateAttempts).toBe(0);
});

// ---------------------------------------------------------------------------
// Review patch (step-04): the countdown shows the seconds remaining + decrements
// ---------------------------------------------------------------------------

test('the throttle countdown shows the seconds remaining and decrements each tick', () => {
  // Pin the displayed countdown value (the 5th-wrong test only checks /\d+s/).
  // Seed a 30s throttle; the mount tick runs immediately -> "30s"; one 1s tick
  // later -> "29s".
  jest.useFakeTimers();
  try {
    const now = Date.now();
    seedState({
      gateAttempts: GATE_MAX_ATTEMPTS,
      gateThrottleUntil: now + 30_000,
    });
    const { renderer } = renderGate();
    const throttle = findThrottleAlert(renderer.root);
    expect(throttle).toBeDefined();
    // Mount tick: ~30s remaining -> ceil(30000/1000) = 30 -> "30s".
    expect(extractText(throttle)).toContain('30s');

    // Advance one 1s interval tick -> ~29s remaining -> "29s".
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(extractText(findThrottleAlert(renderer.root))).toContain('29s');
  } finally {
    jest.useRealTimers();
  }
});