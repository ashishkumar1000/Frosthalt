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
 *     `onEditSchedule` props (Story 5.2); Delete is REAL as of Story 5.5 (the
 *     confirm alert gates the staging — Cancel/Esc stage nothing).
 *   - The "N changes staged" hint (singular / plural / absent).
 *   - Story 5.5: the delete confirm-alert shape + confirm-stages +
 *     cancel-no-stage; the disable-confirm branch on uncheck (checkbox does
 *     not flip before confirm); enable-direct (no alert); the controls
 *     disabled while an Apply is in flight.
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

// The jest env pairs react 19.1.4 with react-native 0.81.2, whose bundled
// renderer shim expects react 19.1.0 — every `findNodeHandle` call throws
// "Incompatible React versions" at the renderer's module eval. RN's own
// test-env contract handles a null tag (`AnimatedProps` falls back to
// `viewTag = -1` when `process.env.NODE_ENV === 'test'`), but the real
// `findNodeHandle` throws BEFORE returning null, so the fallback is never
// reached. Return null here — the contract AnimatedProps already has — so
// the ApplyButton's `useNativeDriver` pulse can be re-rendered mid-test
// (e.g. confirming a disable on top of an already-staged draft). Every other
// export stays the real one (RendererImplementation is lazily required
// inside its functions, so requiring it here is safe).
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual(
    'react-native/Libraries/ReactNative/RendererImplementation',
  ),
  findNodeHandle: () => null,
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Alert } from 'react-native';
import type { AlertButton } from 'react-native';
import { Schedule } from '../src/components/Schedule';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain, Schedule as ScheduleType } from '../src/config/types';

// The react-native jest preset auto-mocks `announceForAccessibility` as a
// `jest.fn()`, but the react-native-macos TS type has no Jest mock members.
// Cast once — same pattern as Blocklist.test.tsx / Shell.test.tsx.
const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

// Story 5.5 — `Alert.alert` is spied on (NOT the whole `react-native`
// module) so the rest of the render is untouched, the exact Blocklist.test.tsx
// 2-4 idiom. The spy captures the alert args and exposes the button `onPress`
// callbacks so a test can invoke the destructive button -> the staging
// action. Active for the whole file; tests that never trigger a confirm never
// call it (cleared in seedState alongside the other mocks).
const alertSpy = jest.spyOn(Alert, 'alert');

/**
 * The typed button array of the spy's `callIndex`-th alert. Typed as RN's own
 * `AlertButton` (its `style` is the `'default' | 'cancel' | 'destructive'`
 * union) rather than a hand-rolled `{style?: string}` — a typo'd style string
 * in an assertion then fails to COMPILE instead of passing against any string.
 */
function alertButtons(callIndex = 0): AlertButton[] {
  return alertSpy.mock.calls[callIndex][2] as AlertButton[];
}

/**
 * The destructive confirm button of the spy's `callIndex`-th alert, with its
 * `text` asserted FIRST — a button-order/label change fails with a clear
 * "expected 'Delete'/'Disable'" message instead of silently invoking the
 * wrong callback.
 */
function confirmButton(label: 'Delete' | 'Disable', callIndex = 0): AlertButton {
  const buttons = alertButtons(callIndex);
  expect(buttons[1].text).toBe(label);
  return buttons[1];
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
  alertSpy.mockClear();
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

test('unchecking an enabled schedule opens the Disable confirm and only the confirm stages the toggle', () => {
  // 5.5: a press that would DISABLE the row as rendered opens the confirm
  // alert FIRST; the checkbox flips only once the Disable button's onPress
  // stages the toggle (never optimistically before the confirm).
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.accessibilityState.checked).toBe(true);

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  // The alert opened; NOTHING staged yet — the checkbox has not flipped.
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked).toBe(
    true,
  );

  // Confirming (the Disable button's onPress) -> the real store action stages
  // the flip; the buffer holds a NEW array (never a mutation of
  // committed.schedules).
  ReactTestRenderer.act(() => {
    confirmButton('Disable').onPress!();
  });
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

test('unchecking an enabled row opens Alert.alert with title "Disable <name>?" + Cancel/Disable buttons', () => {
  // The disable alert's SHAPE (the delete alert's shape test above is its
  // sibling — this pins the toggle path's copy + buttons, not just the
  // staging side-effects the tests around it assert).
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  ReactTestRenderer.act(() => {
    findCheckboxes(testRenderer.root)[0].props.onPress();
  });

  expect(alertSpy).toHaveBeenCalledTimes(1);
  const title = alertSpy.mock.calls[0][0];
  const message = alertSpy.mock.calls[0][1];
  const buttons = alertButtons();
  expect(title).toBe('Disable Focus mornings?');
  // The message names the Apply step (the staged effect, stated plainly) —
  // the exact copy from Schedule.tsx.
  expect(message).toBe(
    'Turning off this schedule. This takes effect when you Apply.',
  );
  // Two buttons: Cancel (cancel style) + Disable (destructive style).
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
  expect(buttons[1]).toMatchObject({ text: 'Disable', style: 'destructive' });
  // Disable is NOT isPreferred — Cancel stays the safe Enter/Esc target.
  expect(buttons[1].isPreferred).toBeFalsy();
  // Cancel has no onPress (no staging); Disable carries the onPress.
  expect(typeof buttons[1].onPress).toBe('function');
});

test('confirming the disable toggle stages a toggle BY ID (the alert carries the schedule.id key)', () => {
  // 5-1 review BH-3: the previous title claimed "unknown id surfaces the
  // not-found envelope", but this test presses a KNOWN row — the not-found
  // contract is unit-pinned in store.test.ts and is unreachable through the
  // surface (rows render from committed.schedules, so their ids always
  // exist). What this test actually pins is the confirm wiring: the surface
  // forwards the rendered schedule's `id` (captured in the alert's
  // confirm `onPress`) as the toggle key, and the store stages the flip for
  // that id.
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  ReactTestRenderer.act(() => {
    box.props.onPress();
  });
  ReactTestRenderer.act(() => {
    confirmButton('Disable').onPress!();
  });
  // Toggled by id: the staged schedule is the same id with enabled flipped.
  expect(useDomainStore.getState().stagedSchedules![0].id).toBe('focus-mornings');
});

test('confirming the disable toggle surfaces the hint + Cancel (integration)', () => {
  // 5-1 review BH-17: the hint tests above seed the staged buffer directly;
  // this one drives the real user path — press the checkbox, confirm the
  // alert, then assert the surface reacts (the "1 change staged" hint and the
  // Cancel control appear, Apply enables).
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  // Before the press: clean draft — no hint, no Cancel, Apply disabled.
  expect(extractText(testRenderer.toJSON())).not.toContain('change staged');
  expect(findButtonByLabel(testRenderer.root, 'Cancel')).toBeUndefined();

  ReactTestRenderer.act(() => {
    findCheckboxes(testRenderer.root)[0].props.onPress();
  });
  // The alert alone stages nothing — still no hint while it is open.
  expect(extractText(testRenderer.toJSON())).not.toContain('change staged');

  ReactTestRenderer.act(() => {
    confirmButton('Disable').onPress!();
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
// Story 5.2: Add…/Edit open the Shell-owned editor sheet via props
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

// ===========================================================================
// Story 5.5 — delete + disable confirm-alerts (`Alert.alert`, the Blocklist
// 2-4 pattern). The confirm gates the STAGING: pressing Delete/uncheck opens
// the native macOS sheet; only the destructive button's onPress stages.
// Cancel/Esc -> no staging. Enable (checking a disabled row) dispatches
// directly — exempt from the gate.
// ===========================================================================

test('clicking Delete opens Alert.alert with title "Delete <name>?" + Cancel/Delete buttons', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  const del = findButtonByLabel(testRenderer.root, 'Delete Focus mornings');
  expect(del).toBeDefined();

  ReactTestRenderer.act(() => {
    del!.props.onPress();
  });

  expect(alertSpy).toHaveBeenCalledTimes(1);
  const title = alertSpy.mock.calls[0][0];
  const message = alertSpy.mock.calls[0][1];
  const buttons = alertButtons();
  expect(title).toBe('Delete Focus mornings?');
  // The message names the Apply step (the staged effect, stated plainly).
  expect(message).toBe(
    'Removing it from your schedule list. This takes effect when you Apply.',
  );
  // Two buttons: Cancel (cancel style) + Delete (destructive style).
  expect(buttons).toHaveLength(2);
  expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
  expect(buttons[1]).toMatchObject({ text: 'Delete', style: 'destructive' });
  // Delete is NOT isPreferred — Cancel is the safe Esc/cancel target.
  expect(buttons[1].isPreferred).toBeFalsy();
  // Cancel has no onPress (no staging); Delete carries the onPress.
  expect(typeof buttons[1].onPress).toBe('function');
});

test('confirming Delete calls stageScheduleRemove(id) and the row vanishes with the hint', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });
  // Zustand merges `set` partials via spread, so a spy installed on the
  // CURRENT state object's action is copied into every state object created
  // while it is live. `mockRestore()` restores only the object it was
  // installed on — the spread copies keep holding the (now implementation-
  // stripped) wrapper, and a LATER test's confirm would invoke that dead
  // wrapper and stage nothing. Capture the real action and re-seed it into
  // the store after the restore so the merged copies heal.
  const realStageScheduleRemove = useDomainStore.getState().stageScheduleRemove;
  const removeSpy = jest.spyOn(useDomainStore.getState(), 'stageScheduleRemove');

  const testRenderer = renderSchedule();
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Delete Focus mornings')!.props.onPress();
  });

  // The Delete button's onPress -> stageScheduleRemove(id). Nothing staged
  // before the confirm.
  expect(removeSpy).not.toHaveBeenCalled();
  ReactTestRenderer.act(() => {
    confirmButton('Delete').onPress!();
  });
  expect(removeSpy).toHaveBeenCalledTimes(1);
  expect(removeSpy).toHaveBeenCalledWith('focus-mornings');
  removeSpy.mockRestore();
  // act-wrapped like seedState: this test's renderer is still mounted and
  // subscribed, so a bare setState would re-render it outside act and warn.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      stageScheduleRemove: realStageScheduleRemove,
    });
  });

  // The real store action staged the removal: the row vanishes (the rendered
  // list is `stagedSchedules ?? committed.schedules`), "1 change staged"
  // shows, Apply is enabled.
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([]);
  expect(extractText(testRenderer.toJSON())).not.toContain('Focus mornings');
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(false);
  // The story AC "Apply pulses": a staged removal pulses like a staged toggle.
  expect(findApplyComposite(testRenderer.root).props.pulse).toBe(true);
});

test('confirming Delete then pressing Cancel-staged returns the row and clears the hint (recovery path)', () => {
  // The staged-removal round-trip: Delete -> confirm -> Cancel-staged must
  // return the surface to committed (the row re-renders from
  // `stagedSchedules ?? committed.schedules`, the buffer reverts to null).
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Delete Focus mornings')!.props.onPress();
  });
  ReactTestRenderer.act(() => {
    confirmButton('Delete').onPress!();
  });

  // Staged removal: the row is gone, the hint shows, Apply is enabled.
  expect(extractText(testRenderer.toJSON())).not.toContain('Focus mornings');
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');

  // Cancel-staged: the buffer reverts to committed — the row returns, the
  // hint is gone, Apply is disabled.
  const cancel = findButtonByLabel(testRenderer.root, 'Cancel');
  expect(cancel).toBeDefined();
  ReactTestRenderer.act(() => {
    cancel!.props.onPress();
  });

  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(extractText(testRenderer.toJSON())).toContain('Focus mornings');
  expect(extractText(testRenderer.toJSON())).not.toContain('change staged');
  const apply = findButtonByLabel(testRenderer.root, 'Apply');
  expect(apply).toBeDefined();
  expect(apply!.props.disabled).toBe(true);
});

test('cancelling the delete alert does NOT stage (Esc/Cancel leaves every buffer untouched)', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Delete Focus mornings')!.props.onPress();
  });

  // Cancel has no onPress (no staging). Simulate the cancel path by NOT
  // invoking any button onPress — staging must not have happened.
  const buttons = alertButtons();
  expect(buttons[0].onPress).toBeUndefined();
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  // The row stays.
  expect(extractText(testRenderer.toJSON())).toContain('Focus mornings');
});

test('cancelling the disable alert does NOT stage (the checkbox stays checked)', () => {
  seedState({ schedules: [FOCUS_MORNINGS] });

  const testRenderer = renderSchedule();
  ReactTestRenderer.act(() => {
    findCheckboxes(testRenderer.root)[0].props.onPress();
  });

  const buttons = alertButtons();
  expect(buttons[0].onPress).toBeUndefined();
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  // No flip before the confirm — the row still renders committed.
  expect(
    findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked,
  ).toBe(true);
});

test('checking a DISABLED schedule dispatches directly — no alert (enabling is exempt)', () => {
  seedState({ schedules: [EVENINGS] }); // enabled: false

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.accessibilityState.checked).toBe(false);

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  // Direct dispatch: NO alert, the toggle staged immediately, the row flipped
  // optimistically.
  expect(alertSpy).not.toHaveBeenCalled();
  const stagedSchedules = useDomainStore.getState().stagedSchedules;
  expect(stagedSchedules).not.toBeNull();
  expect(stagedSchedules![0].id).toBe('evenings');
  expect(stagedSchedules![0].enabled).toBe(true);
  expect(
    findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked,
  ).toBe(true);
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');
});

test('re-checking a STAGED-DISABLED row goes direct (the branch uses the rendered enabled)', () => {
  // The rendered row is the staged draft (enabled: false), so the press is an
  // ENABLE — exempt. The direct toggle flips it back to committed's value, so
  // the store's clean-revert nulls the buffer (net-zero, no hint).
  seedState({
    schedules: [FOCUS_MORNINGS],
    stagedSchedules: [{ ...FOCUS_MORNINGS, enabled: false }],
  });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.accessibilityState.checked).toBe(false);

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  expect(alertSpy).not.toHaveBeenCalled();
  // Clean-revert: the net-zero draft is cleared to null.
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(
    findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked,
  ).toBe(true);
  expect(extractText(testRenderer.toJSON())).not.toContain('change staged');
});

test('unchecking a STAGED-ENABLED addition opens the confirm (the mixed state IS a disable)', () => {
  // The spec's Design Note: the branch uses the RENDERED enabled, so a
  // newly-added (staged-only, not yet Applied) enabled row that is unchecked
  // IS a disable — it confirms, it never dispatches directly. The mirror of
  // the staged-disabled re-check test above.
  seedState({
    schedules: [], // the addition exists ONLY in the staged buffer
    stagedSchedules: [FOCUS_MORNINGS],
  });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  expect(box.props.accessibilityState.checked).toBe(true);

  ReactTestRenderer.act(() => {
    box.props.onPress();
  });

  // The confirm opened; nothing further staged (still the staged addition).
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(
    findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked,
  ).toBe(true);

  ReactTestRenderer.act(() => {
    confirmButton('Disable').onPress!();
  });

  // The confirmed disable is staged on top of the staged addition (still one
  // net change vs committed: the added row, now disabled).
  expect(useDomainStore.getState().stagedSchedules).toStrictEqual([
    { ...FOCUS_MORNINGS, enabled: false },
  ]);
  expect(
    findCheckboxes(testRenderer.root)[0].props.accessibilityState.checked,
  ).toBe(false);
  expect(extractText(testRenderer.toJSON())).toContain('1 change staged');
});

test('the checkbox and Delete control are disabled while an Apply run is in flight', () => {
  seedState({
    schedules: [FOCUS_MORNINGS],
    applyStatus: 'running',
  });

  const testRenderer = renderSchedule();
  const box = findCheckboxes(testRenderer.root)[0];
  const del = findButtonByLabel(testRenderer.root, 'Delete Focus mornings');
  expect(box.props.disabled).toBe(true);
  expect(del).toBeDefined();
  expect(del!.props.disabled).toBe(true);
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