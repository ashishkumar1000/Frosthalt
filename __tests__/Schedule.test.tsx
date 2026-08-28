/**
 * @format
 *
 * Story 5.1 — the Schedule surface tests.
 *
 * Renders the surface with `react-test-renderer` against a seeded
 * `useDomainStore` state, using the Blocklist.test.tsx idioms (the two NATIVE
 * specs are mocked; prop-based finders — NOT `findByType`, which finds nothing
 * under pnpm + RN 0.81's lazy component getters). Covers:
 *   - Committed schedules render as rows (checkbox + name + live summary).
 *   - The live summary comes from `formatScheduleSummary` (the frozen grammar).
 *   - Checkbox `checked` mirrors `schedule.enabled`; pressing it calls
 *     `stageScheduleEnabledToggle(id)` (optimistic re-render).
 *   - Apply gates on the SCHEDULE buffer only: disabled when clean, enabled +
 *     pulsing when `stagedSchedules != null`.
 *   - Cancel-staged renders only when staged and calls `cancelStagedSchedules`.
 *   - Empty state: the spec's exact AC copy + the primary "Add…" button; no
 *     rows, no Apply, no Cancel.
 *   - Mount announce: "Schedule, N schedule(s)".
 *   - Tab order: enable -> name -> edit -> delete (document order).
 *   - Add/Edit open the Shell-owned editor sheet via the `onAddSchedule` /
 *     `onEditSchedule` props (Story 5.2); Delete remains the 5.5 placeholder
 *     (announce + toast).
 *   - The "N changes staged" hint (singular / plural / absent).
 *
 * The store actions themselves are unit-tested in `store.test.ts`; here we
 * assert the SURFACE wiring (which actions it calls, how it derives the
 * rendered list, when Apply/Cancel are gated).
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
import { Schedule } from '../src/components/Schedule';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain, Schedule as ScheduleType } from '../src/config/types';

// The react-native jest preset auto-mocks `announceForAccessibility` as a
// `jest.fn()`, but the react-native-macos TS type has no Jest mock members.
// Cast once — same pattern as Blocklist.test.tsx / Shell.test.tsx.
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
 * Locate the enable checkboxes by their contract props
 * (`accessibilityRole: 'checkbox'` + an `onPress` function) — the stable
 * Blocklist.test.tsx pattern.
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
 * Locate a button by `accessibilityRole: 'button'` + an `onPress` +
 * `accessibilityLabel`. Multiple buttons exist on a populated surface (Apply,
 * Cancel, Edit, Delete per row); the label disambiguates.
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
 * Locate the ApplyButton COMPOSITE instance by the `pulse` prop discriminator
 * (only the Apply passes `pulse`; Blocklist.test.tsx's findApplyComposite
 * idiom).
 */
function findApplyComposite(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.props != null && 'pulse' in node.props,
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

const FOCUS_MORNINGS: ScheduleType = {
  id: 'focus-mornings',
  name: 'Focus mornings',
  weekdays: [0, 1, 2, 3, 4],
  startTime: '09:00',
  endTime: '17:00',
  enabled: true,
  domains: ['example.com'],
};

const EVENINGS: ScheduleType = {
  id: 'evenings',
  name: 'Evenings',
  weekdays: [5, 6],
  startTime: '20:00',
  endTime: '22:00',
  enabled: false,
  domains: ['example.com'],
};

/** Seeds the store state for a test and clears the announce mock. */
function seedState(overrides: {
  domains?: Domain[];
  schedules?: ScheduleType[];
  stagedSchedules?: ScheduleType[] | null;
  applyStatus?: 'idle' | 'running';
}): void {
  announceForAccessibility.mockClear();
  onAddSchedule.mockClear();
  onEditSchedule.mockClear();
  // Wrap in act(): a previous test's renderer may still be subscribed to the
  // store (react-test-renderer does not auto-unmount), so a bare setState
  // would re-render it outside act and warn. act batches the update.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? DEFAULT_CONFIG.domains,
        schedules: overrides.schedules ?? [],
      },
      staged: null,
      stagedSchedules: overrides.stagedSchedules ?? null,
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

// Story 5.2 — the Shell-owned editor-sheet openers, wired as props. The
// surface must call these (NOT stage anything) when Add…/Edit are pressed;
// the sheet itself is tested in `ScheduleEditor.test.tsx` and the Shell
// wiring in `Shell.test.tsx`.
const onAddSchedule = jest.fn();
const onEditSchedule = jest.fn();

function renderSchedule() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <Schedule
        onAddSchedule={onAddSchedule}
        onEditSchedule={onEditSchedule}
      />,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// ---------------------------------------------------------------------------
// Committed rows render with checkbox + name + live summary
// ---------------------------------------------------------------------------

test('Schedule renders the committed schedules as rows with a checkbox and name each', () => {
  seedState({ schedules: [FOCUS_MORNINGS, EVENINGS] });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());

  // Both names render verbatim (no re-normalisation at display).
  expect(text).toContain('Focus mornings');
  expect(text).toContain('Evenings');
  // Two checkboxes — one per row.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(2);
});

test('each row renders the LIVE summary from formatScheduleSummary (the frozen grammar)', () => {
  const single: ScheduleType = {
    ...FOCUS_MORNINGS,
    id: 'single',
    name: 'Single',
    weekdays: [0], // a single day -> the FULL day name
  };
  seedState({
    schedules: [
      FOCUS_MORNINGS, // [0..4] -> "Every Mon–Fri, 09:00–17:00"
      EVENINGS, // [5,6] -> "Every Sat–Sun, 20:00–22:00"
      single, // [0] -> "Every Monday, 09:00–17:00"
    ],
  });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());

  expect(text).toContain('Every Mon–Fri, 09:00–17:00');
  expect(text).toContain('Every Sat–Sun, 20:00–22:00');
  expect(text).toContain('Every Monday, 09:00–17:00');
});

test('the row label wrapper announces name AND summary together (VoiceOver one-stop)', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const labelWrapper = testRenderer.root.findAll(
    (node) =>
      node.props && node.props.focusable === true && node.props.accessibilityRole === 'text',
  )[0];
  expect(labelWrapper).toBeDefined();
  expect(labelWrapper.props.accessibilityLabel).toBe(
    'Focus mornings, Every Mon–Fri, 09:00–17:00',
  );
});

// ---------------------------------------------------------------------------
// Checkbox checked mirrors schedule.enabled + optimistic toggle
// ---------------------------------------------------------------------------

test('checkbox checked state mirrors schedule.enabled', () => {
  seedState({ schedules: [FOCUS_MORNINGS, EVENINGS] }); // enabled true / false

  const testRenderer = renderSchedule();
  const boxes = findCheckboxes(testRenderer.root);
  expect(boxes).toHaveLength(2);
  // Row order follows the committed list order. The label is STATE-NEUTRAL
  // ("Enable {name}", review BH-15) — the checked/unchecked state is spoken
  // by VoiceOver from `accessibilityState`, not duplicated in the label.
  expect(boxes[0].props.accessibilityState.checked).toBe(true);
  expect(boxes[0].props.accessibilityLabel).toBe('Enable Focus mornings');
  expect(boxes[1].props.accessibilityState.checked).toBe(false);
  expect(boxes[1].props.accessibilityLabel).toBe('Enable Evenings');
});

test('pressing a checkbox calls stageScheduleEnabledToggle(id) and the row re-renders optimistically', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.accessibilityState.checked).toBe(true);

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  // The real store action staged the flip; the buffer holds a NEW array (never
  // a mutation of committed.schedules).
  const stagedSchedules = useDomainStore.getState().stagedSchedules;
  expect(stagedSchedules).not.toBeNull();
  expect(stagedSchedules![0].id).toBe('focus-mornings');
  expect(stagedSchedules![0].enabled).toBe(false);
  expect(stagedSchedules).not.toBe(useDomainStore.getState().committed.schedules);

  // The rendered row now shows the staged (flipped) value — the optimistic
  // render rides `stagedSchedules ?? committed.schedules`.
  const reBox = findCheckboxes(testRenderer.root)[0];
  expect(reBox.props.accessibilityState.checked).toBe(false);

  // And the toggle staged a change -> Apply is now enabled + pulsing.
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);
});

test('pressing a row checkbox stages a toggle BY ID (the row forwards schedule.id as the key)', () => {
  // 5-1 review BH-3: the previous title claimed "unknown id surfaces the
  // not-found envelope", but this test presses a KNOWN row — the not-found
  // contract is unit-pinned in store.test.ts and is unreachable through the
  // surface (rows render from committed.schedules, so their ids always
  // exist). What this test actually pins is the row wiring: the surface
  // forwards the rendered schedule's `id` (not the schedule object) as the
  // toggle key, and the store stages the flip for that id.
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  ReactTestRenderer.act(() => {
    box.props.onPress();
  });
  // Toggled by id: the staged schedule is the same id with enabled flipped.
  expect(useDomainStore.getState().stagedSchedules![0].id).toBe('focus-mornings');
});

test('pressing a checkbox stages the toggle and the hint + Cancel appear (integration)', () => {
  // 5-1 review BH-17: the hint tests above seed the staged buffer directly;
  // this one drives the real user path — press the checkbox, then assert the
  // surface reacts (the "1 change staged" hint and the Cancel control appear,
  // Apply enables).
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  // Before the press: clean draft — no hint, no Cancel, Apply disabled.
  expect(extractText(testRenderer.toJSON())).not.toContain('change staged');
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();

  ReactTestRenderer.act(() => {
    findCheckboxes(testRenderer.root)[0].props.onPress();
  });

  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('1 change staged');
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeDefined();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);
});

// ---------------------------------------------------------------------------
// Apply gates on the SCHEDULE buffer only
// ---------------------------------------------------------------------------

test('Apply is disabled when the schedule draft is clean (stagedSchedules is null)', () => {
  seedState({ schedules: [FOCUS_MORNINGS], stagedSchedules: null });

  const testRenderer = renderSchedule();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(true);

  // No staged draft -> no Cancel, no hint.
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain('change staged');
  expect(text).not.toContain('changes staged');

  // pulse = hasStaged && !running -> false when clean.
  const composite = findApplyComposite(testRenderer.root);
  expect(composite.props.pulse).toBe(false);
  expect(composite.props.busy).toBe(false);
});

test('Apply is enabled and pulsing when a schedule draft is staged', () => {
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [{ ...FOCUS_MORNINGS, enabled: false }],
  });

  const testRenderer = renderSchedule();
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);

  const composite = findApplyComposite(testRenderer.root);
  expect(composite.props.pulse).toBe(true);
  expect(composite.props.busy).toBe(false);
});

test('Apply is disabled while an Apply run is in flight, with the Applying… label + busy', () => {
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [{ ...FOCUS_MORNINGS, enabled: false }],
    applyStatus: 'running',
  });

  const testRenderer = renderSchedule();
  const apply = findButtonByLabel(testRenderer.root, 'Applying…');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(true);
  const composite = findApplyComposite(testRenderer.root);
  expect(composite.props.pulse).toBe(false);
  expect(composite.props.busy).toBe(true);
  // Rows are disabled mid-run (the checkbox + Edit/Delete controls).
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.disabled).toBe(true);

  // The staged draft is retained while running -> the hint persists.
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');
});

// ---------------------------------------------------------------------------
// Cancel-staged: only rendered when staged, calls cancelStagedSchedules
// ---------------------------------------------------------------------------

test('Cancel-staged renders only when a schedule draft exists and reverts the rows', () => {
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [{ ...FOCUS_MORNINGS, enabled: false }],
  });

  const testRenderer = renderSchedule();
  const cancel = findButtonByLabel(testRenderer.root, 'Cancel');
  expect(cancel).toBeDefined();

  ReactTestRenderer.act(() => {
    cancel!.props.onPress();
  });

  // The real store action cleared ONLY the schedule buffer.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  // The row re-renders from committed (enabled: true again) and Apply gates shut.
  const reBox = findCheckboxes(testRenderer.root)[0];
  expect(reBox.props.accessibilityState.checked).toBe(true);
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Empty state: the spec's exact AC copy + the primary "Add…" button
// ---------------------------------------------------------------------------

test('empty state renders the AC copy + the primary "Add…" button, with no rows, no Apply, no Cancel', () => {
  seedState({ schedules: [], stagedSchedules: null });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());

  expect(text).toContain(
    'No schedules yet. Add one to block on a recurring weekly window.',
  );
  const add = findButtonByLabel(testRenderer.root, 'Add…');
  expect(add).toBeDefined();
  expect(add!.props.accessibilityRole).toBe('button');
  // No rows -> no checkboxes; no Apply/Cancel controls.
  expect(findCheckboxes(testRenderer.root)).toHaveLength(0);
  expect(findButtonByLabel(testRenderer.root, 'Apply')).toBeUndefined();
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();
});

test('the empty state is NOT rendered when a schedule draft is staged over empty committed', () => {
  seedState({
    schedules: [],
    stagedSchedules: [FOCUS_MORNINGS],
  });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());

  // The staged row renders; the empty-state copy does not.
  expect(text).toContain('Focus mornings');
  expect(text).not.toContain('No schedules yet');
  expect(findCheckboxes(testRenderer.root)).toHaveLength(1);
  expect(findButtonByLabel(testRenderer.root, 'Apply')).toBeDefined();
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeDefined();
});

// ---------------------------------------------------------------------------
// Mount announce: "Schedule, N schedule(s)"
// ---------------------------------------------------------------------------

test('Schedule announces "Schedule, N schedules" on mount', () => {
  seedState({ schedules: [FOCUS_MORNINGS, EVENINGS] });
  announceForAccessibility.mockClear();

  renderSchedule();

  expect(announceForAccessibility).toHaveBeenCalledWith('Schedule, 2 schedules');
});

test('Schedule mount announce uses the singular for exactly one schedule', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });
  announceForAccessibility.mockClear();

  renderSchedule();

  expect(announceForAccessibility).toHaveBeenCalledWith('Schedule, 1 schedule');
});

test('Schedule mount announce for the empty state is "Schedule, 0 schedules"', () => {
  seedState({ schedules: [], stagedSchedules: null });
  announceForAccessibility.mockClear();

  renderSchedule();

  expect(announceForAccessibility).toHaveBeenCalledWith('Schedule, 0 schedules');
});

test('Schedule mount announce counts the staged draft when one exists', () => {
  // committed has 1 schedule; staged adds a second. The announce counts the
  // STAGED list (what the user sees): 2 schedules.
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [FOCUS_MORNINGS, EVENINGS],
  });
  announceForAccessibility.mockClear();

  renderSchedule();

  expect(announceForAccessibility).toHaveBeenCalledWith('Schedule, 2 schedules');
});

// ---------------------------------------------------------------------------
// Tab order: enable -> name -> edit -> delete (document order per row)
// ---------------------------------------------------------------------------

test('each row mounts enable -> name -> edit -> delete in document order', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const all = testRenderer.root.findAll(() => true);

  const checkbox = findCheckboxes(testRenderer.root)[0];
  const labelWrapper = testRenderer.root.findAll(
    (node) =>
      node.props &&
      node.props.focusable === true &&
      node.props.accessibilityRole === 'text',
  )[0];
  const edit = findButtonByLabel(testRenderer.root, 'Edit Focus mornings');
  const del = findButtonByLabel(testRenderer.root, 'Delete Focus mornings');

  expect(checkbox).toBeDefined();
  expect(labelWrapper).toBeDefined();
  expect(edit).toBeDefined();
  expect(del).toBeDefined();

  // Non-null after the toBeDefined assertions above (jest's expect doesn't
  // narrow, so assert the definite references for the indexOf reads).
  const checkboxIdx = all.indexOf(checkbox!);
  const labelIdx = all.indexOf(labelWrapper!);
  const editIdx = all.indexOf(edit!);
  const deleteIdx = all.indexOf(del!);
  expect(checkboxIdx).toBeGreaterThanOrEqual(0);
  expect(labelIdx).toBeGreaterThan(checkboxIdx);
  expect(editIdx).toBeGreaterThan(labelIdx);
  expect(deleteIdx).toBeGreaterThan(editIdx);
});

// ---------------------------------------------------------------------------
// Story 5.2: Add…/Edit open the Shell-owned editor sheet via props;
// Story 5.5: Delete remains the announce + toast placeholder
// ---------------------------------------------------------------------------

test('the empty-state Add… button calls the onAddSchedule prop (the Shell opens the editor sheet)', () => {
  seedState({ schedules: [], stagedSchedules: null });

  const testRenderer = renderSchedule();
  const add = findButtonByLabel(testRenderer.root, 'Add…');

  ReactTestRenderer.act(() => {
    add!.props.onPress();
  });

  expect(onAddSchedule).toHaveBeenCalledTimes(1);
  // The surface does NOT stage or announce on its own — the sheet owns the
  // draft, and only its Save stages.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(announceForAccessibility).not.toHaveBeenCalledWith(
    'Adding a schedule is coming soon.',
  );
  // No placeholder toast renders for Add anymore.
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Adding a schedule is coming soon.',
  );
});

test('the row Edit control calls the onEditSchedule prop with the schedule id', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const edit = findButtonByLabel(testRenderer.root, 'Edit Focus mornings');

  ReactTestRenderer.act(() => {
    edit!.props.onPress();
  });

  expect(onEditSchedule).toHaveBeenCalledTimes(1);
  expect(onEditSchedule).toHaveBeenCalledWith('focus-mornings');
  // Nothing staged, no placeholder announce — Edit is a real editor entry
  // point now.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Editing schedules is coming soon.',
  );
});

test('the row Delete control announces the delete placeholder and toasts it', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const del = findButtonByLabel(testRenderer.root, 'Delete Focus mornings');

  ReactTestRenderer.act(() => {
    del!.props.onPress();
  });

  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Removing schedules is coming soon.',
  );
  expect(extractText(testRenderer.toJSON())).toContain(
    'Removing schedules is coming soon.',
  );
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

// ---------------------------------------------------------------------------
// "N changes staged" hint: singular / plural
// ---------------------------------------------------------------------------

test('the hint reads "1 change staged" for a single enabled toggle', () => {
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [{ ...FOCUS_MORNINGS, enabled: false }],
  });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('1 change staged');
  expect(text).not.toContain('changes staged');
});

test('the hint reads "N changes staged" (plural) for N>1 net changes', () => {
  // Staged: toggle FOCUS_MORNINGS off AND add EVENINGS -> 2 changes.
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [
      { ...FOCUS_MORNINGS, enabled: false }, // changed
      EVENINGS, // added
    ],
  });

  const testRenderer = renderSchedule();
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('2 changes staged');
  expect(text).not.toContain('1 change staged');
});

test('the hint counts a removal (staged list shorter than committed)', () => {
  seedState({
    schedules: [FOCUS_MORNINGS, EVENINGS],
    stagedSchedules: [FOCUS_MORNINGS], // EVENINGS removed
  });

  const testRenderer = renderSchedule();
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');
});