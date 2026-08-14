/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StatusBadge } from '../src/components/StatusBadge';
import { statusColorNames, tokens, type StatusKey } from '../src/theme/tokens';

// AC-4: the status NAME constants map to the three NSColor names. Asserted as
// plain strings (not PlatformColor mock objects) so the test does not couple to
// the RN version's opaque PlatformColor shape.
test('statusColorNames.free maps to systemGreenColor', () => {
  expect(statusColorNames.free).toBe('systemGreenColor');
});

test('statusColorNames.amber maps to systemOrangeColor', () => {
  expect(statusColorNames.amber).toBe('systemOrangeColor');
});

test('statusColorNames.blocked maps to systemRedColor', () => {
  expect(statusColorNames.blocked).toBe('systemRedColor');
});

// I/O Matrix badge rows: each status renders its label text and exposes a
// "Status: <Label>" accessibility label on the rendered pill. Asserted on the
// host node returned by `toJSON()` rather than via `findAll` counts — the RN
// jest preset's View mock spreads the parent's props onto the host element it
// renders, so an accessibility-label `findAll` would match both the mock class
// instance and the host node (two matches), which says nothing about the
// component's own contract. The host node's props are the rendered contract.
test('StatusBadge renders "Free" for status="free"', async () => {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<StatusBadge status="free" />);
  });
  const json = testRenderer.toJSON();
  expect(extractText(json)).toBe('Free');
  expect(accessibilityLabelOf(json)).toBe('Status: Free');
  expect(accessibilityRoleOf(json)).toBe('text');
});

test('StatusBadge renders "Blocking" for status="amber"', async () => {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<StatusBadge status="amber" />);
  });
  const json = testRenderer.toJSON();
  expect(extractText(json)).toBe('Blocking');
  expect(accessibilityLabelOf(json)).toBe('Status: Blocking');
  expect(accessibilityRoleOf(json)).toBe('text');
});

test('StatusBadge renders "Blocked" for status="blocked"', async () => {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(<StatusBadge status="blocked" />);
  });
  const json = testRenderer.toJSON();
  expect(extractText(json)).toBe('Blocked');
  expect(accessibilityLabelOf(json)).toBe('Status: Blocked');
  expect(accessibilityRoleOf(json)).toBe('text');
});

// I/O Matrix: an unknown status renders nothing — the badge is never decorative.
test('StatusBadge renders null for an unrecognised status', async () => {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <StatusBadge status={'unrecognised' as never} />,
    );
  });
  expect(testRenderer.toJSON()).toBeNull();
});

// AC-4: the badge FILL maps to the three status tokens. The name-constant
// tests above assert the NSColor name each status maps to, and the render
// tests assert the label text — but neither connects the badge's fill to the
// status token. This test closes that wiring: it asserts the rendered badge's
// backgroundColor is identity-equal to tokens.status[status]. Because
// statusFill returns tokens.status[status] (one construction site), the
// badge's fill IS the exported token object — so the assertion verifies the
// status->fill wiring without coupling to PlatformColor's opaque resolved
// shape (the concern behind the frozen Jest-runtime matrix row).
test('StatusBadge fill maps each status to its status token', async () => {
  const cases: Array<[StatusKey, string]> = [
    ['free', 'Free'],
    ['amber', 'Blocking'],
    ['blocked', 'Blocked'],
  ];
  for (const [status, label] of cases) {
    let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
    await ReactTestRenderer.act(() => {
      testRenderer = ReactTestRenderer.create(<StatusBadge status={status} />);
    });
    const json = testRenderer.toJSON();
    expect(json).not.toBeNull();
    expect(backgroundColorOf(json)).toBe(tokens.status[status]);
    // Sanity: the same node carries the expected label, so we read the fill
    // off the badge and not some other node.
    expect(accessibilityLabelOf(json)).toBe(`Status: ${label}`);
  }
});

/**
 * Walks a react-test-renderer JSON tree and concatenates its text nodes.
 * `toJSON()` is stable across react-test-renderer versions, so this avoids
 * coupling to the `findByType` array-vs-single return shape.
 */
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

/** Reads the accessibilityLabel off a react-test-renderer host JSON node. */
function accessibilityLabelOf(node: unknown): string | undefined {
  if (
    node != null &&
    typeof node === 'object' &&
    'props' in node
  ) {
    return (node as { props: { accessibilityLabel?: string } }).props
      .accessibilityLabel;
  }
  return undefined;
}

/** Reads the accessibilityRole off a react-test-renderer host JSON node. */
function accessibilityRoleOf(node: unknown): string | undefined {
  if (
    node != null &&
    typeof node === 'object' &&
    'props' in node
  ) {
    return (node as { props: { accessibilityRole?: string } }).props
      .accessibilityRole;
  }
  return undefined;
}

/**
 * Reads the backgroundColor off a react-test-renderer host JSON node's style
 * array. Used by the fill-wiring test (AC-4): the badge style is
 * `[styles.badge, { backgroundColor: statusFill(status) }]`, so this returns
 * the PlatformColor object the badge renders with. StyleSheet entries that are
 * not objects (e.g. registered IDs on native) are skipped; entries without a
 * `backgroundColor` key are skipped.
 */
function backgroundColorOf(node: unknown): unknown {
  if (node == null || typeof node !== 'object' || !('props' in node)) {
    return undefined;
  }
  const style = (node as { props: { style?: unknown } }).props.style;
  const styles = Array.isArray(style) ? style : [style];
  for (const entry of styles) {
    if (
      entry != null &&
      typeof entry === 'object' &&
      'backgroundColor' in entry
    ) {
      return (entry as { backgroundColor?: unknown }).backgroundColor;
    }
  }
  return undefined;
}
