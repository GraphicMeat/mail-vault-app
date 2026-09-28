// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    const row = document.querySelector('.quick-actions-entry-name').closest('.quick-actions-entry');
    expect(row.dataset.colored).toBe('true');
    const inline = screen.getByRole('radio', { name: 'Inline' });
    fireEvent.keyDown(inline, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Menu' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Neutral' }));
    view.rerender(<QuickActionsSettings />);
    expect(document.querySelector('.quick-actions-entry-name').closest('.quick-actions-entry').dataset.colored).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom colors' }));
    view.rerender(<QuickActionsSettings />);
    expect(document.querySelector('.quick-actions-entry-name').closest('.quick-actions-entry').dataset.colored).toBe('true');
    expect(screen.getByText('Default action color')).toBeTruthy();
  });

  it('saves the wheel layout per surface and hides wheel paging for categories', () => {
    state.quickActions = {
      defaults: {
        row: { mode: 'radial', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }], favoriteId: 'archive', palette: 'neutral' },
        reader: { mode: 'radial', entries: [{ id: 'reply', action: 'reply' }], favoriteId: 'reply', palette: 'neutral', radialLayout: 'flat' },
      },
      overrides: {},
    };
    const view = render(<QuickActionsSettings />);
    const layout = screen.getByRole('radiogroup', { name: 'Wheel layout' });
    expect(within(layout).getByRole('radio', { name: 'One ring' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: 'Page actions in the wheel' })).toBeTruthy();
    fireEvent.click(within(layout).getByRole('radio', { name: 'Categories' }));
    const [surface, , updates] = state.setQuickActionStyle.mock.calls.at(-1);
    expect(surface).toBe('row');
    expect(updates).toEqual({ radialLayout: 'categories' });
    expect(state.quickActions.defaults.row.radialLayout).toBe('categories');
    expect(state.quickActions.defaults.reader.radialLayout).toBe('flat');

    view.rerender(<QuickActionsSettings />);
    expect(within(screen.getByRole('radiogroup', { name: 'Wheel layout' })).getByRole('radio', { name: 'Categories' })
      .getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('radiogroup', { name: 'Page actions in the wheel' })).toBeNull();
  });

  it('picks the favorite action through Tom Select and saves it', () => {
    state.quickActions = {
      defaults: { row: { mode: 'favorite-menu', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    const favorite = document.querySelector('select[aria-label="Favorite action"]');
    expect(favorite.tomselect).toBeTruthy();
    expect(favorite.tomselect.options.archive.text).toBe('Archive');
    expect(favorite.tomselect.options.reply.text).toBe('Reply');
    expect(favorite.tomselect.getValue()).toBe('archive');
    act(() => { favorite.tomselect.setValue('reply'); });
    expect(state.quickActions.defaults.row.favoriteId).toBe('reply');
  });

  it('keeps the favorite picker in a row of its own, apart from the layout controls', () => {
    state.quickActions = {
      defaults: { row: { mode: 'favorite-menu', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    const favorite = document.querySelector('select[aria-label="Favorite action"]');
    expect(favorite.closest('.quick-actions-favorite-row')).toBeTruthy();
    expect(favorite.closest('.quick-actions-choice-controls')).toBeNull();
    expect(favorite.closest('.quick-actions-favorite-row').querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('never puts the favorite into the wheel, before or after choosing categories', () => {
    const entries = ['archive', 'unarchive', 'reply', 'forward'].map(action => ({ id: action, action }));
    state.quickActions = {
      defaults: { row: { mode: 'radial', radialLayout: 'flat', entries, favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    const view = render(<QuickActionsSettings />);
    const controls = () => [...document.querySelectorAll('.quick-actions-choice-controls .quick-actions-choice-field, .quick-actions-choice-controls > label')]
      .map(field => field.firstElementChild.textContent);
    const before = controls();
    expect(document.querySelector('select[aria-label="Favorite action"]')).toBeNull();

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Wheel layout' })).getByRole('radio', { name: 'Categories' }));
    view.rerender(<QuickActionsSettings />);
    // Choosing categories adds no favorite field in front of the wheel layout.
    expect(document.querySelector('select[aria-label="Favorite action"]')).toBeNull();
    expect(controls().slice(0, before.indexOf('Wheel layout') + 1)).toEqual(before.slice(0, before.indexOf('Wheel layout') + 1));
    const wheel = document.querySelector('.quick-actions-radial-preview');
    expect(wheel.dataset.radialLayout).toBe('categories');
    // Archive stays in Organize with Unarchive, not a wedge of its own.
    expect([...wheel.children].some(element => element.dataset.quickAction === 'archive')).toBe(false);
    expect(wheel.querySelector('[data-radial-category="organize"]')).toBeTruthy();
    fireEvent.mouseEnter(wheel.querySelector('[data-radial-category="send"]'));
    expect(wheel.querySelector('[data-quick-action="archive"]')).toBeNull();
  });

  it('adds a new action in its category slot, not at the bottom', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: ['reply', 'archive', 'export'].map(action => ({ id: action, action })), favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), { target: { value: 'forward' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    expect(state.quickActions.defaults.row.entries.map(entry => entry.id)).toEqual(['reply', 'forward', 'archive', 'export']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), { target: { value: 'star' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    expect(state.quickActions.defaults.row.entries.map(entry => entry.id)).toEqual(['reply', 'forward', 'star', 'archive', 'export']);
  });

  it('lists where every action goes by default, grouped by category', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    render(<QuickActionsSettings />);
    // Folded inside a <details>, hence `hidden`.
    const reference = screen.getByRole('list', { name: 'Where new actions go', hidden: true });
    const groups = within(reference).getAllByRole('list', { hidden: true });
    expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Send', 'Mark', 'Organize', 'Clean up', 'More']);
    expect(within(groups[0]).getAllByRole('listitem', { hidden: true }).map(item => item.textContent)).toEqual(
      ['Reply', 'Reply All', 'Forward', 'Reply with template', 'New message to sender'],
    );
    // Rows offer neither Open nor View source: the reference follows the surface.
    expect(within(groups[4]).getAllByRole('listitem', { hidden: true }).map(item => item.dataset.action)).toEqual(['export']);
  });

  it('removes an action with its red trash button', () => {
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: ['reply', 'archive'].map(action => ({ id: action, action })), favoriteId: 'reply', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    const remove = screen.getByRole('button', { name: 'Remove action Archive' });
    expect(remove.classList.contains('quick-actions-remove')).toBe(true);
    expect(remove.querySelector('svg')).toBeTruthy();
    expect(remove.textContent).toBe('');
    fireEvent.click(remove);
    expect(state.quickActions.defaults.row.entries.map(entry => entry.id)).toEqual(['reply']);
  });

  it('reorders actions by dragging their grip, and with the arrow keys', () => {
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      constructor(type, options = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
        this.isPrimary = options.isPrimary ?? true;
      }
    });
    // jsdom has no layout: three stacked 60px rows, as a browser measures.
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const row = this.matches('li.account-settings-account');
      const index = row ? [...this.parentElement.children].indexOf(this) : 0;
      return { left: 0, right: 260, top: index * 60, bottom: row ? (index + 1) * 60 : 180, width: 260, height: row ? 60 : 180 };
    });
    try {
      state.quickActions = {
        defaults: { row: { mode: 'inline', entries: ['archive', 'reply', 'export'].map(action => ({ id: action, action })), favoriteId: 'reply', palette: 'neutral' } },
        overrides: {},
      };
      const view = render(<QuickActionsSettings />);
      const order = () => state.quickActions.defaults.row.entries.map(entry => entry.id);
      expect(screen.queryByRole('button', { name: /^Move (up|down)/ })).toBeNull();
      const grip = screen.getByRole('button', { name: 'Reorder Archive' });
      fireEvent.pointerDown(grip, { button: 0, clientX: 20, clientY: 30 });
      fireEvent.pointerMove(grip, { clientX: 20, clientY: 175 });
      expect(order()).toEqual(['archive', 'reply', 'export']);
      fireEvent.pointerUp(grip, { clientX: 20, clientY: 175 });
      expect(order()).toEqual(['reply', 'export', 'archive']);

      view.rerender(<QuickActionsSettings />);
      fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Export' }), { key: 'ArrowUp' });
      expect(order()).toEqual(['export', 'reply', 'archive']);
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('chooses how selection buttons show from a radio group', () => {
    state.quickActions = {
      defaults: { selection: { mode: 'inline', entries: [{ id: 'markRead', action: 'markRead' }], favoriteId: 'markRead', palette: 'neutral', selectionDisplay: 'icon-label', selectionActionLimit: 3 } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Selection bar' }));
    const display = screen.getByRole('radiogroup', { name: 'Selection buttons' });
    expect(within(display).getByRole('radio', { name: 'Icons and text' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(display).getByRole('radio', { name: 'Icons only' }));
    expect(state.quickActions.defaults.selection.selectionDisplay).toBe('icon-only');
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
