// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QuickActionsSettings } from '../QuickActionsSettings';
import { Dialog } from '../../ui/Dialog';
import { quickActionScopeKey, resolveQuickActions } from '../../../utils/quickActions';
import { applyQuickActionPreset, QUICK_ACTION_PRESETS } from '../../../utils/quickActionPresets';
import { pinQuickActionScope } from '../../../hooks/useQuickActionConfiguration';
import { _resetQuickActionSamples } from '../../../hooks/useQuickActionSamples';
import { useTagStore } from '../../../stores/tagStore';
import { getEmailHeadersPartial } from '../../../services/db';

const state = vi.hoisted(() => ({
  quickActions: null,
  setQuickActions: vi.fn(),
  setQuickActionSurface: vi.fn(),
  setQuickActionStyle: vi.fn(),
  setQuickActionStyleLink: vi.fn(),
  resetQuickActionScope: vi.fn(),
  resetQuickActions: vi.fn(),
  applyQuickActionPreset: vi.fn(),
}));
// The real module for the helpers the sample rows read (normalizeListPreviewLines
// and the like), with this test's store in place of the real one.
vi.mock('../../../stores/settingsStore', async (importOriginal) => ({
  ...(await importOriginal()),
  useSettingsStore: Object.assign(selector => selector(state), { getState: () => state }),
}));
const mailState = vi.hoisted(() => ({
  activeMailbox: 'INBOX', activeAccountId: 'acct-1', viewMode: 'all', unifiedInbox: false,
  mailboxScope: null, mailboxes: [{ path: 'Archive', name: 'Archive' }], accounts: [{ id: 'acct-1', email: 'me@example.test' }],
  serverUids: { complete: false }, archiveEmails: vi.fn(),
  moveEmails: vi.fn(), deleteEmailFromServer: vi.fn(), purgeSelectedEverywhere: vi.fn(), setSelectedFlagged: vi.fn(),
  markSelectedAsRead: vi.fn(), markSelectedAsUnread: vi.fn(), setSelection: vi.fn(), toggleFlagged: vi.fn(),
}));
vi.mock('../../../stores/mailStore', () => {
  const useMailStore = selector => selector(mailState);
  useMailStore.getState = () => mailState;
  return { useMailStore };
});
vi.mock('../../../stores/searchStore', () => ({ useSearchStore: selector => selector({ searchActive: false }) }));
// The samples' only source: the header cache on this computer.
vi.mock('../../../services/db', async (importOriginal) => ({
  ...(await importOriginal()),
  getEmailHeadersPartial: vi.fn(async () => null),
}));

state.setQuickActionSurface.mockImplementation((surface, _scope, config) => {
  state.quickActions = {
    ...state.quickActions,
    defaults: { ...state.quickActions.defaults, [surface]: config },
  };
});
state.setQuickActionStyle.mockImplementation((surface, _scope, updates) => {
  state.quickActions = {
    ...state.quickActions,
    defaults: { ...state.quickActions.defaults, [surface]: { ...state.quickActions.defaults[surface], ...updates } },
  };
});
const mailOperations = () => ['archiveEmails', 'moveEmails', 'deleteEmailFromServer', 'purgeSelectedEverywhere', 'setSelectedFlagged',
  'markSelectedAsRead', 'markSelectedAsUnread', 'setSelection', 'toggleFlagged'].filter(name => mailState[name].mock.calls.length);
const sampleFrame = () => document.querySelector('.quick-actions-sample-frame');
const cached = (uid, subject, flags = ['\\Seen']) => ({
  uid, subject, flags, date: `2026-09-2${uid % 10}T10:00:00Z`, from: { name: `Sender ${uid}`, address: `s${uid}@example.test` },
});

beforeEach(() => {
  state.applyQuickActionPreset.mockImplementation((presetId, scope) => {
    state.quickActions = applyQuickActionPreset(state.quickActions, scope, presetId);
  });
});
afterEach(() => {
  cleanup(); vi.clearAllMocks(); pinQuickActionScope(undefined); _resetQuickActionSamples();
  getEmailHeadersPartial.mockImplementation(async () => null);
  useTagStore.setState({ tags: [], byRow: {} });
});


// The simplified page: the actions are chips in one strip, added from one
// searchable picker; the look is two light rows of choices; the rest is a line.
const row = (entries, extra = {}) => ({
  defaults: { row: { mode: 'inline', entries: entries.map(action => ({ id: action, action })), favoriteId: null, palette: 'neutral', ...extra } },
  overrides: {},
});
const order = () => state.quickActions.defaults.row.entries.map(entry => entry.id);
const strip = () => screen.getByRole('list', { name: 'Your actions' });

describe('Quick actions, simplified', () => {
  it('shows the actions as chips in one strip, in order', () => {
    state.quickActions = row(['archive', 'delete', 'star']);
    render(<QuickActionsSettings />);
    expect(strip().classList.contains('quick-actions-strip')).toBe(true);
    expect(within(strip()).getAllByRole('listitem').map(item => item.dataset.entry)).toEqual(['archive', 'delete', 'star']);
    // No separate add form and no select of actions any more.
    expect(screen.queryByRole('combobox', { name: 'Action' })).toBeNull();
  });

  it('removes a chip with its ×', () => {
    state.quickActions = row(['archive', 'delete']);
    render(<QuickActionsSettings />);
    fireEvent.click(within(strip()).getByRole('button', { name: 'Remove action Archive' }));
    expect(order()).toEqual(['delete']);
  });

  it('moves a chip with the arrow keys on its grip, and by dragging its grip onto another', () => {
    state.quickActions = row(['archive', 'reply', 'export']);
    const view = render(<QuickActionsSettings />);
    fireEvent.keyDown(within(strip()).getByRole('button', { name: 'Reorder Archive' }), { key: 'ArrowRight' });
    expect(order()).toEqual(['reply', 'archive', 'export']);
    view.rerender(<QuickActionsSettings />);
    fireEvent.keyDown(within(strip()).getByRole('button', { name: 'Reorder Export' }), { key: 'ArrowLeft' });
    expect(order()).toEqual(['reply', 'export', 'archive']);
    view.rerender(<QuickActionsSettings />);
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      constructor(type, options = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; }
    });
    // jsdom has no layout: three chips side by side, 100px each.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const index = this.matches('li.quick-actions-chip') ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: index * 100, right: index * 100 + 96, top: 0, bottom: 30, width: 96, height: 30 };
    });
    try {
      // Pointer drag, not HTML5 drag and drop, which Tauri swallows on Windows.
      expect(within(strip()).getAllByRole('listitem')[0].getAttribute('draggable')).toBeNull();
      const grip = within(strip()).getByRole('button', { name: 'Reorder Archive' });
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 210, clientY: 10 });
      fireEvent.pointerUp(grip, { pointerId: 1, clientX: 20, clientY: 10 });
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(order()).toEqual(['archive', 'reply', 'export']);
  });

  it('adds from one searchable picker, grouped by category, into its category slot', () => {
    state.quickActions = row(['reply', 'archive', 'export']);
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    const picker = screen.getByRole('dialog', { name: 'Add action' });
    expect(within(picker).getAllByRole('group').map(group => group.getAttribute('aria-label')))
      .toEqual(['Send', 'Mark', 'Organize', 'Clean up', 'More']);
    // An action already in the strip is shown, and cannot be added twice.
    expect(within(picker).getByRole('button', { name: /Archive/ }).disabled).toBe(true);
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'forw' } });
    expect(within(picker).getAllByRole('button').filter(b => b.dataset.action).map(b => b.dataset.action)).toEqual(['forward']);
    fireEvent.click(within(picker).getByRole('button', { name: 'Forward' }));
    expect(order()).toEqual(['reply', 'forward', 'archive', 'export']);
    expect(screen.queryByRole('dialog', { name: 'Add action' })).toBeNull();
  });

  it('closes only the picker on Escape inside the Settings dialog, which stays open', () => {
    state.quickActions = row(['archive']);
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Settings"><QuickActionsSettings /></Dialog>);
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    expect(screen.getByRole('dialog', { name: 'Add action' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add action' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks for the folder inside the picker before adding Move to folder', () => {
    state.quickActions = row(['archive']);
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    const picker = screen.getByRole('dialog', { name: 'Add action' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Move to folder' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Archive' }));
    expect(order()).toEqual(['archive', 'move:acct-1:Archive']);
  });

  it('draws the layouts and color styles as light tiles, not as copies of the list', () => {
    state.quickActions = row(['archive']);
    render(<QuickActionsSettings />);
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(within(layout).getAllByRole('radio').map(r => r.textContent.trim())).toEqual(['Inline', 'Menu', 'Radial', 'Favorite plus menu']);
    expect(layout.querySelector('[data-testid="email-row"]')).toBeNull();
    const palette = screen.getByRole('radiogroup', { name: 'Color style' });
    expect(within(palette).getAllByRole('radio')).toHaveLength(3);
    expect(palette.querySelector('[data-testid="email-row"]')).toBeNull();
    // Only the one live preview draws mail rows.
    expect(document.querySelectorAll('[data-testid="email-row"]').length)
      .toBe(sampleFrame().querySelectorAll('[data-testid="email-row"]').length);
  });

  it('shows the wheel options only while the wheel is chosen', () => {
    state.quickActions = row(['archive']);
    const view = render(<QuickActionsSettings />);
    expect(screen.queryByRole('radiogroup', { name: 'Wheel layout' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Radial' }));
    view.rerender(<QuickActionsSettings />);
    expect(screen.getByRole('radiogroup', { name: 'Wheel layout' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Page actions in the wheel' })).toBeTruthy();
  });

  it('links the style across surfaces with one switch', () => {
    state.quickActions = row(['archive']);
    render(<QuickActionsSettings />);
    const toggle = screen.getByRole('switch', { name: 'Same look on rows, selection bar and reader' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(state.setQuickActionStyleLink).toHaveBeenCalledWith(null, true, 'row');
  });

  it('keeps the default-order list and the local label list off this page', () => {
    state.quickActions = row(['archive']);
    useTagStore.setState({ tags: [{ id: 't1', name: 'Invoices' }] });
    render(<QuickActionsSettings />);
    expect(screen.queryByText('Where new actions go')).toBeNull();
    expect(document.querySelector('.quick-actions-default-order')).toBeNull();
    expect(document.querySelector('.quick-actions-label-list')).toBeNull();
  });

  it('offers the action sets as plain chips, without drawn rows', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    render(<QuickActionsSettings />);
    const group = screen.getByRole('group', { name: 'Action sets' });
    expect(within(group).getAllByRole('button').map(b => b.textContent.trim())).toEqual(['MailVault', 'Gmail', 'Outlook', 'Thunderbird']);
    expect(group.querySelector('.quick-actions-card-sample')).toBeNull();
  });
});
