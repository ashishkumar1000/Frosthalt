/**
 * @format
 *
 * Story 2.1 — the Blocklist surface tests.
 *
 * Renders the surface with `react-test-renderer` against a seeded
 * `useDomainStore` state (the store is a real Zustand store; the two NATIVE
 * specs are mocked so `readConfig()` at module-eval time falls back to
 * DEFAULT_CONFIG — see the store.test.ts:21-35 pattern). Covers:
 *   - Committed domains render as rows (checkbox + hostname).
 *   - Checkbox `checked` state mirrors `domain.alwaysOn`.
 *   - Pressing a checkbox calls `stageAlwaysOnToggle(hostname)` (optimistic).
 *   - Apply is disabled when there is no staged draft (clean).
 *   - Apply is enabled when a staged draft exists.
 *   - Cancel-staged is only rendered when a staged draft exists.
 *   - Empty state: "No domains yet. Add one to start blocking." and no rows,
 *     no Apply, no Cancel. Story 2.2 now renders the AddDomain field (with its
 *     Add button) ABOVE the empty-state copy, so the field is always reachable.
 *   - Optimistic render: `staged ?? committed.domains` flips the checkbox
 *     immediately on toggle.
 *
 * The store actions themselves are unit-tested in `store.test.ts`; here we
 * assert the SURFACE wiring (which actions it calls, how it derives the
 * rendered list, when Apply/Cancel are gated), not the mutation logic.
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
import { AccessibilityInfo } from 'react-native';
import type { TextInput as TextInputType } from 'react-native';
import { Blocklist } from '../src/components/Blocklist';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain } from '../src/config/types';

// The react-native jest preset auto-mocks `announceForAccessibility` as a
// `jest.fn()`, but the react-native-macos TS type is `(announcement: string)
// => void` (no Jest mock members). Cast once so `.mockClear()` /
// `.toHaveBeenCalledWith(...)` type-check — same pattern as Shell.test.tsx.
const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

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
 * Locate the checkboxes in the rendered tree by their contract props
 * (`accessibilityRole: 'checkbox'` + an `onPress` function) — NOT by
 * `findByType`. Under pnpm + RN 0.81's lazy component getters the imported
 * `Pressable` is not identity-equal to the one in the rendered tree, so
 * `findByType` finds nothing. The prop-based query is the stable pattern used
 * across the 1.2/1.3 tests (ApplyButton.test.tsx, Shell.test.tsx).
 */
function findCheckboxes(root: ReactTestRenderer.ReactTestInstance) {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'checkbox',
  );
}

/**
 * Locate the Apply button by `accessibilityRole: 'button'` + an `onPress` +
 * `accessibilityLabel: 'Apply'`. There may be multiple buttons (Apply +
 * Cancel); the label disambiguates.
 */
function findButtonByLabel(
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

/**
 * Locate the AddDomain field by its contract props: a node with an
 * `onChangeText` function and a `value` string (the TextInput host spreads
 * these). Same finder pattern as AddDomain.test.tsx — NOT `findByType(TextInput)`
 * (identity differs under pnpm + RN 0.81's lazy component getters).
 */
function findAddField(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  )[0];
}

/** Seeds the store state for a test and clears the announce mock. */
function seedState(overrides: {
  domains?: Domain[];
  staged?: Domain[] | null;
  applyStatus?: 'idle' | 'running';
}): void {
  announceForAccessibility.mockClear();
  // Wrap in act(): a previous test's Blocklist renderer may still be
  // subscribed to the store (react-test-renderer does not auto-unmount), so a
  // bare setState would re-render it outside act and warn. act batches the
  // update so any leftover subscriber re-renders cleanly.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? DEFAULT_CONFIG.domains,
      },
      staged: overrides.staged ?? null,
      applyStatus: overrides.applyStatus ?? 'idle',
      lastResult: null,
      drift: null,
    });
  });
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

function renderBlocklist() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<Blocklist />);
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// ---------------------------------------------------------------------------
// Committed rows render with checkbox + hostname
// ---------------------------------------------------------------------------

test('Blocklist renders the committed domains as rows with a checkbox and hostname each', () => {
  seedState({
    domains: [
      { hostname: 'example.com', alwaysOn: true },
      { hostname: 'social.com', alwaysOn: false },
    ],
  });

  const testRenderer = renderBlocklist();
  const text = extractText(testRenderer.toJSON());

  // Both hostnames render verbatim (no re-normalisation at display).
  expect(text).toContain('example.com');
  expect(text).toContain('social.com');
  // Two checkboxes — one per row.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(2);
  // The AddDomain field renders ALONGSIDE the rows (Story 2.2 composes it at
  // the top of the surface, populated or empty).
  expect(findAddField(testRenderer.root)).toBeDefined();
});

test('Blocklist checkbox checked state mirrors domain.alwaysOn', () => {
  seedState({
    domains: [
      { hostname: 'example.com', alwaysOn: true },
      { hostname: 'social.com', alwaysOn: false },
    ],
  });

  const testRenderer = renderBlocklist();
  const boxes = findCheckboxes(testRenderer.root);
  expect(boxes).toHaveLength(2);
  // The first row's checkbox is checked (alwaysOn:true), the second is not.
  // `disabled: false` because no Apply is in flight (idle).
  expect(boxes[0].props.accessibilityState).toEqual({ checked: true, disabled: false });
  expect(boxes[1].props.accessibilityState).toEqual({ checked: false, disabled: false });
  // The accessibility labels carry the hostname so VoiceOver speaks which
  // domain each checkbox controls.
  expect(boxes[0].props.accessibilityLabel).toBe('Always-on for example.com');
  expect(boxes[1].props.accessibilityLabel).toBe('Always-on for social.com');
});

// ---------------------------------------------------------------------------
// Optimistic render: staged ?? committed.domains
// ---------------------------------------------------------------------------

test('Blocklist renders the staged draft when one exists (optimistic toggle)', () => {
  // committed has example.com alwaysOn:false, but a staged draft flips it on.
  // The surface must show the STAGED value (checked) — the user sees the
  // pending toggle immediately, before Apply.
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: false }],
    staged: [{ hostname: 'example.com', alwaysOn: true }],
  });

  const testRenderer = renderBlocklist();
  const boxes = findCheckboxes(testRenderer.root);
  expect(boxes).toHaveLength(1);
  expect(boxes[0].props.accessibilityState).toEqual({ checked: true, disabled: false });
});

// ---------------------------------------------------------------------------
// Toggle calls stageAlwaysOnToggle(hostname)
// ---------------------------------------------------------------------------

test('pressing a checkbox calls stageAlwaysOnToggle with the row hostname', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const toggleSpy = jest.spyOn(useDomainStore.getState(), 'stageAlwaysOnToggle');

  const testRenderer = renderBlocklist();
  const box = findCheckboxes(testRenderer.root)[0];

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  expect(toggleSpy).toHaveBeenCalledTimes(1);
  expect(toggleSpy).toHaveBeenCalledWith('example.com');
  toggleSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Apply disabled when no staged draft (clean); enabled when staged
// ---------------------------------------------------------------------------

test('Apply is disabled when there is no staged draft (clean config)', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: null,
  });

  const testRenderer = renderBlocklist();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(true);
  expect(apply!.props.accessibilityState).toEqual({ disabled: true });
});

test('Apply is enabled when a staged draft exists', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });

  const testRenderer = renderBlocklist();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);
});

test('Apply is disabled while an Apply run is in flight (applyStatus running)', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: [{ hostname: 'example.com', alwaysOn: false }],
    applyStatus: 'running',
  });

  const testRenderer = renderBlocklist();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply!.props.disabled).toBe(true);
});

test('pressing Apply calls the store apply() action', async () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const applySpy = jest.spyOn(useDomainStore.getState(), 'apply');
  applySpy.mockResolvedValue({ ok: true });

  const testRenderer = renderBlocklist();
  const apply = findButtonByLabel(testRenderer.root, 'Apply')!;

  await ReactTestRenderer.act(async () => {
    apply.props.onPress();
    // Flush the `void apply()` microtask so the spy is settled.
    await Promise.resolve();
  });

  expect(applySpy).toHaveBeenCalledTimes(1);
  applySpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Cancel-staged: only rendered when a staged draft exists; calls cancelStaged
// ---------------------------------------------------------------------------

test('Cancel is NOT rendered when there is no staged draft (clean)', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: null,
  });

  const testRenderer = renderBlocklist();
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();
});

test('Cancel is rendered when a staged draft exists and calls cancelStaged', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    staged: [{ hostname: 'example.com', alwaysOn: false }],
  });
  const cancelSpy = jest.spyOn(useDomainStore.getState(), 'cancelStaged');

  const testRenderer = renderBlocklist();
  const cancel = findButtonByLabel(testRenderer.root, 'Cancel');
  expect(cancel).toBeDefined();

  ReactTestRenderer.act(() => {
    cancel!.props.onPress();
  });

  expect(cancelSpy).toHaveBeenCalledTimes(1);
  cancelSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Empty state: "No domains yet. Add one to start blocking." + no rows/Apply
// ---------------------------------------------------------------------------

test('Blocklist shows the empty-state copy and no rows/Apply/Cancel when committed is empty', () => {
  seedState({ domains: [], staged: null });

  const testRenderer = renderBlocklist();
  const text = extractText(testRenderer.toJSON());

  expect(text).toContain('No domains yet. Add one to start blocking.');
  // No checkboxes (no rows), no Apply, no Cancel.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(0);
  expect(findButtonByLabel(testRenderer.root, 'Apply')).toBeUndefined();
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Mount announce: "Blocklist, N domains, M always-on"
// ---------------------------------------------------------------------------

test('Blocklist announces "Blocklist, N domains, M always-on" on mount', () => {
  seedState({
    domains: [
      { hostname: 'example.com', alwaysOn: true },
      { hostname: 'social.com', alwaysOn: true },
      { hostname: 'news.com', alwaysOn: false },
    ],
  });
  announceForAccessibility.mockClear();

  renderBlocklist();

  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Blocklist, 3 domains, 2 always-on',
  );
});

test('Blocklist mount announce counts the staged draft when one exists', () => {
  // committed has 1 domain (alwaysOn:false); staged flips it to true AND adds
  // a second always-on domain. The announce counts the STAGED list (what the
  // user sees): 2 domains, 2 always-on.
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: false }],
    staged: [
      { hostname: 'example.com', alwaysOn: true },
      { hostname: 'social.com', alwaysOn: true },
    ],
  });
  announceForAccessibility.mockClear();

  renderBlocklist();

  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Blocklist, 2 domains, 2 always-on',
  );
});

test('Blocklist mount announce for empty state is "Blocklist, 0 domains, 0 always-on"', () => {
  seedState({ domains: [], staged: null });
  announceForAccessibility.mockClear();

  renderBlocklist();

  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Blocklist, 0 domains, 0 always-on',
  );
});

// ---------------------------------------------------------------------------
// Tab order: checkbox before hostname (source order)
// ---------------------------------------------------------------------------

test('each row renders the checkbox before the hostname label (Tab order checkbox -> domain)', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
  });

  const testRenderer = renderBlocklist();
  // `findAll` returns nodes in document order. The checkbox (focusable,
  // accessibilityRole 'checkbox') must come BEFORE the hostname label wrapper
  // (focusable, accessibilityRole 'text') so Tab order is checkbox -> domain.
  const checkbox = findCheckboxes(testRenderer.root)[0];
  const labelWrapper = testRenderer.root.findAll(
    (node) =>
      node.props &&
      node.props.focusable === true &&
      node.props.accessibilityRole === 'text',
  )[0];
  expect(checkbox).toBeDefined();
  expect(labelWrapper).toBeDefined();
  expect(labelWrapper.props.accessibilityLabel).toBe('example.com');

  // Document order: the checkbox precedes the hostname label wrapper.
  const all = testRenderer.root.findAll(() => true);
  const checkboxIdx = all.indexOf(checkbox);
  const labelIdx = all.indexOf(labelWrapper);
  expect(checkboxIdx).toBeGreaterThanOrEqual(0);
  expect(labelIdx).toBeGreaterThan(checkboxIdx);
});

// ---------------------------------------------------------------------------
// Checkboxes expose accessibilityRole="checkbox" + checked state (a11y AC)
// ---------------------------------------------------------------------------

test('every checkbox exposes accessibilityRole="checkbox" and a checked accessibilityState', () => {
  seedState({
    domains: [
      { hostname: 'a.com', alwaysOn: true },
      { hostname: 'b.com', alwaysOn: false },
      { hostname: 'c.com', alwaysOn: true },
    ],
  });

  const testRenderer = renderBlocklist();
  for (const box of findCheckboxes(testRenderer.root)) {
    expect(box.props.accessibilityRole).toBe('checkbox');
    expect(typeof box.props.accessibilityState?.checked).toBe('boolean');
  }
});

// ---------------------------------------------------------------------------
// Empty committed + non-null staged draft renders the staged rows, not the
// empty-state copy. `isEmpty` gates on `committed.domains.length === 0 &&
// staged == null`; a staged draft (e.g. after `stageDomainAdd` on an empty
// config) must render its rows + Apply/Cancel, never the empty-state text.
// ---------------------------------------------------------------------------

test('a non-null staged draft with empty committed renders the staged rows, not the empty-state copy', () => {
  seedState({
    domains: [],
    staged: [{ hostname: 'newdomain.com', alwaysOn: true }],
  });

  const testRenderer = renderBlocklist();
  const text = extractText(testRenderer.toJSON());
  // The staged row's hostname is rendered; the empty-state copy is NOT.
  expect(text).toContain('newdomain.com');
  expect(text).not.toContain('No domains yet');
  // A staged draft keeps Apply enabled + Cancel visible.
  expect(findButtonByLabel(testRenderer.root, 'Apply')).toBeDefined();
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeDefined();
  // Exactly one checkbox, for the staged domain.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Checkboxes are disabled (and expose the disabled a11y state) while an Apply
// run is in flight — the surface passes `disabled={running}` through DomainRow
// to Checkbox so a mid-Apply toggle cannot race the serialized pipeline.
// ---------------------------------------------------------------------------

test('checkboxes are disabled while an Apply run is in flight', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    applyStatus: 'running',
  });

  const testRenderer = renderBlocklist();
  const checkboxes = findCheckboxes(testRenderer.root);
  expect(checkboxes).toHaveLength(1);
  expect(checkboxes[0].props.disabled).toBe(true);
  expect(checkboxes[0].props.accessibilityState?.disabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Story 2.2 — composition: Blocklist renders + forwards AddDomain, and a clean
// Add flows through to a staged DomainRow + Apply enabled. Covers the
// Blocklist -> AddDomain -> store -> DomainRow seam: if Blocklist stops
// rendering or forwarding AddDomain, or Add stops wiring to stageDomainAdd,
// this fails.
// ---------------------------------------------------------------------------

test('Blocklist renders AddDomain, forwards the add-field ref, and a clean Add stages a new DomainRow + enables Apply', () => {
  seedState({ domains: [] });

  const addFieldRef = React.createRef<TextInputType>();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <Blocklist addFieldRef={addFieldRef} />,
    );
  });
  currentRenderer = testRenderer;

  // (a) The AddDomain field is present on the composed surface.
  const field = findAddField(testRenderer.root);
  expect(field).toBeDefined();

  // (b) The ref flows through Blocklist -> AddDomain's forwarded TextInput.
  // The actual `.focus()` is native-runtime (not unit-testable here — same
  // caveat as the 2.1 row-focus tests), so we assert the ref ATTACHES, which is
  // what the Shell's ⌘N handler relies on.
  expect(addFieldRef.current).not.toBeNull();

  // (c) Type a clean new domain into the field and press Add — the real
  // store action stages it, a new DomainRow (checkbox) for that hostname
  // appears, and Apply becomes enabled. No mock: this exercises the full
  // Blocklist -> AddDomain -> store -> DomainRow path with the real action.
  ReactTestRenderer.act(() => {
    field!.props.onChangeText('newsite.com');
  });
  const addButton = findButtonByLabel(testRenderer.root, 'Add');
  expect(addButton).toBeDefined();
  // Add is enabled for a clean new domain.
  expect(addButton!.props.disabled).toBe(false);

  ReactTestRenderer.act(() => {
    addButton!.props.onPress();
  });

  // The store staged the domain (alwaysOn:true) via the real stageDomainAdd.
  expect(useDomainStore.getState().staged).toStrictEqual([
    { hostname: 'newsite.com', alwaysOn: true },
  ]);
  // A DomainRow (checkbox) for the new hostname is now rendered.
  const checkboxes = findCheckboxes(testRenderer.root);
  expect(checkboxes).toHaveLength(1);
  expect(checkboxes[0].props.accessibilityLabel).toBe(
    'Always-on for newsite.com',
  );
  expect(checkboxes[0].props.accessibilityState).toEqual({
    checked: true,
    disabled: false,
  });
  // Apply is enabled (a staged draft exists).
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);
});