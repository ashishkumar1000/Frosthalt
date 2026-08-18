/**
 * Story 3.1 + 3.3 — the Settings screen branching tests.
 *
 * The Settings screen branches on `committed.passwordHash`: when unset it
 * renders `<SetPassword>` (the set-password form); when set it renders a
 * neutral "Password set." status line PLUS the Danger Zone section (Story 3-3)
 * — a destructive header containing `<ChangePassword>` (the "Change password"
 * trigger). These tests pin both branches so a regression in the sentinel
 * check (`passwordHash != null && passwordHash !== ''`) surfaces.
 *
 * The store is a real Zustand store; the two NATIVE specs are mocked so
 * `readConfig()` at module-eval time falls back to DEFAULT_CONFIG (no
 * passwordHash) — see the store.test.ts:21-35 / AddDomain.test.tsx pattern.
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
import { Settings } from '../src/components/Settings';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import { hashPassword } from '../src/config/password';

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

let currentRenderer: ReturnType<typeof ReactTestRenderer.create> | null = null;

afterEach(() => {
  if (currentRenderer) {
    ReactTestRenderer.act(() => {
      currentRenderer!.unmount();
    });
    currentRenderer = null;
  }
});

function renderSettings() {
  let testRenderer!: ReturnType<typeof ReactTestRenderer.create>;
  ReactTestRenderer.act(() => {
    testRenderer = ReactTestRenderer.create(
      // Story 3-4 threads `onNavigateBlocklist` (Shell's `selectRow(0)`)
      // through Settings -> Panic. The Settings tests do not exercise the
      // navigation link (Panic's success toast handler), so a noop stub is
      // fine here — the navigation wiring is asserted in Panic.test.tsx.
      <Settings onNavigateBlocklist={() => {}} />,
    );
  });
  currentRenderer = testRenderer;
  return testRenderer;
}

test('with no password set, Settings renders the SetPassword form (entry + confirm fields)', () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG }, // passwordHash unset
    });
  });

  const testRenderer = renderSettings();
  const text = extractText(testRenderer.toJSON());
  // The screen title is present.
  expect(text).toContain('Settings');
  // The SetPassword form is rendered: the field labels + submit button label.
  expect(text).toContain('Password');
  expect(text).toContain('Confirm password');
  expect(text).toContain('Set password');
  // No Danger Zone section + no Change password trigger when no password is
  // set (Story 3-3 — the Danger Zone renders ONLY when `hasPassword`).
  expect(text).not.toContain('Danger Zone');
  expect(text).not.toContain('Change password');
});

test('with a password set, Settings renders the neutral "Password set." state and NO set-password form', () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: hashPassword('anything'),
      },
    });
  });

  const testRenderer = renderSettings();
  const text = extractText(testRenderer.toJSON());
  // The neutral confirmation is shown.
  expect(text).toContain('Password set.');
  // The set-password form is NOT rendered (no entry/confirm fields, no submit).
  expect(text).not.toContain('Confirm password');
  expect(text).not.toContain('Set password');
  // No TextInput fields at all in the "Password set" state.
  const fields = testRenderer.root.findAll(
    (node) =>
      node.props &&
      typeof node.props.onChangeText === 'function' &&
      typeof node.props.value === 'string',
  );
  expect(fields.length).toBe(0);
});

test('the "Password set" state shows the Danger Zone section with a "Change password" button (Story 3-3)', () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: hashPassword('anything'),
      },
    });
  });

  const testRenderer = renderSettings();
  const text = extractText(testRenderer.toJSON());
  // The Danger Zone section is present (destructive header).
  expect(text).toContain('Danger Zone');
  // The "Change password" trigger button is present (Story 3-3's first
  // occupant of the Danger Zone).
  expect(text).toContain('Change password');
  // Story 3-4 — the Panic trigger ("Clear all blocked hosts") is rendered as
  // a sibling of <ChangePassword/> INSIDE the Danger Zone.
  expect(text).toContain('Clear all blocked hosts');
  // The neutral "Password set." status line is still shown (kept per spec).
  expect(text).toContain('Password set.');

  // The Danger Zone is announced as a distinct region (spec's Always). Pin the
  // a11y PROPS — not just the text — so the contract can't be silently dropped:
  // the header carries `accessibilityRole="header"` (the VoiceOver landmark;
  // RN 0.81 has no region/group role) and the container carries
  // `accessibilityLabel="Danger Zone"` (the grouping affordance). The header
  // has no label and the container has no role, so the two queries are
  // disjoint and each pins exactly one node.
  const headers = testRenderer.root.findAll(
    (node) => node.props && node.props.accessibilityRole === 'header',
  );
  expect(headers.length).toBeGreaterThanOrEqual(1);
  const dangerContainers = testRenderer.root.findAll(
    (node) => node.props && node.props.accessibilityLabel === 'Danger Zone',
  );
  expect(dangerContainers.length).toBeGreaterThanOrEqual(1);

  // The Panic trigger is INSIDE the Danger Zone container: confirm the
  // ancestor relationship, not just the text presence, so a future caller
  // can't accidentally mount it next to the container. react-test-renderer
  // has no `parentOf`, so we assert via document order in `toJSON()`:
  // the Danger Zone container is an ancestor of the Panic trigger if and
  // only if it appears at a strictly earlier JSON-tree index. Pin both
  // nodes via their accessibility props.
  const panicTrigger = testRenderer.root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityLabel === 'Clear all blocked hosts — requires password' &&
      node.props.accessibilityRole === 'button',
  )[0];
  expect(panicTrigger).toBeDefined();
  // Document-order check: the Danger Zone container appears BEFORE the
  // Panic trigger in the toJSON() tree, proving ancestor containment.
  const json = testRenderer.toJSON();
  const jsonStr = JSON.stringify(json);
  const dangerIdx = jsonStr.indexOf('"accessibilityLabel":"Danger Zone"');
  const panicIdx = jsonStr.indexOf(
    '"accessibilityLabel":"Clear all blocked hosts — requires password"',
  );
  expect(dangerIdx).toBeGreaterThanOrEqual(0);
  expect(panicIdx).toBeGreaterThanOrEqual(0);
  expect(dangerIdx).toBeLessThan(panicIdx);
});

test('with no password set, Settings renders the SetPassword form and NO Danger Zone / Panic (Story 3-1 + 3-4 absence)', () => {
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: { ...DEFAULT_CONFIG }, // passwordHash unset
    });
  });

  const testRenderer = renderSettings();
  const text = extractText(testRenderer.toJSON());
  // No Danger Zone when no password is set (the parent branch handles it).
  expect(text).not.toContain('Danger Zone');
  expect(text).not.toContain('Change password');
  // Story 3-4 — the Panic trigger is mounted ONLY inside the Danger Zone,
  // so it is also absent in the no-password branch.
  expect(text).not.toContain('Clear all blocked hosts');
  // Prop-based pin so a future regression that silently drops the branch
  // cannot ship green — the trigger must be ENTIRELY absent.
  const panicTrigger = testRenderer.root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityLabel ===
        'Clear all blocked hosts — requires password' &&
      node.props.accessibilityRole === 'button',
  );
  expect(panicTrigger.length).toBe(0);
});

test('the Settings screen title is always "Settings" in both branches', () => {
  // Branch 1: no password.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({ committed: { ...DEFAULT_CONFIG } });
  });
  let testRenderer = renderSettings();
  expect(extractText(testRenderer.toJSON())).toContain('Settings');
  ReactTestRenderer.act(() => {
    testRenderer.unmount();
  });
  currentRenderer = null;

  // Branch 2: password set.
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        passwordHash: hashPassword('x'),
      },
    });
  });
  testRenderer = renderSettings();
  expect(extractText(testRenderer.toJSON())).toContain('Settings');
});