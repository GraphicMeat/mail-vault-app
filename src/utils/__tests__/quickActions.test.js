import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_ACTIONS,
  currentQuickActionScope,
  normalizeQuickActions,
  quickActionScopeKey,
  resolveQuickActionSelectionTarget,
  resolveQuickActions,
  isQuickActionStyleLinked,
  resetQuickActionScope,
  setQuickActionStyle,
  setQuickActionStyleLink,
} from '../quickActions';

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
