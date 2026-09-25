// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QuickActionsSettings } from '../QuickActionsSettings';
import { quickActionScopeKey } from '../../../utils/quickActions';
import { pinQuickActionScope } from '../../../hooks/useQuickActionConfiguration';

const state = vi.hoisted(() => ({
  quickActions: null,
  setQuickActions: vi.fn(),
  setQuickActionSurface: vi.fn(),
  setQuickActionStyle: vi.fn(),
  setQuickActionStyleLink: vi.fn(),
  resetQuickActionScope: vi.fn(),
  resetQuickActions: vi.fn(),
}));
vi.mock('../../../stores/settingsStore', () => ({
  // getState: the row preview's sample time goes through formatTime.
  useSettingsStore: Object.assign(selector => selector(state), { getState: () => state }),
}));
const mailState = vi.hoisted(() => ({
  activeMailbox: 'INBOX', activeAccountId: 'acct-1', viewMode: 'all', unifiedInbox: false,
  mailboxScope: null, mailboxes: [{ path: 'Archive', name: 'Archive' }], archiveEmails: vi.fn(),
  moveEmails: vi.fn(), deleteEmailFromServer: vi.fn(), purgeSelectedEverywhere: vi.fn(), setSelectedFlagged: vi.fn(),
}));
vi.mock('../../../stores/mailStore', () => {
  const useMailStore = selector => selector(mailState);
  useMailStore.getState = () => mailState;
  return { useMailStore };
});
vi.mock('../../../stores/searchStore', () => ({ useSearchStore: selector => selector({ searchActive: false }) }));

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

afterEach(() => { cleanup(); vi.clearAllMocks(); pinQuickActionScope(undefined); });

describe('QuickActionsSettings', () => {
  it('uses surface tabs with one matching preview, scope inheritance, mode and ordered action controls', () => {
    state.quickActions = {
      defaults: { row: { mode: 'favorite-menu', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);

    expect(screen.getByRole('tablist', { name: 'Surface' })).toBeTruthy();
    expect(screen.getByLabelText('Scope')).toBeTruthy();
    expect(screen.getByLabelText('Layout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add action' })).toBeTruthy();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(screen.getByRole('group', { name: 'Message rows' })).getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(within(preview).queryByRole('group', { name: 'Email reader' })).toBeNull();
  });

  it('updates production preview through harmless sample callbacks without invoking mail operations', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Email reader' })).getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Preview action selected')).toBeTruthy();
    expect(mailState.archiveEmails).not.toHaveBeenCalled();
    expect(mailState.moveEmails).not.toHaveBeenCalled();
    expect(mailState.deleteEmailFromServer).not.toHaveBeenCalled();
    expect(mailState.purgeSelectedEverywhere).not.toHaveBeenCalled();
    expect(mailState.setSelectedFlagged).not.toHaveBeenCalled();
  });

  it('keeps saved reader actions inert in the production preview layout', () => {
    state.quickActions = {
      defaults: { reader: { mode: 'inline', entries: [{ id: 'move:acct-1:Archive', action: 'move', params: { mailbox: 'Archive', accountId: 'acct-1' } }], favoriteId: null, palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    const reader = within(screen.getByRole('group', { name: 'Email reader' }));
    fireEvent.click(reader.getByRole('button', { name: 'Move: Archive' }));
    expect(screen.getByText('Preview action selected')).toBeTruthy();
    expect(mailState.moveEmails).not.toHaveBeenCalled();
  });

  it('persists a custom action color and keeps it when the layout changes', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'custom' } },
      overrides: {},
    };
    const view = render(<QuickActionsSettings />);
    const color = screen.getByLabelText('Action color Archive');
    fireEvent.change(color, { target: { value: '#ff9900' } });
    expect(state.quickActions.defaults.row.entries[0].color).toBe('#ff9900');

    view.rerender(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Menu' }));
    expect(state.quickActions.defaults.row.entries[0].color).toBe('#ff9900');
  });

  it('uses keyboard-operable radio tabs and colors editor rows only for action palettes', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'semantic' } },
      overrides: {},
    };
    const view = render(<QuickActionsSettings />);
    const row = document.querySelector('.quick-actions-entry-name').closest('li');
    expect(row.dataset.colored).toBe('true');
    const inline = screen.getByRole('radio', { name: 'Inline' });
    fireEvent.keyDown(inline, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Menu' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }));
    view.rerender(<QuickActionsSettings />);
    expect(document.querySelector('.quick-actions-entry-name').closest('li').dataset.colored).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom colors' }));
    view.rerender(<QuickActionsSettings />);
    expect(document.querySelector('.quick-actions-entry-name').closest('li').dataset.colored).toBe('true');
    expect(screen.getByText('Default action color')).toBeTruthy();
  });

  it('resets only the active surface', () => {
    state.quickActions = {
      defaults: {
        row: { mode: 'menu', entries: [{ id: 'delete', action: 'delete' }], favoriteId: null, palette: 'neutral' },
        reader: { mode: 'menu', entries: [{ id: 'reply', action: 'reply' }], favoriteId: 'reply', palette: 'custom' },
      },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(state.quickActions.defaults.row.entries[0].action).toBe('archive');
    expect(state.quickActions.defaults.reader).toMatchObject({ mode: 'menu', palette: 'custom' });
  });

  // The view on screen: INBOX of acct-1, as mailState above describes it.
  const inboxKey = quickActionScopeKey({ kind: 'mailbox', accountId: 'acct-1', mailbox: 'INBOX' });
  const readerOverride = { [inboxKey]: { reader: { mode: 'radial', entries: [{ id: 'reply', action: 'reply' }], favoriteId: 'reply', palette: 'semantic' } } };
  const checked = name => screen.getByRole('radio', { name }).getAttribute('aria-checked');

  it('opens each surface on the scope that governs the current view', () => {
    state.quickActions = { defaults: {}, overrides: readerOverride };
    render(<QuickActionsSettings />);
    expect(checked('All views')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    expect(checked('Current view')).toBe('true');
    expect(checked('Radial')).toBe('true');
  });

  it('follows an override created while Settings is open, but keeps an explicit choice', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    const view = render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    expect(checked('All views')).toBe('true');
    state.quickActions = { defaults: {}, overrides: readerOverride };
    view.rerender(<QuickActionsSettings />);
    expect(checked('Current view')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'All views' }));
    view.rerender(<QuickActionsSettings />);
    expect(checked('All views')).toBe('true');
    expect(checked('Inline')).toBe('true');
  });

  it('stays on Current view after the view goes back to the all-view defaults', () => {
    state.quickActions = { defaults: {}, overrides: readerOverride };
    state.resetQuickActionScope.mockImplementation(() => { state.quickActions = { defaults: {}, overrides: {} }; });
    const view = render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use all-view defaults' }));
    view.rerender(<QuickActionsSettings />);
    expect(checked('Current view')).toBe('true');
    expect(screen.getByRole('button', { name: 'Customize this view' })).toBeTruthy();
  });

  it('edits the scope a detached window was handed, not its own INBOX', () => {
    const work = { kind: 'mailbox', accountId: 'acct-1', mailbox: 'Work' };
    state.quickActions = { defaults: {}, overrides: { [quickActionScopeKey(work)]: readerOverride[inboxKey] } };
    pinQuickActionScope(work);
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    expect(checked('Current view')).toBe('true');
    expect(checked('Radial')).toBe('true');
    expect(document.querySelector('.quick-actions-choice-hint').textContent).toContain('Work');
  });
});
