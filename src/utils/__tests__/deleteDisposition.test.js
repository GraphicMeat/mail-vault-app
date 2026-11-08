import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRASH_CANDIDATES, trashOf, serverDeleteDisposition, serverDeleteDispositionOf } from '../deleteDisposition';

// The confirmation copy reads the delete rule the daemon applies (core
// `actions::policy::delete_disposition`, desktop `WithoutTrash::Permanent`)
// over the same Trash the daemon finds.

const boxes = (...list) => list.map(([path, specialUse]) => ({ path, ...(specialUse ? { specialUse } : {}) }));

describe('trashOf', () => {
  it('finds Trash by special-use first, then by name the way core does', () => {
    expect(trashOf(boxes(['INBOX'], ['Trash'], ['Bin', '\\Trash']))).toBe('Bin');
    expect(trashOf(boxes(['INBOX'], ['INBOX.Trash']))).toBe('INBOX.Trash');
    expect(trashOf(boxes(['INBOX'], ['Deleted Items']))).toBe('Deleted Items');
    expect(trashOf(boxes(['INBOX'], ['[Gmail]/Trash']))).toBe('[Gmail]/Trash');
    expect(trashOf(boxes(['INBOX'], ['Archive']))).toBeNull();
    expect(trashOf(null)).toBeNull();
  });

  it('names the same candidates as core imap::TRASH_CANDIDATES, in order', () => {
    const src = readFileSync(resolve(process.cwd(), 'src-core/src/imap/mod.rs'), 'utf8');
    const m = src.match(/pub const TRASH_CANDIDATES: &\[&str\] = &\[(.*?)\];/);
    expect(m).toBeTruthy();
    const rust = [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]);
    expect(TRASH_CANDIDATES).toEqual(rust);
  });
});

describe('serverDeleteDisposition', () => {
  const account = boxes(['INBOX'], ['Sent', '\\Sent'], ['Archive', '\\Archive'], ['Junk', '\\Junk'], ['Work'], ['Trash', '\\Trash']);

  it('moves to Trash from every folder but Trash, where it is permanent', () => {
    for (const folder of ['INBOX', 'Sent', 'Archive', 'Junk', 'Work']) {
      expect(serverDeleteDisposition(folder, account)).toBe('trash');
    }
    expect(serverDeleteDisposition('Trash', account)).toBe('permanent');
  });

  it('with no Trash: INBOX still moves, any other folder is permanent (desktop)', () => {
    const noTrash = boxes(['INBOX'], ['Sent', '\\Sent'], ['Work']);
    expect(serverDeleteDisposition('INBOX', noTrash)).toBe('trash');
    expect(serverDeleteDisposition('Sent', noTrash)).toBe('permanent');
    expect(serverDeleteDisposition('Work', noTrash)).toBe('permanent');
  });

  it('claims nothing for a folder whose account list is not loaded, except INBOX', () => {
    expect(serverDeleteDisposition('Sent', null)).toBe('unknown');
    expect(serverDeleteDisposition('Sent', [])).toBe('unknown');
    expect(serverDeleteDisposition('INBOX', null)).toBe('trash');
    expect(serverDeleteDisposition('', account)).toBe('unknown');
  });
});

describe('serverDeleteDispositionOf', () => {
  const state = { activeAccountId: 'a', mailboxes: boxes(['INBOX'], ['Sent', '\\Sent'], ['Trash', '\\Trash']) };

  it('reads only the active account folder list', () => {
    expect(serverDeleteDispositionOf([{ accountId: 'a', mailbox: 'Trash' }], state)).toBe('permanent');
    expect(serverDeleteDispositionOf([{ accountId: 'b', mailbox: 'Trash' }], state)).toBe('unknown');
    expect(serverDeleteDispositionOf([{ accountId: 'b', mailbox: 'INBOX' }], state)).toBe('trash');
  });

  it('answers one way only when every delete agrees', () => {
    expect(serverDeleteDispositionOf([{ accountId: 'a', mailbox: 'INBOX' }, { accountId: 'a', mailbox: 'Sent' }], state)).toBe('trash');
    expect(serverDeleteDispositionOf([{ accountId: 'a', mailbox: 'INBOX' }, { accountId: 'a', mailbox: 'Trash' }], state)).toBe('unknown');
    expect(serverDeleteDispositionOf([null], state)).toBe('unknown');
    expect(serverDeleteDispositionOf([], state)).toBe('unknown');
  });
});
