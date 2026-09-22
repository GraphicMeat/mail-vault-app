// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// One stable component: a Proxy minting a new one per access would remount
// the panel on every render and leave a test holding a detached input.
vi.mock('framer-motion', () => {
  const div = React.forwardRef(({ children, initial, animate, exit, ...props }, ref) =>
    React.createElement('div', { ...props, ref }, children));
  return { motion: { div }, AnimatePresence: ({ children }) => children };
});

const { DateTimePicker } = await import('../DateTimePicker');
const { useSettingsStore } = await import('../../../stores/settingsStore');

// Wednesday 2026-09-23, 10:07 UTC — already Wednesday 19:07 in Tokyo.
const NOW = Date.UTC(2026, 8, 23, 10, 7);

beforeEach(() => {
  // Only Date: React and testing-library keep their real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  useSettingsStore.setState({ timeFormat: '24h' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSettingsStore.setState({ timeFormat: 'auto' });
});

function Harness({ initial = '', tz = 'UTC' }) {
  const [value, setValue] = useState(initial);
  return <DateTimePicker value={value} onChange={setValue} tz={tz} ariaLabel="Send time" testId="dt" placeholder="Pick" />;
}

const value = () => screen.getByTestId('dt').dataset.value;
const open = () => fireEvent.click(screen.getByTestId('dt'));

describe('DateTimePicker', () => {
  it('shows the weekday, date and time in the chosen time format, and the raw value on data-value', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    const trigger = screen.getByTestId('dt');
    expect(trigger.dataset.value).toBe('2026-09-25T14:30');
    expect(trigger.textContent).toContain('Fri');
    expect(trigger.textContent).toContain('25');
    expect(trigger.textContent).toContain('14:30');
  });

  it('follows the 12-hour setting', () => {
    useSettingsStore.setState({ timeFormat: '12h' });
    render(<Harness initial="2026-09-25T14:30" />);
    expect(screen.getByTestId('dt').textContent).toMatch(/2:30\s?PM/);
  });

  it('shows the placeholder while empty', () => {
    render(<Harness />);
    expect(screen.getByTestId('dt').textContent).toBe('Pick');
    expect(value()).toBe('');
  });

  it('picking a day keeps the time', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    open();
    fireEvent.click(screen.getByTestId('dt-day-2026-09-28'));
    expect(value()).toBe('2026-09-28T14:30');
  });

  it('picking a slot keeps the day', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    open();
    fireEvent.click(screen.getByTestId('dt-slot-09:15'));
    expect(value()).toBe('2026-09-25T09:15');
  });

  it('a day picked before any time gets 08:00', () => {
    render(<Harness />);
    open();
    fireEvent.click(screen.getByTestId('dt-day-2026-09-24'));
    expect(value()).toBe('2026-09-24T08:00');
  });

  it('a typed time sets the exact minute on the picked day', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    open();
    fireEvent.change(screen.getByTestId('dt-input'), { target: { value: '17:42' } });
    expect(value()).toBe('2026-09-25T17:42');
  });

  it('disables days before today and slots already gone today', () => {
    render(<Harness />);
    open();
    expect(screen.getByTestId('dt-day-2026-09-22').disabled).toBe(true);
    expect(screen.getByTestId('dt-day-2026-09-23').disabled).toBe(false);
    expect(screen.getByTestId('dt-slot-10:00').disabled).toBe(true);
    expect(screen.getByTestId('dt-slot-10:15').disabled).toBe(false);
  });

  it('"today" is today in the selected zone, not on this machine', () => {
    render(<Harness tz="Asia/Tokyo" />);
    open();
    // 19:07 in Tokyo: 19:00 is gone there, even though it is 10:07 in UTC.
    expect(screen.getByTestId('dt-slot-19:00').disabled).toBe(true);
    expect(screen.getByTestId('dt-slot-19:15').disabled).toBe(false);
    cleanup();
    // 2026-09-23 23:30 UTC is already the 24th in Tokyo.
    vi.setSystemTime(Date.UTC(2026, 8, 23, 23, 30));
    render(<Harness tz="Asia/Tokyo" />);
    open();
    expect(screen.getByTestId('dt-day-2026-09-23').disabled).toBe(true);
    expect(screen.getByTestId('dt-day-2026-09-24').disabled).toBe(false);
  });

  it('moves between months, and not back past the current one', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    open();
    expect(screen.getByRole('button', { name: 'Previous month' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByTestId('dt-day-2026-10-01'));
    expect(value()).toBe('2026-10-01T14:30');
  });

  it('closes on Escape and hands focus back to the field', () => {
    render(<Harness initial="2026-09-25T14:30" />);
    open();
    fireEvent.keyDown(screen.getByTestId('dt-input'), { key: 'Escape' });
    expect(screen.queryByTestId('dt-input')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('dt'));
  });
});
