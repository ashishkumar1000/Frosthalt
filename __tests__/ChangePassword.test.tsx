/**
 * Story 3.3 — the ChangePassword flow tests.
 *
 * Renders the component with `react-test-renderer` against a seeded
 * `useDomainStore` state (the store is a real Zustand store; the two NATIVE
 * specs are mocked so `readConfig()` at module-eval time falls back to
 * DEFAULT_CONFIG — see the store.test.ts:21-35 / SetPassword.test.tsx pattern).
 *
 * Covers the spec's I/O-matrix + Acceptance Criteria:
 *   - Trigger renders with a VoiceOver label; the form is NOT yet visible.
 *   - Click trigger (password set) -> `gateOpen` true + `gateAction` stashed;
 *     the form is still NOT visible (gate-first).
 *   - Gate verify correct -> run the stashed `gateAction` (the Shell's
 *     `runGateAction` sim) + `closeGate` -> the New+Confirm form opens.
 *   - Form fields mirror SetPassword a11y (`secureTextEntry`, autoCapitalize
 *     "none", autoCorrect false, spellCheck false, autoComplete "off",
 *     maxLength 1024) + per-field Show/Hide toggles.
 *   - New too short -> inline length error + submit disabled.
 *   - Mismatched confirm -> inline match error + submit disabled.
 *   - Clean matching entry -> submit enabled; pressing it calls `setPassword`
 *     with the trimmed entry, `committed.passwordHash` updates, the form
 *     closes, and a success message shows.
 *   - `writeConfig` failure -> form stays open with a save error and
 *     `committed.passwordHash` is unchanged.
 *   - Cancel -> form closes with no submit.
 *
 * Mocking `setPassword`: the same `jest.fn` wrapper via `setState` pattern
 * `SetPassword.test.tsx` uses. `seedState` always restores the REAL actions
 * (captured once at module load) so a mock can never leak.
 *
 * The gate itself is not rendered here (the Shell hosts `<PasswordGate>`); to
 * simulate "gate verified", the test runs the stashed `gateAction` and calls
 * `closeGate` — exactly what the Shell's `runGateAction` does on a successful
 * `verifyPassword`.
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
import { ChangePassword } from '../src/components/ChangePassword';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../src/config/password';
import type { WriteResult } from '../src/hosts/shellRunner';

// The REAL store actions, captured once at module load. `seedState` always
// restores these so a `jest.fn` wrapper installed by a test can never leak.
const REAL_SET_PASSWORD = useDomainStore.getState().setPassword;
const REAL_REQUIRE_PASSWORD = useDomainStore.getState().requirePassword;

// Native mock handle — the store's `setPassword` calls `writeConfig` (the
// configStore port) when the `callThrough` mock delegates to the real action.
// The default `{ ok: true }` return makes a real `setPassword` succeed so the
// "committed advances" + "form closes" assertions hold. A test that wants a
// failed write overrides this via `mockSetPassword(false)` (which bypasses the
// real action entirely and returns a failure envelope).
type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
const configNative = require('../src/native/specs/NativeConfigStoreSpec')
  .default as unknown as NativeConfigMock;

beforeEach(() => {
  configNative.writeConfig.mockReset();
  configNative.writeConfig.mockReturnValue({ ok: true });
});

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
 * Find a TextInput field by its `accessibilityLabel`. Same prop-based query
 * pattern as `SetPassword.test.tsx` (find by props, not `findByType`, because
 * the imported `TextInput` is not identity-equal to the one in the rendered
 * tree under pnpm + RN 0.81).
 */
function findField(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string' &&
      node.props.accessibilityLabel === label,
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Count fields matching a label (0 when the form is not yet open). */
function countFields(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): number {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string' &&
      node.props.accessibilityLabel === label,
  ).length;
}

/** Convenience: the entry field ('New password'). */
function findEntry(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  return findField(root, 'New password');
}

/** Convenience: the confirm field ('Confirm new password'). */
function findConfirm(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  return findField(root, 'Confirm new password');
}

/** Find the destructive trigger button by accessibilityLabel 'Change password'. */
function findTrigger(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Change password',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find the form submit button by accessibilityLabel 'Save new password'. */
function findSubmit(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Save new password',
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

/** Find the Show/Hide toggles by their accessibilityLabels. */
function findToggles(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance[] {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityLabel === 'string' &&
      (node.props.accessibilityLabel === 'Show password' ||
        node.props.accessibilityLabel === 'Hide password' ||
        node.props.accessibilityLabel === 'Show confirm password' ||
        node.props.accessibilityLabel === 'Hide confirm password'),
  );
}

/** Seeds the store with a password set and restores the real actions. */
function seedState(passwordHash?: string): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: passwordHash ?? hashPassword('secret123'),
      },
      staged: null,
      applyStatus: 'idle',
      lastResult: null,
      drift: null,
      lastReadSection: null,
      gateOpen: false,
      gateAction: null,
      gateAttempts: 0,
      gateThrottleUntil: null,
      // Always restore the real actions so a previous test's mock can't leak.
      setPassword: REAL_SET_PASSWORD,
      requirePassword: REAL_REQUIRE_PASSWORD,
    });
  });
}

/**
 * Install a `setPassword` mock. `callThrough: true` delegates to the real
 * action (so committed updates + writeConfig fires); `callThrough: false`
 * returns a safe `{ ok: false }`. Returns the mock for assertions.
 */
function mockSetPassword(
  callThrough: boolean,
): jest.Mock<Promise<WriteResult>, [string]> {
  const impl = callThrough
    ? (pw: string): Promise<WriteResult> => REAL_SET_PASSWORD(pw)
    : (): Promise<WriteResult> => Promise.resolve({ ok: false, error: 'disk-full' });
  const mock = jest.fn(impl) as unknown as jest.Mock<
    Promise<WriteResult>,
    [string]
  >;
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ setPassword: mock });
  });
  return mock;
}

let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
  // Restore the real actions + reset gate state so a mock can never leak into
  // a later suite that shares the module-level store instance.
  useDomainStore.setState({
    setPassword: REAL_SET_PASSWORD,
    requirePassword: REAL_REQUIRE_PASSWORD,
    gateOpen: false,
    gateAction: null,
    gateAttempts: 0,
    gateThrottleUntil: null,
    committed: { ...DEFAULT_CONFIG },
  });
});

function renderChangePassword() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<ChangePassword />);
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

/** Type into a field by dispatching `onChangeText`. */
function typeInto(
  field: ReactTestRenderer.ReactTestInstance,
  text: string,
) {
  ReactTestRenderer.act(() => {
    field.props.onChangeText(text);
  });
}

/**
 * Press the trigger, then simulate the Shell's `runGateAction` (run the stashed
 * `gateAction` + `closeGate`) so the New+Confirm form opens. Mirrors the real
 * gate-first flow: trigger -> gate opens -> verify -> action runs -> gate
 * closes -> form opens.
 */
function openForm(root: ReactTestRenderer.ReactTestInstance): void {
  ReactTestRenderer.act(() => {
    findTrigger(root).props.onPress();
  });
  // After the trigger, the gate opened + the flip is stashed as `gateAction`.
  const action = useDomainStore.getState().gateAction;
  expect(action).toBeInstanceOf(Function);
  ReactTestRenderer.act(() => {
    // Run the stashed flip (the Shell does this on `verifyPassword` ok)...
    action!();
    // ...then the Shell's `runGateAction` `finally` calls `closeGate`.
    useDomainStore.getState().closeGate();
  });
}

// ---------------------------------------------------------------------------
// Trigger renders + a11y; the form is NOT yet visible
// ---------------------------------------------------------------------------

test('renders the destructive "Change password" trigger with a VoiceOver label and NO form fields', () => {
  seedState();
  const testRenderer = renderChangePassword();
  const trigger = findTrigger(testRenderer.root);
  expect(trigger.props.accessibilityRole).toBe('button');
  expect(trigger.props.accessibilityLabel).toBe('Change password');
  // The form is NOT yet open: no New/Confirm fields, no Save/Cancel buttons.
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBe(0);
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        node.props.accessibilityLabel === 'Save new password',
    ).length,
  ).toBe(0);
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        node.props.accessibilityLabel === 'Cancel',
    ).length,
  ).toBe(0);
});

// ---------------------------------------------------------------------------
// Click trigger (password set) -> gate opens; form NOT yet visible
// ---------------------------------------------------------------------------

test('clicking the trigger (password set) opens the gate and stashes the flip; the form is still NOT visible', () => {
  seedState();
  const testRenderer = renderChangePassword();
  ReactTestRenderer.act(() => {
    findTrigger(testRenderer.root).props.onPress();
  });

  // The gate opened (the store's `requirePassword` set `gateOpen: true`).
  expect(useDomainStore.getState().gateOpen).toBe(true);
  // The stashed action is the UI state flip `() => setChangeOpen(true)`.
  const action = useDomainStore.getState().gateAction;
  expect(action).toBeInstanceOf(Function);
  // Gate-first: the form is still NOT visible (changeOpen is false until the
  // gate verifies and runs the flip).
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBe(0);
});

test('Esc during the gate closes it WITHOUT opening the form or calling setPassword (matrix: Esc during gate)', () => {
  seedState();
  const testRenderer = renderChangePassword();
  // Press the trigger -> gate opens, the flip is stashed as gateAction.
  ReactTestRenderer.act(() => {
    findTrigger(testRenderer.root).props.onPress();
  });
  expect(useDomainStore.getState().gateOpen).toBe(true);
  expect(useDomainStore.getState().gateAction).toBeInstanceOf(Function);

  // Install a setPassword mock so we can prove "no change" (the action never
  // runs, so the mock is never called).
  const setPasswordMock = mockSetPassword(false);

  // Simulate the Shell's Esc branch (Shell.tsx:143-146): closeGate() runs but
  // does NOT run gateAction. The flip never fires -> the form never opens.
  ReactTestRenderer.act(() => {
    useDomainStore.getState().closeGate();
  });

  // Gate closed; the stashed action was dropped (closeGate nulls gateAction).
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
  // The form did NOT open.
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBe(0);
  // No password change: setPassword was never called.
  expect(setPasswordMock).not.toHaveBeenCalled();
});

test('clicking the trigger when NO password is set short-circuits the gate and opens the form directly', () => {
  // `requirePassword` runs the action immediately when no password is set (the
  // no-op short-circuit). The parent Settings only renders <ChangePassword/>
  // when `hasPassword`, so this is defensive — but it locks the contract so a
  // future caller that renders ChangePassword without a password does not lock
  // the user out of the change flow.
  seedState();
  // Wipe the hash AFTER seedState (so the rest of the seeded state is intact).
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG }, // passwordHash unset
    });
  });
  const testRenderer = renderChangePassword();
  ReactTestRenderer.act(() => {
    findTrigger(testRenderer.root).props.onPress();
  });
  // No gate (short-circuit): gateOpen stays false, no gateAction stashed.
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
  // The flip ran immediately -> the form is open. (>= 1, not === 1: RN-macos
  // renders TextInput as a composite + inner host, so a prop query returns
  // duplicate matches — same caveat as SetPassword.test.tsx's findField.)
  expect(countFields(testRenderer.root, 'New password')).toBeGreaterThanOrEqual(1);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Gate verify correct -> form opens (New + Confirm + Save + Cancel)
// ---------------------------------------------------------------------------

test('after the gate verifies, the New+Confirm form opens with Save + Cancel buttons', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);

  // Both fields are present.
  expect(findEntry(testRenderer.root).props.accessibilityLabel).toBe(
    'New password',
  );
  expect(findConfirm(testRenderer.root).props.accessibilityLabel).toBe(
    'Confirm new password',
  );
  // The Save + Cancel buttons are present.
  expect(findSubmit(testRenderer.root).props.accessibilityLabel).toBe(
    'Save new password',
  );
  expect(findCancel(testRenderer.root).props.accessibilityLabel).toBe('Cancel');
  // The trigger is no longer rendered (the closed-state branch is gone).
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        node.props.accessibilityLabel === 'Change password' &&
        node.props.accessibilityRole === 'button',
    ).length,
  ).toBe(0);
  // The gate closed after the action ran (closeGate in openForm).
  expect(useDomainStore.getState().gateOpen).toBe(false);
});

// ---------------------------------------------------------------------------
// Form fields mirror SetPassword a11y
// ---------------------------------------------------------------------------

test('the form fields have secureTextEntry + password a11y attrs + maxLength 1024', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  const entry = findEntry(testRenderer.root);
  const confirm = findConfirm(testRenderer.root);

  for (const field of [entry, confirm]) {
    expect(field.props.secureTextEntry).toBe(true);
    expect(field.props.autoCapitalize).toBe('none');
    expect(field.props.autoCorrect).toBe(false);
    expect(field.props.spellCheck).toBe(false);
    expect(field.props.autoComplete).toBe('off');
    expect(field.props.maxLength).toBe(1024);
    expect(typeof field.props.accessibilityLabel).toBe('string');
    expect(field.props.accessibilityLabel.length).toBeGreaterThan(0);
  }
});

test('each field has a Show/Hide toggle with a VoiceOver label, and flipping hides/reveals', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  const toggles = findToggles(testRenderer.root);
  expect(toggles.length).toBe(2);
  for (const t of toggles) {
    expect(typeof t.props.accessibilityLabel).toBe('string');
    expect(t.props.accessibilityLabel.length).toBeGreaterThan(0);
  }

  // Initially both fields are secure (hidden).
  expect(findEntry(testRenderer.root).props.secureTextEntry).toBe(true);
  expect(findConfirm(testRenderer.root).props.secureTextEntry).toBe(true);

  // Flip the entry toggle -> entry reveals, confirm stays hidden.
  ReactTestRenderer.act(() => {
    toggles[0].props.onPress();
  });
  expect(findEntry(testRenderer.root).props.secureTextEntry).toBe(false);
  expect(findConfirm(testRenderer.root).props.secureTextEntry).toBe(true);

  // Flip the confirm toggle -> confirm reveals too.
  ReactTestRenderer.act(() => {
    findToggles(testRenderer.root)[1].props.onPress();
  });
  expect(findEntry(testRenderer.root).props.secureTextEntry).toBe(false);
  expect(findConfirm(testRenderer.root).props.secureTextEntry).toBe(false);
});

// ---------------------------------------------------------------------------
// New too short -> inline length error, submit disabled
// ---------------------------------------------------------------------------

test('a too-short new password shows the length error and disables submit', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'ab');
  typeInto(findConfirm(testRenderer.root), 'ab');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain(`${PASSWORD_MIN_LENGTH} characters`);
  expect(findSubmit(testRenderer.root).props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Mismatched confirm -> inline match error, submit disabled
// ---------------------------------------------------------------------------

test('a mismatched confirm shows the match error and disables submit', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  // Entry long enough to pass the length check, confirm differs.
  typeInto(findEntry(testRenderer.root), 'abc123');
  typeInto(findConfirm(testRenderer.root), 'abc124');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain("Passwords don't match");
  expect(findSubmit(testRenderer.root).props.disabled).toBe(true);
});

test('valid entry but EMPTY confirm: submit disabled and no mismatch spam', () => {
  seedState();
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'abc123');
  // confirm left empty
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain("Passwords don't match");
  expect(findSubmit(testRenderer.root).props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Clean matching entry: submit enabled; pressing it calls setPassword,
// updates committed.passwordHash, closes the form, shows success
// ---------------------------------------------------------------------------

test('a clean matching entry enables submit; pressing it calls setPassword with the trimmed entry, updates committed.passwordHash, closes the form, and shows the success message', async () => {
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), '  secret456  ');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(false);

  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });

  // Called with the TRIMMED entry (the form trims before hashing).
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('secret456');
  // committed.passwordHash advanced to the hash of the trimmed entry.
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret456'),
  );
  // The form closed: the trigger is back, the fields are gone.
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBe(0);
  // The trigger is back (>= 1: Pressable also renders composite + inner host,
  // so a prop query can return duplicate matches — same caveat as the field
  // finder).
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        node.props.accessibilityLabel === 'Change password' &&
        node.props.accessibilityRole === 'button',
    ).length,
  ).toBeGreaterThanOrEqual(1);
  // The success message is shown.
  expect(extractText(testRenderer.toJSON())).toContain('Password changed.');
});

test('submit is a no-op when disabled: pressing it on invalid input does not call setPassword', async () => {
  seedState();
  const spy = mockSetPassword(false);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'ab');
  typeInto(findConfirm(testRenderer.root), 'ab');

  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });
  expect(spy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Keyboard submit (onSubmitEditing): Return calls handleSubmit
// ---------------------------------------------------------------------------

test('pressing Return on the entry field with a clean matching entry calls setPassword and closes the form', async () => {
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  await ReactTestRenderer.act(async () => {
    findEntry(testRenderer.root).props.onSubmitEditing({
      nativeEvent: { text: 'secret456' },
    });
  });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('secret456');
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret456'),
  );
  // Form closed + success shown.
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(extractText(testRenderer.toJSON())).toContain('Password changed.');
});

test('pressing Return on the CONFIRM field with a clean matching entry calls setPassword and closes the form', async () => {
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  await ReactTestRenderer.act(async () => {
    findConfirm(testRenderer.root).props.onSubmitEditing({
      nativeEvent: { text: 'secret456' },
    });
  });

  // The confirm field is wired to the same `handleSubmit` as the entry field
  // (mirrors SetPassword.tsx:226) — Return on either field submits. Pin the
  // wiring so the confirm field's onSubmitEditing can't be silently dropped
  // and ship green.
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('secret456');
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret456'),
  );
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(extractText(testRenderer.toJSON())).toContain('Password changed.');
});

// ---------------------------------------------------------------------------
// writeConfig failure: form stays open + save error; committed unchanged
// ---------------------------------------------------------------------------

test('writeConfig failure surfaces the save error, retains the form + fields, and leaves committed.passwordHash unchanged', async () => {
  // Seed with a known hash so we can assert it is unchanged after a failure.
  const seededHash = hashPassword('secret123');
  seedState(seededHash);
  const spy = mockSetPassword(false);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  const submit = findSubmit(testRenderer.root);
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });

  expect(spy).toHaveBeenCalledTimes(1);
  // The save-failure error is surfaced.
  expect(extractText(testRenderer.toJSON())).toContain(
    "Couldn't save password. No changes made.",
  );
  // The form stayed open: fields retained so the user can retry without
  // retyping. (>= 1: RN-macos renders TextInput as composite + inner host, so
  // a prop query returns duplicate matches.)
  expect(countFields(testRenderer.root, 'New password')).toBeGreaterThanOrEqual(1);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBeGreaterThanOrEqual(1);
  expect(findEntry(testRenderer.root).props.value).toBe('secret456');
  expect(findConfirm(testRenderer.root).props.value).toBe('secret456');
  // committed.passwordHash is unchanged (the store leaves committed unchanged
  // on failure).
  expect(useDomainStore.getState().committed.passwordHash).toBe(seededHash);
});

// ---------------------------------------------------------------------------
// handleSubmit .catch: a rejected setPassword promise resets saving + surfaces
// the save error (the safety net so a UI never leaves a spinner stuck on an
// unforeseen rejection — mirrors SetPassword's .catch).
// ---------------------------------------------------------------------------

test('a rejected setPassword promise flips saving off, surfaces the save error, and leaves committed unchanged', async () => {
  const seededHash = hashPassword('secret123');
  seedState(seededHash);
  // Install a setPassword mock that REJECTS (not resolves {ok:false}) — this
  // exercises the `.catch` branch, not the `.then(result)` ok:false branch.
  const rejectingMock = jest.fn(
    (): Promise<WriteResult> => Promise.reject(new Error('native port gone')),
  );
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ setPassword: rejectingMock });
  });
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(false);
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });

  expect(rejectingMock).toHaveBeenCalledTimes(1);
  expect(rejectingMock).toHaveBeenCalledWith('secret456');
  // The `.catch` flipped `saving` off + set status='error' -> the save-error
  // message shows and the submit is NOT stuck disabled (canSubmit recomputes
  // true: !saving && valid matching entry+confirm && status !== 'saved').
  expect(extractText(testRenderer.toJSON())).toContain(
    "Couldn't save password. No changes made.",
  );
  expect(findSubmit(testRenderer.root).props.disabled).toBe(false);
  // The form stayed open (fields retained so the user can retry).
  expect(countFields(testRenderer.root, 'New password')).toBeGreaterThanOrEqual(1);
  // committed.passwordHash is unchanged (the rejection never wrote).
  expect(useDomainStore.getState().committed.passwordHash).toBe(seededHash);
});

// ---------------------------------------------------------------------------
// Cancel: closes the form with no submit
// ---------------------------------------------------------------------------

test('Cancel closes the form, clears the fields, and does NOT call setPassword', () => {
  seedState();
  const spy = mockSetPassword(false);
  const testRenderer = renderChangePassword();
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');

  ReactTestRenderer.act(() => {
    findCancel(testRenderer.root).props.onPress();
  });

  // The form closed: the trigger is back, the fields are gone.
  expect(countFields(testRenderer.root, 'New password')).toBe(0);
  expect(countFields(testRenderer.root, 'Confirm new password')).toBe(0);
  // The trigger is back (>= 1: Pressable composite + inner host can yield
  // duplicate matches).
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        node.props.accessibilityLabel === 'Change password' &&
        node.props.accessibilityRole === 'button',
    ).length,
  ).toBeGreaterThanOrEqual(1);
  // No submit fired.
  expect(spy).not.toHaveBeenCalled();
  // committed.passwordHash is unchanged.
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret123'),
  );
});

// ---------------------------------------------------------------------------
// The success line clears on the next trigger press
// ---------------------------------------------------------------------------

test('the success line clears when the trigger is pressed again for a new change', async () => {
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderChangePassword();
  // No success line initially.
  expect(extractText(testRenderer.toJSON())).not.toContain('Password changed.');
  // Open the form and drive a successful submit.
  openForm(testRenderer.root);
  typeInto(findEntry(testRenderer.root), 'secret456');
  typeInto(findConfirm(testRenderer.root), 'secret456');
  await ReactTestRenderer.act(async () => {
    await findSubmit(testRenderer.root).props.onPress();
  });
  // The success line shows after a successful change.
  expect(extractText(testRenderer.toJSON())).toContain('Password changed.');
  // Press the trigger again -> the success line clears (status -> 'idle') and
  // the gate opens for a new change.
  ReactTestRenderer.act(() => {
    findTrigger(testRenderer.root).props.onPress();
  });
  expect(extractText(testRenderer.toJSON())).not.toContain('Password changed.');
  expect(useDomainStore.getState().gateOpen).toBe(true);
  // Sanity: the submit spy was only called once (the re-open did not submit).
  expect(spy).toHaveBeenCalledTimes(1);
});