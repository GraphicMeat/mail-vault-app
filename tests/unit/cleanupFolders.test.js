/**
 * The rule picker and the cleanup engine share one folder policy.
 *
 * They did not before 2026-08-31: the picker offered "Drafts", executeRule()
 * refused every rule pointing at it, and the resulting rule row rendered
 * normally with its toggle on while nothing ever happened. Same silent no-op
 * class as the field-shape mismatch fixed the same day.
 *
 * The engine-side refusal stays (a hand-edited or migrated rule must still be
 * refused); this pins the other half, so the two lists cannot drift apart.
 *
 * The picker's literal is not a mailbox path either. A rule saved as "Sent"
 * matched nothing at all on a Dovecot account, where that folder is
 * "INBOX.Sent" - the rule ran, found no cached headers under the literal, and
 * reported success. resolveCleanupFolders is the one place that turns the
 * picker's word into the paths this account actually has.
 */
import { describe, it, expect } from 'vitest';
import {
  CLEANUP_FOLDERS, PROTECTED_FOLDERS, resolveCleanupFolders, isTrashFolder,
} from '../../src/utils/cleanupFolders';

const box = (path, extra = {}) => ({
  path, name: path.split(/[/.]/).pop(), children: [], ...extra,
});

/** A Dovecot account: everything hangs off INBOX, only some carry SPECIAL-USE. */
const DOVECOT = [
  box('INBOX'),
  box('INBOX.Sent', { specialUse: '\\Sent' }),
  box('INBOX.Trash', { specialUse: '\\Trash' }),
  box('INBOX.Drafts', { specialUse: '\\Drafts' }),
  box('INBOX.Junk'),
  box('INBOX.Sammelmappe', { noselect: true }),
];

const paths = (folder, boxes = DOVECOT) => resolveCleanupFolders(folder, boxes).map(b => b.path);

describe('cleanup folder policy', () => {
  it('never offers a folder the engine would refuse', () => {
    expect(CLEANUP_FOLDERS.filter(f => PROTECTED_FOLDERS.has(f))).toEqual([]);
  });

  // Negative control: an empty picker also offers nothing protected.
  it('still offers the folders worth cleaning', () => {
    expect(CLEANUP_FOLDERS).toContain('INBOX');
    expect(CLEANUP_FOLDERS).toContain('Trash');
  });

  it('offers the every-folder sentinel', () => {
    expect(CLEANUP_FOLDERS).toContain('all');
  });

  // Negative control: a protected set that lost its only member would let any
  // picker list pass the first assertion.
  it('still protects Drafts', () => {
    expect(PROTECTED_FOLDERS.has('Drafts')).toBe(true);
  });
});

describe('resolveCleanupFolders - the picker word to this account\'s paths', () => {
  it('finds INBOX whatever case the server reports it in', () => {
    expect(paths('INBOX')).toEqual(['INBOX']);
    expect(paths('INBOX', [box('Inbox')])).toEqual(['Inbox']);
  });

  it('finds a role folder by SPECIAL-USE, not by name', () => {
    expect(paths('Sent')).toEqual(['INBOX.Sent']);
    expect(paths('Trash')).toEqual(['INBOX.Trash']);
    // Gmail's name shares nothing with the picker's word.
    expect(paths('Sent', [box('INBOX'), box('[Gmail]/Sent Mail', { specialUse: '\\Sent' })]))
      .toEqual(['[Gmail]/Sent Mail']);
  });

  it('falls back to the last path segment when the server advertises no SPECIAL-USE', () => {
    const plain = [box('INBOX'), box('INBOX.Sent'), box('INBOX.Junk')];
    expect(paths('Sent', plain)).toEqual(['INBOX.Sent']);
    expect(paths('Junk')).toEqual(['INBOX.Junk']);
  });

  // Control for the two above: a folder this account does not have resolves to
  // nothing, rather than to the literal the picker wrote.
  it('resolves a folder the account does not have to nothing', () => {
    expect(paths('Archive')).toEqual([]);
    expect(paths('Sent', [])).toEqual([]);
    expect(paths('Sent', null)).toEqual([]);
  });

  it("'all' walks every selectable folder", () => {
    expect(paths('all')).toEqual(['INBOX', 'INBOX.Sent', 'INBOX.Trash', 'INBOX.Junk']);
  });

  it("'all' never returns Drafts, by role or by name", () => {
    expect(paths('all', [box('INBOX'), box('Drafts'), box('Entwürfe', { specialUse: '\\Drafts' })]))
      .toEqual(['INBOX']);
  });

  it('never returns a \\NoSelect placeholder - nothing can be deleted from one', () => {
    expect(paths('all')).not.toContain('INBOX.Sammelmappe');
  });
});

describe('isTrashFolder - the only folder a rule may delete permanently', () => {
  it('reads the role first', () => {
    expect(isTrashFolder(box('INBOX.Bin', { specialUse: '\\Trash' }))).toBe(true);
  });

  it('falls back to the last path segment', () => {
    expect(isTrashFolder(box('INBOX.Trash'))).toBe(true);
  });

  it('control: every other folder moves to Trash instead', () => {
    expect(isTrashFolder(box('INBOX'))).toBe(false);
    expect(isTrashFolder(box('INBOX.Sent', { specialUse: '\\Sent' }))).toBe(false);
    expect(isTrashFolder(undefined)).toBe(false);
  });
});
