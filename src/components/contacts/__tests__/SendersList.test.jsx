// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({ getTotalSize: () => count * 56, getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 56, size: 56, key: i })) }),
}));
const h = vi.hoisted(() => ({ senders: null, people: null, freshSenders: null, freshPeople: null }));
vi.mock('../../../stores/sendersStore', async () => {
  const { create } = await import('zustand');
  h.freshSenders = () => ({
    items: [
      { address: 'amy@x.io', name: 'Amy', received: 3, sentTo: 0, lastMs: 9, personId: 'p1', favorite: true },
      { address: 'bo@x.io', name: 'Bo', received: 7, sentTo: 0, lastMs: 8, personId: null, favorite: false },
    ],
    total: 2, query: '', sort: 'last', load: vi.fn(), loadMore: vi.fn(), setQuery: vi.fn(), setSort: vi.fn(),
  });
  h.senders = create(() => h.freshSenders());
  return { useSendersStore: h.senders };
});
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.freshPeople = () => ({ selectedId: null, sender: null, items: [], select: vi.fn(), selectSender: vi.fn() });
  h.people = create(() => h.freshPeople());
  return { usePeopleStore: h.people };
});
import { SendersList } from '../SendersList';

beforeEach(() => { h.senders.setState(h.freshSenders(), true); h.people.setState(h.freshPeople(), true); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('SendersList', () => {
  it('renders a row per sender with received count', () => {
    render(<SendersList />);
    expect(screen.getByTestId('sender-row-amy@x.io').textContent).toContain('Amy');
    expect(screen.getByTestId('sender-row-bo@x.io').textContent).toContain('7');
    expect(h.senders.getState().load).toHaveBeenCalled();
  });

  it('a saved sender row selects the contact', () => {
    render(<SendersList />);
    fireEvent.click(screen.getByTestId('sender-row-amy@x.io'));
    expect(h.people.getState().select).toHaveBeenCalledWith('p1');
    expect(h.people.getState().selectSender).not.toHaveBeenCalled();
  });

  it('an unsaved sender row selects the sender', () => {
    render(<SendersList />);
    fireEvent.click(screen.getByTestId('sender-row-bo@x.io'));
    expect(h.people.getState().selectSender).toHaveBeenCalledWith(expect.objectContaining({ address: 'bo@x.io', name: 'Bo' }));
    expect(h.people.getState().select).not.toHaveBeenCalled();
  });

  it('typing searches once after a pause', () => {
    vi.useFakeTimers();
    render(<SendersList />);
    fireEvent.change(screen.getByTestId('senders-search'), { target: { value: 'a' } });
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.change(screen.getByTestId('senders-search'), { target: { value: 'am' } });
    expect(h.senders.getState().setQuery).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(h.senders.getState().setQuery).toHaveBeenCalledTimes(1);
    expect(h.senders.getState().setQuery).toHaveBeenCalledWith('am');
  });

  it('marks favorites with a star', () => {
    render(<SendersList />);
    expect(screen.getByTestId('sender-row-amy@x.io').querySelector('[data-testid="row-favorite"]')).toBeTruthy();
    expect(screen.getByTestId('sender-row-bo@x.io').querySelector('[data-testid="row-favorite"]')).toBeNull();
    expect(screen.getByTestId('sender-row-amy@x.io').querySelector('[data-testid="row-saved"]')).toBeTruthy();
  });

  it('sort changes go to the store', () => {
    render(<SendersList />);
    fireEvent.change(screen.getByTestId('senders-sort'), { target: { value: 'total' } });
    expect(h.senders.getState().setSort).toHaveBeenCalledWith('total');
  });

  it('reloads when the contacts list changes (a sender was saved or starred)', () => {
    render(<SendersList />);
    h.senders.getState().load.mockClear();
    act(() => h.people.setState({ items: [{ id: 'p9' }] }));
    expect(h.senders.getState().load).toHaveBeenCalledTimes(1);
  });
});
