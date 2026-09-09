// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import SenderTimeline from '../SenderTimeline';
afterEach(cleanup);
const query = { startDate: '2026-09-01', endDate: '2026-09-30', direction: 'both', timelineBucket: 'week', senderSort: 'recent', senderAddress: null };
const lanes = [
  { address: 'old@test', buckets: [{ startDate: '2026-09-01', endDate: '2026-09-07', received: 40, sent: 2, keys: ['a'] }] },
  { address: 'new@test', buckets: [{ startDate: '2026-09-08', endDate: '2026-09-14', received: 10, sent: 1, keys: ['b'] }] },
];
describe('sender timeline', () => {
  it('orders recent lanes first and emits exact model bucket date bounds', () => {
    const onSelectBucket = vi.fn();
    render(<SenderTimeline lanes={lanes} query={query} onQueryChange={() => {}} onSelectBucket={onSelectBucket} />);
    const rows = screen.getAllByRole('row');
    expect(rows[0].getAttribute('aria-label')).toBe('new@test');
    fireEvent.click(within(rows[0]).getByRole('button', { name: /new@test.*8 September 2026.*14 September 2026.*10 received.*1 sent/i }));
    expect(onSelectBucket).toHaveBeenCalledWith({ senderAddress: 'new@test', startDate: '2026-09-08', endDate: '2026-09-14' });
  });
  it('keeps one volume scale across lanes with received circles and sent diamonds', () => {
    const { container } = render(<SenderTimeline lanes={lanes} query={query} onQueryChange={() => {}} onSelectBucket={() => {}} />);
    const old = container.querySelector('[data-sender="old@test"] circle[data-direction="received"]');
    const recent = container.querySelector('[data-sender="new@test"] circle[data-direction="received"]');
    expect(old).not.toBeNull();
    expect(Number(old.getAttribute('r')) / Number(recent.getAttribute('r'))).toBeCloseTo(2);
    expect(container.querySelector('[data-sender="old@test"] rect[data-direction="sent"]')).not.toBeNull();
  });
  it('changes zoom and sort while preserving sender selection in the shared query', () => {
    const onQueryChange = vi.fn();
    const selectedQuery = { ...query, senderAddress: 'old@test' };
    const { rerender } = render(<SenderTimeline lanes={lanes} query={selectedQuery} onQueryChange={onQueryChange} onSelectBucket={() => {}} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Timeline detail' }), { target: { value: 'day' } });
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...selectedQuery, timelineBucket: 'day' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Timeline detail' }), { target: { value: 'message' } });
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...selectedQuery, timelineBucket: 'message' });
    rerender(<SenderTimeline lanes={lanes} query={{ ...selectedQuery, senderSort: 'count' }} onQueryChange={onQueryChange} onSelectBucket={() => {}} />);
    expect(screen.getAllByRole('row')[0].getAttribute('aria-label')).toBe('old@test');
  });
  it('uses individual event times and directions at message detail, keeping exact day selection', () => {
    const events = [
      { key: 'one', at: '2026-09-09T08:00:00Z', direction: 'received' },
      { key: 'two', at: '2026-09-09T12:00:00Z', direction: 'sent' },
    ];
    const onSelectBucket = vi.fn();
    render(<SenderTimeline lanes={[{ address: 'ana@test', buckets: [{ startDate: '2026-09-09', endDate: '2026-09-09', received: 1, sent: 1, keys: ['one', 'two'], events }] }]} query={{ ...query, startDate: '2026-09-09', endDate: '2026-09-09', timelineBucket: 'message', timeZone: 'UTC' }} onQueryChange={() => {}} onSelectBucket={onSelectBucket} />);
    const marks = within(screen.getByRole('row', { name: 'ana@test' })).getAllByRole('button');
    expect(marks).toHaveLength(2);
    expect(marks[0].getAttribute('aria-label')).toMatch(/received/i);
    expect(marks[1].getAttribute('aria-label')).toMatch(/sent/i);
    expect(parseFloat(marks[1].style.left)).toBeGreaterThan(parseFloat(marks[0].style.left));
    fireEvent.click(marks[1]);
    expect(onSelectBucket).toHaveBeenCalledWith(expect.objectContaining({ senderAddress: 'ana@test', startDate: '2026-09-09', endDate: '2026-09-09', messageKey: 'two' }));
  });
  it('sorts senders by their exact latest contact within the same week', () => {
    const input = [
      { ...lanes[0], address: 'a-old@test', lastAt: '2026-09-01T10:00:00Z' },
      { ...lanes[0], address: 'z-new@test', lastAt: '2026-09-06T10:00:00Z' },
    ];
    render(<SenderTimeline lanes={input} query={query} onQueryChange={() => {}} onSelectBucket={() => {}} />);
    expect(screen.getAllByRole('row')[0].getAttribute('aria-label')).toBe('z-new@test');
  });
  it('keeps adjacent-day events near midnight in separate selectable day clusters', () => {
    const input = [{ address: 'ana@test', buckets: [
      { startDate: '2026-09-08', endDate: '2026-09-08', received: 1, sent: 0, keys: ['one'], events: [{ key: 'one', at: '2026-09-08T23:59:00Z', direction: 'received' }] },
      { startDate: '2026-09-09', endDate: '2026-09-09', received: 1, sent: 0, keys: ['two'], events: [{ key: 'two', at: '2026-09-09T00:01:00Z', direction: 'received' }] },
    ] }];
    const onSelectBucket = vi.fn();
    render(<SenderTimeline lanes={input} query={{ ...query, startDate: '2026-09-08', endDate: '2026-09-09', timelineBucket: 'message', timeZone: 'UTC' }} onQueryChange={() => {}} onSelectBucket={onSelectBucket} />);
    const marks = within(screen.getByRole('row', { name: 'ana@test' })).getAllByRole('button');
    expect(parseFloat(marks[1].style.left) - parseFloat(marks[0].style.left)).toBeGreaterThan(10);
    fireEvent.click(marks[1]);
    expect(onSelectBucket).toHaveBeenCalledWith({ senderAddress: 'ana@test', startDate: '2026-09-09', endDate: '2026-09-09' });
  });
  it('virtualizes large sender sets and exposes lanes after scrolling', () => {
    const input = Array.from({ length: 500 }, (_, i) => ({ ...lanes[0], address: `person${String(i).padStart(3, '0')}@test` }));
    render(<SenderTimeline lanes={input} query={query} onQueryChange={() => {}} onSelectBucket={() => {}} />);
    expect(screen.getAllByRole('row').length).toBeLessThan(30);
    const viewport = screen.getByRole('table', { name: 'Sender timeline' });
    expect(viewport.getAttribute('aria-rowcount')).toBe('500');
    fireEvent.scroll(viewport, { target: { scrollTop: 24000 } });
    expect(screen.getByRole('row', { name: 'person499@test' })).toBeTruthy();
  });
});
