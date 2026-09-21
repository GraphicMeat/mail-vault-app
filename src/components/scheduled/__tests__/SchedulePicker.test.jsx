// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SchedulePicker } from '../SchedulePicker';

afterEach(cleanup);

// The picker refuses a past time in its OWN display only — it never gates
// anything the daemon would use to decide whether to send (that rule lives
// in the caller: catch-up must send something already due).
function Harness({ initialLocalTime, tz = 'UTC' }) {
  const [value, setValue] = React.useState({ localTime: initialLocalTime, tz });
  return <SchedulePicker localTime={value.localTime} tz={value.tz} onChange={setValue} testIdPrefix="t" />;
}

describe('SchedulePicker', () => {
  it('shows no past-time warning for a time in the future', () => {
    render(<Harness initialLocalTime="2999-01-01T09:00" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });

  it('shows the past-time warning for a time already behind "now"', () => {
    render(<Harness initialLocalTime="2000-01-01T09:00" />);
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
  });

  it('shows no warning while the input is still empty', () => {
    render(<Harness initialLocalTime="" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });

  it('re-evaluates when the picked time changes', () => {
    render(<Harness initialLocalTime="2999-01-01T09:00" />);
    expect(screen.queryByTestId('t-past-error')).toBeNull();
    fireEvent.change(screen.getByTestId('t-time'), { target: { value: '2000-01-01T09:00' } });
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
  });

  it('a preset always lands in the future, never past', () => {
    render(<Harness initialLocalTime="2000-01-01T09:00" />);
    expect(screen.getByTestId('t-past-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('t-preset-tomorrow'));
    expect(screen.queryByTestId('t-past-error')).toBeNull();
  });
});
