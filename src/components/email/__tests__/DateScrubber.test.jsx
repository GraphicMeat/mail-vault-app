// @vitest-environment jsdom

import React, { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DateScrubber, MonthHeader } from '../DateScrubber';
import { monthBuckets, railSegments } from '../../../utils/dateBuckets';

afterEach(cleanup);

const row = (y, m) => ({ type: 'email', email: { date: new Date(y, m - 1, 15, 12).toISOString() } });
const buckets = monthBuckets([row(2021, 3), row(2021, 3), row(2021, 2), row(2020, 11)]);
const segments = railSegments(buckets, [{ ym: '2020-06', count: 9 }], { totalEmails: 30, totalCached: 20 });

function Harness({ onJump, loading = null }) {
  const scrollRef = useRef(null);
  const virtualizer = { getVirtualItemForOffset: () => ({ index: 0 }), scrollToIndex: vi.fn() };
  return (
    <div style={{ position: 'relative' }}>
      <div ref={scrollRef} />
      <DateScrubber scrollRef={scrollRef} virtualizer={virtualizer} buckets={buckets}
        segments={segments} onJump={onJump} loading={loading} />
    </div>
  );
}

describe('DateScrubber', () => {
  it('renders the rail as a slider on the current month, with year ticks', () => {
    render(<Harness onJump={() => {}} />);
    const rail = screen.getByRole('slider');
    expect(rail.getAttribute('aria-label')).toBe('Timeline');
    expect(rail.getAttribute('aria-valuetext')).toBe('March 2021');
    expect(rail.getAttribute('aria-valuemax')).toBe(String(segments.length - 1));
    expect(rail.textContent).toContain('2021');
    expect(rail.textContent).toContain('2020');
    expect(screen.getByTestId('date-scrubber-pill').textContent).toBe('March 2021');
  });

  it('jumps to the clicked month on press', () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);
    const rail = screen.getByRole('slider');
    fireEvent.pointerDown(rail, { clientY: 0 });
    fireEvent.pointerUp(rail, { clientY: 0 });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0][0]).toMatchObject({ kind: 'loaded', key: '2021-03' });
  });

  it('steps by keyboard, including onto months not loaded yet', () => {
    const onJump = vi.fn();
    render(<Harness onJump={onJump} />);
    const rail = screen.getByRole('slider');
    fireEvent.keyDown(rail, { key: 'ArrowDown' });
    expect(onJump.mock.calls[0][0]).toMatchObject({ key: '2021-02' });
    fireEvent.keyDown(rail, { key: 'End' });
    expect(onJump.mock.calls[1][0]).toMatchObject({ kind: 'older' });
  });

  it('shows the target and a spinner while a jump loads', () => {
    render(<Harness onJump={() => {}} loading={segments.find(s => s.kind === 'unloaded')} />);
    expect(screen.getByTestId('date-scrubber-pill').textContent).toBe('June 2020');
  });

  it('draws a month header band', () => {
    render(<MonthHeader bucket={buckets[1]} />);
    expect(screen.getByTestId('list-month-header').textContent).toBe('February 2021');
  });
});
