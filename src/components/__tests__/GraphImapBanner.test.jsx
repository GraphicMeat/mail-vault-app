// @vitest-environment jsdom
//
// Outlook.com and Hotmail work over IMAP now, which is a better experience than
// Graph. An account still on Graph is told so once per launch, per account,
// with the switch one click away and a way to never be told again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { t } from '../../i18n';

const { GraphImapBanner } = await import('../GraphImapBanner');
const { useMailStore } = await import('../../stores/mailStore');
const { useSettingsStore } = await import('../../stores/settingsStore');

const graph = (id, email) => ({ id, email, oauth2Provider: 'microsoft', oauth2Transport: 'graph' });
const imap = (id, email) => ({ id, email, oauth2Provider: 'microsoft', oauth2Transport: 'imap' });
const gmail = (id, email) => ({ id, email, oauth2Provider: 'google' });

beforeEach(() => {
  useSettingsStore.setState({ graphImapNoticeDismissed: {} });
  useMailStore.setState({ accounts: [] });
});
afterEach(cleanup);

describe('GraphImapBanner', () => {
  it('stays out of the way without a Graph account', () => {
    useMailStore.setState({ accounts: [imap('a', 'a@outlook.com'), gmail('g', 'g@gmail.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    expect(screen.queryAllByTestId('graph-imap-banner')).toHaveLength(0);
  });

  it('shows one banner per Graph account, naming the address', () => {
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com'), imap('b', 'b@outlook.com'), graph('c', 'c@hotmail.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    const banners = screen.getAllByTestId('graph-imap-banner');
    expect(banners).toHaveLength(2);
    expect(banners[0].textContent).toContain('a@outlook.com');
    expect(banners[1].textContent).toContain('c@hotmail.com');
  });

  it('says IMAP is working and gives a better experience', () => {
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    expect(screen.getByTestId('graph-imap-banner').textContent).toContain(t('graphImapBanner.body'));
    expect(t('graphImapBanner.body')).toMatch(/IMAP/);
  });

  it('Switch to IMAP hands that account to the connection settings', () => {
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com'), graph('c', 'c@hotmail.com')] });
    const onSwitch = vi.fn();
    render(<GraphImapBanner onSwitch={onSwitch} />);
    const second = screen.getAllByTestId('graph-imap-banner')[1];
    fireEvent.click(within(second).getByRole('button', { name: t('graphImapBanner.switch') }));
    expect(onSwitch).toHaveBeenCalledWith('c');
  });

  it('Do not show again hides that account only, and remembers it', () => {
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com'), graph('c', 'c@hotmail.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    const first = screen.getAllByTestId('graph-imap-banner')[0];
    fireEvent.click(within(first).getByRole('button', { name: t('graphImapBanner.dismiss') }));
    const left = screen.getAllByTestId('graph-imap-banner');
    expect(left).toHaveLength(1);
    expect(left[0].textContent).toContain('c@hotmail.com');
    expect(useSettingsStore.getState().graphImapNoticeDismissed).toEqual({ a: true });
  });

  it('a dismissed account is not shown again on the next launch', () => {
    useSettingsStore.setState({ graphImapNoticeDismissed: { a: true } });
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    expect(screen.queryAllByTestId('graph-imap-banner')).toHaveLength(0);
  });

  it('an account that switched to IMAP loses its banner', () => {
    useMailStore.setState({ accounts: [graph('a', 'a@outlook.com')] });
    render(<GraphImapBanner onSwitch={vi.fn()} />);
    expect(screen.getAllByTestId('graph-imap-banner')).toHaveLength(1);
    act(() => useMailStore.setState({ accounts: [imap('a', 'a@outlook.com')] }));
    expect(screen.queryAllByTestId('graph-imap-banner')).toHaveLength(0);
  });
});
