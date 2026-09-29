// @vitest-environment jsdom

// The row's quick actions as Settings draws them over sample messages:
// `configOverride` in place of the saved set, `preview` making every action
// inert. The real QuickActions and real icons, unlike RowQuickActions.test.jsx,
// so the wheel and the star's fill are what a person sees.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { create } from 'zustand';

const mocks = vi.hoisted(() => ({
  config: null,
  openCompose: vi.fn(),
  openExport: vi.fn(),
  replyTarget: vi.fn(),
}));

vi.mock('../../hooks/useQuickActionConfiguration', () => ({
  useQuickActionConfiguration: () => ({ config: mocks.config, scope: null }),
}));
vi.mock('../MoveToFolderDropdown', () => ({ MoveToFolderDropdown: () => <div data-testid="move-dropdown" /> }));
vi.mock('../SnoozePicker', () => ({ SnoozePicker: () => <div data-testid="snooze-picker" /> }));
vi.mock('../email/MessageStateIcon', () => ({ useBackupScan: () => null, isBackedUp: () => false }));
vi.mock('../../i18n/index.js', () => ({ t: key => key, useT: () => key => key, getLocale: () => 'en' }));
vi.mock('../../utils/composeOpener', () => ({ openCompose: (...args) => mocks.openCompose(...args) }));
vi.mock('../../utils/replyTarget', () => ({ replyTarget: (...args) => mocks.replyTarget(...args) }));
vi.mock('../../stores/exportStore', () => ({ useExportStore: { getState: () => ({ openExport: mocks.openExport }) } }));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: () => [] }));
vi.mock('../../services/workflows/messageMutations', () => ({ reloadListInView: vi.fn(), setDeleteUndo: vi.fn() }));

const spies = () => ({
  setSelection: vi.fn(),
  markSelectedAsRead: vi.fn(),
  markSelectedAsUnread: vi.fn(),
  setSelectedFlagged: vi.fn(),
  purgeSelectedEverywhere: vi.fn(),
  moveEmails: vi.fn(),
});
const useMailStoreMock = create(() => ({}));
function useMailStore(selector) { return useMailStoreMock(selector); }
useMailStore.getState = () => useMailStoreMock.getState();
vi.mock('../../stores/mailStore', () => ({ useMailStore }));

const useSettingsStoreMock = create(() => ({ emailTemplates: [{ id: 'tpl', name: 'Thanks', body: '<p>Thanks</p>' }] }));
function useSettingsStore(selector) { return useSettingsStoreMock(selector); }
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore }));

const useTagStoreMock = create(() => ({ tags: [{ id: 't1', name: 'Follow up' }], applyTagToRows: vi.fn() }));
function useTagStore(selector) { return useTagStoreMock(selector); }
useTagStore.getState = () => useTagStoreMock.getState();
vi.mock('../../stores/tagStore', () => ({ useTagStore }));

const { RowQuickActions } = await import('../RowQuickActions');
const { QuickActionWheelInPlace } = await import('../QuickActions');
const { useUnsubscribeStore } = await import('../../stores/unsubscribeStore');
const { QUICK_ACTION_TYPES } = await import('../../utils/quickActions');

const email = (overrides = {}) => ({
  uid: 42, subject: 'A message', date: '2026-09-01T10:00:00Z',
  from: { address: 'sender@example.test', name: 'Sender' },
  flags: [], isArchived: false, source: 'server', _accountId: 'acct-a', _mailbox: 'INBOX',
  ...overrides,
});
const entry = (action, params) => ({ id: action, action, ...(params ? { params } : {}) });
const inline = (...entries) => ({ mode: 'inline', palette: 'neutral', favoriteId: null, radialPagination: false, radialLayout: 'flat', entries });
const fillOf = action => document.querySelector(`[data-quick-action="${action}"] svg`)?.getAttribute('fill');

let rowActions;
let onRequestDelete;
let onArchive;
let onClose;
const renderRow = (emails, props = {}) => render(<RowQuickActions emails={emails} actions={rowActions}
  onRequestDelete={onRequestDelete} onArchive={onArchive} onClose={onClose} {...props} />);

beforeEach(() => {
  useMailStoreMock.setState({
    activeAccountId: 'acct-a', activeMailbox: 'INBOX', unifiedInbox: false, mailboxScope: null,
    accounts: [{ id: 'acct-a' }], selectedEmailIds: new Set(),
    mailboxes: [{ name: 'INBOX', path: 'INBOX' }, { name: 'Junk', path: 'Junk', specialUse: '\\Junk' }],
    ...spies(),
  }, true);
  useUnsubscribeStore.setState({ pending: null });
  mocks.config = inline(entry('archive'));
  mocks.openCompose.mockReset();
  mocks.openExport.mockReset();
  mocks.replyTarget.mockReset().mockImplementation(async target => target);
  rowActions = {
    deleteEmailFromServer: vi.fn(), removeLocalEmails: vi.fn(), saveEmailsLocally: vi.fn(),
  };
  onRequestDelete = vi.fn();
  onArchive = vi.fn();
  onClose = vi.fn();
});
afterEach(cleanup);

describe('RowQuickActions — star state', () => {
  it('draws Unstar filled on a starred row, and Star as an outline on one that is not', () => {
    mocks.config = inline(entry('star'), entry('unstar'));
    renderRow([email({ flags: ['\\Flagged'] })]);
    expect(document.querySelector('[data-quick-action="star"]')).toBeNull();
    expect(fillOf('unstar')).toBe('currentColor');
    cleanup();
    renderRow([email()]);
    expect(document.querySelector('[data-quick-action="unstar"]')).toBeNull();
    expect(fillOf('star')).toBe('none');
  });
});

describe('RowQuickActions — configOverride', () => {
  it('shows the given set instead of the saved one', () => {
    mocks.config = inline(entry('archive'));
    renderRow([email()], { configOverride: inline(entry('reply'), entry('forward')) });
    expect([...document.querySelectorAll('[data-quick-action]')].map(button => button.dataset.quickAction))
      .toEqual(['reply', 'forward']);
  });
});

describe('RowQuickActions — preview', () => {
  // As the list draws it: a trigger on the row, and the wheel it opens over
  // the page, not a wheel painted across the rows around it.
  it('keeps a radial set behind its trigger, and the wheel it opens shows the star in its state', () => {
    const wheel = { ...inline(entry('archive'), entry('star'), entry('unstar')), mode: 'radial', palette: 'semantic' };
    renderRow([email({ flags: ['\\Flagged'] })], { configOverride: wheel, preview: true });
    expect(document.querySelector('.quick-actions-radial-preview')).toBeNull();
    expect(document.querySelector('[data-quick-action]')).toBeNull();
    fireEvent.click(document.querySelector('.quick-actions-trigger'));
    const opened = document.querySelector('.quick-actions-radial[data-surface="row"]');
    expect(opened.hasAttribute('data-quick-actions-preview')).toBe(true);
    expect(opened.querySelector('[data-quick-action="star"]')).toBeNull();
    expect(opened.querySelector('[data-quick-action="unstar"] svg').getAttribute('fill')).toBe('currentColor');
  });

  it('draws the wheel open in place only in a picture nothing can open', () => {
    const wheel = { ...inline(entry('archive'), entry('unstar')), mode: 'radial', palette: 'semantic' };
    render(<QuickActionWheelInPlace.Provider value>
      <RowQuickActions emails={[email({ flags: ['\\Flagged'] })]} actions={rowActions} onRequestDelete={onRequestDelete}
        onArchive={onArchive} onClose={onClose} configOverride={wheel} preview />
    </QuickActionWheelInPlace.Provider>);
    const preview = document.querySelector('.quick-actions-radial-preview');
    expect(preview.querySelector('[data-quick-action="unstar"]')).not.toBeNull();
    expect(document.querySelector('.quick-actions-trigger')).toBeNull();
  });

  it('runs nothing, whichever action is pressed', async () => {
    // Two messages, one each way, so both sides of every pair are offered.
    const emails = [
      email({ uid: 1, flags: ['\\Seen', '\\Flagged'], isArchived: true }),
      email({ uid: 2, listUnsubscribe: '<mailto:leave@list.test>' }),
    ];
    const rowOnly = QUICK_ACTION_TYPES.filter(action => !['open', 'source', 'theme'].includes(action));
    const config = inline(...rowOnly.map(action => action === 'tag' ? entry('tag', { tagId: 't1' })
      : action === 'replyTemplate' ? entry('replyTemplate', { templateId: 'tpl' }) : entry(action)));
    renderRow(emails, { configOverride: config, preview: true });

    const pressed = [];
    for (const button of document.querySelectorAll('[data-quick-action]')) {
      if (button.disabled) continue;
      pressed.push(button.dataset.quickAction);
      fireEvent.click(button);
    }
    await Promise.resolve();

    // Not vacuous: every action that changes mail was on offer and pressed.
    expect(pressed).toEqual(expect.arrayContaining([
      'archive', 'unarchive', 'markRead', 'markUnread', 'star', 'unstar', 'tag', 'move', 'spam',
      'reply', 'replyAll', 'forward', 'replyTemplate', 'export', 'newMessage', 'delete', 'deleteServer',
      'deleteEverywhere', 'unsubscribe',
    ]));
    const state = useMailStoreMock.getState();
    for (const name of Object.keys(spies())) expect(state[name], name).not.toHaveBeenCalled();
    expect(useTagStoreMock.getState().applyTagToRows).not.toHaveBeenCalled();
    expect(rowActions.saveEmailsLocally).not.toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onRequestDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.openCompose).not.toHaveBeenCalled();
    expect(mocks.openExport).not.toHaveBeenCalled();
    expect(useUnsubscribeStore.getState().pending).toBeNull();
    expect(document.querySelector('[data-testid="move-dropdown"]')).toBeNull();
    expect(document.querySelector('[data-testid="snooze-picker"]')).toBeNull();
  });
});
