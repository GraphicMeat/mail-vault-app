import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_ACTIONS,
  QUICK_ACTION_TYPES,
  QUICK_ACTION_ORDER,
  RADIAL_CATEGORIES,
  currentQuickActionScope,
  groupRadialEntries,
  insertQuickActionEntry,
  normalizeQuickActions,
  quickActionScopeKey,
  resolveQuickActionSelectionTarget,
  resolveQuickActions,
  isQuickActionStyleLinked,
  resetQuickActionScope,
  setQuickActionStyle,
  setQuickActionStyleLink,
  QUICK_ACTION_SURFACES,
  QUICK_ACTION_SURFACE_ACTIONS,
} from '../quickActions';
import { QUICK_ACTION_PRESETS, activeQuickActionPreset, applyQuickActionPreset } from '../quickActionPresets';

describe('quick action settings', () => {
  it('recovers malformed defaults and removes invalid entries and colors', () => {
    const result = normalizeQuickActions({
      defaults: {
        row: {
          mode: 'broken',
          entries: [
            { id: 'archive', action: 'archive' },
            { id: 'bad', action: 'runShell' },
            { id: 'tag:ok', action: 'tag', params: { labelId: 'ok' }, color: '#abc' },
            { id: 'tag:bad', action: 'tag', params: { labelId: 'bad' }, color: 'url(javascript:bad)' },
          ],
          favoriteId: 'delete',
          palette: 'custom',
        },
      },
    });

    expect(result.defaults.row.mode).toBe(DEFAULT_QUICK_ACTIONS.defaults.row.mode);
    expect(result.defaults.row.entries.map(entry => entry.id)).toEqual(['archive', 'tag:ok', 'tag:bad']);
    expect(result.defaults.row.entries[1].color).toBe('#aabbcc');
    expect(result.defaults.row.entries[2].color).toBeUndefined();
    expect(result.defaults.row.favoriteId).not.toBe('delete');
    expect(result.defaults.selection.entries.length).toBeGreaterThan(0);
  });

  it('preserves intentionally empty entry lists and normalizes stable parameterized ids', () => {
    const result = normalizeQuickActions({ defaults: { row: { entries: [] } } });
    expect(result.defaults.row.entries).toEqual([]);

    const tags = normalizeQuickActions({ defaults: { row: { entries: [
      { id: 'tag:label-a', action: 'tag', params: { labelId: 'label-a' } },
      { id: 'tag:label-b', action: 'tag', params: { labelId: 'label-b' } },
    ] } } });
    expect(tags.defaults.row.entries.map(entry => entry.id)).toEqual(['tag:label-a', 'tag:label-b']);
  });

  it('normalizes radial pagination and bounded selection display settings without changing other surfaces', () => {
    const result = normalizeQuickActions({ defaults: {
      selection: { radialPagination: 'yes', selectionDisplay: 'text-only', selectionActionLimit: 99 },
      row: { radialPagination: true },
    } });
    expect(result.defaults.row.radialPagination).toBe(true);
    expect(result.defaults.selection.radialPagination).toBe(false);
    expect(result.defaults.selection.selectionDisplay).toBe('icon-label');
    expect(result.defaults.selection.selectionActionLimit).toBe(6);
    expect(result.defaults.reader.selectionActionLimit).toBeUndefined();
  });

  it('inherits global configuration until a scoped override is set or reset', () => {
    const scope = { kind: 'mailbox', accountId: 'a:1', mailbox: 'INBOX/Work' };
    const key = quickActionScopeKey(scope);
    const base = normalizeQuickActions({
      defaults: { row: { entries: [{ id: 'archive', action: 'archive' }] } },
      overrides: {},
    });
    expect(key).toBe(JSON.stringify(['mailbox', 'a:1', 'INBOX/Work', 'list', 'all', null]));
    expect(resolveQuickActions(base, 'row', scope).inherited).toBe(true);
    expect(resolveQuickActions(base, 'row', scope).config.entries[0].id).toBe('archive');

    const overridden = normalizeQuickActions({
      ...base,
      overrides: { [key]: { row: { mode: 'menu', entries: [] } } },
    });
    expect(resolveQuickActions(overridden, 'row', scope).inherited).toBe(false);
    expect(resolveQuickActions(overridden, 'row', scope).config.entries).toEqual([]);
    expect(resolveQuickActions({ ...overridden, overrides: {} }, 'row', scope).inherited).toBe(true);
  });

  it('links only style fields across surfaces while preserving entries and scoped isolation', () => {
    const scope = { kind: 'mailbox', accountId: 'a', mailbox: 'INBOX' };
    const initial = normalizeQuickActions({
      defaults: {
        row: { mode: 'inline', entries: [{ id: 'archive', action: 'archive' }], palette: 'neutral' },
        selection: { mode: 'menu', entries: [{ id: 'export', action: 'export' }], palette: 'custom' },
      },
    });
    const linked = setQuickActionStyleLink(initial, null, true, 'row');
    const updated = setQuickActionStyle(linked, 'reader', null, { mode: 'radial', palette: 'semantic', radialPagination: true });
    expect(updated.defaults.row).toMatchObject({ mode: 'radial', palette: 'semantic', radialPagination: true });
    expect(updated.defaults.selection).toMatchObject({ mode: 'radial', palette: 'semantic', radialPagination: true });
    expect(updated.defaults.selection.entries).toEqual([{ id: 'export', action: 'export' }]);

    const scoped = setQuickActionStyleLink(updated, scope, true, 'selection');
    const scopedUpdated = setQuickActionStyle(scoped, 'row', scope, { mode: 'menu' });
    expect(resolveQuickActions(scopedUpdated, 'row', scope).config.mode).toBe('menu');
    expect(resolveQuickActions(scopedUpdated, 'reader', scope).config.mode).toBe('menu');
    expect(scopedUpdated.defaults.row.mode).toBe('radial');
    expect(isQuickActionStyleLinked(scopedUpdated, scope)).toBe(true);
    const unlinked = setQuickActionStyleLink(scopedUpdated, scope, false, 'row');
    const independentlyUpdated = setQuickActionStyle(unlinked, 'reader', scope, { mode: 'inline' });
    expect(resolveQuickActions(independentlyUpdated, 'row', scope).config.mode).toBe('menu');
    expect(resolveQuickActions(independentlyUpdated, 'reader', scope).config.mode).toBe('inline');
    const relinked = setQuickActionStyleLink(independentlyUpdated, scope, true, 'row');
    const reset = resetQuickActionScope(relinked, scope, 'row');
    expect(isQuickActionStyleLinked(reset, scope)).toBe(false);
  });

  it('keeps same mailbox names distinct across accounts and view kinds', () => {
    expect(quickActionScopeKey({ kind: 'mailbox', accountId: 'a', mailbox: 'INBOX' }))
      .not.toBe(quickActionScopeKey({ kind: 'mailbox', accountId: 'b', mailbox: 'INBOX' }));
    expect(quickActionScopeKey({ kind: 'archive', accountId: 'a' }))
      .not.toBe(quickActionScopeKey({ kind: 'explorer', accountId: 'a', mailbox: 'INBOX' }));
  });

  it('separates unified folders, ignores stale active account, and distinguishes mailbox subtrees', () => {
    const inboxScope = currentQuickActionScope({ activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'INBOX', activeAccountId: 'a' });
    const sentScope = currentQuickActionScope({ activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Sent', activeAccountId: 'a' });
    const sameSentScope = currentQuickActionScope({ activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Sent', activeAccountId: 'b' });
    expect(inboxScope.kind).toBe('unified');
    expect(inboxScope.accountId).toBeNull();
    expect(quickActionScopeKey(sentScope)).not.toBe(quickActionScopeKey(inboxScope));
    expect(quickActionScopeKey(sameSentScope)).toBe(quickActionScopeKey(sentScope));

    const branch = currentQuickActionScope({ activeMailbox: 'Kunden', activeAccountId: 'a', mailboxScope: { root: 'Kunden', paths: ['Kunden'] } });
    expect(branch.kind).toBe('subtree');
    expect(quickActionScopeKey(branch)).not.toBe(quickActionScopeKey({ kind: 'mailbox', accountId: 'a', mailbox: 'Kunden' }));
  });

  it('refuses an account-scoped selection target when any selected key is not loaded', () => {
    const state = { activeMailbox: 'UNIFIED', activeAccountId: 'a' };
    const visibleA = { uid: 1, _accountId: 'a', _mailbox: 'INBOX' };
    expect(resolveQuickActionSelectionTarget(['a:INBOX:1', 'b:INBOX:2'], [visibleA], state)).toBeNull();
  });
});

describe('tag entries after the move to daemon-owned tags', () => {
  it('normalizes a tag entry onto the tag id', () => {
    const { entries } = normalizeQuickActions({ defaults: { row: { entries: [{ action: 'tag', params: { tagId: 't1' } }] } } }).defaults.row;
    const entry = entries.find(item => item.action === 'tag');
    expect(entry.params).toEqual({ tagId: 't1' });
    expect(entry.id).toBe('tag:t1');
  });

  it('keeps a quick action configured before the move working', () => {
    const { entries } = normalizeQuickActions({ defaults: { row: { entries: [{ action: 'tag', params: { labelId: 'L2' } }] } } }).defaults.row;
    const entry = entries.find(item => item.action === 'tag');
    expect(entry.params).toEqual({ tagId: 'L2' });
  });

  it('drops a tag entry that names nothing', () => {
    const { entries } = normalizeQuickActions({ defaults: { row: { entries: [{ action: 'tag', params: {} }] } } }).defaults.row;
    expect(entries.some(entry => entry.action === 'tag')).toBe(false);
  });
});

describe('snooze quick action', () => {
  it('is a saved action that survives normalization', () => {
    const { entries } = normalizeQuickActions({ defaults: { row: { entries: [{ action: 'snooze' }] } } }).defaults.row;
    expect(entries).toEqual([{ id: 'snooze', action: 'snooze' }]);
  });

  // Appended, never inserted: the selection bar shows its first three
  // entries inline, and the reader's grouped layout keys off its exact list.
  // Unsubscribe (the v10 addition) follows it in the row list.
  it('comes last in the row and selection defaults and is not added to the reader', () => {
    expect(DEFAULT_QUICK_ACTIONS.defaults.row.entries.slice(-2).map(entry => entry.action)).toEqual(['snooze', 'unsubscribe']);
    expect(DEFAULT_QUICK_ACTIONS.defaults.selection.entries.at(-1).action).toBe('snooze');
    expect(DEFAULT_QUICK_ACTIONS.defaults.selection.entries.slice(0, 3).map(entry => entry.action))
      .toEqual(['markRead', 'markUnread', 'archive']);
    expect(DEFAULT_QUICK_ACTIONS.defaults.reader.entries.some(entry => entry.action === 'snooze')).toBe(false);
  });
});

const entries = (...actions) => actions.map(action => ({ id: action, action }));
const shape = groups => groups.map(group => group.type === 'category'
  ? [group.id, group.entries.map(item => item.id)]
  : group.entry.id);

describe('radial categories', () => {
  it('keeps a valid radial layout per surface and defaults anything else to flat', () => {
    const result = normalizeQuickActions({ defaults: {
      row: { mode: 'radial', radialLayout: 'categories' },
      selection: { radialLayout: 'rings' },
    } });
    expect(result.defaults.row.radialLayout).toBe('categories');
    expect(result.defaults.selection.radialLayout).toBe('flat');
    expect(result.defaults.reader.radialLayout).toBe('flat');
    for (const surface of ['row', 'selection', 'reader']) {
      expect(DEFAULT_QUICK_ACTIONS.defaults[surface].radialLayout).toBe('flat');
    }
  });

  it('carries the radial layout across linked surfaces like the other style fields', () => {
    const linked = setQuickActionStyleLink(normalizeQuickActions({}), null, true, 'row');
    const updated = setQuickActionStyle(linked, 'row', null, { radialLayout: 'categories' });
    expect(updated.defaults.selection.radialLayout).toBe('categories');
    expect(updated.defaults.reader.radialLayout).toBe('categories');
    const separate = setQuickActionStyle(normalizeQuickActions({}), 'reader', null, { radialLayout: 'categories' });
    expect(separate.defaults.reader.radialLayout).toBe('categories');
    expect(separate.defaults.row.radialLayout).toBe('flat');
  });

  it('files every quick action type in exactly one category', () => {
    const filed = Object.values(RADIAL_CATEGORIES).flat();
    expect([...filed].sort()).toEqual([...QUICK_ACTION_TYPES].sort());
    expect(Object.keys(RADIAL_CATEGORIES)).toEqual(['send', 'mark', 'organize', 'delete', 'more']);
  });

  it('sorts entries into categories in category order, keeping the configured order inside each', () => {
    const groups = groupRadialEntries(entries('forward', 'spam', 'reply', 'star', 'delete', 'markRead', 'move', 'snooze'));
    expect(shape(groups)).toEqual([
      ['send', ['forward', 'reply']],
      ['mark', ['star', 'markRead']],
      ['organize', ['move', 'snooze']],
      ['delete', ['spam', 'delete']],
    ]);
  });

  it('never pulls the favorite into the wheel: it stays in its own category', () => {
    const groups = groupRadialEntries(entries('reply', 'forward', 'archive', 'move', 'snooze'), {}, 'archive');
    expect(shape(groups)).toEqual([['send', ['reply', 'forward']], ['organize', ['archive', 'move', 'snooze']]]);
  });

  it('turns a one-action category into a direct wedge in that category slot and hides empty ones', () => {
    const groups = groupRadialEntries(entries('export', 'reply', 'forward', 'deleteServer'));
    expect(shape(groups)).toEqual([['send', ['reply', 'forward']], 'deleteServer', 'export']);
  });

  it('drops the actions the target state hides, then collapses or hides what is left', () => {
    const visibility = { markRead: false, markUnread: true, star: false, unstar: false, archive: false };
    const groups = groupRadialEntries(entries('archive', 'markRead', 'markUnread', 'star', 'unstar', 'reply', 'forward'), visibility);
    // Organize held only the hidden archive; mark keeps only markUnread.
    expect(shape(groups)).toEqual([['send', ['reply', 'forward']], 'markUnread']);
  });

  it('keeps one canonical order of every action, category by category', () => {
    expect(QUICK_ACTION_ORDER).toEqual(Object.values(RADIAL_CATEGORIES).flat());
    expect(new Set(QUICK_ACTION_ORDER).size).toBe(QUICK_ACTION_TYPES.length);
    expect([...QUICK_ACTION_ORDER].sort()).toEqual([...QUICK_ACTION_TYPES].sort());
  });

  it('inserts a new action in its category slot, not at the bottom', () => {
    const ids = list => list.map(item => item.id);
    const add = (list, action) => ids(insertQuickActionEntry(entries(...list), { id: action, action }));
    // Among its own category, in the default order.
    expect(add(['reply', 'forward', 'archive', 'export'], 'replyAll')).toEqual(['reply', 'replyAll', 'forward', 'archive', 'export']);
    expect(add(['reply', 'archive', 'move', 'export'], 'snooze')).toEqual(['reply', 'archive', 'move', 'snooze', 'export']);
    expect(add(['reply', 'toggleRead', 'star', 'export'], 'markRead')).toEqual(['reply', 'toggleRead', 'markRead', 'star', 'export']);
    // No action of its category yet: before the first later category.
    expect(add(['reply', 'archive', 'export'], 'star')).toEqual(['reply', 'star', 'archive', 'export']);
    expect(add(['archive', 'export'], 'reply')).toEqual(['reply', 'archive', 'export']);
    expect(add(['reply', 'archive'], 'export')).toEqual(['reply', 'archive', 'export']);
    // The person's own order of the rest is kept.
    expect(add(['export', 'archive', 'reply'], 'forward')).toEqual(['export', 'archive', 'reply', 'forward']);
    expect(add([], 'archive')).toEqual(['archive']);
  });

  it('keeps several entries of one action (folders, tags) inside the same category', () => {
    const list = [
      { id: 'move:Work', action: 'move', params: { mailbox: 'Work' } },
      { id: 'tag:t1', action: 'tag', params: { tagId: 't1' } },
      { id: 'move:Home', action: 'move', params: { mailbox: 'Home' } },
    ];
    expect(shape(groupRadialEntries(list))).toEqual([['organize', ['move:Work', 'tag:t1', 'move:Home']]]);
  });
});

describe('quick action presets', () => {
  const SCOPE = { kind: 'mailbox', accountId: 'a', mailbox: 'INBOX' };
  const OTHER = { kind: 'mailbox', accountId: 'b', mailbox: 'INBOX' };
  const preset = id => QUICK_ACTION_PRESETS.find(item => item.id === id);

  it('offers MailVault first, exactly as its defaults, then the other apps', () => {
    expect(QUICK_ACTION_PRESETS[0].id).toBe('mailvault');
    expect(preset('mailvault').surfaces).toEqual(DEFAULT_QUICK_ACTIONS.defaults);
    expect(QUICK_ACTION_PRESETS.map(item => item.id)).toEqual(expect.arrayContaining(['gmail', 'outlook', 'thunderbird']));
    expect(new Set(QUICK_ACTION_PRESETS.map(item => item.id)).size).toBe(QUICK_ACTION_PRESETS.length);
    for (const item of QUICK_ACTION_PRESETS) expect(item.labelKey).toBe(`quickActions.preset.${item.id}`);
  });

  // Against the raw preset: normalizing drops an entry it cannot use (a tag
  // with no tag) and swaps a favorite it cannot find, so comparing two
  // normalized copies would pass over exactly that.
  it.each(QUICK_ACTION_PRESETS.map(item => [item.id, item]))('%s normalizes to itself', (_id, item) => {
    expect(normalizeQuickActions({ defaults: item.surfaces }).defaults).toEqual(item.surfaces);
  });

  it.each(QUICK_ACTION_PRESETS.map(item => [item.id, item]))('%s uses only actions each surface offers', (_id, item) => {
    expect(Object.keys(item.surfaces)).toEqual(QUICK_ACTION_SURFACES);
    for (const surface of QUICK_ACTION_SURFACES) {
      const { entries, favoriteId, selectionActionLimit } = item.surfaces[surface];
      expect(entries.length, surface).toBeGreaterThan(0);
      expect(entries.filter(entry => !QUICK_ACTION_SURFACE_ACTIONS[surface].includes(entry.action)), surface).toEqual([]);
      expect(entries.map(entry => entry.id)).toContain(favoriteId);
      if (surface === 'selection') expect(selectionActionLimit).toBeGreaterThanOrEqual(1);
      if (surface === 'selection') expect(selectionActionLimit).toBeLessThanOrEqual(6);
    }
  });

  it('keeps the per-surface action lists within the known actions', () => {
    for (const surface of QUICK_ACTION_SURFACES) {
      expect(QUICK_ACTION_SURFACE_ACTIONS[surface].filter(action => !QUICK_ACTION_TYPES.includes(action))).toEqual([]);
    }
    expect(QUICK_ACTION_SURFACE_ACTIONS.row).not.toContain('theme');
    expect(QUICK_ACTION_SURFACE_ACTIONS.reader).not.toContain('newMessage');
    expect(QUICK_ACTION_SURFACE_ACTIONS.selection).not.toContain('reply');
  });

  it('applied to All views, replaces the defaults of every surface and unlinks their style', () => {
    const before = setQuickActionStyleLink(
      setQuickActionStyle(normalizeQuickActions({}), 'row', SCOPE, { mode: 'menu' }), null, true, 'row');
    expect(before.styleLinks.global).toBe(true);
    const after = applyQuickActionPreset(before, null, 'gmail');
    expect(after.defaults).toEqual(preset('gmail').surfaces);
    expect(after.overrides).toEqual(before.overrides);
    expect(after.styleLinks.global).toBe(false);
  });

  it('applied to one view, writes only that view and unlinks only its style', () => {
    let before = setQuickActionStyleLink(normalizeQuickActions({}), SCOPE, true, 'row');
    before = setQuickActionStyle(before, 'row', OTHER, { mode: 'menu' });
    const after = applyQuickActionPreset(before, SCOPE, 'thunderbird');
    const key = quickActionScopeKey(SCOPE);
    expect(after.overrides[key]).toEqual(preset('thunderbird').surfaces);
    expect(after.overrides[quickActionScopeKey(OTHER)]).toEqual(before.overrides[quickActionScopeKey(OTHER)]);
    expect(after.defaults).toEqual(before.defaults);
    expect(after.styleLinks.overrides[key]).toBe(false);
    expect(after.styleLinks.global).toBe(before.styleLinks.global);
  });

  it('leaves the settings alone for a preset it does not know', () => {
    const before = setQuickActionStyle(normalizeQuickActions({}), 'row', null, { mode: 'menu' });
    expect(applyQuickActionPreset(before, null, 'nope')).toEqual(before);
  });

  it('gives the same result as the onboarding "Recommended" choice', () => {
    // Onboarding's applyRecommended, over the same util calls its setters make.
    let styled = setQuickActionStyleLink(normalizeQuickActions({}), null, true, 'row');
    styled = setQuickActionStyle(styled, 'row', null, { mode: 'inline', palette: 'neutral', radialLayout: 'categories' });
    let recommended = setQuickActionStyleLink(styled, null, false, 'row');
    for (const surface of QUICK_ACTION_SURFACES) {
      const { mode, palette, radialPagination, radialLayout } = DEFAULT_QUICK_ACTIONS.defaults[surface];
      recommended = setQuickActionStyle(recommended, surface, null, { mode, palette, radialPagination, radialLayout });
    }
    expect(applyQuickActionPreset(styled, null, 'mailvault')).toEqual(recommended);
  });

  it('names the preset a scope shows, and none once anything in it is changed', () => {
    const fresh = normalizeQuickActions({});
    expect(activeQuickActionPreset(fresh)).toBe('mailvault');
    expect(activeQuickActionPreset(fresh, SCOPE)).toBe('mailvault');

    const gmail = applyQuickActionPreset(fresh, null, 'gmail');
    expect(activeQuickActionPreset(gmail)).toBe('gmail');
    // A view with no override of its own shows the All-views set.
    expect(activeQuickActionPreset(gmail, SCOPE)).toBe('gmail');

    const scoped = applyQuickActionPreset(gmail, SCOPE, 'outlook');
    expect(activeQuickActionPreset(scoped, SCOPE)).toBe('outlook');
    expect(activeQuickActionPreset(scoped)).toBe('gmail');

    expect(activeQuickActionPreset(setQuickActionStyle(scoped, 'reader', SCOPE, { palette: 'semantic' }), SCOPE)).toBeNull();
    const fewer = { ...preset('gmail').surfaces.row, entries: preset('gmail').surfaces.row.entries.slice(1) };
    expect(activeQuickActionPreset({ ...gmail, defaults: { ...gmail.defaults, row: fewer } })).toBeNull();
  });

  it('compares a view that overrides one surface against its own set of three', () => {
    const gmail = applyQuickActionPreset(normalizeQuickActions({}), null, 'gmail');
    // The row alone is overridden, with the preset's own row: still Gmail.
    const rowOnly = normalizeQuickActions({
      ...gmail,
      overrides: { [quickActionScopeKey(SCOPE)]: { row: preset('gmail').surfaces.row } },
    });
    expect(activeQuickActionPreset(rowOnly, SCOPE)).toBe('gmail');
  });
});
