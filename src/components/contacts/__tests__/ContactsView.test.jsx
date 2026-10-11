// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../i18n', () => ({
  useT: () => (k, v) => (v?.count != null ? `${k}:${v.count}` : k),
  tErr: (e) => String(e),
}));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
const h = vi.hoisted(() => ({ store: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.store = create(() => ({
    items: [], total: 0, indexReady: true, indexing: false, query: '', sort: 'name', vipOnly: false,
    selectedId: null, card: null, review: [], status: 'idle', error: null,
    load: vi.fn(), setQuery: vi.fn(), setSort: vi.fn(), setVipOnly: vi.fn(), select: vi.fn(), loadReview: vi.fn(),
  }));
  return { usePeopleStore: h.store, initPeople: vi.fn() };
});

vi.mock('../PersonCard', () => ({ PersonCard: () => null }));

import { ContactsView } from '../ContactsView';

afterEach(cleanup);

describe('ContactsView', () => {
  beforeEach(() => h.store.setState({ items: [], total: 0, indexReady: true, indexing: false }));

  it('loads on mount and shows the empty state with import and new actions', () => {
    render(<ContactsView onClose={() => {}} />);
    expect(h.store.getState().load).toHaveBeenCalled();
    expect(screen.getByTestId('contacts-view')).toBeTruthy();
    expect(screen.getByText('contacts.empty')).toBeTruthy();
    expect(screen.getByTestId('contacts-import')).toBeTruthy();
  });

  it('shows the indexing note while the history is still being read', () => {
    h.store.setState({ indexReady: false, indexing: true });
    render(<ContactsView onClose={() => {}} />);
    expect(screen.getByText('contacts.indexing')).toBeTruthy();
  });

  it('the back button calls onClose', () => {
    const onClose = vi.fn();
    render(<ContactsView onClose={onClose} />);
    fireEvent.click(screen.getByTestId('contacts-back'));
    expect(onClose).toHaveBeenCalled();
  });
});
