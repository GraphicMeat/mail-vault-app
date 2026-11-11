// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../../utils/dateFormat', () => ({ formatDateOnly: (ms) => `D${ms}`, formatMonthYear: (y, m) => `M${y}-${m}` }));
vi.mock('../../../utils/composeOpener', () => ({ openCompose: vi.fn() }));
vi.mock('../../../utils/notificationOpen', () => ({ openNotificationTarget: vi.fn() }));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: Object.assign((sel) => sel({ accounts: [] }), { getState: () => ({}) }),
}));
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({
    sender: { address: 'bo@x.io', name: 'Bo' }, selectedId: null, stats: { 'bo@x.io': { received: 4, sentTo: 1, cc: 0, lastMs: 2000 } },
    mail: [{ accountId: 'a1', mailboxPath: 'INBOX', uid: 1, sortMs: 5, subject: 'Hello', direction: 'received' }], mailNext: null, mailLoading: false,
    loadMail: vi.fn(), loadMoreMail: vi.fn(), saveSender: vi.fn(), favoriteSender: vi.fn(),
  });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { SenderCard } from '../SenderCard';

beforeEach(() => h.s.setState(h.fresh(), true));
afterEach(cleanup);

describe('SenderCard', () => {
  it('shows address and counts', () => {
    render(<SenderCard />);
    expect(screen.getByTestId('sender-address').textContent).toBe('bo@x.io');
    expect(screen.getByText('Bo', { selector: 'h2' })).toBeTruthy();
    expect(screen.getByTestId('stat-received').textContent).toBe('4');
    expect(screen.getByTestId('stat-sent').textContent).toBe('1');
    expect(screen.getByTestId('stat-last').textContent).toBe('D2000');
    expect(screen.getByTestId('contact-email')).toBeTruthy();
  });

  it('Save contact calls saveSender', () => {
    render(<SenderCard />);
    fireEvent.click(screen.getByTestId('sender-save'));
    expect(h.s.getState().saveSender).toHaveBeenCalledWith({ address: 'bo@x.io', name: 'Bo' });
  });

  it('Favorite calls favoriteSender', () => {
    render(<SenderCard />);
    fireEvent.click(screen.getByTestId('sender-favorite'));
    expect(h.s.getState().favoriteSender).toHaveBeenCalledWith({ address: 'bo@x.io', name: 'Bo' });
  });

  it('shows the emails list for the address', () => {
    render(<SenderCard />);
    expect(screen.getByTestId('mail-row-a1-1').textContent).toContain('Hello');
    expect(h.s.getState().loadMail).toHaveBeenCalledWith({});
  });

  it('renders nothing without a selected sender', () => {
    h.s.setState({ sender: null });
    render(<SenderCard />);
    expect(screen.queryByTestId('sender-card')).toBeNull();
  });
});
