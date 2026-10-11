// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({ getTotalSize: () => count * 56, getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 56, size: 56, key: i })), measureElement: () => {} }),
}));
const h = vi.hoisted(() => ({ s: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.s = create(() => ({
    items: [
      { id: 'p1', displayName: 'Amy', primaryEmail: 'amy@x.io', vip: true, pinned: false },
      { id: 'p2', displayName: 'Bob', primaryEmail: '', vip: false, pinned: false },
    ],
    total: 2, query: '', sort: 'name', vipOnly: false, selectedId: null, stats: { p1: { received: 3, sentTo: 1, cc: 0, lastMs: 1700000000000 } },
    setQuery: vi.fn(), setSort: vi.fn(), setVipOnly: vi.fn(), select: vi.fn(), loadMore: vi.fn(), refreshStats: vi.fn(), create: vi.fn(),
  }));
  return { usePeopleStore: h.s };
});
import { ContactsList } from '../ContactsList';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ContactsList', () => {
  it('renders a row per contact, shows a total from stats and handles a contact with no email', () => {
    render(<ContactsList />);
    expect(screen.getByTestId('contact-row-p1').textContent).toContain('Amy');
    expect(screen.getByTestId('contact-row-p1').textContent).toContain('4'); // received + sentTo + cc
    expect(screen.getByTestId('contact-row-p2').textContent).toContain('Bob');
  });
  it('asks for stats for the visible rows', () => {
    render(<ContactsList />);
    expect(h.s.getState().refreshStats).toHaveBeenCalledWith(['p1', 'p2']);
  });
  it('typing searches once, after a pause, with the last text', () => {
    vi.useFakeTimers();
    h.s.getState().setQuery.mockClear();
    render(<ContactsList />);
    fireEvent.change(screen.getByTestId('contacts-search'), { target: { value: 'a' } });
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.change(screen.getByTestId('contacts-search'), { target: { value: 'am' } });
    expect(screen.getByTestId('contacts-search').value).toBe('am');
    expect(h.s.getState().setQuery).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(h.s.getState().setQuery).toHaveBeenCalledTimes(1);
    expect(h.s.getState().setQuery).toHaveBeenCalledWith('am');
  });
  it('selecting a row selects the contact; sort and VIP filter call the store', () => {
    render(<ContactsList />);
    fireEvent.click(screen.getByTestId('contact-row-p2'));
    expect(h.s.getState().select).toHaveBeenCalledWith('p2');
    fireEvent.change(screen.getByTestId('contacts-sort'), { target: { value: 'total' } });
    expect(h.s.getState().setSort).toHaveBeenCalledWith('total');
    fireEvent.click(screen.getByTestId('contacts-vip-filter'));
    expect(h.s.getState().setVipOnly).toHaveBeenCalledWith(true);
  });
  it('the new button creates an empty draft by selecting the draft sentinel', () => {
    render(<ContactsList />);
    fireEvent.click(screen.getByTestId('contacts-new'));
    expect(h.s.getState().select).toHaveBeenCalledWith('new');
  });
});
