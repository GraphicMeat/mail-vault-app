// A delete tombstone names one message: `account|folder|uid`. The derivation
// used to rebuild that key from the VIEW (`activeMailbox`) for every row that
// was not in the unified inbox, so in a folder-branch view (activeMailbox is the
// branch root, each row carries its own `_mailbox`) a tombstone for "Projects"
// uid 34 also hid "Projects/Alpha" uid 34, and the tombstone the delete wrote
// for a row INSIDE the branch ("Projects/Alpha" 34) matched nothing.
import { describe, it, expect } from 'vitest';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const { deriveDisplayRows } = await import('../slices/messageListSlice');

const row = (uid, mailbox, accountId = 'a1') => ({
  uid, flags: [], date: '2026-09-01T00:00:00Z', _accountId: accountId, _mailbox: mailbox,
});

const derive = (emails, deleteTombstones, extra = {}) => deriveDisplayRows({
  emails, deleteTombstones, activeAccountId: 'a1', activeMailbox: 'Projects', ...extra,
}).map(e => `${e._accountId}|${e._mailbox}|${e.uid}`);

describe('delete tombstones in a folder-branch view', () => {
  const both = () => [row(34, 'Projects'), row(34, 'Projects/Alpha')];

  it('a tombstone for the branch root does not hide the child folder\'s uid', () => {
    expect(derive(both(), new Set(['a1|Projects|34']))).toEqual(['a1|Projects/Alpha|34']);
  });

  it('a tombstone written for a row inside the branch hides that row', () => {
    expect(derive(both(), new Set(['a1|Projects/Alpha|34']))).toEqual(['a1|Projects|34']);
  });

  it('another account\'s tombstone with the same folder and uid hides nothing', () => {
    expect(derive(both(), new Set(['a2|Projects/Alpha|34']))).toHaveLength(2);
  });

  it('a plain folder view still hides by the view\'s folder', () => {
    const plain = [{ uid: 7, flags: [], date: '2026-09-01T00:00:00Z' }, { uid: 8, flags: [], date: '2026-09-01T00:00:00Z' }];
    expect(deriveDisplayRows({
      emails: plain, deleteTombstones: new Set(['a1|Projects|7']), activeAccountId: 'a1', activeMailbox: 'Projects',
    }).map(e => e.uid)).toEqual([8]);
  });

  it('the unified inbox keeps hiding by each row\'s own folder', () => {
    const unified = [row(5, 'INBOX'), row(5, 'INBOX', 'a2')];
    expect(deriveDisplayRows({
      emails: unified, deleteTombstones: new Set(['a2|INBOX|5']), unifiedInbox: true,
      activeAccountId: 'a1', activeMailbox: 'UNIFIED',
    }).map(e => e._accountId)).toEqual(['a1']);
  });
});
