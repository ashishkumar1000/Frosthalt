/**
 * @format
 *
 * Story 2.2 — the AddDomain field tests.
 *
 * Renders the field with `react-test-renderer` against a seeded
 * `useDomainStore` state (the store is a real Zustand store; the two NATIVE
 * specs are mocked so `readConfig()` at module-eval time falls back to
 * DEFAULT_CONFIG — see the store.test.ts:21-35 / Blocklist.test.tsx pattern).
 * Covers every I/O-matrix row:
 *   - Empty input: no preview, no error, Add disabled.
 *   - Typing valid + new: preview `-> example.com`, no error, Add enabled.
 *   - Typing invalid: no preview, error INVALID, Add disabled.
 *   - Typing duplicate: preview `-> example.com`, error DUPLICATE, Add disabled.
 *   - Add (clean + new): calls `stageDomainAdd(raw)`, clears the field on
 *     `{ ok:true }`, and the new row appears staged (`alwaysOn:true`).
 *   - Add guarded: Add disabled for empty/invalid/duplicate — cannot fire.
 *   - Return in field (clean): fires Add (same as pressing Add).
 *
 * Mocking `stageDomainAdd`: rather than `jest.spyOn(useDomainStore.getState(),
 * 'stageDomainAdd')` (which is fragile across tests because Zustand v5 re-runs
 * the selector on every render via `useSyncExternalStore`, so the spy must be
 * in place before the initial render AND must reliably call through), we
 * install a `jest.fn` wrapper via `useDomainStore.setState({ stageDomainAdd })`
 * AFTER `seedState`. `seedState` always restores the REAL action (captured once
 * at module load) so a mock can never leak into the next test. The wrapper's
 * implementation calls the real action so the staged state still updates.
 *
 * The field is located by its contract props (`onChangeText` fn + `value`),
 * NOT by `findByType(TextInput)` — under pnpm + RN 0.81's lazy component
 * getters the imported `TextInput` is not identity-equal to the one in the
 * rendered tree, so `findByType` finds nothing. The prop-based query is the
 * stable pattern used across the 1.2/1.3/2.1 tests. Text is read via
 * `extractText`.
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
import type { TextInput as TextInputType } from 'react-native';
import { AddDomain } from '../src/components/AddDomain';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain } from '../src/config/types';
import type { WriteResult } from '../src/hosts/shellRunner';

// The REAL `stageDomainAdd`, captured once at module load. `seedState` always
// restores this on the store so a `jest.fn` wrapper installed by a test can
// never leak into the next test (Zustand v5 setState spreads the current
// state, so without an explicit restore a mock would survive `seedState`).
const REAL_STAGE_DOMAIN_ADD = useDomainStore.getState().stageDomainAdd;

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
 * Locate the add field by its contract props: a node with an `onChangeText`
 * function and a `value` string. The RN jest preset renders TextInput as a
 * host component that spreads these props, so this is the stable finder (same
 * reason the 2.1 tests find checkboxes by `onPress` + `accessibilityRole`
 * rather than `findByType`).
 */
function findField(root: ReactTestRenderer.ReactTestInstance) {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/**
 * Locate the Add button by `accessibilityRole: 'button'` + `onPress` +
 * `accessibilityLabel: 'Add'` — the same prop-based query the 2.1 Blocklist
 * tests use for the Apply/Cancel buttons.
 */
function findAddButton(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Add',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Seeds the store state for a test (and restores the real `stageDomainAdd`). */
function seedState(overrides: {
  domains?: Domain[];
  staged?: Domain[] | null;
}): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? DEFAULT_CONFIG.domains,
      },
      staged: overrides.staged ?? null,
      applyStatus: 'idle',
      lastResult: null,
      drift: null,
      // Always restore the real action so a previous test's `jest.fn` wrapper
      // cannot leak into this test.
      stageDomainAdd: REAL_STAGE_DOMAIN_ADD,
    });
  });
}

/**
 * Install a `stageDomainAdd` mock on the store. Pass `callThrough: true` to
 * have the mock delegate to the real action (so the staged state still
 * updates); pass `callThrough: false` (default) for a mock that returns a safe
 * `{ ok: false }` (matching the real `WriteResult` contract) — used by the
 * guard tests where `handleAdd` early-returns and the action is never called
 * anyway. Returning `{ ok: false }` instead of `undefined` keeps the mock
 * honest about its runtime type: if a guard ever fails to early-return,
 * `handleAdd`'s `result.ok` access reads `false` (and the test fails on the
 * `expect(stageSpy).not.toHaveBeenCalled()` assertion) rather than throwing a
 * `TypeError` that masks the real failure. Returns the mock for assertions.
 */
function mockStageAdd(callThrough: boolean): jest.Mock<WriteResult, [string]> {
  const impl = callThrough
    ? (raw: string): WriteResult => REAL_STAGE_DOMAIN_ADD(raw)
    : (): WriteResult => ({ ok: false });
  const mock = jest.fn(impl) as unknown as jest.Mock<WriteResult, [string]>;
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ stageDomainAdd: mock });
  });
  return mock;
}

// Track the current renderer so afterEach can unmount it, fully releasing the
// store subscription so it cannot re-render on a later test's seedState.
let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
});

function renderAddDomain() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<AddDomain />);
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

/** Type into the field by dispatching `onChangeText` (simulates user typing). */
function typeInto(
  testRenderer: ReturnType<typeof ReactTestRenderer.create>,
  text: string,
) {
  const field = findField(testRenderer.root);
  ReactTestRenderer.act(() => {
    field.props.onChangeText(text);
  });
}

// ---------------------------------------------------------------------------
// Empty input: no preview, no error, Add disabled
// ---------------------------------------------------------------------------

test('empty input: no preview, no error, and Add is disabled', () => {
  seedState({ domains: [] });
  const testRenderer = renderAddDomain();

  const text = extractText(testRenderer.toJSON());
  // No normalised preview and no error message for an idle empty field.
  expect(text).not.toContain('→');
  expect(text).not.toContain('Invalid domain');
  expect(text).not.toContain('Already in your list');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
  // Story 2.3 added the `busy` prop to ApplyButton's accessibilityState.
  expect(add.props.accessibilityState).toEqual({ disabled: true, busy: false });
});

test('whitespace-only input is treated as idle: no preview, no error, Add disabled', () => {
  // The component distinguishes `isEmpty` (trimmed === '') from invalid, so a
  // whitespace-only input must NOT surface the "Invalid domain" error — it
  // reads as an idle field, same as empty. Pins the whitespace branch that
  // `normaliseDomain`'s trim would otherwise classify as null/invalid.
  seedState({ domains: [] });
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, '   ');

  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain('→');
  expect(text).not.toContain('Invalid domain');
  expect(text).not.toContain('Already in your list');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Typing valid + new: preview -> example.com, no error, Add enabled
// ---------------------------------------------------------------------------

test('typing a valid new domain shows the normalised preview and enables Add', () => {
  seedState({ domains: [] });
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'https://www.Example.COM/path');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('→ example.com');
  expect(text).not.toContain('Invalid domain');
  expect(text).not.toContain('Already in your list');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(false);
  expect(add.props.accessibilityState).toEqual({ disabled: false, busy: false });
});

// ---------------------------------------------------------------------------
// Typing invalid: no preview, error INVALID, Add disabled
// ---------------------------------------------------------------------------

test('typing an invalid domain shows the invalid error, no preview, and disables Add', () => {
  seedState({ domains: [] });
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'not a domain');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Invalid domain. Try `example.com`.');
  // No normalised preview for invalid input.
  expect(text).not.toContain('→');
  expect(text).not.toContain('Already in your list');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Typing duplicate: preview -> example.com, error DUPLICATE, Add disabled
// ---------------------------------------------------------------------------

test('typing a duplicate of a committed domain shows the preview, the duplicate error, and disables Add', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
  });
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'example.com');

  const text = extractText(testRenderer.toJSON());
  // The preview still shows for a duplicate (the input normalises fine).
  expect(text).toContain('→ example.com');
  expect(text).toContain('Already in your list.');
  expect(text).not.toContain('Invalid domain');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
});

test('typing a duplicate of a STAGED domain shows the duplicate error and disables Add', () => {
  // committed is empty, but a staged draft already holds `social.com`. The UI
  // gate must check `staged ?? committed.domains`, so a staged-only duplicate
  // is caught too.
  seedState({
    domains: [],
    staged: [{ hostname: 'social.com', alwaysOn: true }],
  });
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'social.com');

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Already in your list.');
  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Add (clean + new): calls stageDomainAdd(raw), clears the field, new row staged
// ---------------------------------------------------------------------------

test('pressing Add with clean input calls stageDomainAdd with the RAW input, clears the field, and stages the domain alwaysOn:true', () => {
  seedState({ domains: [] });
  // callThrough so the real action stages the domain (the staged state is
  // asserted below) while the mock records the call.
  const stageSpy = mockStageAdd(true);
  const testRenderer = renderAddDomain();
  // Type a raw URL so we can assert `stageDomainAdd` receives the RAW string
  // (the store normalises internally — the UI must NOT pre-normalise).
  typeInto(testRenderer, 'https://www.Example.COM/path');

  const add = findAddButton(testRenderer.root);
  ReactTestRenderer.act(() => {
    add.props.onPress();
  });

  // Called with the raw input, not the normalised apex.
  expect(stageSpy).toHaveBeenCalledTimes(1);
  expect(stageSpy).toHaveBeenCalledWith('https://www.Example.COM/path');

  // The real action (via the wrapper) staged the normalised domain as
  // alwaysOn:true.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);

  // The field cleared on success (preview + error are derived, so they clear
  // with it).
  const fieldAfter = findField(testRenderer.root);
  expect(fieldAfter.props.value).toBe('');
  const textAfter = extractText(testRenderer.toJSON());
  expect(textAfter).not.toContain('→');
  expect(textAfter).not.toContain('Invalid domain');
});

test('a duplicate Add never fires: pressing Add on a duplicate does not call stageDomainAdd and does not clear the field', () => {
  // The UI gate disables Add for a duplicate; but even if `onPress` were
  // invoked (e.g. via accessibility tooling), `handleAdd` early-returns when
  // `!addEnabled`, so stageDomainAdd is NOT called and the field is NOT
  // cleared. This is the UI gate the spec requires. The mock returns a safe
  // `{ ok: false }` (not undefined) so any accidental call would surface as a
  // recorded call here without a masking TypeError.
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
  });
  const stageSpy = mockStageAdd(false);
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'example.com');

  const add = findAddButton(testRenderer.root);
  // Add is disabled by the gate.
  expect(add.props.disabled).toBe(true);
  // Invoke onPress anyway — must be a no-op.
  ReactTestRenderer.act(() => {
    add.props.onPress();
  });

  expect(stageSpy).not.toHaveBeenCalled();
  // Field retains the typed value (not cleared).
  const fieldAfter = findField(testRenderer.root);
  expect(fieldAfter.props.value).toBe('example.com');
});

test('an invalid Add never fires: pressing Add on invalid input does not call stageDomainAdd', () => {
  seedState({ domains: [] });
  const stageSpy = mockStageAdd(false);
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'nope');

  const add = findAddButton(testRenderer.root);
  expect(add.props.disabled).toBe(true);
  ReactTestRenderer.act(() => {
    add.props.onPress();
  });

  expect(stageSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Return in field (clean) fires Add
// ---------------------------------------------------------------------------

test('Return in the field with clean input fires Add (calls stageDomainAdd and clears the field)', () => {
  seedState({ domains: [] });
  const stageSpy = mockStageAdd(true);
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'example.com');

  const field = findField(testRenderer.root);
  // `submitBehavior="submit"` is what keeps the field focused after a Return
  // (no blur) so the user can immediately type the next domain — the closest
  // testable proxy for the no-blur behaviour, since the blur itself is a
  // native-runtime effect not observable in the node jest env.
  expect(field.props.submitBehavior).toBe('submit');
  // `onSubmitEditing` is what Return fires on a single-line TextInput. The
  // handler reads `raw` from state (not the event), so the event shape does
  // not matter — only that the submit fires.
  ReactTestRenderer.act(() => {
    field.props.onSubmitEditing({ nativeEvent: { text: 'example.com' } });
  });

  expect(stageSpy).toHaveBeenCalledTimes(1);
  expect(stageSpy).toHaveBeenCalledWith('example.com');
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'example.com', alwaysOn: true },
  ]);
  // Field cleared on success.
  expect(findField(testRenderer.root).props.value).toBe('');
});

test('Return in the field with INVALID input does NOT fire Add (handleAdd early-returns)', () => {
  seedState({ domains: [] });
  const stageSpy = mockStageAdd(false);
  const testRenderer = renderAddDomain();
  typeInto(testRenderer, 'not a domain');

  const field = findField(testRenderer.root);
  ReactTestRenderer.act(() => {
    field.props.onSubmitEditing({ nativeEvent: { text: 'not a domain' } });
  });

  expect(stageSpy).not.toHaveBeenCalled();
  // Field retains the invalid input — not cleared.
  expect(findField(testRenderer.root).props.value).toBe('not a domain');
});

// ---------------------------------------------------------------------------
// forwardRef: exposes the TextInput ref (for ⌘N focus)
// ---------------------------------------------------------------------------

test('AddDomain forwards a ref to the underlying TextInput (for ⌘N focus)', () => {
  seedState({ domains: [] });
  const ref = React.createRef<TextInputType>();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<AddDomain ref={ref} />);
  });
  currentRenderer = testRenderer;

  // The forwarded ref attaches to the underlying TextInput host instance.
  // The actual `.focus()` call is a native-runtime method not exercised in the
  // node jest env (same caveat as the 2.1 row-focus tests), so we assert the
  // ref ATTACHES — proving the forwardRef wiring the Shell's ⌘N handler relies
  // on (`addFieldRef.current?.focus()`).
  expect(ref.current).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Story 2.3 — onFocusChange: reports focus/blur to the Shell so it can gate
// bare Return -> Apply (the focused field owns Return -> Add). The focus()
// call + isFocused() are native-runtime and not unit-testable in the node jest
// env, so we assert the CALLBACK WIRING: invoking the TextInput's `onFocus` /
// `onBlur` props fires the Shell-passed `onFocusChange` with true / false.
// ---------------------------------------------------------------------------

test('onFocusChange is invoked with true on the field onFocus and false on onBlur', () => {
  seedState({ domains: [] });
  const onFocusChange = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <AddDomain onFocusChange={onFocusChange} />,
    );
  });
  currentRenderer = testRenderer;

  const field = findField(testRenderer.root);
  expect(typeof field.props.onFocus).toBe('function');
  expect(typeof field.props.onBlur).toBe('function');

  // Focus the field -> the callback fires with true.
  ReactTestRenderer.act(() => {
    field.props.onFocus();
  });
  expect(onFocusChange).toHaveBeenCalledWith(true);

  // Blur the field -> the callback fires with false.
  ReactTestRenderer.act(() => {
    field.props.onBlur();
  });
  expect(onFocusChange).toHaveBeenCalledWith(false);

  // Exactly two calls total (one focus, one blur).
  expect(onFocusChange).toHaveBeenCalledTimes(2);
});

test('onFocusChange is optional: omitting it does not break onFocus/onBlur (no throw)', () => {
  // The prop is optional; the field's onFocus/onBlur use `onFocusChange?.(...)`
  // so a render without the prop must not throw when focus/blur fire.
  seedState({ domains: [] });
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<AddDomain />);
  });
  currentRenderer = testRenderer;

  const field = findField(testRenderer.root);
  // Invoking onFocus/onBlur with no callback wired must not throw.
  expect(() => {
    ReactTestRenderer.act(() => {
      field.props.onFocus();
      field.props.onBlur();
    });
  }).not.toThrow();
});