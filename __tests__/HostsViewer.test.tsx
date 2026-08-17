/**
 * @format
 *
 * Story 2.6 — the read-only hosts viewer (HostsViewer) tests.
 *
 * Mirrors the Blocklist.test.tsx structure: TurboModule mocks (so the
 * transitive store -> configStore -> NativeConfigStoreSpec import resolves),
 * `extractText`, `findButtonByLabel`, a `seedState` helper extended with
 * `drift` + `lastReadSection`, an `afterEach` that unmounts the renderer so
 * the store subscription is released, and the `announceForAccessibility` cast.
 *
 * Covers the spec's I/O & Edge-Case Matrix:
 *   - in-sync: verbatim lines + no banner.
 *   - missing: banner + Restore (press -> `restoreSection` spy called).
 *   - mismatch: banner + Restore + the ACTUAL (drifted) lines verbatim.
 *   - corrupt: guidance + NO Restore button.
 *   - empty in-sync: empty-state line, no banner.
 *   - Restore busy (applyStatus='running'): button disabled.
 *   - Close button calls `onClose`.
 *   - `checkDrift` is called on mount (fresh read on open).
 *   - The drift banner exposes `accessibilityRole="alert"`.
 *
 * The viewer reads ONLY `useDomainStore` (the AD-5 rule); it must not import
 * `shellRunner.ts`/`readHostsSection`. `restoreSection`/`checkDrift` are spied
 * on the store so the tests assert the WIRING, not the port logic (which is
 * covered by store.test.ts).
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
import { HostsViewer } from '../src/components/HostsViewer';
import { useDomainStore } from '../src/domain/store';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Domain } from '../src/config/types';
import type { DriftResult } from '../src/domain/drift';
import type { ReadSectionResult } from '../src/hosts/shellRunner';

// The mocked native ShellRunner spec — `readHostsSection` is a jest.fn we
// control per-test so the mount `checkDrift()` recomputes the seeded drift
// (instead of clobbering it with a default `undefined` return).
const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as {
  readHostsSection: jest.Mock<ReadSectionResult, []>;
  writeHosts: jest.Mock;
};

// The react-native jest preset auto-mocks `announceForAccessibility` as a
// `jest.fn()`, but the react-native-macos TS type is `(announcement: string)
// => void` (no mock members). Cast once so `.mockClear()` /
// `.toHaveBeenCalledWith(...)` type-check — same pattern as Blocklist.test.tsx.
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
 * Locate a button by `accessibilityRole: 'button'` + an `onPress` + a matching
 * `accessibilityLabel`. There may be several buttons (Close + Restore); the
 * label disambiguates. Same finder pattern as Blocklist.test.tsx.
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

/** Locate the drift banner by `accessibilityRole: 'alert'` + the alert label. */
function findBanner(
  root: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      node.props &&
      node.props.accessibilityRole === 'alert' &&
      node.props.accessibilityLabel === 'Drift warning',
  )[0];
}

/**
 * Seeds the store state for a HostsViewer test AND mocks `readHostsSection` so
 * the mount `checkDrift()` recomputes the SAME drift + lastReadSection (instead
 * of clobbering the seed with a default `undefined` return). The mapping is:
 *   - drift.reason 'in-sync' with lastReadSection=L -> read returns { ok:true, section:L }
 *   - drift.reason 'missing' (lastReadSection null) -> read returns { ok:true, section:null }
 *   - drift.reason 'mismatch' with lastReadSection=L -> read returns { ok:true, section:L }
 *   - drift.reason 'corrupt' -> read returns { ok:false, error:'markers-mismatch' }
 *   - drift null (unchecked) -> read returns { ok:true, section:null } (the
 *     "checkDrift called on mount" test asserts the call, not the recomputed
 *     state, so any consistent return is fine).
 */
function seedState(overrides: {
  domains?: Domain[];
  drift?: DriftResult | null;
  lastReadSection?: string[] | null;
  applyStatus?: 'idle' | 'running';
}): void {
  announceForAccessibility.mockClear();
  shellNative.readHostsSection.mockReset();
  const reason = overrides.drift?.reason;
  if (reason === 'corrupt') {
    shellNative.readHostsSection.mockReturnValue({
      ok: false,
      error: 'markers-mismatch',
    });
  } else if (overrides.lastReadSection != null) {
    shellNative.readHostsSection.mockReturnValue({
      ok: true,
      section: overrides.lastReadSection,
    });
  } else {
    // Absent section (covers 'missing' + the in-sync empty-committed case +
    // drift:null).
    shellNative.readHostsSection.mockReturnValue({ ok: true, section: null });
  }
  ReactTestRenderer.act(() => {
    useDomainStore.setState({
      committed: {
        ...DEFAULT_CONFIG,
        domains: overrides.domains ?? DEFAULT_CONFIG.domains,
      },
      staged: null,
      applyStatus: overrides.applyStatus ?? 'idle',
      lastResult: null,
      drift: overrides.drift ?? null,
      lastReadSection: overrides.lastReadSection ?? null,
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

function renderViewer(onClose = jest.fn()): {
  renderer: ReturnType<typeof ReactTestRenderer.create>;
  onClose: jest.Mock;
} {
  let renderer!: ReturnType<typeof ReactTestRenderer.create>;
  // Wrap create in act so the mount `useEffect` (which calls `checkDrift()` ->
  // setState) flushes inside act and the renderer stays mounted. Same pattern
  // as Blocklist.test.tsx's `renderBlocklist`.
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<HostsViewer onClose={onClose} />);
  });
  currentRenderer = renderer;
  return { renderer, onClose };
}

// ---------------------------------------------------------------------------
// In-sync: verbatim lines, no banner
// ---------------------------------------------------------------------------

test('in-sync: the viewer renders the verbatim on-disk section lines and no banner', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: false, reason: 'in-sync' },
    lastReadSection: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 www.example.com',
      ':: www.example.com',
    ],
  });

  const { renderer } = renderViewer();
  const text = extractText(renderer.toJSON());

  // The actual on-disk lines render VERBATIM in the mono body. The viewer must
  // NOT render the expected/computed lines (effectiveHostsLines); here they
  // coincide (in-sync), so the discriminator is the exact strings.
  expect(text).toContain('0.0.0.0 example.com');
  expect(text).toContain(':: example.com');
  expect(text).toContain('0.0.0.0 www.example.com');
  expect(text).toContain(':: www.example.com');
  // No drift banner.
  expect(findBanner(renderer.root)).toBeUndefined();
  // No Restore button (no drift).
  expect(findButtonByLabel(renderer.root, 'Restore section')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Drift — missing: banner + Restore
// ---------------------------------------------------------------------------

test('drift reason "missing": the banner renders and a "Restore section" button is shown', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: true, reason: 'missing' },
    lastReadSection: null,
  });

  const { renderer } = renderViewer();
  const text = extractText(renderer.toJSON());

  // The spec's AC banner headline.
  expect(text).toContain(
    'Managed section not found — your hosts file may have been edited outside Frosthalt.',
  );
  // Banner is an alert.
  expect(findBanner(renderer.root)).toBeDefined();
  // Restore button is present.
  expect(findButtonByLabel(renderer.root, 'Restore section')).toBeDefined();
});

test('pressing "Restore section" calls the store restoreSection action', async () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: true, reason: 'missing' },
    lastReadSection: null,
  });
  const restoreSpy = jest.spyOn(useDomainStore.getState(), 'restoreSection');
  restoreSpy.mockResolvedValue({ ok: true });

  const { renderer } = renderViewer();
  const restore = findButtonByLabel(renderer.root, 'Restore section')!;
  expect(restore).toBeDefined();

  await ReactTestRenderer.act(async () => {
    restore.props.onPress();
    await Promise.resolve();
  });

  expect(restoreSpy).toHaveBeenCalledTimes(1);
  restoreSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Drift — mismatch: banner + Restore + the ACTUAL (drifted) lines verbatim
// ---------------------------------------------------------------------------

test('drift reason "mismatch": banner + Restore, and the body shows the ACTUAL on-disk lines (not the expected set)', () => {
  // committed has example.com, but the on-disk section holds a stray
  // '0.0.0.0 news.com' line someone added by hand. The viewer must render the
  // ACTUAL drifted lines (lastReadSection), NOT effectiveHostsLines(committed)
  // — rendering the expected set would hide the very drift the viewer exists
  // to expose.
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: true, reason: 'mismatch' },
    lastReadSection: [
      '0.0.0.0 example.com',
      ':: example.com',
      '0.0.0.0 news.com',
      ':: news.com',
    ],
  });

  const { renderer } = renderViewer();
  const text = extractText(renderer.toJSON());

  // The actual drifted line shows (the hand-edit is visible).
  expect(text).toContain('0.0.0.0 news.com');
  expect(text).toContain(':: news.com');
  // Banner + Restore.
  expect(findBanner(renderer.root)).toBeDefined();
  expect(findButtonByLabel(renderer.root, 'Restore section')).toBeDefined();
});

// ---------------------------------------------------------------------------
// Drift — corrupt: guidance, NO Restore
// ---------------------------------------------------------------------------

test('drift reason "corrupt": the banner + corrupt guidance render, and NO Restore button is shown', () => {
  seedState({
    drift: { drift: true, reason: 'corrupt' },
    lastReadSection: null,
  });

  const { renderer } = renderViewer();
  const text = extractText(renderer.toJSON());

  // Same banner headline (the spec's AC: SAME banner headline + corrupt
  // guidance sentence + NO Restore).
  expect(text).toContain(
    'Managed section not found — your hosts file may have been edited outside Frosthalt.',
  );
  // The corrupt guidance sentence.
  expect(text).toContain(
    'The managed section is corrupt and can’t be auto-repaired. Edit /etc/hosts manually, then reopen this viewer.',
  );
  expect(findBanner(renderer.root)).toBeDefined();
  // NO Restore button on corrupt (writeHosts pre-scan refuses malformed
  // markers — Restore cannot repair corrupt).
  expect(findButtonByLabel(renderer.root, 'Restore section')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Empty in-sync: empty-state line, no banner
// ---------------------------------------------------------------------------

test('in-sync with empty committed + absent section: the empty-state line renders and no banner', () => {
  seedState({
    drift: { drift: false, reason: 'in-sync' },
    lastReadSection: null,
  });

  const { renderer } = renderViewer();
  const text = extractText(renderer.toJSON());

  // The empty-state line (no managed section present).
  expect(text).toContain('No managed section present.');
  // No banner.
  expect(findBanner(renderer.root)).toBeUndefined();
  // No Restore.
  expect(findButtonByLabel(renderer.root, 'Restore section')).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Restore busy: applyStatus='running' disables the Restore button
// ---------------------------------------------------------------------------

test('Restore button is disabled while an Apply/Restore run is in flight (applyStatus running)', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: true, reason: 'missing' },
    lastReadSection: null,
    applyStatus: 'running',
  });

  const { renderer } = renderViewer();
  const restore = findButtonByLabel(renderer.root, 'Restore section');
  expect(restore).toBeDefined();
  expect(restore!.props.disabled).toBe(true);
  // ApplyButton surfaces `busy` on accessibilityState so VoiceOver announces
  // the button is busy.
  expect(restore!.props.accessibilityState).toEqual({
    disabled: true,
    busy: true,
  });
});

// ---------------------------------------------------------------------------
// Close button calls onClose
// ---------------------------------------------------------------------------

test('the Close button calls onClose', () => {
  seedState({
    drift: { drift: false, reason: 'in-sync' },
    lastReadSection: [],
  });
  const onClose = jest.fn();

  const { renderer } = renderViewer(onClose);
  const close = findButtonByLabel(renderer.root, 'Close');
  expect(close).toBeDefined();

  ReactTestRenderer.act(() => {
    close!.props.onPress();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// checkDrift is called on mount (fresh read on open)
// ---------------------------------------------------------------------------

test('the viewer calls checkDrift on mount (fresh read on open)', () => {
  seedState({
    drift: null,
    lastReadSection: null,
  });
  const checkSpy = jest.spyOn(useDomainStore.getState(), 'checkDrift');
  // Return a concrete drift result so the setState inside checkDrift does not
  // blow up (the real action reads readHostsSection + computeDrift; we stub it
  // to assert the mount effect WIRING, not the port logic).
  checkSpy.mockReturnValue({ drift: false, reason: 'in-sync' });

  renderViewer();

  // The mount `useEffect` calls checkDrift() exactly once.
  expect(checkSpy).toHaveBeenCalledTimes(1);
  checkSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// The drift banner exposes accessibilityRole="alert"
// ---------------------------------------------------------------------------

test('the drift banner exposes accessibilityRole="alert"', () => {
  seedState({
    domains: [{ hostname: 'example.com', alwaysOn: true }],
    drift: { drift: true, reason: 'missing' },
    lastReadSection: null,
  });

  const { renderer } = renderViewer();
  const banner = findBanner(renderer.root);
  expect(banner).toBeDefined();
  expect(banner!.props.accessibilityRole).toBe('alert');
});