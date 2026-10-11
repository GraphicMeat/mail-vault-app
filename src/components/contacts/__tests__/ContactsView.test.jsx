// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../i18n', () => ({
  useT: () => (k, v) => (v?.created != null ? `${k}:${v.created}/${v.linked}/${v.skipped}` : v?.count != null ? `${k}:${v.count}` : k),
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
    load: vi.fn(), loadProposals: vi.fn(), importVcf: vi.fn(), setQuery: vi.fn(), setSort: vi.fn(), setVipOnly: vi.fn(), select: vi.fn(), loadReview: vi.fn(),
  }));
  return { usePeopleStore: h.store, initPeople: vi.fn() };
});

vi.mock('../PersonCard', () => ({ PersonCard: () => null }));
vi.mock('../ExportButton', () => ({ ExportButton: () => null }));

import { ContactsView } from '../ContactsView';

afterEach(cleanup);

describe('ContactsView', () => {
  beforeEach(() => h.store.setState({ items: [], total: 0, indexReady: true, indexing: false, error: null }));

  it('loads on mount and shows the empty state with import and new actions', () => {
    render(<ContactsView onClose={() => {}} />);
    expect(h.store.getState().load).toHaveBeenCalled();
    expect(screen.getByTestId('contacts-view')).toBeTruthy();
    expect(screen.getByText('contacts.empty')).toBeTruthy();
    expect(screen.getByTestId('contacts-import')).toBeTruthy();
  });

  it('loads the duplicate proposals on mount', () => {
    render(<ContactsView onClose={() => {}} />);
    expect(h.store.getState().loadProposals).toHaveBeenCalled();
  });

  it('importing a file passes its text on and reports what happened', async () => {
    h.store.getState().importVcf.mockResolvedValue({ created: 3, linked: 2, skipped: 1 });
    render(<ContactsView onClose={() => {}} />);
    const file = new File(['BEGIN:VCARD'], 'a.vcf', { type: 'text/vcard' });
    Object.defineProperty(file, 'text', { value: async () => 'BEGIN:VCARD' });
    fireEvent.change(screen.getByTestId('contacts-import-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('contacts-import-result')).toBeTruthy());
    expect(h.store.getState().importVcf).toHaveBeenCalledWith('BEGIN:VCARD');
    expect(screen.getByTestId('contacts-import-result').textContent).toBe('contacts.import.done:3/2/1');
  });

  it('a failed import shows the store error and no result line', async () => {
    h.store.getState().importVcf.mockResolvedValue(null);
    h.store.setState({ error: 'E_INVALID: bad card' });
    render(<ContactsView onClose={() => {}} />);
    const file = new File(['x'], 'a.vcf');
    Object.defineProperty(file, 'text', { value: async () => 'x' });
    fireEvent.change(screen.getByTestId('contacts-import-input'), { target: { files: [file] } });
    await waitFor(() => expect(h.store.getState().importVcf).toHaveBeenCalled());
    expect(screen.queryByTestId('contacts-import-result')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('E_INVALID: bad card');
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
