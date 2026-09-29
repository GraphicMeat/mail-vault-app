// @vitest-environment jsdom

// The quick actions previews draw the person's latest mail: one account's
// cached INBOX headers, read locally, or previewMail's cast when there is none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { create } from 'zustand';

const getEmailHeadersPartial = vi.fn();
// The hook's one source; anything else it asked the db for would throw here.
vi.mock('../../services/db', () => ({ getEmailHeadersPartial: (...args) => getEmailHeadersPartial(...args) }));
const mail = create(() => ({ accounts: [], emails: [], activeAccountId: null, activeMailbox: 'INBOX' }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => mail(selector), { getState: () => mail.getState() }),
}));
const settings = create(() => ({ hiddenAccounts: {} }));
// getState: the cast's times go through formatTime.
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(selector => settings(selector), { getState: () => settings.getState() }),
}));

const { useQuickActionSamples, _resetQuickActionSamples } = await import('../useQuickActionSamples');

const header = (uid, flags = ['\\Seen']) => ({ uid, subject: `Message ${uid}`, flags, date: '2026-09-28T10:00:00Z', from: { name: 'Ann', address: 'ann@example.test' } });
const cache = byAccount => getEmailHeadersPartial.mockImplementation(async accountId => (byAccount[accountId] ? { emails: byAccount[accountId] } : null));
const accounts = (...ids) => mail.setState({ accounts: ids.map(id => ({ id, email: `${id}@example.test` })) });

beforeEach(() => { getEmailHeadersPartial.mockReset(); cache({}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetQuickActionSamples();
  mail.setState({ accounts: [], emails: [], activeAccountId: null });
  settings.setState({ hiddenAccounts: {} });
});

describe('useQuickActionSamples', () => {
  it('reads the latest five cached INBOX headers of a random account, stamped with where they live', async () => {
    accounts('a', 'b', 'c');
    cache({ a: [header(1)], b: [header(21), header(22), header(23), header(24), header(25)], c: [header(3)] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { result } = renderHook(() => useQuickActionSamples());
    await waitFor(() => expect(result.current[0].uid).toBe(21));
    expect(getEmailHeadersPartial).toHaveBeenCalledTimes(1);
    expect(getEmailHeadersPartial).toHaveBeenCalledWith('b', 'INBOX', 5);
    expect(result.current.map(row => [row.uid, row._accountId, row._mailbox])).toEqual(
      [21, 22, 23, 24, 25].map(uid => [uid, 'b', 'INBOX']),
    );
  });

  it('passes over an account with nothing cached, and a hidden one', async () => {
    accounts('a', 'b', 'c');
    settings.setState({ hiddenAccounts: { c: true } });
    cache({ b: [header(5)], c: [header(9)] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { result } = renderHook(() => useQuickActionSamples());
    await waitFor(() => expect(result.current[0].uid).toBe(5));
    expect(getEmailHeadersPartial.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('keeps the account it picked for the next open', async () => {
    accounts('a', 'b');
    cache({ a: [header(1)], b: [header(2)] });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const first = renderHook(() => useQuickActionSamples());
    await waitFor(() => expect(first.result.current[0].uid).toBe(2));
    first.unmount();
    Math.random.mockReturnValue(0);
    const second = renderHook(() => useQuickActionSamples());
    // Drawn at once from the last read, then read again from the same account.
    expect(second.result.current[0].uid).toBe(2);
    await waitFor(() => expect(getEmailHeadersPartial).toHaveBeenCalledTimes(2));
    expect(getEmailHeadersPartial.mock.calls[1][0]).toBe('b');
  });

  it('falls back to previewMail\'s cast without accounts, or with nothing cached', async () => {
    const { result } = renderHook(() => useQuickActionSamples());
    const cast = result.current;
    expect(cast).toHaveLength(5);
    expect(cast.map(row => row.uid)).toEqual([-1, -2, -3, -4, -5]);
    expect(cast[0]).toMatchObject({ subject: 'Launch campaign, round three', _mailbox: 'INBOX', source: 'server', flags: [] });
    expect(cast[2].flags).toEqual(['\\Seen']);
    expect(Number.isNaN(Date.parse(cast[0].date))).toBe(false);
    expect(getEmailHeadersPartial).not.toHaveBeenCalled();
    cleanup();

    accounts('a');
    const empty = renderHook(() => useQuickActionSamples());
    await waitFor(() => expect(empty.result.current[0]._accountId).toBe('a'));
    expect(empty.result.current.map(row => row.uid)).toEqual([-1, -2, -3, -4, -5]);
  });

  it('drops a read that lands after the preview closed', async () => {
    accounts('a');
    let land;
    getEmailHeadersPartial.mockImplementation(() => new Promise(resolve => { land = resolve; }));
    const errors = vi.spyOn(console, 'error');
    const { result, unmount } = renderHook(() => useQuickActionSamples());
    const before = result.current;
    unmount();
    await act(async () => { land({ emails: [header(1)] }); });
    expect(result.current).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    // Nothing was kept for the next open either.
    const next = renderHook(() => useQuickActionSamples());
    expect(next.result.current[0].uid).toBe(-1);
  });

  it('shows a star or read change the list made since the cache was written', async () => {
    accounts('a');
    cache({ a: [header(1), header(2)] });
    mail.setState({ activeAccountId: 'a', activeMailbox: 'INBOX' });
    const { result } = renderHook(() => useQuickActionSamples());
    await waitFor(() => expect(result.current[0].uid).toBe(1));
    const untouched = result.current[1];
    act(() => mail.setState({ emails: [{ uid: 1, flags: ['\\Seen', '\\Flagged'] }, { uid: 2, flags: ['\\Seen'] }] }));
    expect(result.current[0].flags).toEqual(['\\Seen', '\\Flagged']);
    expect(result.current[1]).toBe(untouched);
  });
});
