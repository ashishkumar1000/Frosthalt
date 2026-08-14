/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { ApplyButton } from '../src/components/ApplyButton';

// The Pressable node is located by its contract props (`accessibilityRole:
// 'button'` + an `onPress` function) rather than by `findByType(Pressable)`.
// Under pnpm + react-native 0.81's lazy component getters, the `Pressable`
// reference the test imports is not identity-equal to the one in the rendered
// tree, so `findByType(Pressable)` finds nothing. The prop-based query is
// stable and says exactly what we mean: "the button element carrying the
// press handler." The accent fill / white text / rounded.md visuals are
// native-rendered and covered by the manual visual check + code review
// (asserting PlatformColor mock objects would couple to the RN version — see
// the spec's Jest-runtime matrix row). The node-testable contract is: label
// rendered, onPress fires, disabled wired, reduced-opacity on disabled.
function findPressable(root: ReactTestRenderer.ReactTestInstance) {
  const matches = root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole === 'button',
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

// I/O Matrix: ApplyButton idle — renders its label and fires onPress on press.
test('ApplyButton renders its label and fires onPress when pressed', async () => {
  const onPress = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <ApplyButton label="Apply" onPress={onPress} />,
    );
  });
  expect(extractText(testRenderer.toJSON())).toBe('Apply');
  const button = findPressable(testRenderer.root);
  expect(button.props.disabled).toBe(false);
  expect(button.props.accessibilityState).toEqual({ disabled: false });
  await ReactTestRenderer.act(() => {
    button.props.onPress();
  });
  expect(onPress).toHaveBeenCalledTimes(1);
});

// I/O Matrix: ApplyButton disabled — non-interactive; the disabled state is
// wired through to the Pressable (disabled prop + accessibilityState) and the
// reduced-opacity style is applied. The native press responder gates the
// actual press in a real runtime; here we assert the contract the responder
// reads, plus the opacity style that conveys the disabled affordance.
test('ApplyButton disabled reflects the disabled state', async () => {
  const onPress = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <ApplyButton label="Apply" onPress={onPress} disabled />,
    );
  });
  const button = findPressable(testRenderer.root);
  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState).toEqual({ disabled: true });
  // The disabled style ({ opacity: 0.4 }) is a plain number, safe to assert
  // without coupling to PlatformColor mock shapes. It conveys the
  // "reduced-opacity, non-interactive" affordance from the I/O matrix row.
  expect(hasOpacity(testRenderer.toJSON(), 0.4)).toBe(true);
});

// I/O Matrix: ApplyButton pressed — the press-feedback affordance. The
// Pressable style is a function of the interaction state; the default render
// is pressed:false, so the pressed style can't be read from toJSON(). Invoke
// the style callback with pressed:true and assert the pressed style
// ({ opacity: 0.85 }) is present — mirroring the disabled-opacity assertion.
test('ApplyButton shows reduced opacity in the pressed state', async () => {
  const onPress = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <ApplyButton label="Apply" onPress={onPress} />,
    );
  });
  const button = findPressable(testRenderer.root);
  const styleFn = button.props.style;
  expect(typeof styleFn).toBe('function');
  const pressedStyle = styleFn({ pressed: true });
  expect(styleHasOpacity(pressedStyle, 0.85)).toBe(true);
});

/**
 * Walks a react-test-renderer JSON tree and concatenates its text nodes.
 * `toJSON()` is stable across react-test-renderer versions, avoiding coupling
 * to the `findByType` array-vs-single return shape.
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

/** True if any style entry on the root host node sets the given opacity. */
function hasOpacity(node: unknown, opacity: number): boolean {
  if (node == null || typeof node !== 'object' || !('props' in node)) {
    return false;
  }
  return styleHasOpacity(
    (node as { props: { style?: unknown } }).props.style,
    opacity,
  );
}

/**
 * True if any entry in a style value (array or single) sets the given opacity.
 * Used by both the disabled-opacity assertion (read off the rendered host
 * node via hasOpacity) and the pressed-opacity assertion (read off the style
 * callback's return value).
 */
function styleHasOpacity(style: unknown, opacity: number): boolean {
  const styles = Array.isArray(style) ? style : [style];
  return styles.some(
    (entry) =>
      entry != null &&
      typeof entry === 'object' &&
      (entry as { opacity?: number }).opacity === opacity,
  );
}
