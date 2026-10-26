// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLocale, t } from '../../i18n/index.js';

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  lifecycleSync: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleMarkSeen: vi.fn().mockResolvedValue({ rows: [] }),
  lifecycleDismiss: vi.fn().mockResolvedValue({ rows: [] }),
}));

const api = await import('../../services/api');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useLifecycleStore } = await import('../../stores/lifecycleStore');
const { LifecyclePinnedRows } = await import('../LifecyclePinnedRows');

const ROWS = [
  { id: 'trial-ending:20400', kind: 'trial-ending', atMs: Date.UTC(2026, 10, 3), seen: false, dismissed: false },
  { id: 'free-nudge', kind: 'free-nudge', atMs: Date.UTC(2026, 10, 1), seen: true, dismissed: false },
];

beforeEach(async () => {
  await setLocale('en');
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useMailStore.setState({ activeMailbox: 'INBOX', unifiedFolder: null, mailboxScope: null, selectedEmailId: null });
  useLifecycleStore.setState({ rows: ROWS, openId: null });
  api.lifecycleMarkSeen.mockClear();
  api.lifecycleDismiss.mockClear();
});
afterEach(cleanup);

describe('LifecyclePinnedRows', () => {
  it('pins each message above the inbox with who it is from and its subject', () => {
    render(<LifecyclePinnedRows />);
    const rows = screen.getAllByTestId('lifecycle-pinned-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain(t('lifecycle.from'));
    expect(rows[0].textContent).toContain(t('lifecycle.trialEnding.subject'));
    expect(rows[1].textContent).toContain(t('lifecycle.freeNudge.subject'));
  });

  it('marks the unread one', () => {
    render(<LifecyclePinnedRows />);
    expect(screen.getAllByTestId('lifecycle-pinned-row').map(r => r.dataset.unread)).toEqual(['true', 'false']);
  });

  it('opening a row opens the message and reads it', () => {
    render(<LifecyclePinnedRows />);
    fireEvent.click(screen.getAllByTestId('lifecycle-pinned-row')[0]);
    expect(useLifecycleStore.getState().openId).toBe('trial-ending:20400');
    expect(api.lifecycleMarkSeen).toHaveBeenCalledWith('trial-ending:20400');
  });

  it('opening a row leaves the email that was open, so the reader shows one thing', () => {
    useMailStore.setState({ selectedEmailId: 'a1:INBOX:5', selectedEmail: { uid: 5 } });
    render(<LifecyclePinnedRows />);
    fireEvent.click(screen.getAllByTestId('lifecycle-pinned-row')[0]);
    expect(useMailStore.getState()).toMatchObject({ selectedEmailId: null, selectedEmail: null });
  });

  it('Enter on a focused row opens it too', () => {
    render(<LifecyclePinnedRows />);
    fireEvent.keyDown(screen.getAllByTestId('lifecycle-pinned-row')[1], { key: 'Enter' });
    expect(useLifecycleStore.getState().openId).toBe('free-nudge');
  });

  it('the x dismisses without opening', () => {
    render(<LifecyclePinnedRows />);
    fireEvent.click(screen.getAllByTestId('lifecycle-dismiss')[0]);
    expect(api.lifecycleDismiss).toHaveBeenCalledWith('trial-ending:20400');
    expect(useLifecycleStore.getState().openId).toBeNull();
    expect(screen.getAllByTestId('lifecycle-pinned-row')).toHaveLength(1);
  });

  it('marks the open message as the current one', () => {
    useLifecycleStore.setState({ openId: 'free-nudge' });
    render(<LifecyclePinnedRows />);
    expect(screen.getAllByTestId('lifecycle-pinned-row').map(r => r.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('renders nothing outside an inbox, while a search is showing, or with no messages', () => {
    useMailStore.setState({ activeMailbox: 'Sent' });
    const { container, rerender } = render(<LifecyclePinnedRows />);
    expect(container.firstChild).toBeNull();

    useMailStore.setState({ activeMailbox: 'INBOX' });
    rerender(<LifecyclePinnedRows hidden />);
    expect(container.firstChild).toBeNull();

    useLifecycleStore.setState({ rows: [] });
    rerender(<LifecyclePinnedRows />);
    expect(container.firstChild).toBeNull();
  });

  it('skips a kind this version does not know instead of showing a raw key', () => {
    useLifecycleStore.setState({ rows: [{ id: 'x', kind: 'from-the-future', atMs: 1, seen: false, dismissed: false }] });
    const { container } = render(<LifecyclePinnedRows />);
    expect(container.firstChild).toBeNull();
  });
});
