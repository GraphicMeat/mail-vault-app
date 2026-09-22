// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QuickActionsSettings } from '../QuickActionsSettings';

const state = vi.hoisted(() => ({
  quickActions: null,
  setQuickActions: vi.fn(),
  setQuickActionSurface: vi.fn(),
  setQuickActionStyle: vi.fn(),
  setQuickActionStyleLink: vi.fn(),
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
});
