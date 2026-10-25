// @vitest-environment jsdom
//
// The sleep/wake heartbeat reads a long gap between two ticks as the machine
// having slept. A hidden page is not a sleeping machine: once the main window
// sits in the tray, Chromium (WebView2) runs chained timers at most once a
// minute, so a 15s interval really fires every ~60s. That gap must not pause
// the backup coordinator every minute; a real sleep still must.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const stopLimitWatch = vi.hoisted(() => vi.fn());
const scheduler = vi.hoisted(() => ({
  initProgressListener: vi.fn(),
  watchTransferLimits: vi.fn(() => stopLimitWatch),
  tick: vi.fn(),
  checkAndQueueDue: vi.fn(),
  onSleep: vi.fn(),
  onWake: vi.fn(),
  onOnline: vi.fn(),
  onOffline: vi.fn(),
  stopAll: vi.fn(),
}));
vi.mock('../../services/backupScheduler', () => ({ backupScheduler: scheduler }));

import { useBackupScheduler } from '../useBackupScheduler';

// Moves the wall clock by `gapMs` in total but lets only one heartbeat tick
// run, the way a throttled (or slept) timer fires late.
function tickAfter(gapMs) {
  vi.setSystemTime(Date.now() + gapMs - 15_000);
  vi.advanceTimersByTime(15_000);
}

describe('useBackupScheduler heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(scheduler).forEach(fn => fn.mockClear());
    stopLimitWatch.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not read a hidden page\'s once-a-minute timers as sleep', () => {
    renderHook(() => useBackupScheduler());
    for (let i = 0; i < 10; i++) tickAfter(75_000);
    expect(scheduler.onSleep).not.toHaveBeenCalled();
  });

  it('follows the daily limit settings while mounted, and stops following them on unmount', () => {
    const { unmount } = renderHook(() => useBackupScheduler());
    expect(scheduler.watchTransferLimits).toHaveBeenCalledTimes(1);
    expect(stopLimitWatch).not.toHaveBeenCalled();
    unmount();
    expect(stopLimitWatch).toHaveBeenCalledTimes(1);
  });

  it('still pauses and resumes the coordinator across a real sleep', () => {
    renderHook(() => useBackupScheduler());
    tickAfter(10 * 60_000);
    expect(scheduler.onSleep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(scheduler.onWake).toHaveBeenCalledTimes(1);
  });
});

// Real hook, fake browser events/clock only. Visibility's delayed idle probe
// makes the throttle's boundary observable between the minute interval ticks.
for (const [first, second, gap] of [['keydown', 'click', 500], ['mousemove', 'mousemove', 4000]]) {
  it(`keeps the first ${first} activity timestamp inside its throttle`, () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    Object.values(scheduler).forEach(fn => fn.mockClear());
    const { unmount } = renderHook(() => useBackupScheduler());
    vi.advanceTimersByTime(1000); document.dispatchEvent(new Event(first));
    vi.advanceTimersByTime(gap); document.dispatchEvent(new Event(second));
    vi.advanceTimersByTime(165000-gap);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(15000);
    expect(scheduler.checkAndQueueDue).toHaveBeenCalledTimes(1);
    unmount(); vi.useRealTimers();
  });
}
it('rechecks actual activity after the visibility settle delay', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  Object.values(scheduler).forEach(fn => fn.mockClear());
  const { unmount } = renderHook(() => useBackupScheduler());
  vi.advanceTimersByTime(180000); scheduler.checkAndQueueDue.mockClear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(14000); document.dispatchEvent(new Event('click'));
  vi.advanceTimersByTime(1000);
  expect(scheduler.checkAndQueueDue).not.toHaveBeenCalled();
  unmount(); vi.useRealTimers();
});
it('characterizes the old delayed-wake callback surviving unmount as a later-cutover gap', () => {
  vi.useFakeTimers(); Object.values(scheduler).forEach(fn => fn.mockClear());
  const { unmount } = renderHook(() => useBackupScheduler());
  tickAfter(151000); unmount();
  expect(scheduler.stopAll).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(10000);
  expect(scheduler.onWake).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
