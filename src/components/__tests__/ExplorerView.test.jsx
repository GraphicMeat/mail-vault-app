// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as explorerModule from '../ExplorerView';
import { useSettingsStore } from '../../stores/settingsStore';

vi.mock('../../stores/safeStorage', () => ({ safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
vi.mock('../../services/trackerVerdicts', () => ({ backfillTrackerVerdicts: vi.fn() }));

const emails = [
  { uid: 1, _accountId: 'a', _mailbox: 'INBOX', from: { name: 'Shop', address: 'shop@example.test' }, subject: 'Invoice September', date: '2026-09-09T12:00:00', flags: [], isArchived: true, messageId: '<sep@test>' },
  { uid: 2, _accountId: 'a', _mailbox: 'INBOX', from: { name: 'Shop', address: 'shop@example.test' }, subject: 'Invoice August', date: '2026-08-08T12:00:00', flags: ['\\Seen'], isArchived: false, messageId: '<aug@test>' },
  { uid: 1, _accountId: 'b', _mailbox: 'INBOX', from: { name: 'Shop', address: 'other@example.test' }, subject: 'Meeting', date: '2025-12-03T12:00:00', flags: [], isArchived: false, messageId: '<meeting@test>' },
];
const context = { activeAccountId: 'a', activeMailbox: 'UNIFIED', unifiedInbox: true };
const keyOf = e => `${e._accountId}:${e._mailbox}:${e.uid}`;
const renderEmail = e => <button data-testid="leaf-email" key={keyOf(e)}>{e.subject}</button>;
function mount(extra = {}) {
  expect(typeof explorerModule.ExplorerView).toBe('function');
  return render(<explorerModule.ExplorerView emails={emails} conversationEmails={emails} context={context} rootLabel="Inbox" selectedEmailIds={new Set()} getSelectionKey={keyOf} onSetSelection={() => {}} renderEmail={renderEmail} {...extra} />);
}
function enter(label) { fireEvent.click(screen.getByRole('button', { name: `Open group ${label}` })); }
function grouping(value) { fireEvent.change(screen.getByRole('combobox', { name: 'Browse by' }), { target: { value } }); }

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  // Simulate viewport geometry; keep TanStack's real windowing behavior.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 500, top: 0, left: 0, right: 700, bottom: 500 });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(700);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = function(options) { this.scrollTop = options.top || 0; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Explorer browsing', () => {
  it('does not render a back control at the root', () => {
    mount();
    expect(screen.queryByTestId('explorer-back')).toBeNull();
  });
  it('keeps pointer navigation from creating a programmatic Back focus ring', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open group 2026' }), { detail: 1 });
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(screen.getByTestId('explorer-back')).not.toBe(document.activeElement);
  });
  it('restores keyboard focus to the root breadcrumb after Alt+Left back navigation', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Open group 2026' }), { detail: 0 });
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
    fireEvent.keyDown(screen.getByTestId('explorer-view'), { key: 'ArrowLeft', altKey: true });
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(screen.getByRole('button', { name: 'Inbox' })).toBe(document.activeElement);
  });
  it('navigates date groups, breadcrumbs and back to real email leaves', () => {
    mount(); enter('2026'); enter('September');
    expect(screen.getByRole('button', { name: 'Invoice September' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invoice August' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to parent group' }));
    expect(screen.getByRole('button', { name: 'Open group August' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Explorer path' })).getByRole('button', { name: 'Inbox' }));
    expect(screen.getByRole('button', { name: 'Open group 2025' })).toBeTruthy();
  });

  it('selects only a groups descendants, keeping duplicate uids distinct', () => {
    const selected = new Set();
    const choose = (members, checked) => members.forEach(e => checked ? selected.add(keyOf(e)) : selected.delete(keyOf(e)));
    mount({ onSetSelection: choose });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select group 2026' }));
    expect([...selected]).toEqual(['a:INBOX:1', 'a:INBOX:2']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select group 2025' }));
    expect([...selected]).toEqual(['a:INBOX:1', 'a:INBOX:2', 'b:INBOX:1']);
  });

  it('preserves each mailbox and grouping path across remounts', () => {
    const first = mount(); enter('2026'); enter('September'); first.unmount();
    const second = mount(); expect(screen.getByText('Invoice September')).toBeTruthy();
    grouping('sender');
    expect(screen.getAllByRole('button', { name: 'Open group Shop' })).toHaveLength(2);
    grouping('date'); expect(screen.getByText('Invoice September')).toBeTruthy();
    second.unmount();
    mount({ context: { ...context, activeAccountId: 'another' } });
    expect(screen.getByRole('button', { name: 'Open group 2026' })).toBeTruthy();
  });

  it('searches only the current group and narrows group selection', () => {
    const selected = [];
    mount({ onSetSelection: members => selected.push(...members) }); enter('2026');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this group' }), { target: { value: 'September' } });
    expect(screen.getByText('Invoice September')).toBeTruthy();
    expect(screen.queryByText('Meeting')).toBeNull();
    expect(screen.queryByText('Invoice August')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select visible emails' }));
    expect(selected.map(keyOf)).toEqual(['a:INBOX:1']);
  });

  it('filters unread without destroying the remembered path and exposes partial loading', () => {
    const load = vi.fn();
    const view = mount({ partial: true, hasMore: true, onLoadMore: load }); enter('2026'); enter('August');
    view.rerender(<explorerModule.ExplorerView emails={emails} context={context} rootLabel="Inbox" unreadOnly selectedEmailIds={new Set()} getSelectionKey={keyOf} onSetSelection={() => {}} renderEmail={renderEmail} partial hasMore onLoadMore={load} />);
    expect(screen.getByText('No unread emails in this group.')).toBeTruthy();
    expect(screen.getByText(/Groups reflect loaded emails/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more emails' }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('navigation', { name: 'Explorer path' })).getByText('August')).toBeTruthy();
  });

  it('opens conversation groups and offers the complete conversation', () => {
    const open = vi.fn(); mount({ onOpenThread: open }); grouping('conversation'); enter('2026'); enter('September'); enter('Invoice September');
    fireEvent.click(screen.getByRole('button', { name: 'Open full conversation' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Invoice September' }));
  });

  it('routes next-email navigation within the open group', () => {
    const open = vi.fn(); mount({ onSelectEmail: open }); enter('2026'); enter('August');
    act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
    expect(open).toHaveBeenCalledWith(emails[1]);
    act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
    expect(open).toHaveBeenLastCalledWith(emails[1]);
    expect(open).not.toHaveBeenCalledWith(emails[0]);
  });

  it('refreshes an open conversation after switching to Date or Sender', () => {
    const refresh = vi.fn();
    const reply = { ...emails[0], uid: 3, messageId: '<reply@test>', inReplyTo: '<sep@test>', subject: 'Re: Invoice September', date: '2026-09-10T12:00:00' };
    mount({ hasOpenThread: true, conversationEmails: [...emails, reply], onThreadsChanged: refresh });
    for (const mode of ['date', 'sender']) {
      grouping(mode);
      const threads = refresh.mock.lastCall[0];
      expect([...threads.values()].find(thread => thread.subject === 'Invoice September').emails.map(keyOf).sort()).toEqual(['a:INBOX:1', 'a:INBOX:3']);
    }
  });

  it('continues after the clicked message and does not skip when it becomes read', () => {
    const rows = emails.map((email, index) => ({ ...email, date: `2026-09-0${9-index}T12:00:00`, flags: [] }));
    const open = vi.fn();
    const props = { emails: rows, context, rootLabel: 'Inbox', unreadOnly: true, selectedEmailIds: new Set(), getSelectionKey: keyOf, onSetSelection: () => {}, renderEmail, onSelectEmail: open };
    const view = render(<explorerModule.ExplorerView {...props} />); enter('2026'); enter('September');
    fireEvent.click(screen.getByText('Invoice August'));
    act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
    expect(open).toHaveBeenLastCalledWith(rows[2]);
    fireEvent.click(screen.getByText('Invoice September'));
    view.rerender(<explorerModule.ExplorerView {...props} emails={[{ ...rows[0], flags: ['\\Seen'] }, ...rows.slice(1)]} />);
    act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
    expect(open).toHaveBeenLastCalledWith(rows[1]);
  });

  it('renders bounded windows for large sender lists', () => {
    act(() => useSettingsStore.getState().setExplorerGrouping('sender'));
    const many = Array.from({ length: 10000 }, (_, index) => ({ ...emails[0], uid: index, messageId: `<${index}@test>`, from: { name: `Sender ${index}`, address: `${index}@example.test` } }));
    mount({ emails: many });
    const rows = screen.getAllByTestId('explorer-group-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
  });

  it('brings a keyboard-focused virtual row into view through outer scroll panes', async () => {
    act(() => useSettingsStore.getState().setExplorerGrouping('sender'));
    const many = Array.from({ length: 100 }, (_, index) => ({ ...emails[0], uid: index, from: { address: `${index}@example.test` } }));
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      mount({ emails: many });
      act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
      await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally { HTMLElement.prototype.scrollIntoView = previous; }
  });

  it('keeps the focused message visible when the reader later shrinks the list pane', async () => {
    const observers = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { this.element = element; }
      unobserve() {}
      disconnect() {}
    });
    const scroll = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      mount(); enter('2026'); enter('September');
      act(() => window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: 1 })));
      await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
      expect(document.activeElement.dataset.explorerIndex).toBe('0');
      scroll.mockClear();
      act(() => observers.forEach(observer => observer.callback([{ target: observer.element }])));
      await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally { HTMLElement.prototype.scrollIntoView = previous; }
  });
});
