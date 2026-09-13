import { describe, it, expect, vi } from 'vitest';

// The label comes from the catalog: fake two entries so the assertion reads
// "the UI language", not "whatever en.json says".
vi.mock('../../i18n/index.js', () => ({
  t: (key) => ({ 'list.sent': 'Gesendet', 'settings.storage.trash': 'Papierkorb' }[key] ?? key),
}));

const { WELL_KNOWN, storageKeyOf, graphFoldersToMailboxes } = await import('../graphConfig.js');

const folder = (over = {}) => ({
  id: 'fld-sent',
  displayName: 'Gesendete Elemente',
  totalItemCount: 5,
  unreadItemCount: 0,
  childFolderCount: 0,
  wellKnownName: 'sentitems',
  storageKey: 'Sent',
  ...over,
});

describe('WELL_KNOWN', () => {
  it('covers exactly the six default folders', () => {
    expect(Object.keys(WELL_KNOWN).sort()).toEqual(['archive', 'deleteditems', 'drafts', 'inbox', 'junkemail', 'sentitems']);
    expect(WELL_KNOWN.sentitems).toEqual({ specialUse: '\\Sent', labelKey: 'list.sent' });
    expect(WELL_KNOWN.inbox).toEqual({ specialUse: '\\Inbox', labelKey: null });
  });
});

describe('storageKeyOf', () => {
  it('reads the key Rust computed', () => {
    expect(storageKeyOf(folder())).toBe('Sent');
  });
  it('falls back to the display name for a listing without a key', () => {
    expect(storageKeyOf({ id: 'x', displayName: 'Projekte' })).toBe('Projekte');
  });
});

describe('graphFoldersToMailboxes', () => {
  it('keys a well-known folder by its English word and labels it in the UI language', () => {
    const [m] = graphFoldersToMailboxes([folder()]);
    expect(m).toMatchObject({ path: 'Sent', name: 'Gesendet', specialUse: '\\Sent', _graphFolderId: 'fld-sent', delimiter: '/', noselect: false, children: [] });
  });
  it('never shows the server language for a well-known folder', () => {
    const [m] = graphFoldersToMailboxes([folder({ wellKnownName: 'deleteditems', storageKey: 'Trash', displayName: 'Gelöschte Elemente' })]);
    expect(m.name).toBe('Papierkorb');
    expect(m.path).toBe('Trash');
  });
  it('keeps INBOX as INBOX in both fields, like an IMAP account', () => {
    const [m] = graphFoldersToMailboxes([folder({ id: 'fld-inbox', wellKnownName: 'inbox', storageKey: 'INBOX', displayName: 'Posteingang' })]);
    expect(m).toMatchObject({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' });
  });
  it('passes a custom folder through by display name with no special use', () => {
    const [m] = graphFoldersToMailboxes([folder({ id: 'fld-proj', wellKnownName: null, storageKey: 'Projekte', displayName: 'Projekte' })]);
    expect(m).toMatchObject({ path: 'Projekte', name: 'Projekte', specialUse: null, _graphFolderId: 'fld-proj' });
  });
  it('treats a folder object without a key as a custom folder named by its display name', () => {
    const [m] = graphFoldersToMailboxes([{ id: 'old', displayName: 'Sent Items' }]);
    expect(m).toMatchObject({ path: 'Sent Items', name: 'Sent Items', specialUse: null });
  });
});
