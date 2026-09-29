// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QuickActionsSettings } from '../QuickActionsSettings';
import { quickActionScopeKey } from '../../../utils/quickActions';
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
    // The row between its two neighbours shows the favorite; the others wait for a hover.
    expect(within(preview).getAllByRole('button', { name: 'Archive' })).toHaveLength(1);
    expect(within(preview).getAllByTestId('email-row')).toHaveLength(3);
    expect(sampleFrame().dataset.sampleSurface).toBe('row');
    expect(preview.querySelector('.email-action-bar')).toBeNull();
    expect(screen.getByText('Shown on a message row when you point at it.', { exact: false })).toBeTruthy();
  });

  it('runs the reader sample\'s actions through harmless callbacks without invoking mail operations', () => {
    state.quickActions = {
      defaults: { reader: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview.querySelector('.email-action-bar')).not.toBeNull();
    fireEvent.click(within(preview).getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Preview action selected')).toBeTruthy();
    expect(mailOperations()).toEqual([]);
  });

  it('keeps saved reader actions inert on the sample message', async () => {
    state.quickActions = {
      defaults: { reader: { mode: 'inline', entries: [{ id: 'move:acct-1:Archive', action: 'move', params: { mailbox: 'Archive', accountId: 'acct-1' } }], favoriteId: null, palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Email reader' }));
    const preview = screen.getByRole('region', { name: 'Preview' });
    // Enabled once the samples are acct-1's (its cache is empty: the cast, on acct-1).
    const move = await waitFor(() => {
      const button = within(preview).getByRole('button', { name: 'Move: Archive' });
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(move);
    expect(screen.getByText('Preview action selected')).toBeTruthy();
    expect(mailState.moveEmails).not.toHaveBeenCalled();
  });

  it('draws the latest cached messages of an account, and a click on anything but a quick action reaches nothing', async () => {
    getEmailHeadersPartial.mockImplementation(async (accountId, mailbox, limit) => (accountId === 'acct-1' && mailbox === 'INBOX' && limit === 5
      ? { emails: [cached(7, 'Quarterly numbers'), cached(8, 'Studio lease'), cached(9, 'Train times', [])] } : null));
    const removeTag = vi.fn();
    // The tag chip's remove button calls the tag store itself: only the shield stops it.
    useTagStore.setState({ tags: [{ id: 't1', name: 'Follow up' }], byRow: { 'acct-1|INBOX|8': ['t1'] }, removeTag });
    state.quickActions = {
      defaults: { row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }, { id: 'star', action: 'star' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    await waitFor(() => expect(sampleFrame().textContent).toContain('Studio lease'));
    expect(getEmailHeadersPartial).toHaveBeenCalledWith('acct-1', 'INBOX', 5);
    expect(sampleFrame().dataset.sampleAccount).toBe('acct-1');
    const frame = within(sampleFrame());
    const rows = frame.getAllByTestId('email-row');
    expect(rows.map(row => row.dataset.uid)).toEqual(['7', '8', '9']);

    fireEvent.click(frame.getByRole('button', { name: 'Remove label Follow up' }));
    fireEvent.click(within(rows[1]).getByTestId('star-toggle'));
    fireEvent.click(within(rows[2]).getByRole('checkbox'));
    fireEvent.click(rows[0]);
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Archive' }));
    fireEvent.click(rows[1].querySelector('.quick-actions [data-quick-action="star"]'));
    expect(removeTag).not.toHaveBeenCalled();
    expect(within(rows[2]).getByRole('checkbox').checked).toBe(false);
    expect(mailOperations()).toEqual([]);
    // The quick actions themselves were reached, and said so.
    expect(screen.getByText('Preview action selected')).toBeTruthy();
  });

  it('draws the selection bar under three ticked sample rows, inert', () => {
    state.quickActions = {
      defaults: { selection: { mode: 'inline', entries: [{ id: 'markRead', action: 'markRead' }, { id: 'archive', action: 'archive' }], favoriteId: 'archive', palette: 'neutral', selectionDisplay: 'icon-label', selectionActionLimit: 3 } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Selection bar' }));
    const frame = within(sampleFrame());
    expect(frame.getAllByRole('checkbox').map(box => box.checked)).toEqual([true, true, true]);
    expect(frame.getByText('3 selected')).toBeTruthy();
    fireEvent.click(frame.getByRole('button', { name: 'Archive selected' }));
    expect(mailOperations()).toEqual([]);
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

  it('uses keyboard-operable radio cards and colors editor rows only for action palettes', () => {
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

  it('draws every choice as a card of its own option, the chosen one marked, the label its only name', () => {
    state.quickActions = {
      defaults: { row: { mode: 'radial', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    const layout = screen.getByRole('radiogroup', { name: 'Layout' });
    const radios = within(layout).getAllByRole('radio');
    expect(radios.map(radio => radio.textContent.trim())).toEqual(['Inline', 'Menu', 'Radial', 'Favorite plus menu']);
    const cards = radios.map(radio => radio.closest('.choice-card'));
    expect(cards.map(card => card.hasAttribute('data-selected'))).toEqual([false, false, true, false]);
    // Each card draws the row in its own layout, beside its radio, never in it.
    for (const [index, card] of cards.entries()) {
      const sample = card.querySelector('.quick-actions-card-sample');
      expect(radios[index].contains(sample)).toBe(false);
      expect(sample.getAttribute('aria-hidden')).toBe('true');
      expect(sample.hasAttribute('inert')).toBe(true);
      expect(sample.hasAttribute('data-quick-actions-preview')).toBe(true);
    }
    expect(cards[0].querySelector('.quick-actions[data-layout="inline"]')).not.toBeNull();
    expect(cards[1].querySelector('.quick-actions[data-layout="menu"]')).not.toBeNull();
    expect(cards[2].querySelector('.quick-actions-radial-preview')).not.toBeNull();
    expect(cards[3].querySelector('.quick-actions[data-layout="favorite-menu"]')).not.toBeNull();
    for (const name of ['Color style', 'Wheel layout', 'Page actions in the wheel']) {
      const group = screen.getByRole('radiogroup', { name });
      for (const radio of within(group).getAllByRole('radio')) {
        expect(radio.querySelector('button')).toBeNull();
        expect(radio.closest('.choice-card').querySelector('.quick-actions-card-sample')).not.toBeNull();
      }
    }
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

  it('keeps the favorite picker in a row of its own, apart from the option cards', () => {
    state.quickActions = {
      defaults: { row: { mode: 'favorite-menu', entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }], favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    render(<QuickActionsSettings />);
    const favorite = document.querySelector('select[aria-label="Favorite action"]');
    expect(favorite.closest('.quick-actions-favorite-row')).toBeTruthy();
    expect(favorite.closest('.quick-actions-option-cards')).toBeNull();
    expect(favorite.closest('.quick-actions-favorite-row').querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('never puts the favorite into the wheel, before or after choosing categories', () => {
    // Move shares Organize with the favorite: a lone Unarchive is hidden on a
    // message that is not archived, which would leave Archive a wedge of its own.
    const entries = ['archive', 'move', 'reply', 'forward'].map(action => ({ id: action, action }));
    state.quickActions = {
      defaults: { row: { mode: 'radial', radialLayout: 'flat', entries, favoriteId: 'archive', palette: 'neutral' } },
      overrides: {},
    };
    const view = render(<QuickActionsSettings />);
    const controls = () => [...document.querySelectorAll('.quick-actions-option-cards > .quick-actions-choice-field')]
      .map(field => field.firstElementChild.textContent);
    const before = controls();
    expect(document.querySelector('select[aria-label="Favorite action"]')).toBeNull();

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Wheel layout' })).getByRole('radio', { name: 'Categories' }));
    view.rerender(<QuickActionsSettings />);
    // Choosing categories adds no favorite field in front of the wheel layout.
    expect(document.querySelector('select[aria-label="Favorite action"]')).toBeNull();
    expect(controls().slice(0, before.indexOf('Wheel layout') + 1)).toEqual(before.slice(0, before.indexOf('Wheel layout') + 1));
    // The live sample's wheel, not a card's.
    const wheel = sampleFrame().querySelector('.quick-actions-radial-preview');
    expect(wheel.dataset.radialLayout).toBe('categories');
    // Archive stays in Organize with Move, not a wedge of its own.
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
  const presetPressed = () => within(screen.getByRole('group', { name: 'Action sets' })).getAllByRole('button')
    .filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.textContent.trim());
  const surfaces = scoped => ['row', 'selection', 'reader'].map(name => scoped[name]);
  const presetSurfaces = id => {
    const { defaults } = applyQuickActionPreset({}, null, id);
    return surfaces(defaults);
  };

  it('offers the four action sets, each drawn as its own row, MailVault marked on the defaults', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    render(<QuickActionsSettings />);
    const group = screen.getByRole('group', { name: 'Action sets' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(button => button.textContent.trim())).toEqual(['MailVault', 'Gmail', 'Outlook', 'Thunderbird']);
    expect(within(group).queryAllByRole('radio')).toHaveLength(0);
    expect(presetPressed()).toEqual(['MailVault']);
    expect(screen.queryByTestId('quick-actions-preset-custom')).toBeNull();
    for (const [index, preset] of QUICK_ACTION_PRESETS.entries()) {
      const actions = buttons[index].closest('.choice-card').querySelector('.quick-actions-card-sample [data-surface="row"], .quick-actions-card-sample .quick-actions-radial-preview');
      expect(actions?.dataset.layout ?? 'radial').toBe(preset.surfaces.row.mode);
    }
  });

  it('applies an action set to all three surfaces of All views, marks it, and a later edit unmarks it', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    const view = render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Gmail' }));
    expect(state.applyQuickActionPreset).toHaveBeenCalledWith('gmail', null);
    expect(surfaces(state.quickActions.defaults)).toEqual(presetSurfaces('gmail'));
    view.rerender(<QuickActionsSettings />);
    expect(presetPressed()).toEqual(['Gmail']);
    expect(checked('Inline')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Menu' }));
    view.rerender(<QuickActionsSettings />);
    expect(presetPressed()).toEqual([]);
    expect(screen.getByTestId('quick-actions-preset-custom').textContent).toBe('Custom');
  });

  it('applies an action set to the current view only, with Scope on Current view', () => {
    state.quickActions = { defaults: {}, overrides: {} };
    const view = render(<QuickActionsSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Current view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outlook' }));
    const [presetId, scope] = state.applyQuickActionPreset.mock.calls.at(-1);
    expect(presetId).toBe('outlook');
    expect(quickActionScopeKey(scope)).toBe(inboxKey);
    expect(surfaces(state.quickActions.overrides[inboxKey])).toEqual(presetSurfaces('outlook'));
    expect(state.quickActions.defaults.row.mode).toBe('radial');
    view.rerender(<QuickActionsSettings />);
    expect(presetPressed()).toEqual(['Outlook']);
    fireEvent.click(screen.getByRole('radio', { name: 'All views' }));
    view.rerender(<QuickActionsSettings />);
    expect(presetPressed()).toEqual(['MailVault']);
  });

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
