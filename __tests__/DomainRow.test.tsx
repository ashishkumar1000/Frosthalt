/**
 * @format
 *
 * Story 2.4 — DomainRow remove-control tests.
 *
 * Renders a single `<DomainRow>` with `react-test-renderer` (no store, no native
 * spec mocks needed — DomainRow imports only `tokens`/`Checkbox`/`Domain`, and
 * `PlatformColor` is mocked by the react-native jest preset, same seam as
 * `ApplyButton.test.tsx`). Covers:
 *   - The remove control renders (always mounted) with the right a11y label.
 *   - Pressing it calls `onRemove(domain.hostname)` (the stored apex).
 *   - `disabled` propagates to the remove control (no staging during Apply).
 *   - Opacity is 0 by default (hidden) and 1 on `onHoverIn` and on `onFocus`.
 *   - Tab order is checkbox -> domain -> remove (source order).
 *
 * The remove control is located by its contract props (`accessibilityRole:
 * 'button'` + an `onPress` + `accessibilityLabel: 'Remove <host>'`), NOT by
 * `findByType(Pressable)` — under pnpm + RN 0.81's lazy component getters the
 * imported `Pressable` is not identity-equal to the one in the rendered tree
 * (same prop-based query pattern as Blocklist.test.tsx / ApplyButton.test.tsx).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { DomainRow } from '../src/components/DomainRow';
import type { Domain } from '../src/config/types';

const EXAMPLE: Domain = { hostname: 'example.com', alwaysOn: true };

/** Locate the remove Pressable by its contract props (role + label). */
function findRemoveButton(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Remove '),
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Locate the hover-container Pressable by its `onHoverIn` prop. */
function findHoverContainer(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance {
  const matches = root.findAll(
    (node) => node.props && typeof node.props.onHoverIn === 'function',
  );
  expect(matches.length).toBeGreaterThanOrEqual(1);
  return matches[0];
}

/** Read the `opacity` value from a (possibly array) style prop. */
function styleOpacity(style: unknown): number | undefined {
  const styles = Array.isArray(style) ? style : [style];
  for (const entry of styles) {
    if (
      entry != null &&
      typeof entry === 'object' &&
      'opacity' in (entry as Record<string, unknown>)
    ) {
      return (entry as { opacity?: number }).opacity;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The remove control renders, is always mounted, and carries the a11y label.
// ---------------------------------------------------------------------------

test('DomainRow renders a remove control with accessibilityLabel "Remove <hostname>"', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  const remove = findRemoveButton(testRenderer.root);
  expect(remove.props.accessibilityLabel).toBe('Remove example.com');
  expect(remove.props.accessibilityRole).toBe('button');
  expect(remove.props.focusable).toBe(true);
  expect(remove.props.enableFocusRing).toBe(true);
});

// ---------------------------------------------------------------------------
// Pressing the remove control calls onRemove with the stored apex.
// ---------------------------------------------------------------------------

test('pressing the remove control calls onRemove with domain.hostname (the stored apex)', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  ReactTestRenderer.act(() => {
    findRemoveButton(testRenderer.root).props.onPress();
  });

  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onRemove).toHaveBeenCalledWith('example.com');
});

// ---------------------------------------------------------------------------
// disabled propagates to the remove control (no staging during Apply).
// ---------------------------------------------------------------------------

test('the remove control is disabled when disabled={true} is passed', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow
        domain={EXAMPLE}
        onToggleAlwaysOn={jest.fn()}
        onRemove={onRemove}
        disabled
      />,
    );
  });

  const remove = findRemoveButton(testRenderer.root);
  expect(remove.props.disabled).toBe(true);
  expect(remove.props.accessibilityState).toEqual({ disabled: true });
});

test('the remove control is enabled by default', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  const remove = findRemoveButton(testRenderer.root);
  expect(remove.props.disabled).toBe(false);
  expect(remove.props.accessibilityState).toEqual({ disabled: false });
});

// ---------------------------------------------------------------------------
// Opacity reveal: 0 by default (hidden), 1 on hover-in and on focus.
// ---------------------------------------------------------------------------

test('the remove control is hidden (opacity 0) by default', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  const remove = findRemoveButton(testRenderer.root);
  expect(styleOpacity(remove.props.style)).toBe(0);
});

test('the remove control reveals (opacity 1) on row hover-in', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  // Hover the row -> the remove control becomes visible.
  ReactTestRenderer.act(() => {
    findHoverContainer(testRenderer.root).props.onHoverIn();
  });

  expect(styleOpacity(findRemoveButton(testRenderer.root).props.style)).toBe(1);

  // Hover out -> hidden again.
  ReactTestRenderer.act(() => {
    findHoverContainer(testRenderer.root).props.onHoverOut();
  });

  expect(styleOpacity(findRemoveButton(testRenderer.root).props.style)).toBe(0);
});

test('the remove control reveals (opacity 1) on button focus (keyboard Tab)', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  // Focus the remove control (keyboard Tab to it) -> it becomes visible.
  ReactTestRenderer.act(() => {
    findRemoveButton(testRenderer.root).props.onFocus();
  });

  expect(styleOpacity(findRemoveButton(testRenderer.root).props.style)).toBe(1);

  // Blur -> hidden again.
  ReactTestRenderer.act(() => {
    findRemoveButton(testRenderer.root).props.onBlur();
  });

  expect(styleOpacity(findRemoveButton(testRenderer.root).props.style)).toBe(0);
});

test('the remove control is dimmed (opacity 0.4) when disabled AND hovered', () => {
  // During an Apply run the control is disabled; hovering reveals it dimmed
  // (the same dim the checkbox + Apply button use), conveying non-interactive.
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow
        domain={EXAMPLE}
        onToggleAlwaysOn={jest.fn()}
        onRemove={onRemove}
        disabled
      />,
    );
  });

  ReactTestRenderer.act(() => {
    findHoverContainer(testRenderer.root).props.onHoverIn();
  });

  expect(styleOpacity(findRemoveButton(testRenderer.root).props.style)).toBe(0.4);
});

// ---------------------------------------------------------------------------
// Tab order: checkbox -> domain -> remove (document order).
// ---------------------------------------------------------------------------

test('Tab order is checkbox -> domain label -> remove (document order)', () => {
  const onRemove = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <DomainRow domain={EXAMPLE} onToggleAlwaysOn={jest.fn()} onRemove={onRemove} />,
    );
  });

  const checkbox = testRenderer.root.findAll(
    (node) =>
      node.props && node.props.accessibilityRole === 'checkbox',
  )[0];
  const labelWrapper = testRenderer.root.findAll(
    (node) =>
      node.props &&
      node.props.focusable === true &&
      node.props.accessibilityRole === 'text',
  )[0];
  const remove = findRemoveButton(testRenderer.root);

  expect(checkbox).toBeDefined();
  expect(labelWrapper).toBeDefined();
  expect(labelWrapper.props.accessibilityLabel).toBe('example.com');

  // `findAll(() => true)` returns nodes in document order. Assert the three
  // Tab stops appear in the expected reading order.
  const all = testRenderer.root.findAll(() => true);
  const checkboxIdx = all.indexOf(checkbox);
  const labelIdx = all.indexOf(labelWrapper);
  const removeIdx = all.indexOf(remove);
  expect(checkboxIdx).toBeGreaterThanOrEqual(0);
  expect(labelIdx).toBeGreaterThan(checkboxIdx);
  expect(removeIdx).toBeGreaterThan(labelIdx);
  // The row-root hover container MUST be non-focusable — otherwise it would
  // regress into a Tab stop between checkbox and domain, breaking the
  // checkbox -> domain -> remove Tab order. `focusable={false}` is load-bearing
  // (see the DomainRow comment); pin it so removing it fails this test.
  expect(findHoverContainer(testRenderer.root).props.focusable).toBe(false);
});