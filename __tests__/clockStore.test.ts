/**
 * @format
 *
 * Story 5.4 — the scoped clock slice (`useClockStore`) tests.
 *
 * Pure-domain tests: no React, no component rendering — the slice is a
 * Zustand store with a module-level `setInterval(1000)` driver copied from
 * the Story 4.3 `timerStore` pattern, so the harness reuses that spec's fake
 * timers + `setInterval`/`clearInterval` spy harness for a deterministic
 * wall clock. Pins the driver contract the Story 5.4 spec asks for:
 *
 *   - `start()` syncs `nowMs` from the wall clock and drives per-second
 *     ticks (`nowMs` advances with the fake clock).
 *   - `start()` is idempotent: a second start clears the existing interval
 *     (1 `clearInterval`) before installing the new one — at most ONE
 *     driver ever runs (the spec's Never clause).
 *   - Refcount: N starts need N stops; the driver survives until the LAST
 *     stop, which clears it and parks `nowMs` at wall-clock now.
 *   - `stop()` with no live subscribers is still safe (parks only).
 *   - A restart after a full stop installs a fresh driver.
 *   - The slice NEVER self-parks (unlike the timer slice there is no end
 *     time): a long advance keeps ticking while subscribed.
 *   - The slice never touches the ports and imports nothing from `store.ts`
 *     — the one-way import rule is pinned by a source scan (the same guard
 *     pattern StatusHeader.test.tsx uses for `useTimerStore`).
 */

import { useClockStore } from '../src/domain/clockStore';

const T0 = 1_756_000_000_000; // arbitrary fixed epoch ms

let setIntervalSpy: jest.SpyInstance;
let clearIntervalSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  // Spy AFTER fake timers are installed (the timerStore.test pattern):
  // installing fake timers replaces the globals, which would wipe the spy.
  setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
});

afterEach(() => {
  // Defensive: force the module-level refcount back to 0 no matter how the
  // test exited, then reset the mirror so no state leaks between tests.
  useClockStore.getState().stop();
  useClockStore.getState().stop();
  useClockStore.getState().stop();
  jest.useRealTimers();
  jest.restoreAllMocks();
  useClockStore.setState({ nowMs: 0 });
});

// I/O Matrix: start — the single refcounted driver ticks nowMs per second.
test('start syncs nowMs and drives one tick per second', () => {
  useClockStore.getState().start();

  const s = useClockStore.getState();
  expect(s.nowMs).toBe(T0);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(clearIntervalSpy).not.toHaveBeenCalled();

  jest.advanceTimersByTime(1000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 1000);
  jest.advanceTimersByTime(59_000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 60_000);
});

// Never clause: "no setInterval anywhere except the clock driver (single
// refcounted interval, at most one ever running)" — a second start clears
// the existing driver before installing a fresh one.
test('a second start clears the existing driver — never two intervals', () => {
  useClockStore.getState().start();
  useClockStore.getState().start();

  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  // The surviving driver still ticks (and only one interval exists, so each
  // tick lands exactly once).
  jest.advanceTimersByTime(1000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 1000);
  jest.advanceTimersByTime(1000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 2000);
});

// Refcount: the driver survives every stop except the LAST one.
test('refcount — N starts need N stops; the last stop kills the driver', () => {
  useClockStore.getState().start();
  useClockStore.getState().start();
  useClockStore.getState().start();
  expect(setIntervalSpy).toHaveBeenCalledTimes(3); // reinstalled per start
  expect(clearIntervalSpy).toHaveBeenCalledTimes(2); // clear-then-reinstall

  jest.advanceTimersByTime(1000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 1000);

  useClockStore.getState().stop();
  jest.advanceTimersByTime(5000);
  // Two slots still held — the driver kept counting.
  expect(useClockStore.getState().nowMs).toBe(T0 + 6000);

  useClockStore.getState().stop();
  jest.advanceTimersByTime(5000);
  // Refcount 1 still held — the driver KEPT counting through the advance.
  expect(useClockStore.getState().nowMs).toBe(T0 + 11_000);

  // The last stop clears the driver and parks nowMs AT the wall clock.
  jest.setSystemTime(T0 + 16_000);
  useClockStore.getState().stop();
  // 2 from the two clear-then-reinstall starts + 1 for the final clear.
  expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  expect(useClockStore.getState().nowMs).toBe(T0 + 16_000);
});

// Safety: stop with no live subscribers is a harmless park (the timerStore
// pattern's defensive contract).
test('stop with no subscribers never clears a foreign interval (a true no-op)', () => {
  // An unpaired stop neither decrements nor re-syncs: `nowMs` keeps its
  // module-load value (no spurious mirror update at subscribers).
  const before = useClockStore.getState().nowMs;
  useClockStore.getState().stop();
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(clearIntervalSpy).not.toHaveBeenCalled();
  expect(useClockStore.getState().nowMs).toBe(before);
  // Even with the fake wall clock advanced, the unpaired stop does not park.
  jest.setSystemTime(T0 + 30_000);
  useClockStore.getState().stop();
  expect(useClockStore.getState().nowMs).toBe(before);
});

// Restart: after a full stop a fresh start reinstalls exactly one driver.
test('restart after the last stop installs a fresh driver', () => {
  useClockStore.getState().start();
  jest.advanceTimersByTime(2000);
  useClockStore.getState().stop();
  const cleared = clearIntervalSpy.mock.calls.length;

  jest.setSystemTime(T0 + 60_000);
  useClockStore.getState().start();
  // nowMs re-synced from the wall clock at start.
  expect(useClockStore.getState().nowMs).toBe(T0 + 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  expect(clearIntervalSpy).toHaveBeenCalledTimes(cleared); // nothing new cleared

  jest.advanceTimersByTime(1000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 61_000);
});

// The clock slice has no session semantics: it never self-parks.
test('the clock never self-parks — a long advance keeps ticking', () => {
  useClockStore.getState().start();
  jest.advanceTimersByTime(10 * 60_000);
  expect(useClockStore.getState().nowMs).toBe(T0 + 10 * 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(clearIntervalSpy).not.toHaveBeenCalled();
});

// One-way import rule: the clock slice must import NOTHING from the store
// (UI -> domain -> adapters -> ports; the store may subscribe to the slice,
// never the reverse). Mirrors the StatusHeader.test.tsx source-guard shape.
declare const __dirname: string;
test('clockStore imports nothing from store.ts (one-way rule)', () => {
  const fs = require('fs') as { readFileSync(file: string, encoding: string): string };
  const path = require('path') as { join(...parts: string[]): string };
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'domain', 'clockStore.ts'),
    'utf8',
  );
  expect(source).not.toMatch(/from\s+'\.\/store'/);
  expect(source).not.toContain('useDomainStore');
});