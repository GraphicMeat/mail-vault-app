// @vitest-environment jsdom
//
// The sleep/wake heartbeat reads a long gap between two ticks as the machine
// having slept. A hidden page is not a sleeping machine: once the main window
// sits in the tray, Chromium (WebView2) runs chained timers at most once a
// minute, so a 15s interval really fires every ~60s. That gap must not pause
// the backup coordinator every minute; a real sleep still must.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

const scheduler = vi.hoisted(() => ({
  initProgressListener: vi.fn(),
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

  it('still pauses and resumes the coordinator across a real sleep', () => {
    renderHook(() => useBackupScheduler());
    tickAfter(10 * 60_000);
    expect(scheduler.onSleep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(scheduler.onWake).toHaveBeenCalledTimes(1);
  });
});
