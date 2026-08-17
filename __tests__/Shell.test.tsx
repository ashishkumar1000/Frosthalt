/**
 * @format
 */

// Shell now imports the Blocklist surface (Story 2.1), which pulls in the
// domain store -> configStore -> NativeConfigStoreSpec TurboModule. The
// TurboModule is not registered in the jest node env, so the spec's
// `TurboModuleRegistry.getEnforcing(...)` throws at module load. Mock both
// native specs (the store.test.ts:21-35 / Blocklist.test.tsx seam) so the
// transitive import resolves. The Shell tests themselves do not exercise the
// store — they assert sidebar nav, keyboard handling, and the status header.
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

// Story 2.3 — ApplyButton's pulse is the codebase's first `useNativeDriver:
// true` animation (`Animated.createAnimatedComponent(Pressable)`). The Shell
// Return -> Apply tests trigger a Shell re-render via `setAddFieldFocused`
// (driven through the AddDomain `onFocusChange` callback), which re-renders
// Blocklist -> ApplyButton. Re-rendering an `Animated.createAnimatedComponent`
// host in the node jest env hits a pre-existing react 19.1.4 vs
// react-native 0.81.2 renderer version mismatch (the lazy re-require of the
// `-dev` renderer throws a version-check error). The Shell tests do NOT assert
// anything about the pulse — they assert `apply()` fires (or doesn't) on bare
// Return — so we mock ApplyButton as a plain Pressable that forwards the
// contract props (`onPress` + `accessibilityRole:'button'` + `accessibilityLabel`
// + `accessibilityState`). The `pulse`/`busy` prop WIRING is asserted in
// `Blocklist.test.tsx`, which renders the real ApplyButton once (no re-render)
// and so does not hit the animated re-render path.
jest.mock('../src/components/ApplyButton', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const ApplyButton = (props: {
    label: string;
    onPress: () => void;
    onPressIn?: () => void;
    onPressOut?: () => void;
    disabled?: boolean;
    busy?: boolean;
    pulse?: boolean;
  }) =>
    React.createElement(
      Pressable,
      {
        onPress: props.onPress,
        onPressIn: props.onPressIn,
        onPressOut: props.onPressOut,
        disabled: props.disabled,
        accessibilityRole: 'button',
        accessibilityLabel: props.label,
        accessibilityState: { disabled: !!props.disabled, busy: !!props.busy },
      },
      React.createElement(Text, null, props.label),
    );
  return { __esModule: true, ApplyButton };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Shell } from '../src/components/Shell';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain } from '../src/config/types';
import type { WriteResult } from '../src/hosts/shellRunner';

// The REAL `apply`, captured once at module load. The Return -> Apply tests
// install a `jest.fn` wrapper via `useDomainStore.setState({ apply })` (the
// AddDomain `mockStageAdd` pattern — NOT `jest.spyOn`, which is fragile under
// Zustand v5's `useSyncExternalStore` re-runs). `seedState` always restores the
// real action so a mock can never leak into the next test.
const REAL_APPLY = useDomainStore.getState().apply;

// The react-native jest preset auto-mocks `announceForAccessibility`
// as a `jest.fn()`, but the TypeScript type from react-native-macos's types is
// `(announcement: string) => void` (no Jest mock members). Cast once to a
// `jest.Mock` so `.mockClear()` / `.toHaveBeenCalledWith(...)` type-check.
const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

// The shell reads safe-area insets via `useSafeAreaInsets`, so the test renders
// it inside a `SafeAreaProvider` — exactly as `App.tsx` does in production. The
// react-native jest preset mocks the safe-area native module's onInsetsChange
// (it never fires in the test env), so the provider would otherwise render
// `null` children while `insets` is null. Passing `initialSafeAreaInsets`
// seeds the provider with zero insets, making the children render — the same
// trick App.test.tsx relies on App's provider for, made explicit here so the
// shell subtree is actually present for assertions.
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

// Track the current renderer so afterEach can unmount it, fully releasing the
// store subscription so it cannot re-render on a later test's setState. This
// matters for Story 2.3: a leftover Shell renderer subscribed to the store
// would re-render with `pulse: true` when a later test seeds `staged`, firing
// the ApplyButton pulse effect's native-animated connection during the act
// flush (which has no native animated runtime in the node jest env). Unmounting
// per test keeps exactly one renderer alive at a time — the same discipline the
// Blocklist/AddDomain tests use.
let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
});

function renderShell() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <SafeAreaProvider initialSafeAreaInsets={ZERO_INSETS}>
        <Shell />
      </SafeAreaProvider>,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// Locate sidebar rows by their contract props (`onPress` fn +
// `accessibilityRole: 'button'` + a `selected` accessibilityState) — NOT by
// `findByType(Pressable)`. Under pnpm + RN 0.81's lazy component getters the
// imported `Pressable` is not identity-equal to the one in the rendered tree,
// so `findByType(Pressable)` finds nothing. The prop-based query is stable and
// says exactly what we mean: "the row elements carrying the press handler."
//
// The `accessibilityState.selected` discriminator was added in Story 2.2:
// the Blocklist surface now renders an "Add" button (`ApplyButton`,
// `accessibilityRole:'button'`) inside the empty state, so a bare
// `onPress + accessibilityRole:'button'` query would also match that action
// button. Sidebar rows carry `accessibilityState={{ selected }}` (always a
// boolean); action buttons carry `accessibilityState={{ disabled }}` with no
// `selected` key — so requiring `selected` to be present keeps the query
// pinned to the four sidebar rows.
function findRows(root: ReactTestRenderer.ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityState != null &&
      'selected' in node.props.accessibilityState,
  );
}

/**
 * The focusable root View carries `onKeyDown` + `keyDownEvents` + `focusable`.
 * Located by that triple. The RN jest preset's `View` mock spreads the root's
 * props onto the host child it renders, so the predicate can double-match the
 * root View and that spread-prop descendant — `findAll` returns them in
 * document order and the outermost (true root) is first, so `matches[0]` is
 * the shell root. This is the same spread-prop quirk the 1.2 Design Notes
 * warned about for `findAll(accessibilityLabel)` counts.
 */
function findKeyDownContainer(root: ReactTestRenderer.ReactTestInstance) {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onKeyDown === 'function' &&
      Array.isArray(node.props.keyDownEvents) &&
      node.props.focusable === true,
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Counts rows currently marked selected via `accessibilityState.selected`. */
function selectedRowCount(rows: ReactTestRenderer.ReactTestInstance[]) {
  return rows.filter((r) => r.props.accessibilityState?.selected === true)
    .length;
}

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

// AC: a left sidebar with four rows (Blocklist/Timer/Schedule/Settings)
// renders.
test('Shell renders exactly four sidebar rows in the fixed order', async () => {
  const testRenderer = renderShell();
  const rows = findRows(testRenderer.root);
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
    'Blocklist',
    'Timer',
    'Schedule',
    'Settings',
  ]);
});

// I/O Matrix: Initial mount — Blocklist (row 0) is the default active surface
// and receives keyboard focus on mount; exactly one row is active.
test('Shell mounts with Blocklist (row 0) active and exactly one row selected', async () => {
  const testRenderer = renderShell();
  const rows = findRows(testRenderer.root);
  expect(selectedRowCount(rows)).toBe(1);
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  // Row 0 also receives keyboard focus on mount via the mount effect's
  // ref.focus() — a native-runtime behavior not unit-testable in the node
  // jest env (see the Matrix Test Audit), so it is not asserted here.
});

// I/O Matrix: Sidebar row click — row becomes active, content swaps to that
// surface, exactly one row active.
test('clicking a sidebar row selects it and swaps the content to that surface', async () => {
  const testRenderer = renderShell();
  const rows = findRows(testRenderer.root);

  // Click the Timer row (index 1).
  await ReactTestRenderer.act(() => {
    rows[1].props.onPress();
  });
  let json = testRenderer.toJSON();
  expect(extractText(json)).toContain('No timer running');
  // Exactly one row active, and it is the Timer row.
  const rowsAfterTimer = findRows(testRenderer.root);
  expect(selectedRowCount(rowsAfterTimer)).toBe(1);
  expect(rowsAfterTimer[1].props.accessibilityState?.selected).toBe(true);

  // Click the Settings row (index 3) — content swaps again.
  await ReactTestRenderer.act(() => {
    rowsAfterTimer[3].props.onPress();
  });
  json = testRenderer.toJSON();
  expect(extractText(json)).toContain('App settings will appear here');
  const rowsAfterSettings = findRows(testRenderer.root);
  expect(selectedRowCount(rowsAfterSettings)).toBe(1);
  expect(rowsAfterSettings[3].props.accessibilityState?.selected).toBe(true);
});

// I/O Matrix: ⌘1-⌘4 nav — selects row 0/1/2/3, calls
// `announceForAccessibility("<Surface>, 0 domains")`.
test('⌘2 selects row 1 (Timer), moves focus, and announces the surface', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });

  const rows = findRows(testRenderer.root);
  expect(rows[1].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
  expect(extractText(testRenderer.toJSON())).toContain('No timer running');
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Timer, 0 domains',
  );
});

test('⌘4 selects row 3 (Settings) and announces "Settings, 0 domains"', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '4' } });
  });

  const rows = findRows(testRenderer.root);
  expect(rows[3].props.accessibilityState?.selected).toBe(true);
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Settings, 0 domains',
  );
});

// I/O Matrix: ⌘1-⌘4 nav — ⌘1 selects row 0 (Blocklist). Row 0 is the default
// on mount, so navigate away first (⌘2) then back (⌘1) to prove ⌘1 is a real
// change, not a no-op on the already-selected row.
test('⌘1 selects row 0 (Blocklist) and announces "Blocklist, 0 domains"', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Move off the default row 0 first.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });
  announceForAccessibility.mockClear();

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '1' } });
  });

  const rows = findRows(testRenderer.root);
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Blocklist, 0 domains',
  );
});

// I/O Matrix: ⌘3 selects row 2 (Schedule) and announces the surface.
test('⌘3 selects row 2 (Schedule) and announces "Schedule, 0 domains"', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });

  const rows = findRows(testRenderer.root);
  expect(rows[2].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
  expect(extractText(testRenderer.toJSON())).toContain('No schedule set');
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Schedule, 0 domains',
  );
});

// I/O Matrix: Plain number (no ⌘) does NOT navigate.
test('a plain number key without ⌘ does not navigate', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  // The Blocklist surface (row 0 is active on mount) fires its own mount
  // announce ("Blocklist, N domains, M always-on") on render — clear it AFTER
  // render so this test isolates the Shell's keyDown announce behaviour
  // (which is what this matrix row is about: a plain key must NOT make the
  // Shell announce).
  announceForAccessibility.mockClear();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: '2' } });
  });

  const rows = findRows(testRenderer.root);
  // Row 0 (Blocklist) stays active — no navigation occurred.
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
  expect(announceForAccessibility).not.toHaveBeenCalled();
});

// I/O Matrix: ⌘ with non-1-4 key — no row change, no announce.
test('⌘ with a key outside 1-4 does not navigate', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  // Clear the Blocklist mount announce after render so the assertion isolates
  // the Shell's keyDown announce behaviour (see the plain-number test above).
  announceForAccessibility.mockClear();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'b' } });
  });

  const rows = findRows(testRenderer.root);
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  expect(announceForAccessibility).not.toHaveBeenCalled();
});

// I/O Matrix: Status header on every surface — header renders the "Free"
// badge + "0 domains" + "no active timer" above the content.
test('the status header renders the Free badge and the static placeholders', async () => {
  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('0 domains');
  expect(text).toContain('no active timer');
});

// AC: the status header stays present across every surface.
test('the status header is present on every selected surface', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  for (const key of ['1', '2', '3', '4']) {
    await ReactTestRenderer.act(() => {
      container.props.onKeyDown({ nativeEvent: { metaKey: true, key } });
    });
    const text = extractText(testRenderer.toJSON());
    expect(text).toContain('Free');
    expect(text).toContain('0 domains');
    expect(text).toContain('no active timer');
  }
});

// AC: the focusable container declares ⌘1-⌘4 + ⌘N as handled key events (so
// the native default does not swallow them) and is focusable (so the bubbled
// key events reach the handler from the focused row). ⌘N (focus the add field,
// Story 2.2) was added to the handled set so Return-in-field works after ⌘N.
test('the shell root is focusable and declares ⌘1-⌘4 + ⌘N as handled key events', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.focusable).toBe(true);
  expect(container.props.keyDownEvents).toEqual([
    { key: '1', metaKey: true },
    { key: '2', metaKey: true },
    { key: '3', metaKey: true },
    { key: '4', metaKey: true },
    { key: 'n', metaKey: true },
    // Story 2.3 — bare Return / Enter fire Apply on surface 0 when the add
    // field is blurred and a staged draft exists.
    { key: 'Return' },
    { key: 'Enter' },
  ]);
});

// Story 2.2 — ⌘N is declared in `keyDownEvents` so the native layer does not
// swallow it before the Shell's `onKeyDown` can focus the add field. The
// `addFieldRef.current?.focus()` call itself is native-runtime and not
// unit-testable in the node jest env (same caveat as the 2.1 row-focus tests),
// so this asserts the DECLARATION (the part that is testable here).
test('⌘N is declared in keyDownEvents (focus the add field)', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.keyDownEvents).toContainEqual({
    key: 'n',
    metaKey: true,
  });
});

// Story 2.2 — ⌘N does NOT navigate away from the surface and does NOT announce
// (it is a focus shortcut, not navigation). Guards against an `onKeyDown`
// branch that accidentally falls through to `selectRow` or announces.
test('⌘N does not navigate away and does not announce (focus-only shortcut)', async () => {
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  // Clear the Blocklist mount announce after render so the assertion isolates
  // the keyDown behaviour.
  announceForAccessibility.mockClear();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'n' } });
  });

  const rows = findRows(testRenderer.root);
  // Still on row 0 (Blocklist) — ⌘N did not change the surface.
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
  // ⌘N is focus-only — no VoiceOver announcement.
  expect(announceForAccessibility).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Story 2.1 integration: the Shell renders the Blocklist surface content
// (title + domain rows + checkboxes) for surface 0, not the placeholder.
// `Blocklist.test.tsx` renders <Blocklist/> directly and bypasses the Shell;
// this pins the Shell -> Blocklist wiring at Shell.tsx:95 so reverting that
// one line to <SurfacePlaceholder/> fails here. Also covers the
// navigate-away-then-back remount path, not just the initial mount.
// ---------------------------------------------------------------------------

test('Shell renders the Blocklist surface content (not the placeholder) on surface 0', async () => {
  // Seed the store with one committed domain so a row + checkbox render.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'example.com', alwaysOn: true }],
      },
    });
  });

  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());
  // The Blocklist surface title + the committed hostname are present.
  expect(text).toContain('Blocklist');
  expect(text).toContain('example.com');
  // A checkbox for the domain row is present — the placeholder renders none.
  const checkboxes = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'checkbox',
  );
  expect(checkboxes.length).toBeGreaterThanOrEqual(1);

  // The AddDomain field (Story 2.2) is present on the composed surface 0 — a
  // node with `onChangeText` fn + `value` string (the TextInput host spreads
  // these). Regression guard: catches AddDomain disappearing from the
  // composed surface.
  const addFields = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  );
  expect(addFields.length).toBeGreaterThanOrEqual(1);

  // Navigate away to Timer (surface 1) then back to Blocklist (surface 0)
  // via ⌘2 then ⌘1 — the Blocklist surface must remount and re-render its
  // content (pins the navigate-away-and-back path, not just the mount).
  const container = findKeyDownContainer(testRenderer.root);
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });
  expect(extractText(testRenderer.toJSON())).toContain('No timer running');

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '1' } });
  });
  const textAfterReturn = extractText(testRenderer.toJSON());
  expect(textAfterReturn).toContain('Blocklist');
  expect(textAfterReturn).toContain('example.com');
  // The AddDomain field re-renders after the navigate-away-and-back remount.
  expect(
    testRenderer.root.findAll(
      (node) =>
        node.props &&
        typeof node.props.onChangeText === 'function' &&
        typeof node.props.value === 'string',
    ).length,
  ).toBeGreaterThanOrEqual(1);

  // Restore the empty baseline so this seed does not leak into other suites
  // that share the module-level store instance.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// ===========================================================================
// Story 2.3 — Return -> Apply: bare Return / Enter fire `apply()` on the
// Blocklist surface (surface 0) when the add field is blurred and a staged
// draft exists. The add field ALWAYS owns Return when focused (its
// `onSubmitEditing` -> Add); `addFieldFocused` is tracked via the AddDomain
// `onFocusChange` callback so the gate is deterministic and unit-testable.
// ===========================================================================

/**
 * Seed the store for a Return -> Apply test: committed with one domain, an
 * optional staged draft, and the REAL `apply` restored (so a previous test's
 * mock can never leak). Returns nothing; callers then install the mock via
 * `mockApply()` if they want to assert on calls.
 */
function seedForReturn(overrides: {
  domains?: Domain[];
  staged?: Domain[] | null;
}): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? [{ hostname: 'example.com', alwaysOn: true }],
      },
      staged: overrides.staged ?? null,
      applyStatus: 'idle',
      lastResult: null,
      // Always restore the real action so a previous test's mock cannot leak.
      apply: REAL_APPLY,
    });
  });
}

/**
 * Install a `jest.fn` mock for `apply` on the store (records calls; returns a
 * resolved `{ ok: true }` so `void apply()` does not crash). The AddDomain
 * `mockStageAdd` setState-wrapper pattern — NOT `jest.spyOn`, which is fragile
 * under Zustand v5's `useSyncExternalStore` re-runs. `seedForReturn` restores
 * the real action so the mock never leaks.
 */
function mockApply(): jest.Mock<Promise<WriteResult>, []> {
  const mock = jest.fn(() => Promise.resolve({ ok: true } as WriteResult)) as
    unknown as jest.Mock<Promise<WriteResult>, []>;
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ apply: mock });
  });
  return mock;
}

/** Locate the add field by its contract props (onChangeText fn + value string). */
function findAddFieldIn(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  )[0];
}

// AC: bare Return + Enter are declared in `keyDownEvents` (so the native layer
// does not swallow them before the Shell's `onKeyDown` can fire Apply). Two
// separate `toContainEqual` assertions so a missing one names which key.
test('bare Return is declared in keyDownEvents (so the native default does not swallow it)', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.keyDownEvents).toContainEqual({ key: 'Return' });
});

test('bare Enter is declared in keyDownEvents (so the native default does not swallow it)', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.keyDownEvents).toContainEqual({ key: 'Enter' });
});

// I/O Matrix: Return (field blurred, staged) -> apply() fires.
test('bare Return on surface 0 with the field blurred and staged != null fires apply()', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    // Flush the `void apply()` microtask so the mock is settled.
    await Promise.resolve();
  });

  expect(applyMock).toHaveBeenCalledTimes(1);
});

test('bare Enter on surface 0 with the field blurred and staged != null fires apply()', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Enter' } });
    await Promise.resolve();
  });

  expect(applyMock).toHaveBeenCalledTimes(1);
});

// I/O Matrix: Return (field focused) -> Add owns Return; apply() NOT fired.
// The `addFieldFocused` state is driven via the AddDomain `onFocusChange` prop
// the Shell passes through Blocklist (find the field, invoke its `onFocus`).
test('bare Return does NOT fire apply() when the add field is focused (the field owns Return -> Add)', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  // Drive addFieldFocused=true via the AddDomain onFocusChange callback the
  // Shell wires through Blocklist — the deterministic, unit-testable path
  // (no reliance on uncertain Return bubble semantics).
  const field = findAddFieldIn(testRenderer.root);
  expect(field).toBeDefined();
  ReactTestRenderer.act(() => {
    field!.props.onFocus();
  });

  const container = findKeyDownContainer(testRenderer.root);
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// I/O Matrix: Return (no staged) -> nothing. apply() short-circuits at call
// time; but the Shell's branch is guarded by `staged != null`, so apply() is
// not even called when staged is null.
test('bare Return does NOT fire apply() when staged == null (nothing staged)', async () => {
  seedForReturn({ staged: null });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// I/O Matrix: Return (other surface) -> nothing (no Apply on Timer/Schedule/
// Settings). Navigate to surface 1 (Timer) via ⌘2 first, then Return.
test('bare Return on surface 1 (Timer) does NOT fire apply()', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  // Navigate to Timer (surface 1) first.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });
  // Confirm we left surface 0.
  expect(extractText(testRenderer.toJSON())).toContain('No timer running');

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// ⌘Return must NOT fire apply() — the spec's "bare Return only, matching the
// default-button contract" Never clause. Guards against an `onKeyDown` branch
// that accidentally ignores `metaKey` for Return.
test('⌘Return does NOT fire apply() (bare Return only — the default-button contract)', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// ⌘N + empty + staged + Return -> Add no-op (field owns Return); apply() NOT
// fired (the documented focus-context edge from the spec's matrix). ⌘N focuses
// the field (tracked via onFocusChange), so the field owns Return and Apply
// does not fire.
test('after ⌘N focuses the field, bare Return does NOT fire apply() (field owns Return)', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  // ⌘N focuses the add field. The focus() call is native-runtime (not exercised
  // in the node jest env), but the field's onFocus fires setAddFieldFocused(true)
  // — so we simulate the focus event the native focus() would trigger by
  // invoking the field's onFocus directly (the deterministic test proxy for the
  // native focus side-effect, same as the AddDomain onFocusChange test).
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'n' } });
  });
  // The ⌘N handler calls addFieldRef.current?.focus(); the native focus would
  // fire the field's onFocus -> setAddFieldFocused(true). Simulate that:
  const field = findAddFieldIn(testRenderer.root);
  expect(field).toBeDefined();
  ReactTestRenderer.act(() => {
    field!.props.onFocus();
  });

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// Regression guard (Story 2.3 PATCH): navigating away while the add field is
// focused, then back to surface 0, must NOT leave `addFieldFocused` stale-true.
// In the native runtime the field's `onBlur` is queued async by
// RCTEventDispatcher; when ⌘2 unmounts <Blocklist> the TextInput is destroyed
// before the queued blur fires, so `onFocusChange(false)` never runs. Without
// the `selectRow` reset, navigating back mounts a fresh, unfocused field whose
// `onFocus` also does not fire — so `addFieldFocused` stays stale-true and bare
// Return -> Apply silently stops working. The fix resets it in `selectRow`.
// This test drives the round-trip-with-focus path (focus -> ⌘2 -> ⌘1 -> Return)
// and asserts apply() fires, proving the stale-true state was cleared.
test('after focus -> navigate-away -> navigate-back, bare Return fires apply() (no stale addFieldFocused)', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Focus the add field (addFieldFocused -> true), mirroring a user clicking it.
  const field = findAddFieldIn(testRenderer.root);
  expect(field).toBeDefined();
  ReactTestRenderer.act(() => {
    field!.props.onFocus();
  });

  // Navigate away to Timer (surface 1) — this unmounts <Blocklist> and its
  // TextInput; the fix resets addFieldFocused=false in selectRow.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });
  expect(extractText(testRenderer.toJSON())).toContain('No timer running');

  // Navigate back to Blocklist (surface 0) — a fresh TextInput mounts; it is NOT
  // focused, so no onFocus fires. The fix's selectRow reset keeps
  // addFieldFocused=false; without it the stale-true from the focused field
  // would persist and gate bare Return off.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '1' } });
  });
  expect(extractText(testRenderer.toJSON())).toContain('example.com');

  // Bare Return must fire apply() — the regression. If addFieldFocused were
  // stale-true, the gate `!addFieldFocused` would be false and apply() would NOT
  // fire (the bug the PATCH fixes).
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).toHaveBeenCalledTimes(1);
});

// Restore the real apply after the Return -> Apply test module's last test, so
// no mock leaks into suites that share the module-level store instance. (Each
// `seedForReturn` also restores, but this is a belt-and-braces cleanup for the
// shared store.)
afterAll(() => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      apply: REAL_APPLY,
      committed: { ...DEFAULT_CONFIG },
      staged: null,
    });
  });
});