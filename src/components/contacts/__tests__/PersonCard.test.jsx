// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k, v) => (v?.name ? `${k}:${v.name}` : k) }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../../utils/dateFormat', () => ({
  formatDateOnly: (ms) => `D${ms}`,
  formatMonthYear: (y, m) => `M${y}-${m}`,
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: Object.assign((sel) => sel({ accounts: [] }), { getState: () => ({}) }),
}));
vi.mock('../../../utils/notificationOpen', () => ({ openNotificationTarget: vi.fn() }));
vi.mock('../../ui/Dialog', async () => {
  const React = await import('react');
  return {
    Dialog: ({ open, title, description, footer }) => (open
      ? React.createElement('div', { role: 'alertdialog' },
        React.createElement('h3', null, title),
        React.createElement('p', { 'data-testid': 'dialog-description' }, description),
        footer)
      : null),
  };
});
vi.mock('../MergeDialog', async () => {
  const React = await import('react');
  return { MergeDialog: ({ ids }) => React.createElement('div', { 'data-testid': 'merge-dialog' }, ids.join(',')) };
});
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({
    selectedId: null, card: null, stats: {}, proposals: [],
    fetchCard: vi.fn(async (id) => ({ id, displayName: id === 'p2' ? 'Amelia' : '', emails: [] })),
    mail: [], mailNext: null, mailLoading: false,
    loadMail: vi.fn(), loadMoreMail: vi.fn(), update: vi.fn(), create: vi.fn(), remove: vi.fn(), select: vi.fn(),
  });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { PersonCard } from '../PersonCard';

const CARD = {
  id: 'p1', displayName: 'Amy', emails: [{ address: 'amy@x.io', label: 'work', recordId: 'r1' }], phones: [{ number: '+100', label: '', recordId: 'r1' }],
  org: 'Acme', notes: '', vip: false, pinned: false, blocked: false, recordIds: ['r1'], sourceKinds: ['local'],
};
const select = (card, extra = {}) => h.s.setState({ selectedId: card.id, card, ...extra });

beforeEach(() => h.s.setState(h.fresh(), true));
afterEach(cleanup);

describe('PersonCard', () => {
  it('shows the name, the received/sent/cc breakdown and first and last dates', () => {
    select(CARD, { stats: { p1: { received: 3, sentTo: 1, cc: 2, firstMs: 1000, lastMs: 2000 } } });
    render(<PersonCard />);
    expect(screen.getByText('Amy', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByTestId('stat-received').textContent).toBe('3');
    expect(screen.getByTestId('stat-sent').textContent).toBe('1');
    expect(screen.getByTestId('stat-cc').textContent).toBe('2');
    expect(screen.getByTestId('stat-first').textContent).toBe('D1000');
    expect(screen.getByTestId('stat-last').textContent).toBe('D2000');
    act(() => h.s.setState({ stats: { p1: { received: 0, sentTo: 0, cc: 0, firstMs: null, lastMs: null } } }));
    expect(screen.getByText('contacts.stats.none')).toBeTruthy();
    expect(screen.queryByTestId('stat-received')).toBeNull();
  });

  it('with no selection shows nothing; with "new" shows an empty editable draft', () => {
    const { unmount } = render(<PersonCard />);
    expect(screen.queryByTestId('person-card')).toBeNull();
    unmount();
    h.s.setState({ selectedId: 'new', card: null });
    render(<PersonCard />);
    expect(screen.getByTestId('person-card')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByTestId('person-save').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('person-name'), { target: { value: 'Zed' } });
    expect(screen.getByTestId('person-save').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('person-save'));
    expect(h.s.getState().create).toHaveBeenCalledWith({ displayName: 'Zed', emails: [], phones: [], org: '', notes: '' });
  });

  it('a draft with only an email or only a phone can be saved', () => {
    h.s.setState({ selectedId: 'new', card: null });
    render(<PersonCard />);
    fireEvent.click(screen.getByTestId('person-add-email'));
    expect(screen.getByTestId('person-save').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('person-email-0'), { target: { value: ' z@x.io ' } });
    expect(screen.getByTestId('person-save').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('person-save'));
    expect(h.s.getState().create).toHaveBeenCalledWith(expect.objectContaining({ displayName: '', emails: ['z@x.io'] }));
  });

  it('save calls update with only the changed fields', () => {
    select(CARD);
    render(<PersonCard />);
    expect(screen.getByTestId('person-save').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('person-notes'), { target: { value: 'met in Vilnius' } });
    fireEvent.click(screen.getByTestId('person-save'));
    expect(h.s.getState().update).toHaveBeenCalledWith('p1', { notes: 'met in Vilnius' });
  });

  it('after save the form shows what the daemon stored, so Save goes back to disabled', async () => {
    const stored = { ...CARD, emails: [{ address: 'jane@x.io', label: '', recordId: 'r1' }] };
    h.s.setState({ update: vi.fn(async () => { h.s.setState({ card: stored }); return stored; }) });
    select(CARD);
    render(<PersonCard />);
    fireEvent.change(screen.getByTestId('person-email-0'), { target: { value: 'Jane@X.io' } });
    expect(screen.getByTestId('person-save').disabled).toBe(false);
    await act(async () => { fireEvent.click(screen.getByTestId('person-save')); });
    expect(screen.getByTestId('person-email-0').value).toBe('jane@x.io');
    expect(screen.getByTestId('person-save').disabled).toBe(true);
    expect(screen.queryByTestId('person-cancel')).toBeNull();
  });

  it('shows the provenance label of an existing email read-only', () => {
    select(CARD);
    render(<PersonCard />);
    expect(screen.getByTestId('person-email-0').value).toBe('amy@x.io');
    expect(screen.getByText('work')).toBeTruthy();
  });

  it('delete asks for confirmation with the name, then calls remove', () => {
    select(CARD);
    render(<PersonCard />);
    fireEvent.click(screen.getByTestId('person-delete'));
    expect(screen.getByTestId('dialog-description').textContent).toBe('contacts.deleteConfirm:Amy');
    expect(h.s.getState().remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('person-delete-confirm'));
    expect(h.s.getState().remove).toHaveBeenCalledWith('p1');
  });

  it('cancelling the delete confirmation never calls remove', () => {
    select(CARD);
    render(<PersonCard />);
    fireEvent.click(screen.getByTestId('person-delete'));
    fireEvent.click(screen.getByTestId('person-delete-cancel'));
    expect(h.s.getState().remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('VIP, pinned and blocked toggles call update', () => {
    select({ ...CARD, pinned: true });
    render(<PersonCard />);
    fireEvent.click(screen.getByTestId('toggle-vip'));
    expect(h.s.getState().update).toHaveBeenCalledWith('p1', { vip: true });
    fireEvent.click(screen.getByTestId('toggle-pinned'));
    expect(h.s.getState().update).toHaveBeenCalledWith('p1', { pinned: false });
    fireEvent.click(screen.getByTestId('toggle-blocked'));
    expect(h.s.getState().update).toHaveBeenCalledWith('p1', { blocked: true });
  });

  it('a new card object for the same contact keeps unsaved edits', () => {
    select(CARD);
    render(<PersonCard />);
    fireEvent.change(screen.getByTestId('person-notes'), { target: { value: 'draft note' } });
    act(() => h.s.setState({ card: { ...CARD, vip: true } }));
    expect(screen.getByTestId('person-notes').value).toBe('draft note');
    act(() => h.s.setState({ selectedId: 'p9', card: { ...CARD, id: 'p9', notes: 'other' } }));
    expect(screen.getByTestId('person-notes').value).toBe('other');
  });

  it('a contact with no email shows the details without an email section crash', () => {
    select({ ...CARD, emails: [], phones: [] });
    render(<PersonCard />);
    expect(screen.queryByTestId('person-email-0')).toBeNull();
    expect(screen.getByTestId('person-add-email')).toBeTruthy();
    expect(screen.getByTestId('person-name').value).toBe('Amy');
  });

  it('the merge button opens the merge dialog for this contact', () => {
    select(CARD);
    render(<PersonCard />);
    expect(screen.queryByTestId('merge-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('person-merge'));
    expect(screen.getByTestId('merge-dialog').textContent).toBe('p1');
  });

  it('lists possible duplicates that include this contact with the reason', async () => {
    select(CARD, { proposals: [
      { a: 'p2', b: 'p1', reason: 'name' },
      { a: 'p3', b: 'p4', reason: 'phone' },
    ] });
    render(<PersonCard />);
    expect(screen.getByText('contacts.merge.proposals')).toBeTruthy();
    const row = screen.getByTestId('proposal-p2');
    expect(row.textContent).toContain('contacts.merge.reason.name');
    expect(await screen.findByText('Amelia')).toBeTruthy();
    expect(screen.queryByTestId('proposal-p3')).toBeNull();
    expect(screen.queryByTestId('proposal-p4')).toBeNull();
  });

  it('shows no duplicates block when none include this contact', () => {
    select(CARD, { proposals: [{ a: 'p3', b: 'p4', reason: 'phone' }] });
    render(<PersonCard />);
    expect(screen.queryByTestId('person-proposals')).toBeNull();
  });

  it('a proposal opens the merge dialog with both contacts', () => {
    select(CARD, { proposals: [{ a: 'p1', b: 'p2', reason: 'phone' }] });
    render(<PersonCard />);
    fireEvent.click(screen.getByTestId('proposal-merge-p2'));
    expect(screen.getByTestId('merge-dialog').textContent).toBe('p1,p2');
  });

  it('the correspondence tab shows the mail list', () => {
    select(CARD);
    render(<PersonCard />);
    fireEvent.click(screen.getByText('contacts.tab.mail'));
    expect(screen.getByTestId('person-mail')).toBeTruthy();
    expect(h.s.getState().loadMail).toHaveBeenCalledWith({});
  });
});
