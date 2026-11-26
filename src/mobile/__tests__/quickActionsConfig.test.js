// @vitest-environment node
// The phone's quick action configuration (quickActions/config.js): desktop's shape with the
// phone's own start, the scope a list keys, the writers the shared editor calls, and the action
// sets of other mail apps on the phone's two surfaces.
import { describe, it, expect, vi } from 'vitest';
import { QUICK_ACTION_SURFACE_ACTIONS, resolveQuickActions } from '../../utils/quickActions.js';
import { QUICK_ACTION_PRESETS } from '../../utils/quickActionPresets.js';
import {
  PHONE_PRESETS, PHONE_ROW, PHONE_SELECTION, activePhonePreset, applyPhonePreset, phoneQuickActions, phoneScope,
  phoneSurface, quickActionsStore,
} from '../quickActions/config.js';
import { PREF_DEFAULTS } from '../prefs.js';

const actions = (config) => config.entries.map((e) => e.action);

describe('phone defaults', () => {
  it('start from desktop with the actions the phone can run, the wheel for the row', () => {
    const qa = phoneQuickActions(PREF_DEFAULTS);
    expect(qa.defaults.row.mode).toBe('radial');
    expect(actions(qa.defaults.row)).toEqual(['toggleRead', 'star', 'unstar', 'reply', 'replyAll', 'forward', 'move', 'spam', 'deleteServer']);
    expect(qa.defaults.selection.mode).toBe('inline');
    expect(actions(qa.defaults.selection)).toEqual(['markRead', 'markUnread', 'star', 'unstar', 'move', 'spam', 'deleteServer']);
    // Desktop's reader surface is untouched (the viewer's bar is its own pref).
    expect(qa.defaults.reader.entries.length).toBeGreaterThan(5);
  });

  it('are actions each surface offers on desktop', () => {
    for (const a of actions(PHONE_ROW)) expect(QUICK_ACTION_SURFACE_ACTIONS.row).toContain(a);
    for (const a of actions(PHONE_SELECTION)) expect(QUICK_ACTION_SURFACE_ACTIONS.selection).toContain(a);
  });

  it('keep a saved surface exactly, archive and all, and fill only the one not saved', () => {
    const row = { ...PHONE_ROW, entries: [{ id: 'archive', action: 'archive' }, { id: 'reply', action: 'reply' }] };
    const qa = phoneQuickActions({ quickActions: { defaults: { row } } });
    expect(actions(qa.defaults.row)).toEqual(['archive', 'reply']);
    expect(actions(qa.defaults.selection)).toEqual(actions(PHONE_SELECTION));
  });

  it('read a surface at a scope as desktop resolves it', () => {
    const scope = phoneScope({ accountId: 'a1', folder: 'Sent' });
    const override = { ...PHONE_ROW, entries: [{ id: 'reply', action: 'reply' }] };
    const saved = { quickActions: phoneQuickActions({}) };
    const write = vi.fn();
    quickActionsStore(saved, write).setSurface('row', scope, override);
    const next = write.mock.calls[0][0].quickActions;
    expect(actions(phoneSurface({ quickActions: next }, 'row', scope))).toEqual(['reply']);
    expect(actions(phoneSurface({ quickActions: next }, 'row', null))).toEqual(actions(PHONE_ROW));
  });
});

describe('scope', () => {
  it('keys All Inboxes, a folder and a search as desktop keys them', () => {
    expect(phoneScope({ allInboxes: true, accountId: 'a1' })).toMatchObject({ kind: 'unified', accountId: null, mailbox: 'INBOX' });
    expect(phoneScope({ accountId: 'a1', folder: 'Sent' })).toMatchObject({ kind: 'mailbox', accountId: 'a1', mailbox: 'Sent' });
    expect(phoneScope({ accountId: 'a1', folder: 'INBOX', searching: true }).kind).toBe('search');
  });
});

describe('the editor writers', () => {
  it('write the whole value through save, with desktop reducers', () => {
    const write = vi.fn();
    const store = quickActionsStore(PREF_DEFAULTS, write);
    const row = { ...PHONE_ROW, entries: [{ id: 'reply', action: 'reply' }] };
    store.setSurface('row', null, row);
    expect(Object.keys(write.mock.calls[0][0])).toEqual(['quickActions']);
    expect(actions(write.mock.calls[0][0].quickActions.defaults.row)).toEqual(['reply']);
    store.setStyle('row', null, { palette: 'custom' });
    expect(write.mock.calls[1][0].quickActions.defaults.row.palette).toBe('custom');
    const scope = phoneScope({ accountId: 'a1', folder: 'Sent' });
    store.setSurface('row', scope, row);
    const scoped = write.mock.calls[2][0].quickActions;
    expect(Object.keys(scoped.overrides)).toHaveLength(1);
    quickActionsStore({ quickActions: scoped }, write).resetScope(scope, 'row');
    expect(write.mock.calls[3][0].quickActions.overrides).toEqual({});
  });
});

describe('presets', () => {
  it('are desktop\'s, MailVault being the phone start', () => {
    expect(PHONE_PRESETS.map((p) => p.id)).toEqual(QUICK_ACTION_PRESETS.map((p) => p.id));
    expect(activePhonePreset({})).toBe('mailvault');
    expect(activePhonePreset({ defaults: { row: { ...PHONE_ROW, entries: [{ id: 'reply', action: 'reply' }] } } })).toBe(null);
  });

  it('apply to All views, and to one view as an override', () => {
    const gmail = applyPhonePreset({}, null, 'gmail');
    expect(activePhonePreset(gmail)).toBe('gmail');
    expect(actions(gmail.defaults.row)).toEqual(actions(QUICK_ACTION_PRESETS.find((p) => p.id === 'gmail').surfaces.row));
    const scope = phoneScope({ accountId: 'a1', folder: 'Sent' });
    const viewOnly = applyPhonePreset({}, scope, 'outlook');
    expect(activePhonePreset(viewOnly, scope)).toBe('outlook');
    expect(activePhonePreset(viewOnly, null)).toBe('mailvault');
    expect(resolveQuickActions(viewOnly, 'row', scope).inherited).toBe(false);
    expect(applyPhonePreset({}, null, 'nope').defaults.row.mode).toBe('radial');
  });
});
