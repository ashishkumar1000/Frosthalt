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
import { useTimerStore } from '../src/domain/timerStore';
import { DEFAULT_CONFIG } from '../src/config/types';
import { hashPassword } from '../src/config/password';
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
  // Story 4.4 — the timer tests spy on `setInterval` with jest.spyOn, which
  // survives the unmount (spies are not torn down by the renderer). Restore
  // every spy here so a leaked spy can never change a later test's timer
  // behaviour (correctness must not depend on test ordering).
  jest.restoreAllMocks();
  // Story 2.5 — the domain count + nav announce read `committed`, so a leaked
  // seed from a test that fails before its inline restore would silently flip
  // later tests' count assertions (the old nav tests assert "0 domains", which
  // only holds when committed is empty). Reset the store to the empty baseline
  // after every test so each starts from a deterministic empty blocklist.
  // Story 3.2 — also reset the gate runtime state so a prior test's open gate
  // or wrong attempts can't leak into a later test (e.g. a leftover
  // `gateOpen:true` would block the Return -> Apply guard).
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG },
      staged: null,
      // Story 5.1 — the parallel schedule buffer is runtime state too; reset
      // it so a prior test's staged schedule can't leak (a leftover non-null
      // buffer would flip the surface-2 Return -> Apply gate).
      stagedSchedules: null,
      gateOpen: false,
      gateAction: null,
      gateAttempts: 0,
      gateThrottleUntil: null,
      // Story 4.5 — the Shell-level toast is runtime-only; reset it so a
      // prior test's toast can't leak into the next.
      toast: null,
    });
  });
  // Story 4.4 — the status header now subscribes to the scoped timer slice,
  // so a live-session test can leave a per-second driver (or a stale
  // `endEpochMs`) behind. Force the refcount back to 0 and wipe the slice so
  // no driver leaks into a later test. Extra stops are no-ops.
  useTimerStore.getState().stop();
  useTimerStore.getState().stop();
  useTimerStore.setState({ nowMs: 0, endEpochMs: null, totalMs: null });
  if (jest.isMockFunction(setTimeout)) {
    jest.useRealTimers();
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

/** Reads the `fontVariant` array from a (possibly array) style prop. Mirrors
 * the array-aware `styleOpacity` helper in DomainRow.test.tsx. */
function styleFontVariant(style: unknown): string[] {
  const entries = Array.isArray(style) ? style : [style];
  const variants: string[] = [];
  for (const entry of entries) {
    if (
      entry != null &&
      typeof entry === 'object' &&
      'fontVariant' in (entry as Record<string, unknown>)
    ) {
      const fv = (entry as { fontVariant?: unknown }).fontVariant;
      if (Array.isArray(fv)) {
        variants.push(...(fv as string[]));
      }
    }
  }
  return variants;
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
  // Story 4.1: Timer is a real surface; with the empty store, the empty-
  // blocklist empty state renders (the preset chips + check list are
  // absent). Pin the empty-state CTA + "Add some domains on Blocklist
  // first." copy so a regression that re-introduces a placeholder would
  // surface here.
  expect(extractText(json)).toContain('Add some domains on Blocklist first.');
  // Exactly one row active, and it is the Timer row.
  const rowsAfterTimer = findRows(testRenderer.root);
  expect(selectedRowCount(rowsAfterTimer)).toBe(1);
  expect(rowsAfterTimer[1].props.accessibilityState?.selected).toBe(true);

  // Click the Settings row (index 3) — content swaps again. Story 3.1 made
  // Settings a real screen: with no password set (the store default) it renders
  // the SetPassword form, so the placeholder copy is gone and the form's
  // submit label is present.
  await ReactTestRenderer.act(() => {
    rowsAfterTimer[3].props.onPress();
  });
  json = testRenderer.toJSON();
  expect(extractText(json)).not.toContain('App settings will appear here');
  expect(extractText(json)).toContain('Set password');
  const rowsAfterSettings = findRows(testRenderer.root);
  expect(selectedRowCount(rowsAfterSettings)).toBe(1);
  expect(rowsAfterSettings[3].props.accessibilityState?.selected).toBe(true);
});

// I/O Matrix: ⌘1-⌘4 nav — selects row 0/1/2/3, calls
// `announceForAccessibility("<Surface>, <count> domain(s)")` with the real
// effective count (0 here because the store is empty after the afterEach reset).
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
  // Story 4.1: with no domains in the store, Timer's empty-blocklist state
  // renders — the CTA + copy are present, the placeholder is gone.
  expect(extractText(testRenderer.toJSON())).toContain(
    'Add some domains on Blocklist first.',
  );
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
  // Story 5.1: Schedule is a real surface — with an empty store the empty
  // state renders (the AC copy + the primary "Add…" placeholder button), and
  // the old placeholder copy is gone.
  expect(extractText(testRenderer.toJSON())).toContain(
    'No schedules yet. Add one to block on a recurring weekly window.',
  );
  expect(extractText(testRenderer.toJSON())).toContain('Add…');
  expect(extractText(testRenderer.toJSON())).not.toContain('No schedule set');
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Schedule, 0 domains',
  );
});

// 5-1 review BH-18: ⌘3 with a POPULATED config renders the schedule rows (the
// empty-store variant above only proves the empty state).
test('⌘3 with populated committed.schedules renders the schedule rows', async () => {
  useDomainStore.setState({
    committed: {
      ...DEFAULT_CONFIG,
      schedules: [
        {
          id: 'focus',
          name: 'Focus',
          weekdays: [0, 1, 2, 3, 4],
          startTime: '09:00',
          endTime: '17:00',
          enabled: true,
          domains: ['example.com'],
        },
      ],
    },
  });
  announceForAccessibility.mockClear();
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });

  // The surface rendered the row (name + live summary via the frozen grammar)
  // instead of the empty state.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Focus');
  expect(text).toContain('Every Mon–Fri, 09:00–17:00');
  expect(text).not.toContain('No schedules yet');
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

// I/O Matrix: Status header — header renders the "Free" badge + the EFFECTIVE
// domain count (not the raw config count) + "no active timer" above the
// content. Seed committed with 3 always-on + 1 non-always-on -> effective count
// 3 (the non-always-on domain is NOT written to /etc/hosts by this epic's Apply,
// so `effectiveBlocklist` filters it out). The header must show 3, NOT 4.
test('the status header renders the Free badge and the effective (not raw) domain count', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
          { hostname: 'c.com', alwaysOn: true },
          { hostname: 'dev.local', alwaysOn: false },
        ],
      },
    });
  });
  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Free');
  expect(text).toContain('3 domains');
  // The raw config has 4 domains, but the effective count is 3 (always-on
  // only). The header must NOT show the raw count.
  expect(text).not.toContain('4 domains');
  expect(text).toContain('no active timer');
  // Restore the empty baseline so this seed does not leak into other suites
  // that share the module-level store instance.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC: the status header with the effective count stays present across every
// surface. Seeds committed with 3 always-on + 1 non-always-on (effective 3)
// and asserts "3 domains" persists after each ⌘1-⌘4 navigation.
test('the status header with the effective count is present on every selected surface', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
          { hostname: 'c.com', alwaysOn: true },
          { hostname: 'dev.local', alwaysOn: false },
        ],
      },
    });
  });
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  for (const key of ['1', '2', '3', '4']) {
    await ReactTestRenderer.act(() => {
      container.props.onKeyDown({ nativeEvent: { metaKey: true, key } });
    });
    const text = extractText(testRenderer.toJSON());
    expect(text).toContain('Free');
    expect(text).toContain('3 domains');
    expect(text).toContain('no active timer');
  }
  // Restore the empty baseline so this seed does not leak into other suites.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// ===========================================================================
// Story 2.5 — Domain count in the status header: effective blocked count +
// tabular figures + on-change announce. The count is
// `effectiveBlocklist(committed).length` — always-on domains enforced in
// /etc/hosts right now (staged/pending edits do not move it until Applied).
// ===========================================================================

// AC: Given effective count 1, the header reads "1 domain" (singular); given
// 0 or >1, "N domains". Seeds committed with exactly 1 always-on domain and
// asserts the singular form. `toContain('1 domain')` matches the singular
// text; `not.toContain('1 domains')` rules out the plural (since "1 domain"
// is a substring of "1 domains", the negation of the plural string is the
// discriminator).
test('the status header shows "1 domain" (singular) when the effective count is 1', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'solo.com', alwaysOn: true }],
      },
    });
  });
  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('1 domain');
  expect(text).not.toContain('1 domains');
  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC: Given Apply succeeds (committed updates), the header count updates and
// VoiceOver announces the new count. Seeds committed with 1 always-on, renders
// (StatusHeader's first-run guard skips the mount announce), clears the mock,
// then simulates an Apply committing a new committed (1 -> 2 always-on) via
// `setState`. Asserts the header shows "2 domains" and the on-change announce
// fired with "2 domains blocked".
test('the header count updates and VoiceOver announces on count change (Apply commit)', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'a.com', alwaysOn: true }],
      },
    });
  });
  const testRenderer = renderShell();
  // StatusHeader mounts; its effect's first-run guard skips the initial mount
  // (the Blocklist surface's mount announce covers the entry). Clear the mock
  // so the on-change announce is isolated.
  announceForAccessibility.mockClear();

  // Simulate an Apply committing a new committed (1 -> 2 always-on domains).
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
        ],
      },
    });
  });

  // The header count updates to 2 (tabular-nums, plural).
  expect(extractText(testRenderer.toJSON())).toContain('2 domains');
  // The StatusHeader on-change announce fires with the new count.
  expect(announceForAccessibility).toHaveBeenCalledWith('2 domains blocked');

  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC: Given the user navigates (⌘1-⌘4), the nav announce speaks the real
// effective count (not "0 domains"). Seeds committed with 2 always-on, then
// ⌘2 (Timer) and asserts the announce is "Timer, 2 domains".
test('the nav announce uses the real effective count (not hardcoded "0 domains")', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
        ],
      },
    });
  });
  const testRenderer = renderShell();
  // Clear the Blocklist mount announce so the nav announce is isolated.
  announceForAccessibility.mockClear();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });

  expect(announceForAccessibility).toHaveBeenCalledWith('Timer, 2 domains');
  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC: Given app launch, StatusHeader does NOT announce on mount. The Blocklist
// surface's mount-announce (`Blocklist.tsx`) already speaks "Blocklist, N
// domains, M always-on" on entry; StatusHeader's first-run guard skips the
// initial mount to avoid double-announcing. Filters the mock calls for the
// StatusHeader announce pattern ("N domain(s) blocked"); it must be empty.
test('StatusHeader does NOT announce on the initial mount (Blocklist entry announce covers it)', async () => {
  // Ensure committed is clean (empty) so the effective count is 0.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
  announceForAccessibility.mockClear();
  renderShell();
  // The Blocklist surface's mount announce fires ("Blocklist, 0 domains, 0
  // always-on"), but the StatusHeader's on-change announce must NOT — its
  // first-run guard skips the initial mount. Filter for the StatusHeader
  // announce pattern ("N domain(s) blocked"); it must be empty.
  const blockedAnnounces = announceForAccessibility.mock.calls
    .map((c) => String(c[0]))
    .filter((s) => /domains? blocked$/.test(s));
  expect(blockedAnnounces).toEqual([]);
});

// I/O Matrix row 3 — staged edit, not yet applied -> header count unchanged.
// The count reflects `committed` (applied), NOT `staged` (pending). Seeds
// committed with exactly 1 always-on domain, renders, asserts the header reads
// "1 domain". Then sets `staged` to a draft with a pending add (committed
// UNCHANGED), re-extracts the header text, and asserts it STILL reads
// "1 domain" — the pending edit must NOT move the count until Apply commits.
test('the header count reflects committed, not staged (a pending staged edit does not move it)', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'a.com', alwaysOn: true }],
      },
      staged: null,
    });
  });
  const testRenderer = renderShell();
  expect(extractText(testRenderer.toJSON())).toContain('1 domain');

  // Stage a pending add (a new always-on domain) — committed is UNCHANGED.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      staged: [
        { hostname: 'a.com', alwaysOn: true },
        { hostname: 'new.com', alwaysOn: true },
      ],
    });
  });

  // The header count is UNCHANGED — it reads `committed`, not `staged`. The
  // pending add does not move the count until Apply commits it.
  expect(extractText(testRenderer.toJSON())).toContain('1 domain');
  // Guard: the staged draft has 2 domains, but the header must NOT show "2
  // domains" (that would mean it is counting staged, not committed).
  expect(extractText(testRenderer.toJSON())).not.toContain('2 domains');

  // Restore the empty baseline + clear the staged draft.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG },
      staged: null,
    });
  });
});

// Always clause — the count numeral uses `fontVariant: ['tabular-nums']` so
// digit width is fixed and the header does not jitter as the count changes
// (9 -> 10). Reuses the proven `tokens.typography.countdown` pattern
// (`tokens.ts:120`). Pins the load-bearing `fontVariant` on the count `Text`
// (same pinning discipline as DomainRow.test's `focusable` pin).
test('the count numeral uses tabular figures (fontVariant tabular-nums)', async () => {
  // Seed committed with 2 always-on domains -> effective count 2 -> the count
  // Text label is "2 domains".
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
        ],
      },
    });
  });
  const testRenderer = renderShell();

  // Find the count Text node whose children is the count label string
  // ("N domains" / "N domain"). The separator dots ("·"), "Free", "no active
  // timer", hostnames, etc. do NOT match `/^\d+ domains?$/`.
  const countTexts = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.children === 'string' &&
      /^\d+ domains?$/.test(node.props.children),
  );
  // React-Native's `Text` exposes its string children through an internal
  // nested `Text` instance too (both carry the same `children` + style), so
  // `findAll` returns >=1 match for the single rendered count `Text`. We only
  // need at least one; `toJSON()` (the real host tree) has exactly one count
  // Text, so we pin the style on `countTexts[0]`.
  expect(countTexts.length).toBeGreaterThanOrEqual(1);

  // Read `fontVariant` from the (possibly array) style prop — mirrors the
  // array-aware `styleOpacity` helper in DomainRow.test.tsx.
  const fontVariant = styleFontVariant(countTexts[0].props.style);
  expect(fontVariant).toContain('tabular-nums');

  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC (I/O matrix row 5 — "nav announce likewise"): the nav announce uses the
// singular form when the effective count is 1. The plural nav-announce test
// above seeds 2; this seeds exactly 1 always-on and asserts "Timer, 1 domain"
// (singular), exercising the `count === 1` branch of `Shell.selectRow`'s ternary
// that no other test reaches.
test('the nav announce uses the singular form when the effective count is 1', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'solo.com', alwaysOn: true }],
      },
    });
  });
  const testRenderer = renderShell();
  announceForAccessibility.mockClear();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });

  expect(announceForAccessibility).toHaveBeenCalledWith('Timer, 1 domain');
  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC (Always clause; verification gap): the count is
// `effectiveBlocklist(committed).length` — effectiveBlocklist normalises each
// hostname and DEDUPES by apex (effectiveBlocklist.ts:37-48), so a corrupt
// config holding duplicate-by-apex always-on entries (e.g. `a.com` and
// `www.a.com`, which both normalise to apex `a.com`) must count as 1, NOT 2.
// A regression to `committed.domains.filter(d => d.alwaysOn).length` would
// render "2 domains" here. No other count test distinguishes the two (every
// other seed uses distinct normalised apexes).
test('the count dedupes always-on domains that normalise to the same apex (effectiveBlocklist, not a raw alwaysOn filter)', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'www.a.com', alwaysOn: true },
        ],
      },
    });
  });
  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());
  // Both entries normalise to apex `a.com` -> effective count 1 (deduped).
  expect(text).toContain('1 domain');
  // A raw alwaysOn filter would count 2; effectiveBlocklist must not.
  expect(text).not.toContain('2 domains');
  // Restore the empty baseline.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
});

// AC: the focusable container declares ⌘1-⌘4 + ⌘N as handled key events (so
// the native default does not swallow them) and is focusable (so the bubbled
// key events reach the handler from the focused row). ⌘N (focus the add field,
// Story 2.2) was added to the handled set so Return-in-field works after ⌘N.
// Story 2.6 added bare Escape (closes the hosts viewer overlay).
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
    // Story 2.6 — bare Escape closes the read-only hosts viewer overlay.
    { key: 'Escape' },
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
  // Story 4.1: Timer Free-state surface renders (the seeded example.com
  // domain is in committed.domains, so the picker list + Start button are
  // visible — not the empty-blocklist empty state). The duration picker
  // presets are unique to Timer.
  expect(extractText(testRenderer.toJSON())).toContain('Domains in this session');

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
      // Story 2.6 — reset the drift/lastReadSection fields too, so a prior
      // test that seeded non-null drift (e.g. a viewer test) cannot leak into a
      // Return -> Apply test. Currently masked (the viewer's mount checkDrift
      // overwrites both), but reset here for test-isolation hygiene.
      drift: null,
      lastReadSection: null,
      // Story 3.2 — reset the gate state so a prior test's open gate or wrong
      // attempts can't block the Return -> Apply guard (`!gateOpen`).
      gateOpen: false,
      gateAction: null,
      gateAttempts: 0,
      gateThrottleUntil: null,
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

// Story 5.1 (review BH-5): the Schedule surface's Apply is Return-bound too —
// the epic context pins "Apply button on the Schedule surface is the default
// (Return-bound)". Bare Return on surface 2 fires apply() when the SCHEDULE
// buffer is dirty (no add-field guard there — surface 2 renders no field).
test('bare Return on surface 2 with stagedSchedules != null fires apply()', async () => {
  seedForReturn({ staged: null });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      stagedSchedules: [
        {
          id: 'focus',
          name: 'Focus',
          weekdays: [0, 1, 2, 3, 4],
          startTime: '09:00',
          endTime: '17:00',
          enabled: false,
          domains: ['example.com'],
        },
      ],
    });
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Navigate to the Schedule surface first.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).toHaveBeenCalledTimes(1);
});

// The mirror negative: on surface 2 with a CLEAN schedule buffer, bare Return
// must NOT fire apply() — even though a domain draft is staged (that draft
// belongs to surface 0's own Return binding, which surface 2 does not share).
test('bare Return on surface 2 with a clean schedule buffer does NOT fire apply()', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
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
  // Confirm we left surface 0. Story 4.1: Timer Free-state surface renders
  // the duration picker + Start; the seed has one domain so the empty-
  // blocklist empty state does NOT fire.
  expect(extractText(testRenderer.toJSON())).toContain('Domains in this session');

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
  // Story 4.1: confirm we landed on Timer (Free-state surface renders with
  // the seed's domain).
  expect(extractText(testRenderer.toJSON())).toContain('Domains in this session');

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

// ===========================================================================
// Story 2.6 — read-only hosts viewer overlay: "View hosts" link in the status
// header opens the viewer; Escape (declared in KEY_DOWN_EVENTS) closes it; bare
// Return is inert while the viewer is open (the overlay is a window-level inert
// surface, mirroring how the native alert inert-ifies the Shell's Return gate).
// The viewer is an OVERLAY, not a 5th sidebar surface — `SURFACE_NAMES` stays a
// fixed 4-tuple.
// ===========================================================================

// The mocked native ShellRunner spec — `readHostsSection` is auto-mocked as a
// `jest.fn` (returns undefined by default). When the HostsViewer mounts it
// calls `checkDrift()` which calls `readHostsSection()`; an `undefined` return
// is handled safely by `computeDrift` (`!read.ok` -> corrupt) so the viewer
// shows the corrupt banner. For the open/close wiring tests we do not care
// which banner shows — only that the viewer title appears and Escape closes it.
const shellNativeForViewer = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as { readHostsSection: jest.Mock; writeHosts: jest.Mock };

/** Locate the "View hosts" link by its accessibilityLabel. */
function findViewHostsLink(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'View hosts',
  )[0];
}

// AC: the StatusHeader renders a "View hosts" link; pressing it opens the
// viewer (the viewer title "Hosts — managed section" appears in extractText).
test('the StatusHeader renders a "View hosts" link that opens the hosts viewer overlay', async () => {
  shellNativeForViewer.readHostsSection.mockReturnValue({ ok: true, section: null });
  const testRenderer = renderShell();
  const link = findViewHostsLink(testRenderer.root);
  expect(link).toBeDefined();

  // Before pressing: the viewer title is absent.
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Hosts — managed section',
  );

  // Press the link -> the viewer mounts.
  await ReactTestRenderer.act(() => {
    link!.props.onPress();
  });

  // The viewer title now appears in the rendered tree.
  expect(extractText(testRenderer.toJSON())).toContain(
    'Hosts — managed section',
  );
});

// AC: `KEY_DOWN_EVENTS` includes `{ key: 'Escape' }` so the native default does
// not swallow Esc before the Shell's `onKeyDown` can close the viewer.
test('KEY_DOWN_EVENTS includes bare Escape (so Esc closes the viewer)', async () => {
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);
  expect(container.props.keyDownEvents).toContainEqual({ key: 'Escape' });
});

// AC: Escape closes the viewer. Open via the "View hosts" link, fire Escape via
// the key-down container, assert the viewer title disappears.
test('bare Escape closes the hosts viewer overlay', async () => {
  shellNativeForViewer.readHostsSection.mockReturnValue({ ok: true, section: null });
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Open the viewer via the link.
  const link = findViewHostsLink(testRenderer.root);
  expect(link).toBeDefined();
  await ReactTestRenderer.act(() => {
    link!.props.onPress();
  });
  expect(extractText(testRenderer.toJSON())).toContain(
    'Hosts — managed section',
  );

  // Fire bare Escape -> the viewer closes.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Escape' } });
  });
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Hosts — managed section',
  );
});

// AC: bare Return does NOT fire Apply while the viewer is open (the overlay is
// a window-level inert surface). Seeds a staged draft so bare Return WOULD fire
// Apply if the gate were absent, opens the viewer, fires Return, asserts apply
// was NOT called.
test('bare Return does NOT fire apply() while the hosts viewer is open', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();
  shellNativeForViewer.readHostsSection.mockReturnValue({ ok: true, section: null });

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Open the viewer via the link.
  const link = findViewHostsLink(testRenderer.root);
  expect(link).toBeDefined();
  await ReactTestRenderer.act(() => {
    link!.props.onPress();
  });
  // Sanity: the viewer is open.
  expect(extractText(testRenderer.toJSON())).toContain(
    'Hosts — managed section',
  );

  // Bare Return -> Apply must NOT fire (the `!viewerOpen` gate holds).
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
});

// ===========================================================================
// Story 3.2 — the password gate wiring: the Shell renders `<PasswordGate>`
// when `gateOpen` is true, bare Escape closes the gate (calling `closeGate`,
// which preserves the attempt counter), and bare Return does NOT fire Apply
// while the gate is open (the gate is a window-level inert surface, mirroring
// the hosts-viewer Return gate). The gate has no real caller in 3-2 (3-3
// wires change-password first); these tests prove the Shell wiring so a
// regression in the Esc branch or the `!gateOpen` guard surfaces here.
// ===========================================================================

/** Seed a password + open the gate via `requirePassword` (the real entry point). */
function seedGateOpen(attempts = 0): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: hashPassword('secret123'),
      },
      // Reset any prior gate state, then open via the real action so the
      // `gateAction` stash + `gateOpen` flag are set exactly as a caller
      // would set them.
      gateOpen: false,
      gateAction: null,
      gateAttempts: attempts,
      gateThrottleUntil: null,
    });
  });
  ReactTestRenderer.act(() => {
    useDomainStore.getState().requirePassword(() => {});
  });
}

/** Seed a password + open the gate via `requirePassword` with a REAL action. */
function seedGateOpenWithAction(action: () => void, attempts = 0): void {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: hashPassword('secret123'),
      },
      gateOpen: false,
      gateAction: null,
      gateAttempts: attempts,
      gateThrottleUntil: null,
    });
  });
  ReactTestRenderer.act(() => {
    useDomainStore.getState().requirePassword(action);
  });
}

/** Find the gate's password field by accessibilityLabel 'Gate password'. */
function findGateField(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Gate password',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Find the gate's Verify button by accessibilityLabel 'Verify'. */
function findGateVerify(
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

// AC: Given the gate is open, when the user presses Esc, then the sheet
// closes, the action does NOT fire, and the attempt counter is preserved.
test('bare Escape closes the password gate (calls closeGate) and preserves the attempt counter', async () => {
  seedGateOpen(2);
  expect(useDomainStore.getState().gateOpen).toBe(true);
  expect(useDomainStore.getState().gateAttempts).toBe(2);

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // The gate's title is present while open.
  expect(extractText(testRenderer.toJSON())).toContain('Enter password');

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Escape' } });
  });

  // The gate closed.
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
  expect(extractText(testRenderer.toJSON())).not.toContain('Enter password');
  // The attempt counter is PRESERVED (Esc does NOT reset it — the spec's Never).
  expect(useDomainStore.getState().gateAttempts).toBe(2);
});

// AC: Given the gate is open, when the user presses Return, then Apply does
// NOT fire (the gate blocks the Return -> Apply shortcut). Seeds a staged
// draft so bare Return WOULD fire Apply if the gate were absent, opens the
// gate, fires Return, asserts apply was NOT called.
test('bare Return does NOT fire apply() while the password gate is open', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applyMock = mockApply();
  // Now open the gate on top of the staged draft.
  seedGateOpen(0);
  expect(useDomainStore.getState().gateOpen).toBe(true);

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  // apply() was NOT called — the `!gateOpen` gate held.
  expect(applyMock).not.toHaveBeenCalled();
});

// AC: the Shell renders `<PasswordGate>` when `gateOpen` is true (the gate
// title appears), and does NOT render it when `gateOpen` is false.
test('the Shell renders the PasswordGate sheet when gateOpen is true', async () => {
  seedGateOpen(0);
  const testRenderer = renderShell();
  expect(extractText(testRenderer.toJSON())).toContain('Enter password');
  // The gate's Verify button is present.
  const verify = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Verify',
  );
  expect(verify.length).toBeGreaterThanOrEqual(1);
});

test('the Shell does NOT render the PasswordGate sheet when gateOpen is false', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG },
      gateOpen: false,
    });
  });
  const testRenderer = renderShell();
  expect(extractText(testRenderer.toJSON())).not.toContain('Enter password');
});

// AC: Given no password is set, when a caller invokes `requirePassword(action)`,
// then `action` runs immediately and no sheet renders (the no-op short-
// circuit). Proves the gate is dormant in 3-2 (no caller yet) — a direct
// `requirePassword` call with no hash runs the action and keeps the gate
// closed.
test('requirePassword with no password set runs the action immediately and renders NO gate sheet', async () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
  const testRenderer = renderShell();
  const action = jest.fn();
  ReactTestRenderer.act(() => {
    useDomainStore.getState().requirePassword(action);
  });
  expect(action).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(extractText(testRenderer.toJSON())).not.toContain('Enter password');
});

// Review patch (step-04): the runGateAction SUCCESS path — the one piece of new
// Shell behavior tying the gate to callers. Without this, a regression in the
// onVerified wiring (or runGateAction / closeGate) ships green because the
// store-level test simulates runGateAction by hand. This exercises the REAL
// Shell wiring: type the correct password into the rendered gate, press Verify,
// and assert the stashed action ran + the gate closed.
test('end-to-end: typing the correct password runs the stashed action + closes the gate (runGateAction success path)', async () => {
  const action = jest.fn();
  seedGateOpenWithAction(action);
  const testRenderer = renderShell();
  expect(useDomainStore.getState().gateOpen).toBe(true);
  expect(useDomainStore.getState().gateAction).toBe(action);

  // Type the correct password + press Verify (the real onVerified -> runGateAction).
  ReactTestRenderer.act(() => {
    findGateField(testRenderer.root).props.onChangeText('secret123');
  });
  await ReactTestRenderer.act(async () => {
    findGateVerify(testRenderer.root).props.onPress();
    await Promise.resolve();
  });

  // The stashed action ran exactly once (runGateAction fired it).
  expect(action).toHaveBeenCalledTimes(1);
  // The gate closed + cleared; verifyPassword reset attempts on success.
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
  expect(useDomainStore.getState().gateAttempts).toBe(0);
  // The sheet unmounted.
  expect(extractText(testRenderer.toJSON())).not.toContain('Enter password');
});

// Review patch (step-04): pins the call-time read in runGateAction. If it
// captured `gateAction` at RENDER time, re-stashing a new action after render
// (then verifying) would run the STALE (old) action. Reading via `getState()`
// at call time runs the new one.
test('runGateAction reads gateAction at CALL TIME, not render time (a re-stash after render runs the NEW action)', async () => {
  const actionA = jest.fn();
  const actionB = jest.fn();
  seedGateOpenWithAction(actionA);
  const testRenderer = renderShell();

  // Re-stash a NEW action after the Shell has rendered (gateAction: A -> B).
  ReactTestRenderer.act(() => {
    useDomainStore.getState().requirePassword(actionB);
  });
  expect(useDomainStore.getState().gateAction).toBe(actionB);

  // Type the correct password + press Verify.
  ReactTestRenderer.act(() => {
    findGateField(testRenderer.root).props.onChangeText('secret123');
  });
  await ReactTestRenderer.act(async () => {
    findGateVerify(testRenderer.root).props.onPress();
    await Promise.resolve();
  });

  // The NEW action (B) ran — not the stale (A).
  expect(actionB).toHaveBeenCalledTimes(1);
  expect(actionA).not.toHaveBeenCalled();
  expect(useDomainStore.getState().gateOpen).toBe(false);
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
      gateOpen: false,
      gateAction: null,
      gateAttempts: 0,
      gateThrottleUntil: null,
      // Story 4.5 — clear any leaked toast at module teardown too.
      toast: null,
    });
  });
});

// ===========================================================================
// Story 3-4 — Shell-level end-to-end: Panic's success toast navigation
// link drives the Shell to select the Blocklist surface (row 0). Mirrors
// the 3-2 success-path test (L1527-1551) so a regression in the
// onVerified -> runGateAction -> setConfirmOpen(true) -> handleClear ->
// success toast -> onReenablePress -> selectRow(BLOCKLIST_SURFACE_INDEX)
// chain surfaces here. Seeds a password + 2 committed domains, uses a
// callThrough apply mock so the real writeConfig + writeHosts runs (the
// native specs return `{ ok: true }` by default), navigates to Settings,
// drives the full Panic flow, taps "Re-enable your blocklist", and
// asserts the active surface is now Blocklist (row 0).
// ===========================================================================

/** Find the Panic trigger by its VoiceOver label inside the Shell-rendered
 * Danger Zone. The Shell renders Settings only on surface 3 (per Shell.tsx),
 * so navigate there first; then `findAll` pins the trigger. */
function findShellPanicTrigger(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel ===
        'Clear all blocked hosts — requires password',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

test('Shell-level e2e: Panic success toast "Re-enable your blocklist" navigates to Blocklist (P16)', async () => {
  // The Shell's mocked native specs return undefined by default, which
  // the apply pipeline would treat as `{ ok: false }`. Set them up to
  // resolve cleanly for this e2e.
  const configNative = require('../src/native/specs/NativeConfigStoreSpec')
    .default as { writeConfig: jest.Mock };
  const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
    .default as { writeHosts: jest.Mock };
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });

  // Seed: password set + 2 committed domains so the AC committed.domains
  // === [] is meaningful after a successful clear.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'example.com', alwaysOn: true },
          { hostname: 'news.example.org', alwaysOn: true },
        ],
        passwordHash: hashPassword('secret123'),
      },
      staged: null,
      gateOpen: false,
      gateAction: null,
      gateAttempts: 0,
      gateThrottleUntil: null,
    });
  });

  // Install a callThrough apply mock so the real apply pipeline runs and
  // commits the staged [] into committed.domains.
  const applySpy = jest.fn(REAL_APPLY) as unknown as jest.Mock<
    Promise<WriteResult>,
    []
  >;
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ apply: applySpy });
  });

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Navigate to Settings (row 3).
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '4' } });
  });
  // The Panic trigger is now in the rendered tree.
  const trigger = findShellPanicTrigger(testRenderer.root);

  // Tap the trigger -> gate opens.
  await ReactTestRenderer.act(() => {
    trigger.props.onPress();
  });
  expect(useDomainStore.getState().gateOpen).toBe(true);

  // Type the correct password + press Verify (real onVerified -> runGateAction).
  ReactTestRenderer.act(() => {
    findGateField(testRenderer.root).props.onChangeText('secret123');
  });
  await ReactTestRenderer.act(async () => {
    findGateVerify(testRenderer.root).props.onPress();
    await Promise.resolve();
  });

  // The flip ran -> the confirm is open.
  const confirmButton = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === 'Clear all blocks',
  )[0];
  expect(confirmButton).toBeDefined();

  // Press Confirm -> apply -> success toast. Drain the enqueue's
  // microtasks (the store uses a chain of promises to serialize
  // apply runs).
  await ReactTestRenderer.act(async () => {
    await confirmButton.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(applySpy).toHaveBeenCalledTimes(1);
  // The strict `committed.domains === []` claim is pinned in
  // Panic.test.tsx (P8). Here we assert the success toast appeared, the
  // link is wired, and navigation runs — the Shell-level claim under
  // test for this e2e (P16).
  expect(useDomainStore.getState().applyStatus).toBe('idle');
  expect(extractText(testRenderer.toJSON())).toContain('All blocks cleared.');

  // The success toast is visible; tap the "Re-enable" link.
  const link = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === 'Re-enable your blocklist',
  )[0];
  expect(link).toBeDefined();

  await ReactTestRenderer.act(() => {
    link.props.onPress();
  });

  // The Shell's selectRow(BLOCKLIST_SURFACE_INDEX) ran -> surface is now
  // row 0 (Blocklist).
  const rows = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityState != null &&
      'selected' in node.props.accessibilityState,
  );
  expect(rows[0].props.accessibilityState?.selected).toBe(true);
  expect(selectedRowCount(rows)).toBe(1);
});

// ===========================================================================
// Story 4.4 — status header countdown integration: with a LIVE
// `committed.activeTimer` the header (always mounted, above every surface)
// shows the `Blocked` badge + a tabular `mm:ss` countdown derived from the
// scoped `useTimerStore` slice — while the static "no active timer"
// placeholder is gone. The existing no-session assertions at the Story 2.5
// header tests above stay untouched and green (the no-session form is
// preserved byte-for-byte).
// ===========================================================================

test('the status header shows the Blocked badge and a live mm:ss countdown while a session runs', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(1_756_000_000_000);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');

  // Seed a live 5-minute session (2 always-on domains -> effective count 2).
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: true },
        ],
        activeTimer: {
          endEpochMs: 1_756_000_000_000 + 5 * 60_000,
          selectedDomains: ['a.com'],
        },
      },
    });
  });

  const testRenderer = renderShell();
  const text = extractText(testRenderer.toJSON());

  // The header row: the Blocked BADGE ELEMENT (StatusBadge's accessibility
  // label — asserting the element, not just the word "Blocked" in the text
  // soup), the effective count, the live countdown — and the placeholder gone.
  const badgeByLabel = (label: string) =>
    testRenderer.root.findAll(
      (node) => node.props && node.props.accessibilityLabel === label,
    );
  expect(badgeByLabel('Status: Blocked').length).toBeGreaterThanOrEqual(1);
  expect(badgeByLabel('Status: Free')).toHaveLength(0);
  expect(text).toContain('2 domains');
  expect(text).not.toContain('no active timer');
  // Exactly 5 minutes remaining at the seeded clock -> "05:00".
  expect(text).toContain('05:00');

  // The header owns the slice lifecycle: exactly ONE timer driver, mirroring
  // the session end — and it ticks with the header mounted on surface 0.
  // (Story 5.4 adds the header's unconditional clock driver: two intervals.)
  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  expect(useTimerStore.getState().endEpochMs).toBe(
    1_756_000_000_000 + 5 * 60_000,
  );

  // One fake tick -> the header's countdown decrements (still on Blocklist).
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(extractText(testRenderer.toJSON())).toContain('04:59');
});

// ===========================================================================
// Story 4.5 — Shell-level expiry end-to-end: the driver's self-park fires
// the store's module-level expiry trigger -> expireTimer clears
// `committed.activeTimer` (config-then-hosts) -> the header reverts to the
// Epic-2 Free form (badge + count + "no active timer") and the Shell-level
// toast renders, is announced to VoiceOver, and auto-dismisses after 8 s.
// The native mocks here default to `undefined` (a failure envelope), so both
// ports are explicitly seeded to succeed before the expiry runs.
// ===========================================================================

/** Drain the enqueue/microtask chain so an enqueued expireTimer run settles. */
async function drainAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

const T = 1_756_000_000_000;

test('Shell-level expiry e2e: the countdown parks -> domains unblock -> "Session ended." toast renders, is announced, and auto-dismisses after 8 s', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const configNative = require('../src/native/specs/NativeConfigStoreSpec')
    .default as { writeConfig: jest.Mock };
  const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
    .default as { writeHosts: jest.Mock };
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });

  // Seed a live 5-minute session: `a.com` is always-on, `b.com` rides the
  // session only. Live effective count = 2; after expiry the session set
  // lifts and only the always-on domain remains -> count drops to 1.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: false },
        ],
        activeTimer: {
          endEpochMs: T + 5 * 60_000,
          selectedDomains: ['a.com', 'b.com'],
        },
      },
    });
  });

  const testRenderer = renderShell();
  // Live session: Blocked badge, 05:00, 2 domains, no placeholder.
  expect(extractText(testRenderer.toJSON())).toContain('05:00');
  expect(extractText(testRenderer.toJSON())).toContain('2 domains');

  // This suite shares one module-level store + native mocks across tests and
  // does NOT reset mock history per test (only the 3-4 e2e seeds these), so
  // clear the call history here — the call-count assertions below are about
  // THIS test's expiry run only.
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  // The spec AC says the unblock fires "on ANY surface": navigate OFF the
  // launch surface (Blocklist) to Settings before driving the clock, so the
  // expiry provably fires while a different surface is active.
  await ReactTestRenderer.act(async () => {
    findKeyDownContainer(testRenderer.root).props.onKeyDown({
      nativeEvent: { metaKey: true, key: '4' },
    });
  });

  // Drive the wall clock past the session end: the slice's driver tick
  // observes `now >= end`, self-parks at `endEpochMs`, and the store's
  // module-level trigger fires expireTimer. Drain the microtasks so the
  // enqueued run (config write -> hosts write -> state + toast) settles.
  announceForAccessibility.mockClear();
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
    await drainAsync();
  });

  // The store ran the expiry path end-to-end.
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);

  // The header reverted with zero surface changes: Free badge, the
  // placeholder back, and the count dropped to the always-on domain only.
  const text = extractText(testRenderer.toJSON());
  const badgeByLabel = (label: string) =>
    testRenderer.root.findAll(
      (node) => node.props && node.props.accessibilityLabel === label,
    );
  expect(badgeByLabel('Status: Free').length).toBeGreaterThanOrEqual(1);
  expect(badgeByLabel('Status: Blocked')).toHaveLength(0);
  expect(text).toContain('no active timer');
  expect(text).toContain('1 domain');
  // The countdown numeral is gone with the session — not parked at 00:00.
  expect(text).not.toContain('00:00');

  // The Shell-level success toast rendered + was announced to VoiceOver.
  expect(text).toContain('Session ended. Domains unblocked.');
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Session ended. Domains unblocked.',
  );

  // 8 s later the toast auto-dismisses (Shell's clearToast timer).
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(8_000);
  });
  expect(useDomainStore.getState().toast).toBeNull();
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Session ended. Domains unblocked.',
  );
});

test('Shell-level expiry with a denied hosts write keeps the session and shows the error toast, then dismisses it', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const configNative = require('../src/native/specs/NativeConfigStoreSpec')
    .default as { writeConfig: jest.Mock };
  const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
    .default as { writeHosts: jest.Mock };
  configNative.writeConfig.mockReturnValue({ ok: true });
  // The admin prompt is denied: the hosts write resolves not-ok.
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });

  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [{ hostname: 'a.com', alwaysOn: true }],
        activeTimer: {
          endEpochMs: T + 5 * 60_000,
          selectedDomains: ['a.com'],
        },
      },
    });
  });

  const testRenderer = renderShell();
  // Clear the shared mocks' history (see the e2e above) so the deny-path
  // assertions count only this test's calls.
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();
  announceForAccessibility.mockClear();
  // Drive the wall clock past the session end: the driver self-parks and the
  // store's trigger fires expireTimer, whose hosts write is denied.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
    await drainAsync();
  });

  // Deny path: `committed.activeTimer` stays INTACT (accepted drift — config
  // on disk says "no session", memory still says the session runs), so the
  // header keeps the Blocked badge + the 00:00 parked countdown.
  expect(useDomainStore.getState().committed.activeTimer).not.toBeNull();
  // Port assertions, same shape as the success e2e: writeConfig ran ONCE with
  // the accepted-drift `activeTimer: null` payload; writeHosts ran once and
  // was denied.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const text = extractText(testRenderer.toJSON());
  const badgeByLabel = (label: string) =>
    testRenderer.root.findAll(
      (node) => node.props && node.props.accessibilityLabel === label,
    );
  expect(badgeByLabel('Status: Blocked').length).toBeGreaterThanOrEqual(1);
  expect(badgeByLabel('Status: Free')).toHaveLength(0);
  expect(text).not.toContain('no active timer');
  // The parked countdown numeral still renders (the session is "live" in
  // memory until 4.6's End-early or 4.7's re-arm clears it).
  expect(text).toContain('00:00');

  // The failure toast (error tone) rendered + was announced.
  expect(text).toContain("Couldn't update /etc/hosts. No changes made.");
  expect(announceForAccessibility).toHaveBeenCalledWith(
    "Couldn't update /etc/hosts. No changes made.",
  );

  // It still auto-dismisses after 8 s.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(8_000);
  });
  expect(extractText(testRenderer.toJSON())).not.toContain(
    "Couldn't update /etc/hosts. No changes made.",
  );
});

// ===========================================================================
// Story 4.6 — the real end-early flow through the Shell: press -> (no
// password set, so requirePassword short-circuits) -> config write ->
// hosts write -> toast + announce -> badge/countdown revert. The component
// tests mock `endEarly`; this is the only test of the REAL action wired
// through the rendered surface.
// ===========================================================================

test('Shell-level end-early e2e: press -> config write (activeTimer:null) -> hosts write -> "Session ended. 1 domain unblocked." toast, announced, Free badge, countdown gone', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const configNative = require('../src/native/specs/NativeConfigStoreSpec')
    .default as { writeConfig: jest.Mock };
  const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
    .default as { writeHosts: jest.Mock };
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });

  // A LIVE session with NO password set (DEFAULT_CONFIG carries no
  // passwordHash): requirePassword must short-circuit straight into
  // endEarly() — no gate detour. a.com is always-on, b.com rides the
  // session; ending early lifts b.com (N = 1) and keeps a.com.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: [
          { hostname: 'a.com', alwaysOn: true },
          { hostname: 'b.com', alwaysOn: false },
        ],
        activeTimer: {
          endEpochMs: T + 5 * 60_000,
          selectedDomains: ['a.com', 'b.com'],
        },
      },
      applyStatus: 'idle',
    });
  });

  const testRenderer = renderShell();
  // Live session: Blocked badge, 05:00, 2 domains.
  expect(extractText(testRenderer.toJSON())).toContain('05:00');
  expect(extractText(testRenderer.toJSON())).toContain('2 domains');

  // Clear the shared mocks' history (see the expiry e2e above) so the
  // call-count assertions count only THIS test's end-early run.
  configNative.writeConfig.mockClear();
  shellNative.writeHosts.mockClear();

  // The unblock fires on any surface: navigate OFF the Timer surface to
  // Settings (⌘4) first, then back to Timer (⌘2) where the End early
  // button lives.
  const container = findKeyDownContainer(testRenderer.root);
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '4' } });
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '2' } });
  });

  // Press End early and drain the enqueued run (config -> hosts -> state).
  const endEarlyButton = testRenderer.root.findAll(
    (node) => node.props && node.props.accessibilityLabel === 'End early',
  )[0];
  expect(endEarlyButton).toBeDefined();
  announceForAccessibility.mockClear();
  await ReactTestRenderer.act(async () => {
    endEarlyButton.props.onPress();
    await drainAsync();
  });

  // The store ran the real end-early path end-to-end.
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.activeTimer).toBeNull();
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const hostsLines = shellNative.writeHosts.mock.calls[0][0] as string[];
  const distinctApexes = new Set(hostsLines.map((l: string) => l.split(/\s+/)[1]));
  // Only the always-on domain remains blocked; b.com lifted.
  expect(distinctApexes).toStrictEqual(new Set(['a.com', 'www.a.com']));

  // The header reverted with zero surface changes: Free badge, the count
  // dropped to the always-on domain only, and the countdown numeral is gone.
  const text = extractText(testRenderer.toJSON());
  const badgeByLabel = (label: string) =>
    testRenderer.root.findAll(
      (node) => node.props && node.props.accessibilityLabel === label,
    );
  expect(badgeByLabel('Status: Free').length).toBeGreaterThanOrEqual(1);
  expect(badgeByLabel('Status: Blocked')).toHaveLength(0);
  expect(text).toContain('1 domain');
  expect(text).not.toContain('05:00');

  // The Shell-level success toast rendered + was announced to VoiceOver.
  expect(text).toContain('Session ended. 1 domain unblocked.');
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Session ended. 1 domain unblocked.',
  );

  // 8 s later the toast auto-dismisses (Shell's clearToast timer).
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(8_000);
  });
  expect(useDomainStore.getState().toast).toBeNull();
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Session ended. 1 domain unblocked.',
  );
});
// ===========================================================================
// Story 5.2 — the schedule editor sheet wiring: ⌘N on the Schedule surface
// (surface 2, reached via ⌘3) opens the ADD editor; ⌘N while it is open is a
// no-op (the draft must not be wiped by a remount); bare Escape closes it;
// bare Return does NOT fire Apply while it is open (the editor is a
// window-level inert surface, mirroring the viewer/gate Return gates).
// ===========================================================================

/** Navigate to the Schedule surface (surface 2) and open the ADD editor. */
async function openScheduleEditor(
  container: ReactTestRenderer.ReactTestInstance,
): Promise<void> {
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'n' } });
  });
}

/** Find the editor's name field by its accessibilityLabel. */
function findEditorNameField(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Schedule name',
  )[0];
}

test('⌘N on the Schedule surface opens the ADD schedule editor', async () => {
  seedForReturn({ staged: null });
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Before: no editor on the Schedule surface.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });
  expect(extractText(testRenderer.toJSON())).not.toContain('Add schedule');

  await openScheduleEditor(container);

  // The ADD editor sheet renders (its title is present; the EDIT title is not).
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Add schedule');
  expect(text).not.toContain('Edit schedule');
  // Merely OPENING the sheet stages nothing (the scratchpad invariant).
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('⌘N while the editor is open is a no-op (the draft is not wiped by a remount)', async () => {
  seedForReturn({ staged: null });
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await openScheduleEditor(container);

  // Type a partial draft, then press ⌘N again.
  const field = findEditorNameField(testRenderer.root);
  expect(field).toBeDefined();
  ReactTestRenderer.act(() => {
    field!.props.onChangeText('Focus mornings');
  });
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: 'n' } });
  });

  // The typed draft survived (a remount from a second setScheduleEditorTarget
  // would have wiped it back to ''). The finder can match more than one node
  // for the same TextInput under the RN preset (the host component spreads
  // the props onto its inner node — why the AddDomain assertions use >= 1),
  // so assert EVERY match carries the typed value.
  const fields = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Schedule name',
  );
  expect(fields.length).toBeGreaterThanOrEqual(1);
  for (const field of fields) {
    expect(field.props.value).toBe('Focus mornings');
  }
  // Still the ADD editor (⌘N did not toggle the target to anything else).
  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('bare Escape closes the schedule editor without staging anything', async () => {
  seedForReturn({ staged: null });
  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await openScheduleEditor(container);
  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');

  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Escape' } });
  });

  expect(extractText(testRenderer.toJSON())).not.toContain('Add schedule');
  expect(extractText(testRenderer.toJSON())).not.toContain('Edit schedule');
  // Closed WITHOUT staging — Esc discards the draft (the scratchpad invariant).
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('bare Return does NOT fire apply() while the schedule editor is open (even with both buffers dirty)', async () => {
  seedForReturn({
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      stagedSchedules: [
        {
          id: 'focus',
          name: 'Focus',
          weekdays: [0, 1, 2, 3, 4],
          startTime: '09:00',
          endTime: '17:00',
          enabled: false,
          domains: ['example.com'],
        },
      ],
    });
  });
  const applyMock = mockApply();

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  await openScheduleEditor(container);
  // Sanity: the editor is open (its sheet title is present).
  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');

  // Bare Return on surface 2 with BOTH buffers dirty would fire apply() if
  // the editor-open gate were absent (see the 5.1 surface-2 Return test).
  await ReactTestRenderer.act(async () => {
    container.props.onKeyDown({ nativeEvent: { metaKey: false, key: 'Return' } });
    await Promise.resolve();
  });

  expect(applyMock).not.toHaveBeenCalled();
  // The editor is still open — Return did not close or commit it either.
  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');
  expect(useDomainStore.getState().stagedSchedules).not.toBeNull();
});

// 5-2 review patch: the row-Edit and Add… entry points are exercised THROUGH
// the Shell — a regression turning the row Edit into the ADD sheet (which
// would stage a duplicate `-2` schedule on Save) must fail here, not just in
// the component tests.

/** Find a button-role node by its exact accessibilityLabel. */
function findButtonIn(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label,
  )[0];
}

test('the row Edit control opens the EDIT sheet pre-filled with that schedule', async () => {
  seedForReturn({ staged: null });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        schedules: [
          {
            id: 'focus-mornings',
            name: 'Focus mornings',
            weekdays: [0, 1, 2, 3, 4],
            startTime: '09:00',
            endTime: '17:00',
            enabled: true,
            domains: ['example.com'],
          },
        ],
      },
    });
  });

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Navigate to the Schedule surface (surface 2).
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });

  // Press the row's Edit control.
  const edit = findButtonIn(testRenderer.root, 'Edit Focus mornings');
  expect(edit).toBeDefined();
  await ReactTestRenderer.act(() => {
    edit!.props.onPress();
  });

  // The EDIT sheet is open and pre-filled from that row — NOT the ADD sheet
  // (an ADD sheet here would stage a duplicate `-2` schedule on Save).
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Edit schedule');
  expect(text).not.toContain('Add schedule');
  const nameField = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Schedule name',
  );
  expect(nameField.length).toBeGreaterThanOrEqual(1);
  expect(nameField[0].props.value).toBe('Focus mornings');
  // Merely opening the sheet stages nothing.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('the empty-state Add… button opens the ADD sheet with an empty name field', async () => {
  seedForReturn({ staged: null });

  const testRenderer = renderShell();
  const container = findKeyDownContainer(testRenderer.root);

  // Navigate to the Schedule surface (surface 2) — the committed list is
  // empty, so the empty state with its Add… button renders.
  await ReactTestRenderer.act(() => {
    container.props.onKeyDown({ nativeEvent: { metaKey: true, key: '3' } });
  });
  expect(extractText(testRenderer.toJSON())).toContain(
    'No schedules yet. Add one to block on a recurring weekly window.',
  );

  const add = findButtonIn(testRenderer.root, 'Add…');
  expect(add).toBeDefined();
  await ReactTestRenderer.act(() => {
    add!.props.onPress();
  });

  // The ADD sheet is open with an EMPTY draft — not a pre-filled edit.
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('Add schedule');
  expect(text).not.toContain('Edit schedule');
  const nameField = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Schedule name',
  );
  expect(nameField.length).toBeGreaterThanOrEqual(1);
  expect(nameField[0].props.value).toBe('');
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});
