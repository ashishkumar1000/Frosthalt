/**
 * Story 1.4 — ConfigStore typed-port tests.
 *
 * Covers every row of the spec's I/O & Edge-Case Matrix:
 *   - Read valid config          -> parsed Config
 *   - Read missing file          -> DEFAULT_CONFIG (native data null)
 *   - Read corrupt/empty config  -> DEFAULT_CONFIG (JSON.parse throws)
 *   - Write config               -> atomic write; file content = stringify(c)
 *   - Write with missing dir     -> dir created, then file written
 *   - Native IO error on write   -> { ok: false, error }; target unchanged
 *   - Round-trip                 -> write(c) then read(c) deep-equal
 *
 * Mock pattern (established here, first native-module mock in the repo): the
 * TurboModule spec's default export is `TurboModuleRegistry.getEnforcing(...)`,
 * which throws in a pure-node Jest environment (no native binary registered).
 * So `jest.mock` replaces the spec module with a fake whose `readConfig` /
 * `writeConfig` are `jest.fn()`s the tests program per case. The factory is
 * hoisted by `jest.mock` so it runs before the port imports the spec.
 */

jest.mock('../src/native/specs/NativeConfigStoreSpec', () => {
  const mock = {
    readConfig: jest.fn(),
    writeConfig: jest.fn(),
  };
  return {
    __esModule: true,
    default: mock,
  };
});

import {
  readConfig,
  writeConfig,
} from '../src/config/configStore';
import {
  Config,
  DEFAULT_CONFIG,
  Domain,
  Schedule,
} from '../src/config/types';

// The mock's default export is the native module handle. Cast through
// `unknown` because the real default is typed as the codegen `Spec` (which a
// jest.fn() does not structurally satisfy), and we need to drive it per test.
type NativeMock = {
  readConfig: jest.Mock;
  writeConfig: jest.Mock;
};
const native = require('../src/native/specs/NativeConfigStoreSpec')
  .default as unknown as NativeMock;

beforeEach(() => {
  native.readConfig.mockReset();
  native.writeConfig.mockReset();
});

// ---------------------------------------------------------------------------
// I/O Matrix: Read valid config
// ---------------------------------------------------------------------------

test('readConfig returns the parsed Config when the file has valid JSON', () => {
  const config: Config = {
    passwordHash: 'sha256:abc123',
    domains: [
      { hostname: 'example.com', alwaysOn: true },
      { hostname: 'news.site', alwaysOn: false },
    ],
    schedules: [
      {
        id: 'work-hours',
        name: 'Work hours',
        weekdays: [0, 1, 2, 3, 4],
        startTime: '09:00',
        endTime: '17:00',
        enabled: true,
        domains: ['example.com'],
      },
    ],
    settings: { menuBarEnabled: true },
    activeTimer: {
      endEpochMs: 1_700_000_000_000,
      selectedDomains: ['example.com'],
    },
  };
  native.readConfig.mockReturnValue({ ok: true, data: JSON.stringify(config) });

  expect(readConfig()).toEqual(config);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Read missing file  (native returns { ok: true, data: null })
// ---------------------------------------------------------------------------

test('readConfig returns DEFAULT_CONFIG when the file is missing (native data null)', () => {
  native.readConfig.mockReturnValue({ ok: true, data: null });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

test('readConfig returns DEFAULT_CONFIG when native omits data (absent field)', () => {
  // Some native impls return `{ ok: true }` (no data key) for a missing file.
  // The port's `data == null` loose-equality check must cover this too.
  native.readConfig.mockReturnValue({ ok: true });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Read corrupt config  (JSON.parse throws -> DEFAULT_CONFIG)
// ---------------------------------------------------------------------------

test('readConfig returns DEFAULT_CONFIG when the file has invalid JSON', () => {
  native.readConfig.mockReturnValue({ ok: true, data: '{ not valid json' });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

test('readConfig returns DEFAULT_CONFIG when the file is empty', () => {
  // An empty string is not valid JSON — JSON.parse('') throws.
  native.readConfig.mockReturnValue({ ok: true, data: '' });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

// P2: valid JSON that is not a Config object (`null`, `42`, `"hi"`, `[]`, `{}`)
// parses cleanly but is not a usable Config. A caller doing
// `cfg.domains.push(...)` on such a return would crash, so the port must treat
// any non-plain-object parse as corrupt -> DEFAULT_CONFIG (AC 3).
test.each([
  ['null', 'null'],
  ['a number', '42'],
  ['a string', '"hi"'],
  ['an array', '[]'],
  ['an empty object', '{}'],
])(
  'readConfig returns DEFAULT_CONFIG when the file is valid JSON but %s',
  (_label, payload) => {
    native.readConfig.mockReturnValue({ ok: true, data: payload });
    expect(readConfig()).toEqual(DEFAULT_CONFIG);
  },
);

// P1: a misbehaving native impl could return `null`/`undefined` (not throw).
// Accessing `.ok`/`.data` on it would throw a TypeError; the port guards the
// envelope first so a malformed return never throws (AC 3 — never throws).
test('readConfig returns DEFAULT_CONFIG when native returns a null/undefined envelope', () => {
  native.readConfig.mockReturnValue(null);
  expect(readConfig()).toEqual(DEFAULT_CONFIG);

  native.readConfig.mockReturnValue(undefined);
  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// Resilience: native read returns { ok: false, error } -> DEFAULT_CONFIG
// ---------------------------------------------------------------------------

test('readConfig returns DEFAULT_CONFIG when native read reports an error', () => {
  native.readConfig.mockReturnValue({ ok: false, error: 'permission-denied' });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

test('readConfig never throws even if the native call itself throws', () => {
  native.readConfig.mockImplementation(() => {
    throw new Error('jsi bridge gone');
  });

  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Write config  (atomic write; file content = JSON.stringify(c))
// ---------------------------------------------------------------------------

test('writeConfig serializes the config and delegates to the native write', () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    domains: [{ hostname: 'example.com', alwaysOn: true }],
  };
  native.writeConfig.mockReturnValue({ ok: true });

  const result = writeConfig(config);

  expect(result).toEqual({ ok: true });
  expect(native.writeConfig).toHaveBeenCalledTimes(1);
  // The native adapter receives the exact serialized string — it does NOT get
  // the Config object, and the port does not mutate it.
  const [serialized] = native.writeConfig.mock.calls[0];
  expect(typeof serialized).toBe('string');
  expect(JSON.parse(serialized)).toEqual(config);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Write with missing dir
//   The port does not know about the directory; the native adapter creates it.
//   This row is verified natively (manual). Here we assert the port surfaces
//   the native success honestly and does not swallow it.
// ---------------------------------------------------------------------------

test('writeConfig surfaces a native success (missing-dir create handled natively)', () => {
  native.writeConfig.mockReturnValue({ ok: true });

  expect(writeConfig(DEFAULT_CONFIG)).toEqual({ ok: true });
});

// ---------------------------------------------------------------------------
// I/O Matrix: Native IO error on write  -> { ok: false, error }; target unchanged
// ---------------------------------------------------------------------------

test('writeConfig returns { ok: false, error } when native write fails', () => {
  native.writeConfig.mockReturnValue({ ok: false, error: 'disk-full' });

  const result = writeConfig(DEFAULT_CONFIG);

  expect(result).toEqual({ ok: false, error: 'disk-full' });
  // The native adapter is responsible for leaving the target file unchanged
  // (temp discarded, no rename) — the port only surfaces the outcome.
});

test('writeConfig reports { ok: false, error } if the native call itself throws', () => {
  native.writeConfig.mockImplementation(() => {
    throw new Error('jsi bridge gone');
  });

  const result = writeConfig(DEFAULT_CONFIG);

  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe('string');
  expect(result.error).toContain('jsi bridge gone');
});

// P8: JSON.stringify can throw (circular reference). The port must report it as
// { ok: false, error } and never re-throw. The native write is mocked to
// succeed so the failure is attributable solely to serialization.
test('writeConfig returns { ok: false, error } when JSON.stringify throws (circular reference)', () => {
  // Build a circular object and cast it as a Config. JSON.stringify throws on
  // the self-reference; the port catches and reports it.
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const badConfig = circular as unknown as Config;

  native.writeConfig.mockReturnValue({ ok: true });

  const result = writeConfig(badConfig);

  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe('string');
  // The native write must never have been reached — stringify failed first.
  expect(native.writeConfig).not.toHaveBeenCalled();
});

// P9: symmetry with readConfig's malformed-envelope coverage. The native
// writeConfig could return `null`/`undefined` (misbehaving impl). Accessing
// `.ok` on it would throw, but that happens inside the port's try, so the port
// reports { ok: false, error } rather than crashing.
test('writeConfig returns { ok: false, error } when native returns a null/undefined envelope', () => {
  native.writeConfig.mockReturnValue(null);

  const resultNull = writeConfig(DEFAULT_CONFIG);
  expect(resultNull.ok).toBe(false);
  expect(typeof resultNull.error).toBe('string');

  native.writeConfig.mockReturnValue(undefined);

  const resultUndefined = writeConfig(DEFAULT_CONFIG);
  expect(resultUndefined.ok).toBe(false);
  expect(typeof resultUndefined.error).toBe('string');
});

// ---------------------------------------------------------------------------
// I/O Matrix: Round-trip  write(c) then read(c) -> deep-equal
// ---------------------------------------------------------------------------

test('write then read round-trips a full Config deep-equal', () => {
  const original: Config = {
    passwordHash: 'sha256:deadbeef',
    domains: [
      { hostname: 'social.com', alwaysOn: true },
      { hostname: 'video.com', alwaysOn: false },
    ] as Domain[],
    schedules: [
      {
        id: 'evening',
        name: 'Evening block',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        startTime: '18:00',
        endTime: '22:30',
        enabled: false,
        domains: ['example.com'],
      },
    ] as Schedule[],
    settings: { menuBarEnabled: false },
    activeTimer: null,
  };

  // Wire the mock so write persists into an in-memory store that read serves
  // back — this is what makes round-trip verifiable without a real filesystem.
  let stored: string | null = null;
  native.writeConfig.mockImplementation((json: string) => {
    stored = json;
    return { ok: true };
  });
  native.readConfig.mockImplementation(() => {
    if (stored == null) {
      // Mirror the real native adapter: missing file -> { ok: true, data: null }.
      return { ok: true, data: null };
    }
    return { ok: true, data: stored };
  });

  const writeResult = writeConfig(original);
  expect(writeResult).toEqual({ ok: true });

  const readResult = readConfig();
  expect(readResult).toEqual(original);
});

test('round-trip with DEFAULT_CONFIG (empty config) deep-equal', () => {
  let stored: string | null = null;
  native.writeConfig.mockImplementation((json: string) => {
    stored = json;
    return { ok: true };
  });
  native.readConfig.mockImplementation(() =>
    stored == null ? { ok: true, data: null } : { ok: true, data: stored },
  );

  expect(writeConfig(DEFAULT_CONFIG)).toEqual({ ok: true });
  expect(readConfig()).toEqual(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------------------
// AC 2: the Config type carries all five top-level keys, camelCase.
//   (A runtime shape check on DEFAULT_CONFIG + a compile-time type assertion.)
// ---------------------------------------------------------------------------

test('DEFAULT_CONFIG has the four required keys and omits passwordHash', () => {
  const keys = Object.keys(DEFAULT_CONFIG).sort();
  expect(keys).toEqual(
    ['activeTimer', 'domains', 'schedules', 'settings'].sort(),
  );
  // `passwordHash` is intentionally UNSET on the default — not an empty string.
  expect('passwordHash' in DEFAULT_CONFIG).toBe(false);
  expect(DEFAULT_CONFIG.domains).toEqual([]);
  expect(DEFAULT_CONFIG.schedules).toEqual([]);
  expect(DEFAULT_CONFIG.settings).toEqual({ menuBarEnabled: false });
  expect(DEFAULT_CONFIG.activeTimer).toBeNull();
});

// P5: DEFAULT_CONFIG is returned by reference from readConfig, so it is
// deep-frozen — a caller mutating its arrays/settings cannot corrupt every
// future return. Asserts the freeze on the object itself, the two arrays, and
// the settings object, plus that a mutation attempt leaves the array empty.
test('DEFAULT_CONFIG is deep-frozen so readConfig returns cannot be mutation-poisoned', () => {
  expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  expect(Object.isFrozen(DEFAULT_CONFIG.domains)).toBe(true);
  expect(Object.isFrozen(DEFAULT_CONFIG.schedules)).toBe(true);
  expect(Object.isFrozen(DEFAULT_CONFIG.settings)).toBe(true);

  // Jest runs test files in strict mode, so pushing to a frozen array throws
  // a TypeError ("object is not extensible") — which is exactly the guard we
  // want. Either way (throw or silent no-op), the array must stay empty.
  expect(() =>
    DEFAULT_CONFIG.domains.push({ hostname: 'poison.com', alwaysOn: true }),
  ).toThrow();
  expect(DEFAULT_CONFIG.domains).toEqual([]);
});

// Compile-time check that DEFAULT_CONFIG is assignable to Config. If the
// DEFAULT_CONFIG literal were missing a required Config key (or had a
// wrong-typed value), this line would be a compile error — proving AC 2's
// shape holds at the type level. `as Config` is deliberately NOT used so the
// structural check is real.
const _defaultConfigIsAConfig: Config = DEFAULT_CONFIG;
void _defaultConfigIsAConfig;
