/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Shell } from '../src/components/Shell';

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

function renderShell() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <SafeAreaProvider initialSafeAreaInsets={ZERO_INSETS}>
        <Shell />
      </SafeAreaProvider>,
    );
  });
  return testRenderer;
}

// Locate sidebar rows by their contract props (`onPress` fn +
// `accessibilityRole: 'button'`) — NOT by `findByType(Pressable)`. Under pnpm +
// RN 0.81's lazy component getters the imported `Pressable` is not
// identity-equal to the one in the rendered tree, so `findByType(Pressable)`
// finds nothing. The prop-based query is stable and says exactly what we
// mean: "the row elements carrying the press handler." See the ApplyButton /
// StatusBadge tests in 1.2 for the same pattern.
function findRows(root: ReactTestRenderer.ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button',
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

// AC: the focusable container declares ⌘1-⌘4 as handled key events (so the
// native default does not swallow them) and is focusable (so the bubbled key
// events reach the handler from the focused row).
test('the shell root is focusable and declares ⌘1-⌘4 as handled key events', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.focusable).toBe(true);
  expect(container.props.keyDownEvents).toEqual([
    { key: '1', metaKey: true },
    { key: '2', metaKey: true },
    { key: '3', metaKey: true },
    { key: '4', metaKey: true },
  ]);
});