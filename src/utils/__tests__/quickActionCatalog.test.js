import { describe, expect, it, vi } from 'vitest';
import { Archive, ArchiveRestore, Mail, MailOpen } from 'lucide-react';

vi.mock('../../i18n/index.js', async importOriginal => ({
  ...await importOriginal(),
  t: (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key),
}));

const { describeQuickAction, quickActionTone } = await import('../quickActionCatalog');
const { FilledStar } = await import('../quickActionIcons');

const facts = (overrides = {}) => ({
  present: true, has: { markRead: true, markUnread: false, star: true, unstar: false, archive: true, unarchive: false },
  resolved: true, fullyResolved: true, accountId: 'acct-a', localFolder: false, localOnly: false, readOnly: false,
  serverBacked: true, serverActions: true, junkPath: null, snooze: true, unsubscribe: null, purge: null,
  sender: '', senderName: 'Ann', sent: false, singleRecipient: false, dark: false,
  explicit: { star: false, archive: false }, can: {}, busy: {},
  ...overrides,
});
const ctx = { tags: [{ id: 'tag-1', name: 'Work' }], templates: [], folders: () => [] };
const describeOn = (surface, action, overrides, params) => describeQuickAction(surface, { id: action, action, params }, facts(overrides), ctx);

describe('describeQuickAction', () => {
  it('a read toggle presents the direction it will take, on every surface', () => {
    expect(describeOn('row', 'toggleRead')).toMatchObject({ label: 'rowMenu.markRead', Icon: MailOpen });
    expect(describeOn('selection', 'toggleRead', { has: { ...facts().has, markRead: false } })).toMatchObject({ label: 'selection.markUnread', Icon: Mail });
    expect(describeOn('reader', 'toggleRead')).toMatchObject({ label: 'emailActionBar.markRead', Icon: MailOpen });
  });

  it('the reader toggles a lone star and archive; rows keep them one-sided', () => {
    const starred = { has: { ...facts().has, star: false, unstar: true, archive: false, unarchive: true } };
    expect(describeOn('reader', 'star', starred)).toMatchObject({ label: 'emailActionBar.unstar', Icon: FilledStar });
    expect(describeOn('reader', 'archive', starred)).toMatchObject({ label: 'rowMenu.unarchive', Icon: ArchiveRestore, restoreFocus: false });
    expect(describeOn('row', 'archive', starred)).toMatchObject({ label: 'common.archive', Icon: Archive, restoreFocus: true });
  });

  it('uses each surface\'s own words, and the generic title where a surface has none', () => {
    expect(describeOn('selection', 'export').label).toBe('selection.exportSelected');
    expect(describeOn('row', 'export').label).toBe('common.export');
    expect(describeOn('selection', 'reply').label).toBe('quickActions.title');
    expect(describeOn('row', 'newMessage').label).toBe('rowMenu.newMessageTo{"name":"Ann"}');
    expect(describeOn('row', 'tag', {}, { tagId: 'tag-1' }).label).toBe('Work');
    expect(describeOn('reader', 'move', {}, { mailbox: 'Archive' }).label).toBe('emailActionBar.move: Archive');
  });

  it('only the selection bar titles its archive buttons for the whole selection', () => {
    expect(describeOn('selection', 'archive').titleLabel).toBe('selection.archiveSelected');
    expect(describeOn('row', 'archive').titleLabel).toBeUndefined();
  });

  it('tone and destructiveness', () => {
    expect(quickActionTone('deleteEverywhere')).toBe('danger');
    expect(quickActionTone('unarchive')).toBe('positive');
    expect(quickActionTone('reply')).toBeUndefined();
    expect(describeOn('row', 'deleteServer')).toMatchObject({ tone: 'danger', isDestructive: true, restoreFocus: false });
  });
});
