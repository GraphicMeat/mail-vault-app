// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('../../../utils/dateFormat', () => ({
  formatDateOnly: (ms) => `D${ms}`,
  formatMonthYear: (y, m) => `M${y}-${m}`,
}));
vi.mock('../../../utils/notificationOpen', () => ({ openNotificationTarget: vi.fn() }));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: Object.assign((sel) => sel({ accounts: [{ id: 'a1', email: 'me@x.io' }] }), { getState: () => ({}) }),
}));
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({ selectedId: 'p1', mail: [], mailNext: null, mailLoading: false, loadMail: vi.fn(), loadMoreMail: vi.fn() });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { PersonMail } from '../PersonMail';
import { openNotificationTarget } from '../../../utils/notificationOpen';
import { useMailStore } from '../../../stores/mailStore';

const row = (over) => ({ accountId: 'a1', mailboxPath: 'INBOX', uid: 1, sortMs: new Date(2026, 2, 15, 12).getTime(), subject: 'Hello', direction: 'received', ...over });

beforeEach(() => {
  h.s.setState(h.fresh(), true);
  openNotificationTarget.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PersonMail', () => {
  it('renders subjects grouped under month headers, newest first, with a direction badge', () => {
    h.s.setState({
      mail: [
        row({ uid: 3, subject: 'Third', direction: 'sent' }),
        row({ uid: 2, subject: 'Second', sortMs: new Date(2026, 2, 1, 12).getTime() }),
        row({ uid: 1, subject: 'First', sortMs: new Date(2026, 0, 10, 12).getTime() }),
      ],
    });
    render(<PersonMail />);
    expect(screen.getAllByTestId('mail-month').map((el) => el.textContent)).toEqual(['M2026-3', 'M2026-1']);
    const rows = screen.getAllByTestId(/^mail-row-/);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Third'), expect.stringContaining('Second'), expect.stringContaining('First'),
    ]);
    expect(rows[0].textContent).toContain('contacts.mail.dir.sent');
    expect(rows[1].textContent).toContain('contacts.mail.dir.received');
    expect(rows[0].textContent).toContain('me@x.io');
  });

  it('shows the empty state when there is no mail', () => {
    render(<PersonMail />);
    expect(screen.getByTestId('mail-empty').textContent).toBe('contacts.mail.empty');
  });

  it('the direction filter and the subject search reload through the store', () => {
    vi.useFakeTimers();
    render(<PersonMail />);
    const { loadMail } = h.s.getState();
    expect(loadMail).toHaveBeenLastCalledWith({});
    fireEvent.change(screen.getByTestId('mail-direction'), { target: { value: 'sent' } });
    expect(loadMail).toHaveBeenLastCalledWith({ direction: 'sent' });
    fireEvent.change(screen.getByTestId('mail-direction'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('mail-search'), { target: { value: 'invoice' } });
    expect(loadMail).not.toHaveBeenLastCalledWith({ text: 'invoice' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(loadMail).toHaveBeenLastCalledWith({ text: 'invoice' });
  });

  it('Load more appears only when a cursor exists and calls loadMoreMail', () => {
    h.s.setState({ mail: [row({})] });
    const { unmount } = render(<PersonMail />);
    expect(screen.queryByTestId('mail-more')).toBeNull();
    unmount();
    h.s.setState({ mailNext: { sortMs: 1, accountId: 'a1', mailboxPath: 'INBOX', uid: 1 } });
    render(<PersonMail />);
    fireEvent.click(screen.getByTestId('mail-more'));
    expect(h.s.getState().loadMoreMail).toHaveBeenCalledTimes(1);
  });

  it('clicking a row leaves the contacts view and opens that message', () => {
    const onOpenMail = vi.fn();
    h.s.setState({ mail: [row({ uid: 7, mailboxPath: 'Work' })] });
    render(<PersonMail onOpenMail={onOpenMail} />);
    fireEvent.click(screen.getByTestId('mail-row-a1-7'));
    expect(onOpenMail).toHaveBeenCalledTimes(1);
    expect(openNotificationTarget).toHaveBeenCalledWith({ accountId: 'a1', mailbox: 'Work', uid: 7 }, useMailStore.getState);
    expect(onOpenMail.mock.invocationCallOrder[0]).toBeLessThan(openNotificationTarget.mock.invocationCallOrder[0]);
  });

  it('an empty subject shows the placeholder key', () => {
    h.s.setState({ mail: [row({ subject: '' })] });
    render(<PersonMail />);
    expect(screen.getByTestId('mail-row-a1-1').textContent).toContain('contacts.mail.noSubject');
  });
});
