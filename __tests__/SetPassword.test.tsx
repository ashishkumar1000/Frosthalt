/**
 * Story 3.1 — the SetPassword form tests.
 *
 * Renders the form with `react-test-renderer` against a seeded
 * `useDomainStore` state (the store is a real Zustand store; the two NATIVE
 * specs are mocked so `readConfig()` at module-eval time falls back to
 * DEFAULT_CONFIG — see the store.test.ts:21-35 / AddDomain.test.tsx pattern).
 *
 * Covers the spec's I/O-matrix + Acceptance Criteria:
 *   - Renders entry + confirm fields with `secureTextEntry`.
 *   - Field a11y attrs: autoCapitalize="none", autoCorrect={false},
 *     spellCheck={false}, autoComplete="off" (paste allowed — no override).
 *   - Show/Hide toggles flip `secureTextEntry` on each field independently.
 *   - Empty / blank: submit disabled, no error spam.
 *   - Too-short entry: inline length error, submit disabled.
 *   - Mismatched confirm: inline match error, submit disabled.
 *   - Clean matching entry: submit enabled; pressing it calls `setPassword`
 *     with the trimmed entry, and on `{ ok: true }` the fields clear + a
 *     "Password set" confirmation shows.
 *   - `writeConfig` failure: "Couldn't save password. No changes made." is
 *     surfaced and the fields are retained for retry.
 *   - VoiceOver labels on the fields and the Show/Hide toggles.
 *
 * Mocking `setPassword`: the same `jest.fn` wrapper via `setState` pattern
 * `AddDomain.test.tsx` uses for `stageDomainAdd`. `seedState` always restores
 * the REAL action (captured once at module load) so a mock can never leak.
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
import { SetPassword } from '../src/components/SetPassword';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../src/config/password';
import type { WriteResult } from '../src/hosts/shellRunner';

// The REAL `setPassword`, captured once at module load. `seedState` always
// restores this so a `jest.fn` wrapper installed by a test can never leak.
const REAL_SET_PASSWORD = useDomainStore.getState().setPassword;

// Native mock handles — the store's `setPassword` calls `writeConfig` (the
// configStore port) when the `callThrough` mock delegates to the real action.
// The default `{ ok: true }` return makes a real `setPassword` succeed so the
// "clears on success" + "committed advances" assertions hold. A test that
// wants a failed write overrides this via `mockSetPassword(false)` (which
// bypasses the real action entirely and returns a failure envelope).
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
 * Find a TextInput field by its `accessibilityLabel` (distinct per field:
 * 'New password' / 'Confirm new password'). Same prop-based query pattern as
 * `AddDomain.test.tsx` (find by props, not `findByType`, because the imported
 * `TextInput` is not identity-equal to the one in the rendered tree under
 * pnpm + RN 0.81). react-native-macos renders each TextInput as a composite +
 * inner host component, so a plain `onChangeText`+`value` query returns
 * duplicates; scoping on `accessibilityLabel` picks exactly one instance per
 * field (the first match).
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

/** Find the submit button by accessibilityLabel 'Set password'. */
function findSubmit(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Set password',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find a Show/Hide toggle by accessibilityLabel containing 'Show'/'Hide password'. */
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

/** Seeds the store state (no password set) and restores the real setPassword. */
function seedState(): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG },
      staged: null,
      applyStatus: 'idle',
      lastResult: null,
      drift: null,
      lastReadSection: null,
      // Always restore the real action so a previous test's mock can't leak.
      setPassword: REAL_SET_PASSWORD,
    });
  });
}

/**
 * Install a `setPassword` mock. `callThrough: true` delegates to the real
 * action (so committed updates); `callThrough: false` returns a safe
 * `{ ok: false }`. Returns the mock for assertions. The mock returns a
 * Promise to match the real `setPassword` signature.
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
});

function renderSetPassword() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<SetPassword />);
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

// ---------------------------------------------------------------------------
// Renders two secure fields with the right a11y attrs
// ---------------------------------------------------------------------------

test('renders two secureTextEntry fields (entry + confirm) with password a11y attrs', () => {
  seedState();
  const testRenderer = renderSetPassword();
  const entry = findEntry(testRenderer.root);
  const confirm = findConfirm(testRenderer.root);

  for (const field of [entry, confirm]) {
    // secureTextEntry is the contract for a password field.
    expect(field.props.secureTextEntry).toBe(true);
    // Disable every form of OS-level text rewriting so a typed password
    // reaches setPassword verbatim. Paste is left enabled (no override).
    expect(field.props.autoCapitalize).toBe('none');
    expect(field.props.autoCorrect).toBe(false);
    expect(field.props.spellCheck).toBe(false);
    expect(field.props.autoComplete).toBe('off');
    // VoiceOver label on the field itself.
    expect(typeof field.props.accessibilityLabel).toBe('string');
    expect(field.props.accessibilityLabel.length).toBeGreaterThan(0);
  }
});

test('entry and confirm fields carry distinct VoiceOver labels', () => {
  seedState();
  const testRenderer = renderSetPassword();
  expect(findEntry(testRenderer.root).props.accessibilityLabel).toBe(
    'New password',
  );
  expect(findConfirm(testRenderer.root).props.accessibilityLabel).toBe(
    'Confirm new password',
  );
});

// ---------------------------------------------------------------------------
// Show/Hide toggles flip secureTextEntry per field
// ---------------------------------------------------------------------------

test('each field has a Show/Hide toggle with a VoiceOver label, and flipping hides/reveals', () => {
  seedState();
  const testRenderer = renderSetPassword();
  const toggles = findToggles(testRenderer.root);
  // Two toggles — one per field.
  expect(toggles.length).toBe(2);
  // Each toggle has a VoiceOver label that announces Show/Hide.
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
// Empty / blank: submit disabled, no error spam
// ---------------------------------------------------------------------------

test('empty fields: submit disabled and no inline error text', () => {
  seedState();
  const testRenderer = renderSetPassword();
  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain("Passwords don't match");
  expect(text).not.toContain('at least');
});

test('blank (whitespace-only) entries: submit disabled, no error spam', () => {
  seedState();
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), '   ');
  typeInto(findConfirm(testRenderer.root), '   ');
  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
  // The trimmed values are empty, so no length/match error should surface.
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain("Passwords don't match");
});

test('valid entry but EMPTY confirm: submit disabled (either field empty) and no mismatch spam', async () => {
  // The matrix's "Empty / blank" row says "" in EITHER field -> submit
  // disabled. The confirm field's match-error is suppressed when confirm is
  // empty (no spam before the user types the retype), but that suppression
  // must NOT open the submit gate: an empty confirm is still a mismatch for
  // submission (the retype must be present and equal). Pressing submit here
  // must be a no-op — no password set without confirmation.
  seedState();
  const spy = mockSetPassword(false);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'abc123');
  // confirm left empty
  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
  // No mismatch error is spammed for the empty confirm.
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain("Passwords don't match");
  // And pressing the disabled submit is a no-op (the guard early-returns).
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });
  expect(spy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Too-short entry: inline length error, submit disabled
// ---------------------------------------------------------------------------

test('too-short entry shows the length error and disables submit', () => {
  seedState();
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'ab');
  typeInto(findConfirm(testRenderer.root), 'ab');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain(`${PASSWORD_MIN_LENGTH} characters`);
  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Mismatched confirm: inline match error, submit disabled
// ---------------------------------------------------------------------------

test('mismatched confirm shows the match error and disables submit', () => {
  seedState();
  const testRenderer = renderSetPassword();
  // Entry long enough to pass the length check, confirm differs.
  typeInto(findEntry(testRenderer.root), 'abc123');
  typeInto(findConfirm(testRenderer.root), 'abc124');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain("Passwords don't match");
  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Clean matching entry: submit enabled, calls setPassword, clears on success
// ---------------------------------------------------------------------------

test('clean matching entry enables submit; pressing it calls setPassword with the trimmed entry and clears the fields on ok', async () => {
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), '  secret123  ');
  typeInto(findConfirm(testRenderer.root), 'secret123');

  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(false);

  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });

  // Called with the TRIMMED entry (the form trims before hashing).
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('secret123');
  // committed.passwordHash advanced to the hash of the trimmed entry.
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret123'),
  );
  // On success the form swaps to the "Password set." confirmation view (the
  // `status === 'saved'` branch), so the entry/confirm fields are no longer
  // rendered — the plaintext has left the field lifecycle. Assert the success
  // message is shown and the fields are gone.
  expect(extractText(testRenderer.toJSON())).toContain('Password set.');
  const fieldsAfter = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  );
  expect(fieldsAfter.length).toBe(0);
});

test('submit is a no-op when disabled: pressing it on invalid input does not call setPassword', async () => {
  seedState();
  const spy = mockSetPassword(false);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'ab');
  typeInto(findConfirm(testRenderer.root), 'ab');

  const submit = findSubmit(testRenderer.root);
  expect(submit.props.disabled).toBe(true);
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });
  // The guard early-returned; setPassword was never called.
  expect(spy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Keyboard submit (onSubmitEditing): the Return key calls handleSubmit
// ---------------------------------------------------------------------------

test('pressing Return on the entry field with a clean matching entry calls setPassword and clears the fields', async () => {
  // The repo convention (AddDomain.test.tsx) is to dispatch
  // `field.props.onSubmitEditing({ nativeEvent: { text } })` to verify the
  // keyboard-submit wiring. Both password fields wire `onSubmitEditing={handleSubmit}`;
  // this locks that path so deleting the wiring ships a failing test.
  seedState();
  const spy = mockSetPassword(true);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'secret123');
  typeInto(findConfirm(testRenderer.root), 'secret123');

  await ReactTestRenderer.act(async () => {
    findEntry(testRenderer.root).props.onSubmitEditing({
      nativeEvent: { text: 'secret123' },
    });
  });

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('secret123');
  expect(useDomainStore.getState().committed.passwordHash).toBe(
    hashPassword('secret123'),
  );
  // Fields cleared on success (plaintext leaves the field lifecycle).
  expect(extractText(testRenderer.toJSON())).toContain('Password set.');
});

test('pressing Return on the confirm field with invalid input is a no-op (does not call setPassword)', async () => {
  seedState();
  const spy = mockSetPassword(false);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'ab');
  typeInto(findConfirm(testRenderer.root), 'ab');

  await ReactTestRenderer.act(async () => {
    findConfirm(testRenderer.root).props.onSubmitEditing({
      nativeEvent: { text: 'ab' },
    });
  });

  // handleSubmit's `canSubmit` guard early-returned; no password set.
  expect(spy).not.toHaveBeenCalled();
  expect(useDomainStore.getState().committed.passwordHash).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Show/Hide toggle label flips between "Show password" and "Hide password"
// ---------------------------------------------------------------------------

test('the entry Show/Hide toggle accessibilityLabel flips between Show and Hide after press', () => {
  seedState();
  const testRenderer = renderSetPassword();
  // Initially hidden -> label is "Show password".
  const toggleBefore = findToggles(testRenderer.root)[0];
  expect(toggleBefore.props.accessibilityLabel).toBe('Show password');
  expect(findEntry(testRenderer.root).props.secureTextEntry).toBe(true);

  ReactTestRenderer.act(() => {
    toggleBefore.props.onPress();
  });

  // After press -> revealed -> label is "Hide password" and the field is open.
  const toggleAfter = findToggles(testRenderer.root)[0];
  expect(toggleAfter.props.accessibilityLabel).toBe('Hide password');
  expect(findEntry(testRenderer.root).props.secureTextEntry).toBe(false);
});

// ---------------------------------------------------------------------------
// writeConfig failure: surface the error, retain the fields for retry
// ---------------------------------------------------------------------------

test('writeConfig failure surfaces "Couldn\'t save password" and retains the fields', async () => {
  seedState();
  // mockSetPassword(false) returns { ok: false, error: 'disk-full' }.
  const spy = mockSetPassword(false);
  const testRenderer = renderSetPassword();
  typeInto(findEntry(testRenderer.root), 'secret123');
  typeInto(findConfirm(testRenderer.root), 'secret123');

  const submit = findSubmit(testRenderer.root);
  await ReactTestRenderer.act(async () => {
    await submit.props.onPress();
  });

  expect(spy).toHaveBeenCalledTimes(1);
  // The save-failure error is surfaced.
  expect(extractText(testRenderer.toJSON())).toContain(
    "Couldn't save password. No changes made.",
  );
  // Fields retained so the user can retry without retyping.
  expect(findEntry(testRenderer.root).props.value).toBe('secret123');
  expect(findConfirm(testRenderer.root).props.value).toBe('secret123');
  // committed.passwordHash stays unset (the store leaves it unchanged on
  // failure).
  expect(useDomainStore.getState().committed.passwordHash).toBeUndefined();
});