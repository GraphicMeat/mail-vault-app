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
vi.mock('../../../services/workflows/readerWindow', () => ({ openEmailInWindow: vi.fn(async () => true) }));
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
import { openEmailInWindow } from '../../../services/workflows/readerWindow';
import { useMailStore } from '../../../stores/mailStore';

const row = (over) => ({ accountId: 'a1', mailboxPath: 'INBOX', uid: 1, sortMs: new Date(2026, 2, 15, 12).getTime(), subject: 'Hello', direction: 'received', ...over });

beforeEach(() => {
  h.s.setState(h.fresh(), true);
  openNotificationTarget.mockReset();
  openEmailInWindow.mockClear();
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

  it('clicking a row leaves the contacts view, selects that message and opens it in a window', async () => {
    const onOpenMail = vi.fn();
    h.s.setState({ mail: [row({ uid: 7, mailboxPath: 'Work' })] });
    render(<PersonMail onOpenMail={onOpenMail} />);
    fireEvent.click(screen.getByTestId('mail-row-a1-7'));
    expect(onOpenMail).toHaveBeenCalledTimes(1);
    expect(openNotificationTarget).toHaveBeenCalledWith({ accountId: 'a1', mailbox: 'Work', uid: 7 }, useMailStore.getState);
    expect(onOpenMail.mock.invocationCallOrder[0]).toBeLessThan(openNotificationTarget.mock.invocationCallOrder[0]);
    await vi.waitFor(() => expect(openEmailInWindow).toHaveBeenCalledTimes(1));
    expect(openEmailInWindow.mock.calls[0][0]).toMatchObject({ uid: 7, _accountId: 'a1', _mailbox: 'Work' });
    expect(openNotificationTarget.mock.invocationCallOrder[0]).toBeLessThan(openEmailInWindow.mock.invocationCallOrder[0]);
  });

  it('the second click of a double click opens nothing more', () => {
    h.s.setState({ mail: [row({ uid: 7 })] });
    render(<PersonMail />);
    fireEvent.click(screen.getByTestId('mail-row-a1-7'), { detail: 1 });
    fireEvent.click(screen.getByTestId('mail-row-a1-7'), { detail: 2 });
    expect(openNotificationTarget).toHaveBeenCalledTimes(1);
  });

  it('alternate rows carry the stripe ground, across month headers', () => {
    h.s.setState({
      mail: [
        row({ uid: 3 }), row({ uid: 2 }),
        row({ uid: 1, sortMs: new Date(2026, 0, 10, 12).getTime() }),
      ],
    });
    render(<PersonMail />);
    const grounds = [3, 2, 1].map((u) => screen.getByTestId(`mail-row-a1-${u}`).closest('li').className.includes('bg-mail-surface'));
    expect(grounds).toEqual([false, true, false]);
  });

  it('every row is one table row: badge, subject and date in fixed columns', () => {
    h.s.setState({ mail: [row({ uid: 1, direction: 'sent' }), row({ uid: 2, direction: 'received' })] });
    render(<PersonMail />);
    const cols = [1, 2].map((u) => screen.getByTestId(`mail-row-a1-${u}`).className.match(/grid-cols-\[[^\]]+\]/)?.[0]);
    expect(cols[0]).toBeTruthy();
    expect(cols[0]).toBe(cols[1]);
    for (const b of screen.getAllByTestId('mail-direction-badge')) expect(b.className).toContain('text-center');
  });

  it('reloads mail when the selected sender changes', () => {
    h.s.setState({ selectedId: null, sender: { address: 'a@x.io', name: '' } });
    render(<PersonMail />);
    const { loadMail } = h.s.getState();
    expect(loadMail).toHaveBeenCalledTimes(1);
    act(() => h.s.setState({ sender: { address: 'b@x.io', name: '' } }));
    expect(loadMail).toHaveBeenCalledTimes(2);
  });

  it('an empty subject shows the placeholder key', () => {
    h.s.setState({ mail: [row({ subject: '' })] });
    render(<PersonMail />);
    expect(screen.getByTestId('mail-row-a1-1').textContent).toContain('contacts.mail.noSubject');
  });
});
