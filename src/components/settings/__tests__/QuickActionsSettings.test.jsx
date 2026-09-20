// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QuickActionsSettings } from '../QuickActionsSettings';

const state = vi.hoisted(() => ({
  quickActions: null,
  setQuickActions: vi.fn(),
  setQuickActionSurface: vi.fn(),
  resetQuickActions: vi.fn(),
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: selector => selector(state),
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('QuickActionsSettings', () => {
  it('exposes surface, scope inheritance, mode and ordered action controls', () => {
    state.quickActions = {
      defaults: { row: { mode: 'favorite-menu', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);

    expect(screen.getByLabelText('Surface')).toBeTruthy();
    expect(screen.getByLabelText('Scope')).toBeTruthy();
    expect(screen.getByLabelText('Layout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add action' })).toBeTruthy();
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(within(screen.getByRole('group', { name: 'Message rows' })).getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(within(preview).getByRole('group', { name: 'Email reader' })).toBeTruthy();
  });

  it('updates production preview through harmless sample callbacks without invoking mail operations', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
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
    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'menu' } });
    expect(state.quickActions.defaults.row.entries[0].color).toBe('#ff9900');
  });
});
