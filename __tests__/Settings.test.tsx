/**
 * Story 3.1 — the Settings screen branching tests.
 *
 * The Settings screen branches on `committed.passwordHash`: when unset it
 * renders `<SetPassword>` (the set-password form); when set it renders a
 * neutral "Password set." state with NO change-password UI (change-password is
 * Story 3-3). These tests pin both branches so a regression in the sentinel
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
    testRenderer = ReactTestRenderer.create(<Settings />);
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

test('the "Password set" state shows NO change-password UI in this story (change-password is 3-3)', () => {
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
  // No "Change password" button/label — that is Story 3-3's Danger Zone.
  expect(text).not.toContain('Change password');
  // No "Danger Zone" section — that is Story 3-3.
  expect(text).not.toContain('Danger');
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