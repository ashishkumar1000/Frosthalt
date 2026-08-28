/**
 * @format
 *
 * Story 5.2 — the ScheduleEditor sheet tests.
 *
 * Renders `<ScheduleEditor/>` directly (the Shell owns the open state + the
 * Esc/⌘N/Return branches — those are covered in `Shell.test.tsx`) against a
 * seeded `useDomainStore`, using the Blocklist/Schedule test idioms: the two
 * NATIVE specs are mocked, prop-based finders (NOT `findByType`, which finds
 * nothing under pnpm + RN 0.81's lazy component getters). Covers:
 *   - Open modes: `target: 'new'` renders an empty ADD draft; an id renders
 *     the EDIT draft pre-filled from the rendered (staged ?? committed)
 *     schedule.
 *   - Live summary via `formatScheduleSummary` (time-only at 0 weekdays).
 *   - Save gating: disabled on an incomplete/invalid draft; the inline errors
 *     name the field once touched.
 *   - Save: ONE `stageScheduleUpsert` with the built Schedule (generated id on
 *     add via `nextScheduleId`, existing id on edit), the announce, and the
 *     close.
 *   - Cancel: closes WITHOUT staging anything (the scratchpad invariant).
 *   - The union domain list: an ORPHANED domain (removed from the blocklist,
 *     still scheduled) renders selected and keeps its membership through Save.
 *   - The empty-blocklist note + Save disabled.
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
import { ScheduleEditor } from '../src/components/ScheduleEditor';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type {
  Domain,
  Schedule as ScheduleType,
} from '../src/config/types';

// The react-native jest preset auto-mocks `announceForAccessibility` as a
// `jest.fn()`; cast once (the Blocklist.test.tsx pattern).
const announceForAccessibility =
  AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;

const onClose = jest.fn();

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

/** Finds the TextInput (onChangeText carrier) with the given a11y label. */
function findInputByLabel(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      node.props.accessibilityLabel === label,
  )[0];
}

/** Finds a checkbox-role node with the given a11y label (chips + domains). */
function findCheckboxByLabel(
  root: ReactTestRenderer.ReactTestInstance,
  label: string,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityRole === 'checkbox' &&
      node.props.accessibilityLabel === label,
  )[0];
}

/** Finds every checkbox-role node's checked state as a [label, checked] pair. */
function findCheckboxes(
  root: ReactTestRenderer.ReactTestInstance,
): Array<{ label: string; checked: boolean }> {
  return root
    .findAll(
      (node) =>
        node.props &&
        node.props.accessibilityRole === 'checkbox' &&
        typeof node.props.accessibilityLabel === 'string',
    )
    .map((node) => ({
      label: node.props.accessibilityLabel as string,
      checked: Boolean(
        (node.props.accessibilityState as { checked?: boolean } | undefined)
          ?.checked,
      ),
    }));
}

/** Finds a button-role node with the given a11y label. */
function findButtonByLabel(
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

const FOCUS: ScheduleType = {
  id: 'focus-mornings',
  name: 'Focus mornings',
  weekdays: [0, 1, 2, 3, 4],
  startTime: '09:00',
  endTime: '17:00',
  enabled: true,
  // `news.site` is NOT in the blocklist below -> the ORPHANED domain case.
  domains: ['example.com', 'news.site'],
};

function seedState(overrides: {
  domains?: Domain[];
  schedules?: ScheduleType[];
  stagedSchedules?: ScheduleType[] | null;
}): void {
  announceForAccessibility.mockClear();
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? [
          { hostname: 'example.com', alwaysOn: true },
        ],
        schedules: overrides.schedules ?? [],
      },
      staged: null,
      stagedSchedules: overrides.stagedSchedules ?? null,
      applyStatus: 'idle',
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
  onClose.mockClear();
  announceForAccessibility.mockClear();
});

function renderEditor(target: 'new' | string) {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <ScheduleEditor target={target} onClose={onClose} />,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

// ---------------------------------------------------------------------------
// Open modes
// ---------------------------------------------------------------------------

test('target "new" renders the ADD sheet with an empty draft and Save disabled', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');
  // The fresh draft's live summary is the time-only empty form (0 weekdays,
  // no times) — the formatter is total, it never throws.
  expect(findInputByLabel(testRenderer.root, 'Schedule name')).toBeDefined();
  expect(
    (findButtonByLabel(testRenderer.root, 'Save')!.props.accessibilityState as {
      disabled?: boolean;
    }).disabled,
  ).toBe(true);
  // Nothing staged by merely OPENING the sheet (the scratchpad invariant).
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('a schedule id renders the EDIT sheet pre-filled from the rendered schedule', () => {
  seedState({ schedules: [FOCUS] });
  const testRenderer = renderEditor('focus-mornings');

  expect(extractText(testRenderer.toJSON())).toContain('Edit schedule');
  // Name pre-filled.
  expect(
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.value,
  ).toBe('Focus mornings');
  // Times pre-filled.
  expect(findInputByLabel(testRenderer.root, 'Start time')!.props.value).toBe(
    '09:00',
  );
  expect(findInputByLabel(testRenderer.root, 'End time')!.props.value).toBe(
    '17:00',
  );
  // Weekday chips Mon–Fri checked, Sat/Sun not.
  const checked = Object.fromEntries(
    findCheckboxes(testRenderer.root).map((c) => [c.label, c.checked]),
  );
  expect(checked['Mon']).toBe(true);
  expect(checked['Fri']).toBe(true);
  expect(checked['Sat']).toBe(false);
  // The live summary matches the committed schedule.
  expect(extractText(testRenderer.toJSON())).toContain(
    'Every Mon–Fri, 09:00–17:00',
  );
  // A fully valid pre-fill enables Save immediately.
  expect(
    (findButtonByLabel(testRenderer.root, 'Save')!.props.accessibilityState as {
      disabled?: boolean;
    }).disabled,
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Live summary + chips
// ---------------------------------------------------------------------------

test('the summary updates live and renders TIME-ONLY at 0 weekdays (the spec golden example)', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText(
      '9:5',
    );
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('17:00');
  });

  // 0 weekdays -> time only. The summary shows the PARSED, zero-padded value
  // (`9:5` -> `09:05`) — the same normaliseTime output the store re-runs on
  // Save, so what the user reads is what gets staged.
  expect(extractText(testRenderer.toJSON())).toContain('09:05–17:00');

  // Toggling one chip adds the weekday part.
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'Mon')!.props.onPress();
  });
  expect(extractText(testRenderer.toJSON())).toContain(
    'Every Monday, 09:05–17:00',
  );
});

// ---------------------------------------------------------------------------
// Save gating + inline errors
// ---------------------------------------------------------------------------

test('Save stays disabled until every field is valid, then the inline errors never show', () => {
  seedState({});
  const testRenderer = renderEditor('new');
  const saveDisabled = () =>
    (
      findButtonByLabel(testRenderer.root, 'Save')!.props
        .accessibilityState as { disabled?: boolean }
    ).disabled;

  // Fill everything valid.
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      'Focus mornings',
    );
  });
  for (const day of ['Mon', 'Tue']) {
    ReactTestRenderer.act(() => {
      findCheckboxByLabel(testRenderer.root, day)!.props.onPress();
    });
  }
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText(
      '09:00',
    );
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('17:00');
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'example.com')!.props.onPress();
  });
  expect(saveDisabled()).toBe(false);
  // A complete valid draft shows NO inline errors.
  expect(extractText(testRenderer.toJSON())).not.toContain('Name is required.');
  expect(extractText(testRenderer.toJSON())).not.toContain('Pick at least one');
  expect(extractText(testRenderer.toJSON())).not.toContain('use 24-hour');
});

test('an untouched empty draft shows NO inline errors (idle, not erroneous)', () => {
  seedState({});
  const testRenderer = renderEditor('new');
  const text = extractText(testRenderer.toJSON());
  expect(text).not.toContain('Name is required.');
  expect(text).not.toContain('Pick at least one day.');
  expect(text).not.toContain('Pick at least one domain.');
  expect(text).not.toContain('use 24-hour');
});

test('touching a field then invalidating it names the field in an inline error', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  // Name: type then clear -> "Name is required."
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText('x');
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText('');
  });
  expect(extractText(testRenderer.toJSON())).toContain('Name is required.');

  // Start time: garbage -> the START error (it names the offending field).
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText('9');
  });
  expect(extractText(testRenderer.toJSON())).toContain(
    'Start time: use 24-hour HH:mm',
  );
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'End time: use 24-hour',
  );
});

test('the END time error names the end field and leaves the start field alone', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  // Only the END input gets garbage -> only the END error shows.
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('xx');
  });
  const text = extractText(testRenderer.toJSON());
  expect(text).toContain('End time: use 24-hour HH:mm');
  expect(text).not.toContain('Start time: use 24-hour');
});

test('a valid-looking but empty window (end <= start) shows the window error and keeps Save disabled', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      'Focus mornings',
    );
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'Mon')!.props.onPress();
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText(
      '09:00',
    );
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('09:00');
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'example.com')!.props.onPress();
  });

  expect(extractText(testRenderer.toJSON())).toContain(
    'End must be after start.',
  );
  expect(
    (
      findButtonByLabel(testRenderer.root, 'Save')!.props
        .accessibilityState as { disabled?: boolean }
    ).disabled,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Save -> stageScheduleUpsert + announce + close
// ---------------------------------------------------------------------------

test('Save stages ONE schedule via stageScheduleUpsert, announces, and closes', () => {
  seedState({});
  const testRenderer = renderEditor('new');

  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      '  Evenings  ',
    );
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'Sun')!.props.onPress();
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText('9:5');
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('23:30');
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'example.com')!.props.onPress();
  });

  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });

  const state = useDomainStore.getState();
  expect(state.stagedSchedules).toHaveLength(1);
  expect(state.stagedSchedules![0]).toStrictEqual({
    id: 'evenings',
    name: 'Evenings', // trimmed
    weekdays: [6],
    startTime: '09:05', // zero-padded by the store's normaliseTime re-run
    endTime: '23:30',
    enabled: true, // the add default
    domains: ['example.com'],
  });
  expect(announceForAccessibility).toHaveBeenCalledWith(
    'Schedule staged. Apply to save.',
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Save on ADD derives a unique id via nextScheduleId (collision -> -2)', () => {
  seedState({ schedules: [{ ...FOCUS, domains: ['example.com'] }] });
  const testRenderer = renderEditor('new');

  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      'Focus mornings',
    );
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'Mon')!.props.onPress();
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText(
      '10:00',
    );
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'End time')!.props.onChangeText('12:00');
  });
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer.root, 'example.com')!.props.onPress();
  });

  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });

  const state = useDomainStore.getState();
  expect(state.stagedSchedules).toHaveLength(2);
  // The existing schedule is untouched; the new one uniquified.
  expect(state.stagedSchedules![0].id).toBe('focus-mornings');
  expect(state.stagedSchedules![1].id).toBe('focus-mornings-2');
});

test('Save on EDIT keeps the existing id and replaces the schedule in place', () => {
  seedState({ schedules: [FOCUS] });
  const testRenderer = renderEditor('focus-mornings');

  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      'Deep focus',
    );
  });
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Start time')!.props.onChangeText(
      '08:00',
    );
  });

  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });

  const state = useDomainStore.getState();
  expect(state.stagedSchedules).toHaveLength(1);
  expect(state.stagedSchedules![0].id).toBe('focus-mornings');
  expect(state.stagedSchedules![0].name).toBe('Deep focus');
  expect(state.stagedSchedules![0].startTime).toBe('08:00');
  // The untouched edit fields survive (pre-filled values pass through).
  expect(state.stagedSchedules![0].endTime).toBe('17:00');
  expect(state.stagedSchedules![0].enabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Cancel / scratchpad invariants
// ---------------------------------------------------------------------------

test('Cancel closes WITHOUT staging anything', () => {
  seedState({ schedules: [FOCUS] });
  const testRenderer = renderEditor('focus-mornings');

  // Edit a field, then Cancel — the draft is discarded, not staged.
  ReactTestRenderer.act(() => {
    findInputByLabel(testRenderer.root, 'Schedule name')!.props.onChangeText(
      'Changed',
    );
  });
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Cancel')!.props.onPress();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
  expect(announceForAccessibility).not.toHaveBeenCalledWith(
    'Schedule staged. Apply to save.',
  );
});

// ---------------------------------------------------------------------------
// The union domain list (orphaned domains)
// ---------------------------------------------------------------------------

test('the domain list is committed UNION the schedule’s own domains; the orphaned domain renders selected and keeps membership through Save', () => {
  // `news.site` is in the schedule but NOT in the committed blocklist.
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    schedules: [FOCUS],
  });
  const testRenderer = renderEditor('focus-mornings');

  // Both render; the orphaned one pre-checked.
  const checked = Object.fromEntries(
    findCheckboxes(testRenderer.root).map((c) => [c.label, c.checked]),
  );
  expect(checked['example.com']).toBe(true);
  expect(checked['news.site']).toBe(true);

  // Save untouched (a net-identical edit) -> clean-revert, membership kept.
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });
  // Net-identical edit: the buffer cleared (no redundant admin prompt).
  expect(useDomainStore.getState().stagedSchedules).toBeNull();

  // Now toggle the orphaned OFF then Save: the staged draft drops it.
  const testRenderer2 = renderEditor('focus-mornings');
  ReactTestRenderer.act(() => {
    findCheckboxByLabel(testRenderer2.root, 'news.site')!.props.onPress();
  });
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer2.root, 'Save')!.props.onPress();
  });
  expect(useDomainStore.getState().stagedSchedules![0].domains).toStrictEqual([
    'example.com',
  ]);
});

// ---------------------------------------------------------------------------
// Empty blocklist
// ---------------------------------------------------------------------------

test('an empty blocklist with no orphaned memberships renders the note and keeps Save disabled', () => {
  seedState({ domains: [] });
  const testRenderer = renderEditor('new');

  expect(extractText(testRenderer.toJSON())).toContain(
    'Your blocklist is empty. Add domains first',
  );
  expect(
    (
      findButtonByLabel(testRenderer.root, 'Save')!.props
        .accessibilityState as { disabled?: boolean }
    ).disabled,
  ).toBe(true);
});

test('an empty blocklist still lists an EDITING schedule’s orphaned domains (they stay selectable)', () => {
  seedState({ domains: [], schedules: [FOCUS] });
  const testRenderer = renderEditor('focus-mornings');

  // The note does NOT render (there is something to select).
  expect(extractText(testRenderer.toJSON())).not.toContain(
    'Your blocklist is empty.',
  );
  const checked = Object.fromEntries(
    findCheckboxes(testRenderer.root).map((c) => [c.label, c.checked]),
  );
  expect(checked['example.com']).toBe(true);
  expect(checked['news.site']).toBe(true);
});
// ---------------------------------------------------------------------------
// Prefill coercion (5-2 review patch): the editor must mirror the store's
// coercion so its Save gate can never pass a draft the store rejects.
// ---------------------------------------------------------------------------

test('a hand-edited junk weekday value ([7]) pre-fills NO chips, keeps Save disabled, and shows the weekdays error', () => {
  seedState({
    schedules: [{ ...FOCUS, weekdays: [7] as unknown as ScheduleType['weekdays'] }],
  });
  const testRenderer = renderEditor('focus-mornings');

  // The junk value did not survive prefill: no WEEKDAY chip is checked
  // (the domain checkbox may legitimately be checked — that is the
  // schedule's own prefill, not the chips).
  const chipLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const checkedChips = findCheckboxes(testRenderer.root).filter(
    (c) => chipLabels.includes(c.label) && c.checked,
  );
  expect(checkedChips).toHaveLength(0);

  // The error renders (an edit counts as touched) and names the field.
  expect(extractText(testRenderer.toJSON())).toContain(
    'Pick at least one day.',
  );

  // Save stays disabled — the sheet can never submit the junk draft.
  expect(
    (findButtonByLabel(testRenderer.root, 'Save')!.props.accessibilityState as {
      disabled?: boolean;
    }).disabled,
  ).toBe(true);
  // And pressing it (defensively) stages nothing.
  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });
  expect(useDomainStore.getState().stagedSchedules).toBeNull();
});

test('a hand-edited unnormalisable domain entry is dropped from the prefill (what is shown is what the store accepts)', () => {
  seedState({
    schedules: [
      {
        ...FOCUS,
        domains: ['NEWS.site', '!!!', 'https://video.com/watch'],
      },
    ],
  });
  const testRenderer = renderEditor('focus-mornings');

  const checked = Object.fromEntries(
    findCheckboxes(testRenderer.root).map((c) => [c.label, c.checked]),
  );
  // The normalisable entries render normalised + checked; the junk is gone.
  expect(checked['news.site']).toBe(true);
  expect(checked['video.com']).toBe(true);
  expect(checked['!!!']).toBeUndefined();
  expect(checked['https://video.com/watch']).toBeUndefined();
});

test('a MISSING enabled field preserves TRUE through Save (the store default, not false)', () => {
  seedState({
    schedules: [
      { ...FOCUS, enabled: undefined as unknown as boolean },
    ],
  });
  const testRenderer = renderEditor('focus-mornings');

  ReactTestRenderer.act(() => {
    findButtonByLabel(testRenderer.root, 'Save')!.props.onPress();
  });
  const staged = useDomainStore.getState().stagedSchedules;
  expect(staged).toHaveLength(1);
  expect(staged![0].enabled).toBe(true);
});

test('an unknown target id falls back to the ADD sheet (defensive; the Shell only passes ids it read off rows)', () => {
  seedState({ schedules: [FOCUS] });
  const testRenderer = renderEditor('does-not-exist');

  expect(extractText(testRenderer.toJSON())).toContain('Add schedule');
  expect(extractText(testRenderer.toJSON())).not.toContain('Edit schedule');
  // An empty ADD draft, not a half-prefilled one.
  expect(findInputByLabel(testRenderer.root, 'Schedule name')!.props.value).toBe(
    '',
  );
  expect(
    (findButtonByLabel(testRenderer.root, 'Save')!.props.accessibilityState as {
      disabled?: boolean;
    }).disabled,
  ).toBe(true);
});
