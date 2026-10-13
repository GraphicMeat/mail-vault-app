// @vitest-environment jsdom
//
// "Hide view mail" keeps the messages a saved view holds out of their folder,
// so a closed folder's badge (STATUS's unseen count) must not count the
// unread ones among them: the badge would promise mail the folder no longer
// shows. The daemon says how many unread messages it hides per folder.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

import { FolderTree, FolderBubbles } from '../FolderTree';
import { useSettingsStore } from '../../stores/settingsStore';
import { useViewHideStore } from '../../stores/viewHideStore';

const box = (path) => ({ path, name: path, delimiter: '/', specialUse: null, noselect: false, children: [] });
const mailboxes = [box('INBOX'), box('Work'), box('News')];
const counts = { INBOX: { unseen: 4 }, Work: { unseen: 5 }, News: { unseen: 1 } };
const badges = (container) => Object.fromEntries([...container.querySelectorAll('[data-testid="folder-unseen"]')]
  .map(el => [el.closest('[data-testid="folder-row"]').dataset.path, el.textContent]));

const setup = ({ on, unreadByMailbox }) => {
  useSettingsStore.setState({ hideViewMail: on });
  useViewHideStore.setState({ unreadByMailbox });
};

const props = (extra = {}) => ({
  accountId: 'a', mailboxes, activeMailbox: 'INBOX', expanded: new Set(),
  onToggle: () => {}, onSelect: () => {}, counts, ...extra,
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ hideViewMail: false });
  useViewHideStore.setState({ keys: null, unreadByMailbox: null, hiddenByMailbox: null });
});

describe('folder badges with hide view mail', () => {
  it('leave out the unread mail the views hold there', () => {
    setup({ on: true, unreadByMailbox: { 'a|Work': 2 } });
    const { container } = render(<FolderTree {...props()} />);
    expect(badges(container)).toEqual({ Work: '3', News: '1' });
  });

  it('count everything with the switch off', () => {
    setup({ on: false, unreadByMailbox: { 'a|Work': 2 } });
    const { container } = render(<FolderTree {...props()} />);
    expect(badges(container)).toEqual({ Work: '5', News: '1' });
  });

  it('count everything while the membership is unknown', () => {
    setup({ on: true, unreadByMailbox: null });
    const { container } = render(<FolderTree {...props()} />);
    expect(badges(container)).toEqual({ Work: '5', News: '1' });
  });

  it('never go below zero, and a folder left with nothing unread shows no badge', () => {
    // STATUS is older than the daemon's answer: it can say fewer than it hides.
    setup({ on: true, unreadByMailbox: { 'a|Work': 9, 'a|News': 1 } });
    const { container } = render(<FolderTree {...props()} />);
    expect(badges(container)).toEqual({});
  });

  it('count the INBOX row the same way when another folder is open', () => {
    setup({ on: true, unreadByMailbox: { 'a|INBOX': 3 } });
    const { container } = render(<FolderTree {...props({ activeMailbox: 'Work' })} />);
    expect(badges(container)).toEqual({ INBOX: '1', News: '1' });
  });

  it('read only their own account\'s numbers', () => {
    setup({ on: true, unreadByMailbox: { 'b|Work': 2 } });
    const { container } = render(<FolderTree {...props()} />);
    expect(badges(container)).toEqual({ Work: '5', News: '1' });
  });

  it('follow a new answer from the daemon without a remount', () => {
    setup({ on: true, unreadByMailbox: null });
    const { container } = render(<FolderTree {...props()} />);
    act(() => { useViewHideStore.setState({ unreadByMailbox: { 'a|Work': 4 } }); });
    expect(badges(container)).toEqual({ Work: '1', News: '1' });
  });

  it('apply in the chip skin and in folder search results too', () => {
    setup({ on: true, unreadByMailbox: { 'a|Work': 2 } });
    const chips = render(<FolderBubbles {...props()} />);
    expect(badges(chips.container)).toEqual({ Work: '3', News: '1' });
    cleanup();
    const found = render(<FolderTree {...props({ searchQuery: 'work' })} />);
    expect(badges(found.container)).toEqual({ Work: '3' });
  });
});
