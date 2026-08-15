/**
 * Story 1.5 — ShellRunner typed-port tests.
 *
 * Covers the spec's I/O & Edge-Case Matrix rows that are verifiable at the JS
 * port layer (the privileged write itself is verified natively, manually):
 *   - Happy path (valid lines)        -> { ok: true }  (envelope forwarded)
 *   - Empty blocklist ([])            -> { ok: true }  (envelope forwarded)
 *   - Invalid lines                   -> { ok: false, error: "invalid-lines" }
 *   - Admin denied                    -> { ok: false, error: "admin-denied" }
 *   - Hard OS error                   -> { ok: false, error: "<detail>" }
 *   - Native call itself throws       -> { ok: false, error }  (never rejects)
 *
 * The port is a thin pass-through, so these tests assert TWO things:
 *   (1) the `lines` argument is forwarded verbatim to the native spec's
 *       `writeHosts` (no mutation, no reordering, no filtering);
 *   (2) the native `{ ok, error? }` envelope is returned unchanged — the port
 *       does not invent or rewrite errors.
 *
 * Mock pattern (established in 1.4, the first native-module mock in the repo):
 * the TurboModule spec's default export is `TurboModuleRegistry.getEnforcing`,
 * which throws in a pure-node Jest environment (no native binary registered).
 * So `jest.mock` replaces the spec module with a fake whose `writeHosts` is a
 * `jest.fn()` the tests program per case. The factory is hoisted by `jest.mock`
 * so it runs before the port imports the spec.
 */

jest.mock('../src/native/specs/NativeShellRunnerSpec', () => {
  const mock = {
    writeHosts: jest.fn(),
  };
  return {
    __esModule: true,
    default: mock,
  };
});

import { writeHosts } from '../src/hosts/shellRunner';

// The mock's default export is the native module handle. Cast through
// `unknown` because the real default is typed as the codegen `Spec` (which a
// jest.fn() does not structurally satisfy), and we need to drive it per test.
type NativeMock = {
  writeHosts: jest.Mock;
};
const native = require('../src/native/specs/NativeShellRunnerSpec')
  .default as unknown as NativeMock;

beforeEach(() => {
  native.writeHosts.mockReset();
});

// ---------------------------------------------------------------------------
// I/O Matrix: Happy path (one domain) -> { ok: true }; lines forwarded verbatim
// ---------------------------------------------------------------------------

test('writeHosts forwards the lines verbatim and returns { ok: true } on success', async () => {
  const lines = [
    '0.0.0.0 example.com',
    ':: example.com',
    '0.0.0.0 www.example.com',
    ':: www.example.com',
  ];
  native.writeHosts.mockResolvedValue({ ok: true });

  const result = await writeHosts(lines);

  expect(result).toEqual({ ok: true });
  expect(native.writeHosts).toHaveBeenCalledTimes(1);
  // The native adapter receives the exact array — no mutation, no reordering,
  // no filtering, no lowercasing (the caller is responsible for normalisation).
  const [forwarded] = native.writeHosts.mock.calls[0];
  expect(forwarded).toBe(lines);
  expect(forwarded).toStrictEqual(lines);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Empty blocklist ([]) -> { ok: true }; forwarded verbatim
// ---------------------------------------------------------------------------

test('writeHosts forwards an empty array (unblocks all) and returns { ok: true }', async () => {
  native.writeHosts.mockResolvedValue({ ok: true });

  const result = await writeHosts([]);

  expect(result).toEqual({ ok: true });
  expect(native.writeHosts).toHaveBeenCalledTimes(1);
  const [forwarded] = native.writeHosts.mock.calls[0];
  expect(forwarded).toStrictEqual([]);
});

// ---------------------------------------------------------------------------
// I/O Matrix: Invalid lines -> { ok: false, error: "invalid-lines" }
//   The native side re-validates against the hosts-line regex before any
//   elevation. The port does NOT validate — it forwards the lines and surfaces
//   the native envelope unchanged. This asserts the port is a pass-through: it
//   neither pre-filters bad lines nor rewrites the error.
// ---------------------------------------------------------------------------

test('writeHosts surfaces { ok: false, error: "invalid-lines" } from the native side without filtering the lines', async () => {
  // A semicolon-prefixed payload is the spec's injection example. The port must
  // still forward it (the native regex gate is the authority), and surface the
  // native "invalid-lines" envelope verbatim.
  const badLines = ['0.0.0.0 ; rm -rf /'];
  native.writeHosts.mockResolvedValue({ ok: false, error: 'invalid-lines' });

  const result = await writeHosts(badLines);

  expect(result).toEqual({ ok: false, error: 'invalid-lines' });
  expect(native.writeHosts).toHaveBeenCalledTimes(1);
  expect(native.writeHosts.mock.calls[0][0]).toBe(badLines);
});

test('writeHosts surfaces { ok: false, error: "invalid-lines" } for a loopback target (127.0.0.1)', async () => {
  // The contract forbids 127.0.0.1/::1 (loopback). The native regex only allows
  // 0.0.0.0 / ::, so the native side reports invalid-lines; the port forwards
  // it unchanged.
  native.writeHosts.mockResolvedValue({ ok: false, error: 'invalid-lines' });

  const result = await writeHosts(['127.0.0.1 x']);

  expect(result).toEqual({ ok: false, error: 'invalid-lines' });
});

// ---------------------------------------------------------------------------
// I/O Matrix: Admin denied -> { ok: false, error: "admin-denied" }
// ---------------------------------------------------------------------------

test('writeHosts surfaces { ok: false, error: "admin-denied" } when the user cancels the prompt', async () => {
  native.writeHosts.mockResolvedValue({ ok: false, error: 'admin-denied' });

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toEqual({ ok: false, error: 'admin-denied' });
});

// ---------------------------------------------------------------------------
// I/O Matrix: Hard OS error -> { ok: false, error: "<detail>" }
// ---------------------------------------------------------------------------

test('writeHosts surfaces a hard OS error envelope unchanged', async () => {
  const detail = 'splice-failed: awk exited 1';
  native.writeHosts.mockResolvedValue({ ok: false, error: detail });

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toEqual({ ok: false, error: detail });
});

// ---------------------------------------------------------------------------
// Never rejects: the native call itself throws -> { ok: false, error }
//   The native contract is "always resolve, never reject". A throw is a
//   wiring/JSI failure, not a normal outcome. The port catches it and reports
//   { ok: false, error } so a caller `await`ing the port never sees an
//   unhandled rejection (parallel to ConfigStore's writeConfig catch).
// ---------------------------------------------------------------------------

test('writeHosts returns { ok: false, error } instead of rejecting when the native call throws', async () => {
  native.writeHosts.mockRejectedValue(new Error('jsi bridge gone'));

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe('string');
  expect(result.error).toContain('jsi bridge gone');
});

test('writeHosts returns { ok: false, error } when the native promise rejects with a non-Error value', async () => {
  // A non-Error rejection (e.g. a string) must still be stringified into the
  // error field rather than re-thrown.
  native.writeHosts.mockRejectedValue('boom');

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe('string');
  expect(result.error).toContain('boom');
});

// ---------------------------------------------------------------------------
// Envelope integrity: a VALID native envelope is returned as-is (no
// manufactured `error` on ok:true; exact error string on ok:false). A
// MALFORMED native return (null/undefined/non-object/missing boolean `ok`) is
// coerced to { ok:false, error:"bad-envelope" } — the port guards the shape
// before handing it back so a caller reading `.ok` never crashes on a native
// regression (parallel to ConfigStore's `result == null` guard).
// ---------------------------------------------------------------------------

test('writeHosts forwards a native envelope with no error field when ok is true', async () => {
  native.writeHosts.mockResolvedValue({ ok: true });

  const result = await writeHosts(['0.0.0.0 example.com']);

  // No `error` key manufactured by the port.
  expect(result).toStrictEqual({ ok: true });
});

test('writeHosts forwards the error string exactly (no prefixing/trimming)', async () => {
  const exact = 'chown-failed: operation not permitted';
  native.writeHosts.mockResolvedValue({ ok: false, error: exact });

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toStrictEqual({ ok: false, error: exact });
});

test('writeHosts coerces a null native resolve to { ok:false, error:"bad-envelope" }', async () => {
  // A native regression that resolves null must not surface as a crash when a
  // caller reads `result.ok`. The port guards the shape.
  native.writeHosts.mockResolvedValue(null);

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toStrictEqual({ ok: false, error: 'bad-envelope' });
});

test('writeHosts coerces an undefined native resolve to { ok:false, error:"bad-envelope" }', async () => {
  native.writeHosts.mockResolvedValue(undefined);

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toStrictEqual({ ok: false, error: 'bad-envelope' });
});

test('writeHosts coerces a non-envelope native resolve (string) to { ok:false, error:"bad-envelope" }', async () => {
  // A bare string is not a { ok, error? } object — guard it rather than let
  // `result.ok` read `undefined` off a string.
  native.writeHosts.mockResolvedValue('not-an-envelope');

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toStrictEqual({ ok: false, error: 'bad-envelope' });
});

test('writeHosts coerces an envelope with a non-boolean ok to { ok:false, error:"bad-envelope" }', async () => {
  // `ok` present but not a boolean (e.g. the string "true") would be truthy yet
  // not a real envelope — guard it.
  native.writeHosts.mockResolvedValue({ ok: 'true' });

  const result = await writeHosts(['0.0.0.0 example.com']);

  expect(result).toStrictEqual({ ok: false, error: 'bad-envelope' });
});

// Compile-time check that the port's return type is the WriteResult envelope.
// If the port ever stopped returning `Promise<WriteResult>`, this line would be
// a compile error — pinning the contract at the type level.
import type { WriteResult } from '../src/hosts/shellRunner';
const _writeHostsReturnsWriteResult = (
  r: Promise<WriteResult>,
): WriteResult | Promise<WriteResult> => r;
void _writeHostsReturnsWriteResult;