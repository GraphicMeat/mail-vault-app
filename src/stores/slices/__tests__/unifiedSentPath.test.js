import { describe, it, expect } from 'vitest';
import { _resolveMailboxPath } from '../unifiedHelpers.js';

// Unified Drafts / Trash / Sent resolve each account's folder by role.
describe('_resolveMailboxPath prefers the declared role over a name match', () => {
  // Gmail, byte order: user labels before [Gmail]/...
  const gmail = [
    { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
    { name: 'Drafts', path: 'Drafts' },
    { name: 'Bin', path: '[Gmail]/Bin', specialUse: '\\Trash' },
    { name: 'Drafts', path: '[Gmail]/Drafts', specialUse: '\\Drafts' },
    { name: 'Trash', path: '[Imap]/Trash' },
  ];

  it('picks [Gmail]/Drafts, not the Drafts label listed before it', () => {
    expect(_resolveMailboxPath(gmail, 'Drafts')).toBe('[Gmail]/Drafts');
    expect(_resolveMailboxPath(gmail, 'Trash')).toBe('[Gmail]/Bin');
  });

  it('still falls back to the name when nothing declares the role', () => {
    const plain = [{ name: 'INBOX', path: 'INBOX' }, { name: 'Drafts', path: 'INBOX.Drafts' }];
    expect(_resolveMailboxPath(plain, 'Drafts')).toBe('INBOX.Drafts');
  });
});
