// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { presetTomorrow8am, presetNextMonday8am, zoneCity } from '../../../utils/scheduledTime';

// One stable component: a Proxy minting a new one per access would remount
// the panel on every render and leave a test holding a detached input.
vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

const { SchedulePicker } = await import('../SchedulePicker');

// Wednesday 2026-09-23, 23:30 UTC: still Wednesday in Los Angeles, already
// Thursday morning in Tokyo. Only Date and the interval are faked.
const NOW = Date.UTC(2026, 8, 23, 23, 30);
// The runner's own zone is whatever the mini is set to; "away" is a zone
// guaranteed to differ from it.
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const AWAY = HERE === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The picker refuses a past time in its OWN display only — it never gates
// anything the daemon would use to decide whether to send (that rule lives
// in the caller: catch-up must send something already due).
function Harness({ initialLocalTime, tz = 'UTC', presets = true }) {
  const [value, setValue] = React.useState({ localTime: initialLocalTime, tz });
  return <SchedulePicker localTime={value.localTime} tz={value.tz} onChange={setValue} presets={presets} testIdPrefix="t" />;
}

const time = () => screen.getByTestId('t-time').dataset.value;
const zone = () => screen.getByTestId('t-tz');

describe('SchedulePicker', () => {
  it('shows no past-time warning for a time in the future', () => {
    render(<Harness initialLocalTime="2999-01-01T09:00" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });

  it('shows the past-time warning for a time already behind "now"', () => {
    render(<Harness initialLocalTime="2000-01-01T09:00" />);
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
  });

  it('shows no warning while the time is still empty', () => {
    render(<Harness initialLocalTime="" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });

  it('re-evaluates when the picked time changes', () => {
    render(<Harness initialLocalTime="2026-09-23T23:45" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
    fireEvent.click(screen.getByTestId('t-time'));
    fireEvent.change(screen.getByTestId('t-time-input'), { target: { value: '09:00' } });
    expect(time()).toBe('2026-09-23T09:00');
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
  });

  it('a preset always lands in the future, never past', () => {
    render(<Harness initialLocalTime="2000-01-01T09:00" />);
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('t-preset-tomorrow'));
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });

  it('presets are computed in the selected zone, not on this machine', () => {
    render(<Harness initialLocalTime="" tz="Asia/Tokyo" />);
    fireEvent.click(screen.getByTestId('t-preset-tomorrow'));
    expect(time()).toBe('2026-09-25T08:00');
    fireEvent.click(screen.getByTestId('t-preset-monday'));
    expect(time()).toBe('2026-09-28T08:00');
    cleanup();
    render(<Harness initialLocalTime="" tz="America/Los_Angeles" />);
    fireEvent.click(screen.getByTestId('t-preset-tomorrow'));
    expect(time()).toBe(presetTomorrow8am('America/Los_Angeles', NOW));
    expect(time()).toBe('2026-09-24T08:00');
    fireEvent.click(screen.getByTestId('t-preset-monday'));
    expect(time()).toBe(presetNextMonday8am('America/Los_Angeles', NOW));
  });

  it('hides the presets when asked (Reschedule)', () => {
    render(<Harness initialLocalTime="" presets={false} />);
    expect(screen.queryByTestId('t-preset-tomorrow')).toBeNull();
  });

  it('shows the zone with its offset at the SEND instant, the IANA id on data-value', () => {
    render(<Harness initialLocalTime="2026-12-01T09:00" tz="America/New_York" />);
    expect(zone().dataset.value).toBe('America/New_York');
    expect(zone().textContent).toBe('(UTC-05:00) America/New York');
    cleanup();
    render(<Harness initialLocalTime="2026-09-30T09:00" tz="America/New_York" />);
    expect(zone().textContent).toBe('(UTC-04:00) America/New York');
  });

  it('picking a zone from the search keeps the wall clock', () => {
    render(<Harness initialLocalTime="2026-10-02T09:00" tz="UTC" />);
    fireEvent.click(zone());
    fireEvent.change(screen.getByTestId('t-tz-search'), { target: { value: 'vilnius' } });
    fireEvent.keyDown(screen.getByTestId('t-tz-search'), { key: 'Enter' });
    expect(zone().dataset.value).toBe('Europe/Vilnius');
    expect(time()).toBe('2026-10-02T09:00');
  });

  it('shows the time here, and the time there when the zone is not this machine\'s', () => {
    render(<Harness initialLocalTime="" tz={HERE} />);
    expect(screen.getByTestId('t-now').textContent).toMatch(/^Now .+ here$/);
    expect(screen.queryByTestId('t-sends')).toBeNull();
    cleanup();
    render(<Harness initialLocalTime="" tz={AWAY} />);
    expect(screen.getByTestId('t-now').textContent).toContain(`in ${zoneCity(AWAY)}`);
    // Nothing picked yet: no send line.
    expect(screen.queryByTestId('t-sends')).toBeNull();
  });

  it('spells out a picked send in both zones when they differ', () => {
    render(<Harness initialLocalTime="2026-10-02T09:00" tz={AWAY} />);
    const sends = screen.getByTestId('t-sends').textContent;
    expect(sends).toMatch(/^Sends .+ your time$/);
    expect(sends).toContain(`in ${zoneCity(AWAY)}`);
    expect(sends).toContain('Oct');
  });

  it('keeps the clock line ticking, and stops the timer when it goes away', () => {
    const { unmount } = render(<Harness initialLocalTime="" tz="UTC" />);
    const before = screen.getByTestId('t-now').textContent;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('t-now').textContent).not.toBe(before);
    const running = vi.getTimerCount();
    expect(running).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(running - 1);
  });
});
