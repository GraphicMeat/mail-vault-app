import { describe, it, expect } from 'vitest';
import { _collectContactFolderPaths } from '../contactsIndex';

describe('_collectContactFolderPaths', () => {
  it('returns empty array when mailbox tree is null', () => {
    expect(_collectContactFolderPaths(null)).toEqual([]);
    expect(_collectContactFolderPaths(undefined)).toEqual([]);
    expect(_collectContactFolderPaths([])).toEqual([]);
  });

  it('puts INBOX first and includes Sent', () => {
    const tree = [
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Butcher', name: 'Butcher' },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths[0]).toBe('INBOX');
    expect(paths).toContain('Sent');
    expect(paths).toContain('Butcher');
  });

  it('excludes Trash / Junk / Drafts / Archive by specialUse', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
      { path: 'Junk', name: 'Junk', specialUse: '\\Junk' },
      { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' },
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
      { path: 'Custom', name: 'Custom' },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths).toContain('INBOX');
    expect(paths).toContain('Custom');
    expect(paths).not.toContain('Trash');
    expect(paths).not.toContain('Junk');
    expect(paths).not.toContain('Drafts');
    expect(paths).not.toContain('Archive');
  });

  it('excludes system folders by name when specialUse is missing', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Trash', name: 'Trash' },
      { path: 'Spam', name: 'Spam' },
      { path: 'Drafts', name: 'Drafts' },
      { path: 'Deleted Items', name: 'Deleted Items' },
      { path: 'Butcher', name: 'Butcher' },
      { path: 'Clients/Acme', name: 'Acme' },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths).toContain('INBOX');
    expect(paths).toContain('Butcher');
    expect(paths).toContain('Clients/Acme');
    expect(paths).not.toContain('Trash');
    expect(paths).not.toContain('Spam');
    expect(paths).not.toContain('Drafts');
    expect(paths).not.toContain('Deleted Items');
  });

  it('excludes Gmail system paths under [Gmail]/', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
      { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All' },
      { path: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
      { path: 'Work', name: 'Work' },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths).toContain('INBOX');
    expect(paths).toContain('[Gmail]/Sent Mail');
    expect(paths).toContain('Work');
    expect(paths).not.toContain('[Gmail]/Trash');
    expect(paths).not.toContain('[Gmail]/All Mail');
  });

  it('recurses nested children', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      {
        path: 'Clients',
        name: 'Clients',
        children: [
          { path: 'Clients/Butcher', name: 'Butcher' },
          { path: 'Clients/Archive', name: 'Archive', specialUse: '\\Archive' },
        ],
      },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths).toContain('Clients/Butcher');
    expect(paths).not.toContain('Clients/Archive');
  });

  it('dedupes case-insensitive paths', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Inbox', name: 'Inbox' },
    ];
    const paths = _collectContactFolderPaths(tree);
    const inboxCount = paths.filter(p => p.toLowerCase() === 'inbox').length;
    expect(inboxCount).toBe(1);
  });

  it('caps at 12 folders', () => {
    const tree = [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }];
    for (let i = 0; i < 30; i++) tree.push({ path: `F${i}`, name: `F${i}` });
    const paths = _collectContactFolderPaths(tree);
    expect(paths.length).toBe(12);
    expect(paths[0]).toBe('INBOX');
  });

  it('skips \\Noselect folders', () => {
    const tree = [
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Placeholder', name: 'Placeholder', flags: ['\\Noselect'] },
      { path: 'Real', name: 'Real' },
    ];
    const paths = _collectContactFolderPaths(tree);
    expect(paths).toContain('Real');
    expect(paths).not.toContain('Placeholder');
  });
});
