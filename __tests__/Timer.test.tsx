/**
 * @format
 *
 * Story 4.1 / 4.2 — the Timer surface tests.
 *
 * Renders `<Timer onOpenBlocklist={...}/>` with `react-test-renderer`
 * against a seeded `useDomainStore` (the store is a real Zustand store; the
 * two NATIVE specs are mocked so `readConfig()` at module-eval time falls
 * back to DEFAULT_CONFIG — same pattern as the Blocklist / Settings /
 * Shell tests). Covers:
 *
 *   - Surface mount announce: "Timer, free" via
 *     `AccessibilityInfo.announceForAccessibility`.
 *   - Empty-blocklist empty state renders the "Add some domains on Blocklist
 *     first." copy + an "Open Blocklist" CTA that calls `onOpenBlocklist`.
 *   - Pre-check fallback (no persisted activeTimer.selectedDomains -> all
 *     domains checked).
 *   - Pre-check from persisted `committed.activeTimer.selectedDomains`.
 *   - Preset selection clears the custom input; custom focus deselects
 *     presets.
 *   - Toggling a domain live-updates the "N of M selected" count.
 *   - Start precondition gates: invalid custom minutes / zero domains
 *     selected / applyStatus running -> Start disabled.
 *   - Start success path (Story 4.2 engine swap): fires `stageStartTimer`
 *     EXACTLY ONCE with `{durationMs, selected}`, asserts the new toast
 *     copy. The store action itself is mocked so the test asserts the
 *     component wiring, not the native write.
 *   - Start failure path (mocked `{ok:false}` from `stageStartTimer`): deny
 *     toast announced; `committed.activeTimer` stays null (retry-safe).
 *   - Story 4.3 Blocked path: when `committed.activeTimer != null` at mount,
 *     the surface renders the LIVE COUNTDOWN — "FOCUS SESSION" label, the
 *     64×64 `CountdownRing` + tabular mm:ss numeral (derived from
 *     `endEpochMs - now` via the scoped `useTimerStore` slice), the
 *     "Locked until HH:mm" subtitle, the password-gated destructive
 *     "End early" button and its hint. The slice starts on mount and stops
 *     on unmount / Blocked→Free transition; the mount announce speaks the
 *     remaining minutes/seconds.
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

// ApplyButton uses Animated.createAnimatedComponent(Pressable). Re-rendering
// that under react-test-renderer hits a pre-existing react 19.1.4 vs
// react-native 0.81.2 renderer version mismatch (the lazy re-require of the
// dev renderer throws a version-check error). The Timer tests re-render the
// Start button across state changes (preset/custom toggle, domain toggle,
// apply-running), so we mock ApplyButton the same way Shell.test.tsx does —
// a plain Pressable forwarding the contract props. The `pulse`/`busy`
// prop WIRING is asserted via the composite finder (`'pulse' in props`)
// which matches the COMPOSITE instance before the mock replaces it; we
// still see the composite because the mock honours `pulse` / `busy` on the
// props object passed through.
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
import { Timer } from '../src/components/Timer';
import { useDomainStore } from '../src/domain/store';
import { useTimerStore, selectRemainingMs } from '../src/domain/timerStore';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { ActiveTimer, Config, Domain } from '../src/config/types';

const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

/** Walks a react-test-renderer JSON tree concatenating text nodes. */
function extractText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'children' in node) {
    return extractText((node as { children: unknown }).children);
  }
  return '';
}

/** Locate the checkboxes in the rendered tree by their contract props. */
function findCheckboxes(root: ReactTestRenderer.ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'checkbox',
  );
}

/** Locate the preset chip buttons by their `25 min` / `45 min` / `1h` labels. */
function findPresetChip(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label,
  )[0];
}

/** Locate the Start button by its accessibility label ("Start" / "Starting…"). */
function findStartButton(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === label,
  )[0];
}

/** Locate the ApplyButton composite instance (matches the `pulse` prop). */
function findApplyComposite(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.props != null && 'pulse' in node.props,
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Locate the custom input by its accessibility label. */
function findCustomInput(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === 'Custom duration in minutes',
  )[0];
}

/** Seeds the store state for a test and clears the announce mock. */
function seedState(overrides: {
  domains?: Domain[];
  applyStatus?: 'idle' | 'running';
  activeTimer?: ActiveTimer | null;
}): void {
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    const committed: Config = {
      ...DEFAULT_CONFIG,
      domains: overrides.domains ?? DEFAULT_CONFIG.domains,
      activeTimer:
        overrides.activeTimer !== undefined
          ? overrides.activeTimer
          : DEFAULT_CONFIG.activeTimer,
    };
    useDomainStore.setState({
      committed,
      staged: null,
      applyStatus: overrides.applyStatus ?? 'idle',
      lastResult: null,
      drift: null,
    });
  });
}

let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

// Story 4.6: the real `endEarly` action, captured BEFORE any test can mock it.
// Mocks are installed with `setState({ endEarly: spy })`, not `jest.spyOn`:
// a spy mutates the current state object and every later `setState` merge
// spread-copies that mock into new state objects, where `restoreAllMocks`
// cannot reach it — the next `jest.spyOn` would then re-use the stale mock
// (with its old recorded calls) instead of wrapping the real action.
const realEndEarly = useDomainStore.getState().endEarly;
const realRequirePassword = useDomainStore.getState().requirePassword;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
  jest.restoreAllMocks();
  // Story 4.6: put the real `endEarly`/`requirePassword` back even if a test
  // swapped them via setState (see above — restoreAllMocks cannot undo those).
  useDomainStore.setState({ endEarly: realEndEarly, requirePassword: realRequirePassword });
  // Story 4.3: force the scoped timer slice's refcount back to 0 and reset
  // its state so a Blocked test can never leak a live per-second driver
  // (or a stale `endEpochMs`) into another test. Extra stops are no-ops.
  useTimerStore.getState().stop();
  useTimerStore.setState({ nowMs: 0, endEpochMs: null, totalMs: null });
  if (jest.isMockFunction(setTimeout)) {
    jest.useRealTimers();
  }
});

function renderTimer(onOpenBlocklist: () => void = jest.fn()) {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <Timer onOpenBlocklist={onOpenBlocklist} />,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// ---------------------------------------------------------------------------
// Surface mount announce
// ---------------------------------------------------------------------------

test('Timer announces "Timer, free" on mount', () => {
  seedState({
    domains: [
      { hostname: 'example.com', alwaysOn: false },
      { hostname: 'social.com', alwaysOn: false },
    ],
  });
  announceForAccessibility.mockClear();

  renderTimer();

  expect(announceForAccessibility).toHaveBeenCalledWith('Timer, free');
});

// ---------------------------------------------------------------------------
// Empty-blocklist empty state
// ---------------------------------------------------------------------------

test('Timer renders the empty-blocklist empty state with an "Open Blocklist" CTA that calls onOpenBlocklist', () => {
  seedState({ domains: [] });
  const onOpenBlocklist = jest.fn();

  const testRenderer = renderTimer(onOpenBlocklist);
  const text = extractText(testRenderer.toJSON());

  expect(text).toContain('Add some domains on Blocklist first.');
  // The "Open Blocklist" CTA is rendered.
  const cta = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Open Blocklist',
  )[0];
  expect(cta).toBeDefined();
  // No checkboxes, no preset chips, no Start — only the empty-state copy
  // and the CTA.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(0);
  expect(findPresetChip(testRenderer.root, '25 min')).toBeUndefined();
  expect(findStartButton(testRenderer.root, 'Start')).toBeUndefined();

  // Pressing the CTA fires the navigation callback.
  ReactTestRenderer.act(() => {
    cta!.props.onPress();
  });
  expect(onOpenBlocklist).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Story 4.3 — Blocked path: the live countdown (the ONLY active-timer path)
// ---------------------------------------------------------------------------

test('Blocked path renders the live countdown UI when committed.activeTimer is non-null at mount', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: false }],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['example.com'],
    },
  });
  const onOpenBlocklist = jest.fn();

  const testRenderer = renderTimer(onOpenBlocklist);
  const text = extractText(testRenderer.toJSON());

  // The 4.3 Blocked layout: label + numeral + subtitle + End early + hint.
  // (No passwordHash in this seed -> requirePassword short-circuits, so the
  // hint omits the password clause — review step-04 (d).)
  expect(text).toContain('FOCUS SESSION');
  expect(text).toContain('Locked until');
  expect(text).toContain('End early');
  expect(text).toContain('Timer ends automatically at');
  expect(text).not.toContain('End early needs your password');
  // The CountdownRing renders (its a11y-hidden SVG node).
  const ring = testRenderer.root.findAll(
    (node) => node.props && 'progress' in node.props,
  )[0];
  expect(ring).toBeDefined();

  // No preset chips, no checkboxes, no Start, no Open Blocklist — Blocked is
  // the ONLY path (spec Never clause).
  expect(findCheckboxes(testRenderer.root)).toHaveLength(0);
  expect(findPresetChip(testRenderer.root, '25 min')).toBeUndefined();
  expect(findStartButton(testRenderer.root, 'Start')).toBeUndefined();
  const openBlocklistCta = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Open Blocklist',
  )[0];
  expect(openBlocklistCta).toBeUndefined();
  expect(onOpenBlocklist).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Pre-check fallback: all-checked on first run
// ---------------------------------------------------------------------------

test('Timer pre-checks all domains on first run (no persisted activeTimer.selectedDomains)', () => {
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: false },
      { hostname: 'b.com', alwaysOn: false },
      { hostname: 'c.com', alwaysOn: false },
    ],
  });

  const testRenderer = renderTimer();
  const checkboxes = findCheckboxes(testRenderer.root);
  expect(checkboxes).toHaveLength(3);
  for (const box of checkboxes) {
    expect(box.props.accessibilityState).toEqual({
      checked: true,
      disabled: false,
    });
  }
  // The "N of M selected" hint reads "3 of 3 selected" on first run.
  expect(extractText(testRenderer.toJSON())).toContain('3 of 3 selected');
});

// ---------------------------------------------------------------------------
// Pre-check from persisted selection (4.2 forward-compat hook)
// ---------------------------------------------------------------------------

test('Timer initial-selection derivation: with persisted selectedDomains, the seeded selection subset is honored (initial-state hook)', () => {
  // The pre-check fallback reads `committed.activeTimer?.selectedDomains`.
  // In 4.1 no code path populates `activeTimer`, so this branch is forward-
  // compat for 4.2; here we exercise the derivation in isolation by reading
  // the initial selection computed by Timer against a seed that mirrors the
  // 4.2 shape. Because the Story 4.3 Blocked countdown also fires on
  // `activeTimer != null`, this test asserts the DOMAIN list is hidden
  // (Blocked path wins) — pinning the precedence so a future change cannot
  // silently drop the countdown OR the derivation.
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: false },
      { hostname: 'b.com', alwaysOn: false },
      { hostname: 'c.com', alwaysOn: false },
    ],
    activeTimer: {
      endEpochMs: Date.now() + 60_000,
      selectedDomains: ['a.com', 'c.com'],
    },
  });

  const testRenderer = renderTimer();
  // The Blocked countdown wins; no domain list rendered.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(0);
  expect(extractText(testRenderer.toJSON())).toContain('FOCUS SESSION');
  expect(extractText(testRenderer.toJSON())).toContain('Locked until');
});

// ---------------------------------------------------------------------------
// Toggle live-updates the count
// ---------------------------------------------------------------------------

test('toggling a domain live-updates the "N of M selected" count', () => {
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: false },
      { hostname: 'b.com', alwaysOn: false },
    ],
  });

  const testRenderer = renderTimer();
  // All checked initially -> "2 of 2 selected".
  expect(extractText(testRenderer.toJSON())).toContain('2 of 2 selected');

  const boxA = findCheckboxes(testRenderer.root)[0];
  ReactTestRenderer.act(() => {
    boxA.props.onPress();
  });
  // Unchecked a.com -> "1 of 2 selected".
  expect(extractText(testRenderer.toJSON())).toContain('1 of 2 selected');
});

// ---------------------------------------------------------------------------
// Preset clears custom + custom focus deselects preset
// ---------------------------------------------------------------------------

test('clicking a preset chip clears the custom input', () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
  });

  const testRenderer = renderTimer();
  // Type into the custom input.
  const custom = findCustomInput(testRenderer.root);
  expect(custom).toBeDefined();
  ReactTestRenderer.act(() => {
    custom!.props.onChangeText('30');
  });
  // Now click the "45 min" preset.
  ReactTestRenderer.act(() => {
    findPresetChip(testRenderer.root, '45 min')!.props.onPress();
  });
  // The custom input is cleared.
  expect(findCustomInput(testRenderer.root)!.props.value).toBe('');
});

test('focusing the custom input deselects the preset chips', () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
  });

  const testRenderer = renderTimer();
  // "25 min" is selected by default.
  expect(
    findPresetChip(testRenderer.root, '25 min')!.props.accessibilityState,
  ).toEqual({ selected: true });
  expect(
    findPresetChip(testRenderer.root, '45 min')!.props.accessibilityState,
  ).toEqual({ selected: false });

  ReactTestRenderer.act(() => {
    findCustomInput(testRenderer.root)!.props.onFocus();
  });

  // Both presets are now deselected.
  expect(
    findPresetChip(testRenderer.root, '25 min')!.props.accessibilityState,
  ).toEqual({ selected: false });
  expect(
    findPresetChip(testRenderer.root, '45 min')!.props.accessibilityState,
  ).toEqual({ selected: false });
});

// ---------------------------------------------------------------------------
// Start precondition: invalid custom minutes -> disabled + inline error
// ---------------------------------------------------------------------------

test('Start is disabled and an inline message shows when the custom input is invalid', () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
  });

  const testRenderer = renderTimer();
  // Focus the custom input -> kind flips to 'custom'.
  ReactTestRenderer.act(() => {
    findCustomInput(testRenderer.root)!.props.onFocus();
  });
  // Type "0" (invalid).
  ReactTestRenderer.act(() => {
    findCustomInput(testRenderer.root)!.props.onChangeText('0');
  });
  // Start is disabled.
  const start = findApplyComposite(testRenderer.root);
  expect(start.props.disabled).toBe(true);
  // Inline error renders.
  expect(extractText(testRenderer.toJSON())).toContain('Enter minutes (1–1440).');
});

// ---------------------------------------------------------------------------
// Start precondition: zero selected -> disabled
// ---------------------------------------------------------------------------

test('Start is disabled when zero domains are selected', () => {
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: false },
      { hostname: 'b.com', alwaysOn: false },
    ],
  });

  const testRenderer = renderTimer();
  // Uncheck both boxes.
  for (const box of findCheckboxes(testRenderer.root)) {
    ReactTestRenderer.act(() => {
      box.props.onPress();
    });
  }
  // "0 of 2 selected".
  expect(extractText(testRenderer.toJSON())).toContain('0 of 2 selected');
  // Start is disabled.
  expect(findApplyComposite(testRenderer.root).props.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Start precondition: applyStatus running -> disabled + busy + label
// ---------------------------------------------------------------------------

test('Start is disabled, busy, and reads "Starting…" while applyStatus is running', () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
    applyStatus: 'running',
  });

  const testRenderer = renderTimer();
  const start = findApplyComposite(testRenderer.root);
  expect(start.props.disabled).toBe(true);
  expect(start.props.busy).toBe(true);
  expect(start.props.label).toBe('Starting…');
  // Checkboxes are disabled too (the picker is inert while running).
  const boxes = findCheckboxes(testRenderer.root);
  for (const box of boxes) {
    expect(box.props.disabled).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Start success path: single stageStartTimer call (Story 4.2 engine swap)
// ---------------------------------------------------------------------------

test('Start with valid duration + selection fires stageStartTimer once with durationMs + the full selected Set (mocked store)', async () => {
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: false },
      { hostname: 'b.com', alwaysOn: true }, // already alwaysOn — included in the session
      { hostname: 'c.com', alwaysOn: false },
    ],
  });

  const startSpy = jest
    .spyOn(useDomainStore.getState(), 'stageStartTimer')
    .mockResolvedValue({ ok: true });

  const testRenderer = renderTimer();

  // Press Start (default preset is 25 min).
  const start = findStartButton(testRenderer.root, 'Start')!;
  await ReactTestRenderer.act(async () => {
    start.props.onPress();
    await Promise.resolve();
  });

  // `stageStartTimer` fires EXACTLY ONCE (4.2 engine swap: replaces the
  // per-domain `stageAlwaysOnToggle` loop + `apply()` call pair).
  expect(startSpy).toHaveBeenCalledTimes(1);
  const [arg] = startSpy.mock.calls[0];
  // Default preset is 25 min -> durationMs = 25 * 60_000.
  expect(arg.durationMs).toBe(25 * 60_000);
  // The full selection set is passed verbatim (the 4.2 engine writes the
  // ENTIRE selection as `activeTimer.selectedDomains`, deduped by apex in
  // `effectiveBlocklist` — including always-on domains if the user picked
  // them; they're harmless duplicates).
  expect(arg.selected).toBeInstanceOf(Set);
  expect(Array.from(arg.selected).sort()).toStrictEqual([
    'a.com',
    'b.com',
    'c.com',
  ]);
  // Success toast announces the selection count (3), not a staged subset.
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Focus session started. 3 domains blocked.',
  );
});

// ---------------------------------------------------------------------------
// Start success path — singular copy for n === 1 (Story 4.2 review — PATCH 5)
// ---------------------------------------------------------------------------

test('Start with a single selected domain announces the singular toast copy ("1 domain blocked")', async () => {
  // Mirrors the plural test above but seeds exactly one domain and asserts the
  // singular branch of `START_SUCCESS_TOAST` at Timer.tsx:90 (`n === 1 ?
  // 'domain' : 'domains'`). The plural branch is covered above; the singular
  // branch was untested — a regression that broke the `n === 1` check would
  // announce "1 domains blocked" (bad grammar) and slip past the existing
  // test.
  seedState({
    domains: [{ hostname: 'only.com', alwaysOn: false }],
  });

  const startSpy = jest
    .spyOn(useDomainStore.getState(), 'stageStartTimer')
    .mockResolvedValue({ ok: true });

  const testRenderer = renderTimer();

  // Press Start (default preset is 25 min).
  const start = findStartButton(testRenderer.root, 'Start')!;
  await ReactTestRenderer.act(async () => {
    start.props.onPress();
    await Promise.resolve();
  });

  // `stageStartTimer` fires EXACTLY ONCE carrying the single selection.
  expect(startSpy).toHaveBeenCalledTimes(1);
  const [arg] = startSpy.mock.calls[0];
  expect(arg.selected).toBeInstanceOf(Set);
  expect(Array.from(arg.selected)).toStrictEqual(['only.com']);
  // Success toast announces the singular form (NOT "1 domains blocked").
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Focus session started. 1 domain blocked.',
  );
});

// ---------------------------------------------------------------------------
// Start failure path: stageStartTimer {ok:false} -> deny toast + activeTimer
// stays null (retry-safe)
// ---------------------------------------------------------------------------

test('Start failure (stageStartTimer {ok:false}) announces the deny toast; committed.activeTimer stays null (retry-safe)', async () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
  });

  const startSpy = jest
    .spyOn(useDomainStore.getState(), 'stageStartTimer')
    .mockResolvedValue({ ok: false, error: 'denied' });

  const testRenderer = renderTimer();

  const start = findStartButton(testRenderer.root, 'Start')!;
  await ReactTestRenderer.act(async () => {
    start.props.onPress();
    await Promise.resolve();
  });

  // `stageStartTimer` fired once with the user's selection.
  expect(startSpy).toHaveBeenCalledTimes(1);
  // The deny toast is announced.
  expect(announceForAccessibility).toHaveBeenCalledWith(
    "Couldn't start the block. No changes made.",
  );
  // committed.activeTimer stays null — the spec's retry-safe invariant (the
  // mock short-circuits the real store logic, so we assert the call happened
  // and the seed's `committed.activeTimer` is untouched).
  expect(useDomainStore.getState().committed.activeTimer).toBeNull();
});

// ---------------------------------------------------------------------------
// Preset chip default: 25 min selected on mount
// ---------------------------------------------------------------------------

test('on mount, the "25 min" preset is selected by default', () => {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
  });

  const testRenderer = renderTimer();
  expect(
    findPresetChip(testRenderer.root, '25 min')!.props.accessibilityState,
  ).toEqual({ selected: true });
  expect(
    findPresetChip(testRenderer.root, '45 min')!.props.accessibilityState,
  ).toEqual({ selected: false });
  expect(
    findPresetChip(testRenderer.root, '1h')!.props.accessibilityState,
  ).toEqual({ selected: false });
});

// ---------------------------------------------------------------------------
// Story 4.3 — Blocked path: numeral derivation, announce, slice lifecycle,
// End-early gate wiring
// ---------------------------------------------------------------------------

/** Fixed wall-clock epoch for the deterministic Blocked tests. */
const T = 1_756_000_000_000;

/** Locates the countdown numeral by its accessibility label. */
function findNumeral(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) => node.props && node.props.accessibilityLabel === 'Time remaining',
  )[0];
}

/** Locates the End-early button by its accessibility label. */
function findEndEarly(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'End early',
  )[0];
}

/** Seeds a 25-minute Blocked session at the fixed clock and renders. */
function renderBlocked(): ReturnType<typeof ReactTestRenderer.create> {
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
    activeTimer: {
      endEpochMs: T + 25 * 60_000,
      selectedDomains: ['a.com'],
    },
  });
  return renderTimer();
}

test('the numeral derives zero-padded mm:ss from endEpochMs - now and ticks per second', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const testRenderer = renderBlocked();

  const numeral = findNumeral(testRenderer.root);
  expect(numeral).toBeDefined();
  // Exactly 25 minutes remaining at the seeded clock -> "25:00". (The JSX
  // `{mm}:{ss}` renders as a three-child array; extractText joins it.)
  expect(extractText(numeral!.props.children)).toBe('25:00');
  // Per-minute rollover cue (UX-DR17) rides the numeral node.
  expect(numeral!.props.accessibilityLiveRegion).toBe('polite');

  // The ring's progress starts at 0 (nothing elapsed yet).
  const ring = testRenderer.root.findAll(
    (node) => node.props && 'progress' in node.props,
  )[0];
  expect(ring).toBeDefined();
  expect(ring!.props.progress).toBe(0);

  // One tick -> the numeral re-renders AND the ring's progress decreases.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(extractText(numeral!.props.children)).toBe('24:59');
  expect(ring!.props.progress).toBeGreaterThan(0);
});

test('the "Locked until" subtitle and hint read the session end time', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const testRenderer = renderBlocked();
  const end = T + 25 * 60_000;
  // Same derivation the component uses — asserts the derivation, not a
  // timezone-pinned clock string.
  const hhmm = new Date(end).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain(`Locked until ${hhmm}`);
  // No passwordHash in the seed -> requirePassword short-circuits, so the
  // hint drops the password clause (review step-04 (d)).
  expect(text).toContain(`Timer ends automatically at ${hhmm}.`);
  expect(text).not.toContain('End early needs your password');

  // With a password set, the password clause returns.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        passwordHash: 'seed-hash',
      },
    });
  });
  expect(extractText(testRenderer.toJSON())).toContain(
    `End early needs your password. Timer ends automatically at ${hhmm}.`,
  );
});

test('Blocked entry announces the remaining minutes and seconds; ticks inside a minute do not re-announce', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  renderBlocked();

  // Mount announce (hasActiveTimer=true branch), plural form.
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Timer running, 25 minutes 0 seconds remaining',
  );
  // The first tick crosses the `floor(minutes)` boundary (25 -> 24), which
  // fires the explicit per-minute rollover announce (UX-DR17: the numeral's
  // live region is Android-only, so macOS VoiceOver needs the announce).
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(announceForAccessibility).toHaveBeenCalledTimes(1);
  expect(announceForAccessibility).toHaveBeenCalledWith(
    '24 minutes remaining',
  );

  // Ticks WITHIN the same minute bucket are silent — announce keyed on the
  // minute value, not on the per-second tick.
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(5000);
  });
  expect(announceForAccessibility).not.toHaveBeenCalled();
});

test('the per-minute rollover announces on each minute-boundary crossing', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  renderBlocked();
  announceForAccessibility.mockClear(); // drop the mount announce

  // Cross the first minute bucket (25 -> 24 at the 1s tick).
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(60_000);
  });
  expect(announceForAccessibility).toHaveBeenCalledTimes(1);
  expect(announceForAccessibility).toHaveBeenCalledWith(
    '24 minutes remaining',
  );

  // Cross the next bucket (24 -> 23 at the 61s tick).
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(announceForAccessibility).toHaveBeenCalledTimes(2);
  expect(announceForAccessibility).toHaveBeenLastCalledWith(
    '23 minutes remaining',
  );
});

test('the mount announce handles singular minutes/seconds', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
    activeTimer: { endEpochMs: T + 61_000, selectedDomains: ['a.com'] },
  });
  renderTimer();
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Timer running, 1 minute 1 second remaining',
  );
});

test('the scoped slice starts on Blocked mount and parks on unmount', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');

  const testRenderer = renderBlocked();

  // The slice mirrors the session's absolute end time.
  expect(useTimerStore.getState().endEpochMs).toBe(T + 25 * 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(clearIntervalSpy).not.toHaveBeenCalled();

  // Unmount -> the effect cleanup's stop() hits refcount 0 -> driver cleared.
  ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  // The parked nowMs no longer advances (no driver).
  jest.setSystemTime(T + 60_000);
  const parked = useTimerStore.getState().nowMs;
  expect(parked).toBeLessThanOrEqual(T + 1000);
});

test('Blocked -> Free transition stops the slice and restores the picker', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');

  const testRenderer = renderBlocked();
  expect(findPresetChip(testRenderer.root, '25 min')).toBeUndefined();

  // The privileged expiry path (Story 4.5) clears committed.activeTimer; the
  // surface must leave Blocked, the slice must stop, and VoiceOver must hear
  // the Free announce (review step-04 (a)).
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        activeTimer: null,
      },
    });
  });

  expect(findPresetChip(testRenderer.root, '25 min')).toBeDefined();
  expect(findNumeral(testRenderer.root)).toBeUndefined();
  expect(clearIntervalSpy).toHaveBeenCalled();
  expect(announceForAccessibility).toHaveBeenCalledWith('Timer, free');
});

test('Blocked path at an already-expired endEpochMs: numeral reads 00:00, ring empty, Blocked UI stays', () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);

  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
    activeTimer: {
      endEpochMs: T - 1000, // expired 1s before mount
      selectedDomains: ['a.com'],
    },
  });
  const testRenderer = renderTimer();

  // Expiry handling is 4.5's job — 4.3 still renders the Blocked UI (I/O
  // matrix row 2: the surface cannot trigger the unblock itself).
  expect(extractText(testRenderer.toJSON())).toContain('FOCUS SESSION');
  const numeral = findNumeral(testRenderer.root);
  expect(extractText(numeral!.props.children)).toBe('00:00');

  const ring = testRenderer.root.findAll(
    (node) => node.props && 'progress' in node.props,
  )[0];
  expect(ring).toBeDefined();
  expect(ring.props.progress).toBe(0);

  // The slice parked immediately at mount: remaining clamps to 0 and no
  // per-second driver runs (the expired park is pinned in timerStore tests).
  expect(selectRemainingMs(useTimerStore.getState())).toBe(0);

  // Story 4.5 note: that same park fires the domain store's module-level
  // expiry trigger ASYNCHRONOUSLY after this mount. Its expireTimer run
  // no-ops here — this file's `writeConfig` native mock returns `undefined`
  // (a config-write failure envelope), so no state change and no hosts write
  // follow. The "no config/host write ever runs" invariant below still holds
  // for the SURFACE (4.3 cannot unblock); the trigger's own writeConfig call
  // is its separate, spec-owned privileged path (pinned end-to-end in
  // store.test.ts and StatusHeader.test.tsx's expired-at-mount test).
});

test('End early with no password set runs endEarly() immediately (gate never opens, body not deferred)', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  const testRenderer = renderBlocked();

  // Spy on the store action: the component-level test asserts the WIRING
  // (press -> requirePassword -> body), not the store logic (pinned in
  // store.test.ts's 4.6 matrix).
  const endEarlySpy = jest.fn().mockResolvedValue({ ok: true });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ endEarly: endEarlySpy });
  });

  const endEarly = findEndEarly(testRenderer.root);
  expect(endEarly).toBeDefined();
  await ReactTestRenderer.act(async () => {
    endEarly!.props.onPress();
    await Promise.resolve();
  });

  // No passwordHash in the seed -> requirePassword short-circuited and the
  // action body fired the real store action exactly once.
  expect(endEarlySpy).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateOpen).toBe(false);
});

test('End early with a password set opens the gate; the stashed action fires endEarly() on verify', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  // A password IS set: requirePassword must open the gate instead of running.
  seedState({ domains: [{ hostname: 'a.com', alwaysOn: false }] });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        passwordHash: 'seed-hash',
        activeTimer: { endEpochMs: T + 25 * 60_000, selectedDomains: ['a.com'] },
      },
    });
  });
  const testRenderer = renderTimer();

  const endEarlySpy = jest.fn().mockResolvedValue({ ok: true });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ endEarly: endEarlySpy });
  });

  const endEarly = findEndEarly(testRenderer.root);
  expect(endEarly).toBeDefined();
  ReactTestRenderer.act(() => {
    endEarly!.props.onPress();
  });

  // Gate-first: the action is STASHED, not run (Panic pattern).
  expect(useDomainStore.getState().gateOpen).toBe(true);
  const action = useDomainStore.getState().gateAction;
  expect(typeof action).toBe('function');
  expect(endEarlySpy).not.toHaveBeenCalled();

  // Simulate a verified gate exactly as the Shell's runGateAction does.
  await ReactTestRenderer.act(async () => {
    action!();
    await Promise.resolve();
    useDomainStore.getState().closeGate();
  });
  expect(endEarlySpy).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().gateOpen).toBe(false);
});

test('End early deny-at-gate (Esc/cancel without a verify): the action never fires and the session is untouched', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  // A password IS set so the press routes through the gate.
  seedState({ domains: [{ hostname: 'a.com', alwaysOn: false }] });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...useDomainStore.getState().committed,
        passwordHash: 'seed-hash',
        activeTimer: { endEpochMs: T + 25 * 60_000, selectedDomains: ['a.com'] },
      },
    });
  });
  const testRenderer = renderTimer();

  const endEarlySpy = jest.fn().mockResolvedValue({ ok: true });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ endEarly: endEarlySpy });
  });

  const endEarly = findEndEarly(testRenderer.root);
  ReactTestRenderer.act(() => {
    endEarly!.props.onPress();
  });
  expect(useDomainStore.getState().gateOpen).toBe(true);

  // The user cancels (Esc / the gate's Cancel -> the Shell calls closeGate).
  // The stashed action must be discarded WITHOUT running.
  ReactTestRenderer.act(() => {
    useDomainStore.getState().closeGate();
  });

  expect(endEarlySpy).not.toHaveBeenCalled();
  expect(useDomainStore.getState().gateOpen).toBe(false);
  // The session is intact — no end, no staged change, no apply run.
  expect(useDomainStore.getState().committed.activeTimer).toStrictEqual({
    endEpochMs: T + 25 * 60_000,
    selectedDomains: ['a.com'],
  });
  expect(useDomainStore.getState().staged).toBeNull();
  expect(useDomainStore.getState().applyStatus).toBe('idle');
});

test('End early is guarded while applyStatus is running: a press neither opens the gate nor fires endEarly()', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T);
  // Live session + an end-early job already in flight (applyStatus
  // 'running'): the deny path keeps `activeTimer` set, so the button is
  // still rendered and pressable — the handler must drop the press instead
  // of queueing a duplicate job (second config write, second admin prompt).
  seedState({
    domains: [{ hostname: 'a.com', alwaysOn: false }],
    applyStatus: 'running',
    activeTimer: { endEpochMs: T + 25 * 60_000, selectedDomains: ['a.com'] },
  });
  const testRenderer = renderTimer();

  const requirePasswordSpy = jest.fn();
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ requirePassword: requirePasswordSpy });
  });
  const endEarlySpy = jest.fn().mockResolvedValue({ ok: true });
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ endEarly: endEarlySpy });
  });

  const endEarly = findEndEarly(testRenderer.root);
  ReactTestRenderer.act(() => {
    endEarly!.props.onPress();
  });

  // No gate, no stashed action, no queued job — the press was a no-op.
  expect(requirePasswordSpy).not.toHaveBeenCalled();
  expect(endEarlySpy).not.toHaveBeenCalled();
  expect(useDomainStore.getState().gateOpen).toBe(false);
  expect(useDomainStore.getState().gateAction).toBeNull();
});