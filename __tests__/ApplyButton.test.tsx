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
  // Story 2.3 wrapped Pressable in `Animated.createAnimatedComponent`, which
  // forwards the contract props (`onPress` + `accessibilityRole`) onto BOTH
  // the animated wrapper node and the inner Pressable node. So `findAll`
  // returns 2 matches. The WRAPPER (first match) owns the original `style`
  // function prop (the inner node receives the flattened resolved style), so
  // we pick the first to keep the pressed-style assertion reading a function.
  expect(matches.length).toBeGreaterThanOrEqual(1);
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
  // Story 2.3 added the `busy` prop to `accessibilityState`; default false.
  expect(button.props.accessibilityState).toEqual({
    disabled: false,
    busy: false,
  });
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
  expect(button.props.accessibilityState).toEqual({
    disabled: true,
    busy: false,
  });
  // The disabled style ({ opacity: 0.4 }) is a plain number, safe to assert
  // without coupling to PlatformColor mock shapes. It conveys the
  // "reduced-opacity, non-interactive" affordance from the I/O matrix row.
  expect(hasOpacity(testRenderer.toJSON(), 0.4)).toBe(true);
});

// I/O Matrix: ApplyButton pressed — the press-feedback affordance. Story 2.3
// converted the style to a static array (the `Animated.createAnimatedComponent`
// wrapper does not resolve a Pressable press-state function-style), so press
// feedback is now driven by `onPressIn`/`onPressOut` state. Drive `onPressIn`
// and assert the rendered style now carries the pressed opacity (0.85) —
// mirroring the disabled-opacity assertion. `onPressOut` restores it.
test('ApplyButton shows reduced opacity in the pressed state', async () => {
  const onPress = jest.fn();
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  await ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      <ApplyButton label="Apply" onPress={onPress} />,
    );
  });
  const button = findPressable(testRenderer.root);
  // Default render: pressed:false — the pressed style (0.85) is NOT present.
  expect(styleHasOpacity(button.props.style, 0.85)).toBe(false);
  // Press in: the state flips and the re-rendered style carries 0.85.
  await ReactTestRenderer.act(() => {
    button.props.onPressIn();
  });
  expect(styleHasOpacity(findPressable(testRenderer.root).props.style, 0.85)).toBe(true);
  // Press out: restored.
  await ReactTestRenderer.act(() => {
    findPressable(testRenderer.root).props.onPressOut();
  });
  expect(styleHasOpacity(findPressable(testRenderer.root).props.style, 0.85)).toBe(false);
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
