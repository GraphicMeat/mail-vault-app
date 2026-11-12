// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({
  useT: () => (k, v) => (v?.created != null ? `${k}:${v.created}/${v.linked}/${v.skipped}` : v?.count != null ? `${k}:${v.count}` : k),
  tErr: (e) => String(e),
}));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
const h = vi.hoisted(() => ({ store: null, mail: { selectedEmail: null, selectedThread: null } }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.store = create(() => ({
    items: [], total: 0, indexReady: true, indexing: false, query: '', sort: 'name', vipOnly: false,
    selectedId: null, card: null, sender: null, review: [], status: 'idle', error: null,
    load: vi.fn(), loadProposals: vi.fn(), importVcf: vi.fn(), setQuery: vi.fn(), setSort: vi.fn(), setVipOnly: vi.fn(), select: vi.fn(), loadReview: vi.fn(),
  }));
  return { usePeopleStore: h.store, initPeople: vi.fn() };
});

vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => h.mail } }));
vi.mock('../../../stores/myAddresses', () => ({ myAddresses: () => ['me@h.io'] }));
vi.mock('../PersonCard', () => ({ PersonCard: () => <div data-testid="person-card-stub" /> }));
vi.mock('../SenderCard', () => ({ SenderCard: () => <div data-testid="sender-card-stub" /> }));
vi.mock('../SendersList', () => ({ SendersList: () => <div data-testid="senders-list-stub" /> }));
vi.mock('../EmailPeopleList', () => ({ EmailPeopleList: () => <div data-testid="email-people-stub" /> }));
vi.mock('../ReviewQueue', () => ({ ReviewQueue: () => <div data-testid="review-queue-stub" /> }));
vi.mock('../ExportButton', () => ({ ExportButton: () => null }));

import { ContactsView } from '../ContactsView';
import { useContactsViewStore } from '../../../stores/contactsViewStore';

afterEach(cleanup);

describe('ContactsView', () => {
  beforeEach(() => {
    h.store.setState({ items: [], total: 0, indexReady: true, indexing: false, error: null, vipOnly: false, sender: null });
    h.store.getState().setVipOnly.mockClear();
    h.mail.selectedEmail = null;
    h.mail.selectedThread = null;
    useContactsViewStore.setState(useContactsViewStore.getInitialState(), true);
  });

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

  it('shows This email only when the open message has participants', () => {
    const { unmount } = render(<ContactsView onClose={() => {}} />);
    expect(screen.queryByTestId('contacts-tab-email')).toBeNull();
    unmount();
    h.mail.selectedEmail = { from: { address: 'amy@x.io', name: 'Amy' }, to: [{ address: 'me@h.io' }, { address: 'bo@x.io' }], cc: [] };
    render(<ContactsView onClose={() => {}} />);
    expect(screen.getByTestId('contacts-tab-email').textContent).toBe('contacts.scope.email (2)');
    expect(screen.getByTestId('email-people-stub')).toBeTruthy();
    expect(screen.getByTestId('contacts-tab-email').getAttribute('aria-selected')).toBe('true');
  });

  it('reads the open thread when no single message is selected', () => {
    h.mail.selectedThread = { lastEmail: { from: { address: 'amy@x.io' }, to: [], cc: [] } };
    render(<ContactsView onClose={() => {}} />);
    expect(screen.getByTestId('contacts-tab-email').textContent).toBe('contacts.scope.email (1)');
  });

  it('Favorites tab filters to vip, Contacts clears it', () => {
    render(<ContactsView onClose={() => {}} />);
    const { setVipOnly } = h.store.getState();
    expect(setVipOnly).not.toHaveBeenCalled(); // already unfiltered on open
    fireEvent.click(screen.getByTestId('contacts-tab-favorites'));
    expect(setVipOnly).toHaveBeenLastCalledWith(true);
    h.store.setState({ vipOnly: true });
    fireEvent.click(screen.getByTestId('contacts-tab-contacts'));
    expect(setVipOnly).toHaveBeenLastCalledWith(false);
  });

  it('leaving Favorites for All senders clears the favorites filter', () => {
    render(<ContactsView onClose={() => {}} />);
    const { setVipOnly } = h.store.getState();
    h.store.setState({ vipOnly: true });
    fireEvent.click(screen.getByTestId('contacts-tab-senders'));
    expect(setVipOnly).toHaveBeenLastCalledWith(false);
  });

  it('All senders tab shows the senders list', () => {
    render(<ContactsView onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('contacts-tab-senders'));
    expect(screen.getByTestId('senders-list-stub')).toBeTruthy();
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('contacts.scope.senders');
  });

  it('Review tab shows the review queue', () => {
    render(<ContactsView onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('contacts-review-tab'));
    expect(screen.getByTestId('review-queue-stub')).toBeTruthy();
    expect(screen.queryByTestId('person-card-stub')).toBeNull();
  });

  it('an unsaved sender selection shows the sender card', () => {
    render(<ContactsView onClose={() => {}} />);
    expect(screen.getByTestId('person-card-stub')).toBeTruthy();
    act(() => h.store.setState({ sender: { address: 'bo@x.io', name: 'Bo' } }));
    expect(screen.getByTestId('sender-card-stub')).toBeTruthy();
    expect(screen.queryByTestId('person-card-stub')).toBeNull();
  });
});
