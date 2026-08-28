/**
 * @format
 *
 * Story 4.3 — the scoped timer slice (`useTimerStore`) tests.
 *
 * Pure-domain tests: no React, no component rendering — the slice is a
 * Zustand store with a module-level `setInterval(1000)` driver, so the
 * harness uses jest fake timers + `jest.setSystemTime` for a deterministic
 * wall clock, and spies on `setInterval`/`clearInterval` to pin the
 * "exactly one driver" / refcount contracts. Covers the spec's I/O matrix:
 *
 *   - `start()` captures `{ nowMs, endEpochMs, totalMs }` and drives
 *     per-second ticks (`nowMs` advances with the fake clock).
 *   - `start()` is idempotent: a second start clears the existing interval
 *     (1 `clearInterval`) before installing the new one — never two drivers.
 *   - An already-expired `endEpochMs <= Date.now()` parks IMMEDIATELY:
 *     no interval at all, `totalMs` 0, ticks are no-ops.
 *   - Refcount: N starts need N stops; the driver survives until the LAST
 *     stop, which clears it and parks `nowMs` at wall-clock now.
 *   - `stop()` with no live subscribers is still safe (clears + parks).
 *   - Expiry self-park: a tick past the end clears the driver and parks
 *     `nowMs` AT `endEpochMs` — remaining reads exactly 0, never negative.
 *   - `totalMs` is sticky per `endEpochMs` (a stop/start cycle for the same
 *     session keeps the original total; a new session re-captures).
 *   - `selectRemainingMs` derives clamped milliseconds (0 when unstarted).
 */

import {
  useTimerStore,
  selectRemainingMs,
  type TimerState,
} from '../src/domain/timerStore';

const T0 = 1_756_000_000_000; // arbitrary fixed epoch ms

let setIntervalSpy: jest.SpyInstance;
let clearIntervalSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  // Spy AFTER fake timers are installed so the spy wraps jest's mock timers
  // (installing fake timers replaces the globals, which would wipe the spy).
  setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
});

afterEach(() => {
  // Defensive: force the module-level refcount back to 0 no matter how the
  // test exited (extra stops are no-ops beyond the first per spec), then
  // reset the slice so no state leaks between tests.
  useTimerStore.getState().stop();
  useTimerStore.getState().stop();
  useTimerStore.getState().stop();
  jest.useRealTimers();
  jest.restoreAllMocks();
  useTimerStore.setState({ nowMs: 0, endEpochMs: null, totalMs: null });
});

// I/O Matrix: start — captures the session and drives per-second ticks.
test('start captures the session and ticks nowMs once per second', () => {
  const end = T0 + 5 * 60_000;
  useTimerStore.getState().start(end);

  const s = useTimerStore.getState();
  expect(s.endEpochMs).toBe(end);
  expect(s.nowMs).toBe(T0);
  expect(s.totalMs).toBe(5 * 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(clearIntervalSpy).not.toHaveBeenCalled();

  // Tick advance: 1s -> remaining 4:59; 59s more -> remaining 4:00.
  jest.advanceTimersByTime(1000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 1000);
  jest.advanceTimersByTime(59_000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 60_000);

  const remaining = selectRemainingMs(useTimerStore.getState() as TimerState);
  expect(remaining).toBe(4 * 60_000);
});

// I/O Matrix: start is idempotent — at most ONE live driver, ever.
test('a second start clears the existing interval before starting a new one', () => {
  useTimerStore.getState().start(T0 + 60_000);
  useTimerStore.getState().start(T0 + 120_000);

  // 2 starts -> 2 setInterval calls, but the restart cleared the first
  // driver exactly once. Never two concurrent intervals.
  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  const s = useTimerStore.getState();
  expect(s.endEpochMs).toBe(T0 + 120_000);
  // New session -> total re-captured from the new end.
  expect(s.totalMs).toBe(120_000);

  // The surviving driver ticks.
  jest.advanceTimersByTime(1000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 1000);
});

// I/O Matrix: already-expired end — parks immediately, no tick loop.
test('an expired endEpochMs parks immediately without starting a driver', () => {
  useTimerStore.getState().start(T0 - 1000);

  expect(setIntervalSpy).not.toHaveBeenCalled();
  const s = useTimerStore.getState();
  expect(s.endEpochMs).toBe(T0 - 1000);
  expect(s.totalMs).toBe(0);
  expect(s.nowMs).toBe(T0);

  // No driver installed -> advancing time changes nothing.
  jest.advanceTimersByTime(5000);
  expect(useTimerStore.getState().nowMs).toBe(T0);
  expect(selectRemainingMs(useTimerStore.getState() as TimerState)).toBe(0);
});

// Defensive (review step-04): readConfig validates config.json top-level
// only, so a malformed `activeTimer.endEpochMs` can be non-numeric. A
// non-finite value must park the slice immediately (NaN <= Date.now() is
// false — without the guard the driver would install and NEVER park), park
// `endEpochMs` at wall-clock, and never let NaN reach `selectRemainingMs`.
test('a non-finite endEpochMs parks immediately without starting a driver', () => {
  useTimerStore.getState().start(Number.NaN);

  expect(setIntervalSpy).not.toHaveBeenCalled();
  const s = useTimerStore.getState();
  expect(s.endEpochMs).toBe(T0); // parked at wall-clock, NOT NaN
  expect(s.totalMs).toBe(0);
  expect(s.nowMs).toBe(T0);
  expect(selectRemainingMs(s as TimerState)).toBe(0);

  // No driver installed -> time passage changes nothing (no tick side
  // effect, no clearInterval needed).
  jest.advanceTimersByTime(5000);
  expect(useTimerStore.getState().nowMs).toBe(T0);
});

// Defensive (review step-04): a malformed string endEpochMs coerces through
// the old `<=` comparison — the guard must catch it the same way.
test('a non-numeric (string) endEpochMs parks immediately without starting a driver', () => {
  useTimerStore.getState().start('123' as unknown as number);

  expect(setIntervalSpy).not.toHaveBeenCalled();
  const s = useTimerStore.getState();
  expect(s.endEpochMs).toBe(T0); // parked at wall-clock, not the coercion
  expect(s.totalMs).toBe(0);
  expect(s.nowMs).toBe(T0);
  expect(selectRemainingMs(s as TimerState)).toBe(0);
});

// I/O Matrix: refcount — N starts need N stops; the driver dies on the LAST.
test('the driver survives until the last subscriber stops', () => {
  const end = T0 + 60_000;
  useTimerStore.getState().start(end); // subscriber 1 (Timer surface)
  useTimerStore.getState().start(end); // subscriber 2 (status header)

  // First stop: a subscriber left, but the driver stays alive. (The restart
  // between the two starts already cleared the superseded interval once, so
  // compare against the post-start count rather than zero.)
  const clearedAtStart = clearIntervalSpy.mock.calls.length;
  useTimerStore.getState().stop();
  expect(clearIntervalSpy.mock.calls.length).toBe(clearedAtStart);
  jest.advanceTimersByTime(1000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 1000);

  // Last stop: refcount 0 -> driver cleared, nowMs parks at wall-clock now.
  jest.setSystemTime(T0 + 30_000);
  useTimerStore.getState().stop();
  expect(clearIntervalSpy.mock.calls.length).toBe(clearedAtStart + 1);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 30_000);
});

// I/O Matrix: stop with no live subscribers — defensive clear + park.
test('stop() with no subscribers is a safe clear-and-park', () => {
  jest.setSystemTime(T0 + 1234);
  useTimerStore.getState().stop();

  expect(clearIntervalSpy).not.toHaveBeenCalled(); // nothing was running
  expect(useTimerStore.getState().nowMs).toBe(T0 + 1234);
});

// I/O Matrix: restart after a full stop — clean re-acquisition.
test('a start after all subscribers stopped installs a fresh driver', () => {
  useTimerStore.getState().start(T0 + 60_000);
  useTimerStore.getState().stop();
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

  jest.setSystemTime(T0 + 10_000);
  useTimerStore.getState().start(T0 + 60_000);
  expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  const s = useTimerStore.getState();
  expect(s.nowMs).toBe(T0 + 10_000);
  // Same session -> the total stays the ORIGINAL capture, not a fresh one.
  expect(s.totalMs).toBe(60_000);
  expect(selectRemainingMs(s as TimerState)).toBe(50_000);
});

// I/O Matrix: expiry self-park — remaining lands exactly on 0, never negative.
test('the driver self-parks at endEpochMs when the session expires', () => {
  useTimerStore.getState().start(T0 + 2500);

  jest.advanceTimersByTime(1000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 1000);

  // Tick lands past the end: driver clears itself, nowMs parks AT the end.
  jest.advanceTimersByTime(2000);
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  const s = useTimerStore.getState();
  expect(s.nowMs).toBe(T0 + 2500);
  expect(selectRemainingMs(s as TimerState)).toBe(0);

  // No driver left -> further time passage is a no-op (00:00 holds).
  jest.advanceTimersByTime(60_000);
  expect(useTimerStore.getState().nowMs).toBe(T0 + 2500);
});

// totalMs stickiness — a subscriber remount mid-session never resets the ring.
test('totalMs is sticky per endEpochMs across stop/start cycles', () => {
  const end = T0 + 5 * 60_000;
  useTimerStore.getState().start(end);
  useTimerStore.getState().stop();
  // Wall clock moved on (the "user navigated away for a while" case).
  jest.setSystemTime(T0 + 90_000);
  useTimerStore.getState().start(end);

  expect(useTimerStore.getState().totalMs).toBe(5 * 60_000);
  // remaining = total - elapsed wall-clock = 300000 - 90000.
  expect(selectRemainingMs(useTimerStore.getState() as TimerState)).toBe(
    210_000,
  );

  // A NEW (superseding) session re-captures the total from the CURRENT wall
  // clock (still T0+90000): 600000 - 90000.
  useTimerStore.getState().start(T0 + 10 * 60_000);
  expect(useTimerStore.getState().totalMs).toBe(510_000);
});

// selectRemainingMs — the derived value consumers subscribe to.
test('selectRemainingMs clamps at 0 and reads 0 when no session is mirrored', () => {
  const unstarted = {
    nowMs: 12345,
    endEpochMs: null,
  } as unknown as TimerState;
  expect(selectRemainingMs(unstarted)).toBe(0);

  const negative = {
    nowMs: T0 + 5000,
    endEpochMs: T0 + 1000,
  } as unknown as TimerState;
  expect(selectRemainingMs(negative)).toBe(0);

  expect(
    selectRemainingMs({ nowMs: T0, endEpochMs: T0 + 1500 } as TimerState),
  ).toBe(1500);
});