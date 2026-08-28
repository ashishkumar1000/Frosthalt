/**
 * Story 1.6 — `runApply` pipeline tests.
 *
 * Mocks both native specs (factory pattern established in 1.4 / 1.5, see
 * `shellRunner.test.ts:27-35`) so the pipeline logic is proven in JS without
 * the native modules. Asserts the STRICT ORDER
 * (writeConfig -> effective -> lines -> writeHosts), the happy path, the
 * admin-denied case (staged retained by the store; here we assert the envelope
 * + that writeHosts WAS called after config was written), and the config-write
 * failure short-circuit (writeHosts NOT called).
 *
 * `runApply` is a pure function of its `{ committed, staged, stagedSchedules
 * }` snapshot — it does not touch store state, so these tests drive it
 * directly.
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
  },
}));

import { runApply } from '../src/domain/apply';
import type { ApplyInput } from '../src/domain/apply';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { Config, Domain, Schedule } from '../src/config/types';
import type { WriteResult } from '../src/hosts/shellRunner';

type NativeConfigMock = { readConfig: jest.Mock; writeConfig: jest.Mock };
type NativeShellMock = { writeHosts: jest.Mock };
const configNative = require('../src/native/specs/NativeConfigStoreSpec')
  .default as unknown as NativeConfigMock;
const shellNative = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as NativeShellMock;

const GOLDEN_LINES = [
  '0.0.0.0 example.com',
  ':: example.com',
  '0.0.0.0 www.example.com',
  ':: www.example.com',
];

beforeEach(() => {
  configNative.readConfig.mockReset();
  configNative.writeConfig.mockReset();
  shellNative.writeHosts.mockReset();
  // Defaults: a happy writeConfig + happy writeHosts.
  configNative.writeConfig.mockReturnValue({ ok: true });
  shellNative.writeHosts.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// Happy path: stage one alwaysOn domain, apply -> config + hosts written in
// strict order, { ok: true }
// ---------------------------------------------------------------------------

test('happy path: writeConfig then writeHosts in strict order with the golden 4-line payload', async () => {
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  const input: ApplyInput = {
    committed: DEFAULT_CONFIG,
    staged,
    stagedSchedules: null,
  };

  // Record the call order across BOTH ports.
  const calls: string[] = [];
  configNative.writeConfig.mockImplementation(() => {
    calls.push('writeConfig');
    return { ok: true };
  });
  shellNative.writeHosts.mockImplementation(() => {
    calls.push('writeHosts');
    return Promise.resolve({ ok: true } as WriteResult);
  });

  const result = await runApply(input);

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  // Strict order: config before hosts.
  expect(calls).toStrictEqual(['writeConfig', 'writeHosts']);

  // writeConfig received the committed config with staged as its domains.
  const [serialized] = configNative.writeConfig.mock.calls[0];
  const written: Config = JSON.parse(serialized);
  expect(written.domains).toStrictEqual(staged);
  // Non-block-affecting fields are preserved from committed.
  expect(written.settings).toStrictEqual(DEFAULT_CONFIG.settings);
  expect(written.schedules).toStrictEqual(DEFAULT_CONFIG.schedules);

  // writeHosts received the exact golden 4-line payload.
  const [lines] = shellNative.writeHosts.mock.calls[0];
  expect(lines).toStrictEqual(GOLDEN_LINES);
});

test('happy path: the written config round-trips back as a Config', async () => {
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  await runApply({ committed: DEFAULT_CONFIG, staged, stagedSchedules: null });

  const [serialized] = configNative.writeConfig.mock.calls[0];
  const written = JSON.parse(serialized) as Config;
  expect(written.domains).toEqual(staged);
  expect(written.activeTimer).toBeNull();
});

// ---------------------------------------------------------------------------
// Admin denied: config.json written (strict order), writeHosts called,
// { ok: false, error: "admin-denied" } returned
// ---------------------------------------------------------------------------

test('admin-denied: writeHosts returns admin-denied and runApply forwards the envelope', async () => {
  shellNative.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: false, error: 'admin-denied' });
  // Strict order: config was written BEFORE the (denied) hosts write.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Config write failure: writeHosts NOT called, staged retained by store,
// { ok: false, error: "config-write:<detail>" }
// ---------------------------------------------------------------------------

test('config-write failure short-circuits before writeHosts and reports config-write:<detail>', async () => {
  configNative.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: false, error: 'config-write:disk-full' });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

test('config-write failure with no error detail uses "unknown" as the detail', async () => {
  // A malformed native envelope (ok:false, no error) is coerced to a stable
  // detail rather than `undefined`.
  configNative.writeConfig.mockReturnValue({ ok: false });

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: false, error: 'config-write:unknown' });
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// null staged: no-op -> { ok: true }, neither port called
// ---------------------------------------------------------------------------

test('a null staged slice is a no-op: { ok: true } and neither port is called', async () => {
  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: null,
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).not.toHaveBeenCalled();
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Empty effective blocklist: staged all alwaysOn:false -> writeHosts([]) ->
// markers-only section (unblocks all), { ok: true }
// ---------------------------------------------------------------------------

test('staged with all alwaysOn:false -> writeHosts receives an empty array (markers only)', async () => {
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: false }];
  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged,
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
  const [lines] = shellNative.writeHosts.mock.calls[0];
  expect(lines).toStrictEqual([]);
});

// ---------------------------------------------------------------------------
// Hard OS error from writeHosts is forwarded verbatim
// ---------------------------------------------------------------------------

test('a hard OS error envelope from writeHosts is forwarded unchanged', async () => {
  shellNative.writeHosts.mockResolvedValue({
    ok: false,
    error: 'splice-failed: awk exited 1',
  });

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: false, error: 'splice-failed: awk exited 1' });
});

// ---------------------------------------------------------------------------
// End-to-end never-reject: a native throw / rejection is caught by the PORT
// (1.4/1.5 never-throw/never-reject contracts) and forwarded as a
// `{ ok, error? }` envelope, so runApply never rejects — it resolves to the
// envelope. This pins the spec's "the store never throws" invariant through
// the full chain (native -> port -> runApply).
// ---------------------------------------------------------------------------

test('a rejected native writeHosts is caught by the port and forwarded as { ok: false }; runApply never rejects', async () => {
  shellNative.writeHosts.mockRejectedValue(new Error('port died'));

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  // The shellRunner port caught the rejection and surfaced its message; runApply
  // returns that envelope verbatim (it never rejected — `await` did not throw).
  expect(result).toStrictEqual({ ok: false, error: 'port died' });
  // Strict order held up to the breach: config was written, writeHosts attempted.
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
});

test('a throwing native writeConfig is caught by the port and surfaced as config-write:<detail>; runApply never rejects', async () => {
  configNative.writeConfig.mockImplementation(() => {
    throw new Error('config port died');
  });

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged: [{ hostname: 'example.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  // The configStore port caught the throw -> { ok:false, error:'config port
  // died' }; runApply wraps it as config-write:<detail> (its normal failure
  // path), so it resolves rather than rejecting.
  expect(result).toStrictEqual({
    ok: false,
    error: 'config-write:config port died',
  });
  // writeHosts is never reached (config write failed first).
  expect(shellNative.writeHosts).not.toHaveBeenCalled();
});

test('multiple alwaysOn domains produce 4 lines each, in effective-blocklist order', async () => {
  const staged: Domain[] = [
    { hostname: 'example.com', alwaysOn: true },
    { hostname: 'news.site', alwaysOn: false },
    { hostname: 'social.com', alwaysOn: true },
  ];
  await runApply({ committed: DEFAULT_CONFIG, staged, stagedSchedules: null });

  const [lines] = shellNative.writeHosts.mock.calls[0];
  expect(lines).toStrictEqual([
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
    '0.0.0.0 social.com',
    ':: social.com',
    '0.0.0.0 www.social.com',
    ':: www.social.com',
  ]);
});

// ---------------------------------------------------------------------------
// Story 5.1 — the schedule slice rides the SAME single config write.
// ---------------------------------------------------------------------------

test('one writeConfig carries BOTH fields: staged domains AND staged schedules replace their committed counterparts', async () => {
  const staged: Domain[] = [{ hostname: 'example.com', alwaysOn: true }];
  const stagedSchedules: Schedule[] = [
    {
      id: 'focus-mornings',
      name: 'Focus mornings',
      weekdays: [0, 1, 2, 3, 4],
      startTime: '09:00',
      endTime: '17:00',
      enabled: false,
    },
  ];

  const result = await runApply({
    committed: DEFAULT_CONFIG,
    staged,
    stagedSchedules,
  });

  expect(result).toStrictEqual({ ok: true });
  // ONE config write — never two (one admin prompt per Apply, unchanged).
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual(staged);
  expect(written.schedules).toStrictEqual(stagedSchedules);
  // The hosts write still fires once after the config write (order unchanged;
  // the hosts payload is unchanged until 5.3 fills the effectiveBlocklist
  // reservation — an idempotent identical write is the accepted shape).
  expect(shellNative.writeHosts).toHaveBeenCalledTimes(1);
});

test('a schedules-only Apply (staged: null) keeps committed.domains in the written config', async () => {
  const committed: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'kept.com', alwaysOn: true }],
  };
  const stagedSchedules: Schedule[] = [
    {
      id: 'evenings',
      name: 'Evenings',
      weekdays: [5],
      startTime: '20:00',
      endTime: '22:00',
      enabled: true,
    },
  ];

  await runApply({ committed, staged: null, stagedSchedules });

  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  // The clean domain slice leaves committed.domains untouched in the write.
  expect(written.domains).toStrictEqual([{ hostname: 'kept.com', alwaysOn: true }]);
  expect(written.schedules).toStrictEqual(stagedSchedules);
});

test('a domains-only Apply (stagedSchedules: null) preserves NON-EMPTY committed.schedules verbatim (VG-1)', async () => {
  // The mirror of the schedules-only test above, and the pin the review's
  // VG-1 gap demanded: with committed.schedules NON-empty, a domains-only
  // Apply must carry those schedules into the written config untouched. A
  // regression to `schedules: stagedSchedules ?? []` (dropping a clean
  // schedule draft) passes every other test in this file because they all
  // seed DEFAULT_CONFIG (empty schedules) — the wipe would land on disk only
  // and surface on relaunch. This test fails under that regression.
  const committedSchedules: Schedule[] = [
    {
      id: 'focus-mornings',
      name: 'Focus mornings',
      weekdays: [0, 1, 2, 3, 4],
      startTime: '09:00',
      endTime: '17:00',
      enabled: true,
    },
    {
      id: 'evenings',
      name: 'Evenings',
      weekdays: [5, 6],
      startTime: '20:00',
      endTime: '22:00',
      enabled: false,
    },
  ];
  const committed: Config = {
    ...DEFAULT_CONFIG,
    schedules: committedSchedules,
  };

  const result = await runApply({
    committed,
    staged: [{ hostname: 'added.com', alwaysOn: true }],
    stagedSchedules: null,
  });

  expect(result).toStrictEqual({ ok: true });
  expect(configNative.writeConfig).toHaveBeenCalledTimes(1);
  const written = JSON.parse(configNative.writeConfig.mock.calls[0][0]);
  expect(written.domains).toStrictEqual([{ hostname: 'added.com', alwaysOn: true }]);
  // The clean schedule slice leaves the NON-EMPTY committed.schedules
  // untouched in the written config — verbatim, not reset to [].
  expect(written.schedules).toStrictEqual(committedSchedules);
});

// Compile-time pin: runApply returns Promise<WriteResult>.
const _runApplyReturnsWriteResult = (
  r: Promise<WriteResult>,
): WriteResult | Promise<WriteResult> => r;
void _runApplyReturnsWriteResult;