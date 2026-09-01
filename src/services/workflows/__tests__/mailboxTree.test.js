// Folder-list recovery after a failed first fetch.
//
// The first fetch of a session can land before credentials finish loading
// ("Password missing"). Nothing retried it and nothing re-applied the folder
// list that the background prefetch later cached, so the account kept the
// INBOX placeholder — sidebar and Move dropdown both stuck at one folder.
import { describe, it, expect, vi } from 'vitest';
import {
  countMailboxes,
  isMailboxTreeComplete,
  pickMailboxList,
  INBOX_PLACEHOLDER,
  retryOnce,
} from '../mailboxTree';

const full = [
  { name: 'INBOX', path: 'INBOX', children: [] },
  { name: 'Archive', path: 'Archive', children: [] },
  { name: 'Sent', path: 'Sent', children: [] },
];
const placeholder = [{ name: 'INBOX', path: 'INBOX', specialUse: null, children: [] }];

describe('isMailboxTreeComplete', () => {
  it('rejects the INBOX-only placeholder', () => {
    expect(isMailboxTreeComplete(placeholder)).toBe(false);
  });

  it('rejects empty and missing lists', () => {
    expect(isMailboxTreeComplete([])).toBe(false);
    expect(isMailboxTreeComplete(null)).toBe(false);
    expect(isMailboxTreeComplete(undefined)).toBe(false);
  });

  it('accepts a real folder list', () => {
    expect(isMailboxTreeComplete(full)).toBe(true);
  });

  it('accepts a single folder that is not INBOX', () => {
    expect(isMailboxTreeComplete([{ name: 'Sent', path: 'Sent', children: [] }])).toBe(true);
  });

  it('rejects the old nested tree format so it gets refetched', () => {
    expect(isMailboxTreeComplete([
      { name: 'INBOX', path: 'INBOX', children: [{ name: 'Sub', path: 'INBOX/Sub', children: [] }] },
    ])).toBe(false);
  });
});

describe('countMailboxes', () => {
  it('counts nested children', () => {
    expect(countMailboxes([
      { path: 'a', children: [{ path: 'a/b', children: [{ path: 'a/b/c' }] }] },
      { path: 'd' },
    ])).toBe(4);
  });

  it('treats nothing as zero', () => {
    expect(countMailboxes(null)).toBe(0);
    expect(countMailboxes(undefined)).toBe(0);
  });
});

describe('pickMailboxList', () => {
  it('prefers a complete list over a stale placeholder — the restore-descriptor bug', () => {
    // Descriptor snapshotted the placeholder while the fetch was failing; the
    // cache has since been filled by the background prefetch.
    expect(pickMailboxList(placeholder, full)).toBe(full);
  });

  it('keeps the descriptor list when it is the complete one', () => {
    expect(pickMailboxList(full, placeholder)).toBe(full);
  });

  it('falls back to any non-empty list when none is complete', () => {
    expect(pickMailboxList(null, placeholder)).toBe(placeholder);
  });

  it('ends at the INBOX placeholder when there is nothing at all', () => {
    expect(pickMailboxList(null, undefined, [])).toEqual(INBOX_PLACEHOLDER);
  });
});

describe('retryOnce', () => {
  it('retries a failed fetch once and returns the second result', async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error('Password missing'))
      .mockResolvedValueOnce(full);

    await expect(retryOnce(fetchFn, { delayMs: 0 })).resolves.toBe(full);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a call that succeeded', async () => {
    const fetchFn = vi.fn().mockResolvedValue(full);

    await expect(retryOnce(fetchFn, { delayMs: 0 })).resolves.toBe(full);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the retry fails too', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('still down'));

    await expect(retryOnce(fetchFn, { delayMs: 0 })).rejects.toThrow('still down');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('skips the retry when the activation was aborted meanwhile', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('Password missing'));

    await expect(retryOnce(fetchFn, { delayMs: 0, isAborted: () => true })).resolves.toBe(null);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ── Tree building ──────────────────────────────────────────────────────────
// bson73, discussion #1: five levels deep, and the leaf is called "erledigt"
// ten times over. His server is Dovecot — '.' delimiter, INBOX. on every path.
import { buildMailboxTree, mailboxDescendants, mailboxAncestors } from '../mailboxTree';

const box = (path, delimiter = '.', extra = {}) => ({
  path,
  name: delimiter ? path.split(delimiter).pop() : path,
  delimiter,
  specialUse: null,
  noselect: false,
  children: [],
  ...extra,
});

const DOVECOT = [
  box('INBOX'),
  box('INBOX.Kunden'),
  box('INBOX.Lieferanten'),
  box('INBOX.Lieferanten.Apps'),
  box('INBOX.Lieferanten.Bestellungen'),
  box('INBOX.Lieferanten.Bestellungen.erledigt'),
  box('INBOX.Lieferanten.Technik'),
  box('INBOX.Lieferanten.Technik.Telefonie'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG'),
  box('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt'),
  box('INBOX.Privat'),
  box('INBOX.Sent', '.', { specialUse: '\\Sent' }),
];

const paths = nodes => (nodes || []).map(n => n.path);
const at = (nodes, path) => {
  for (const n of nodes || []) {
    if (n.path === path) return n;
    const hit = at(n.children, path);
    if (hit) return hit;
  }
  return null;
};

describe('buildMailboxTree', () => {
  it('lifts a Dovecot INBOX. prefix so the reader own folders become roots', () => {
    // Apple Mail shows Kunden / Lieferanten / Privat at the top level, not one
    // click under a collapsed INBOX. Nesting them is what made Hostinger
    // accounts look like they had a single mailbox.
    expect(paths(buildMailboxTree(DOVECOT))).toEqual([
      'INBOX', 'INBOX.Kunden', 'INBOX.Lieferanten', 'INBOX.Privat', 'INBOX.Sent',
    ]);
  });

  it('nests five levels and stamps depth on each one', () => {
    const tree = buildMailboxTree(DOVECOT);
    expect(at(tree, 'INBOX.Lieferanten').depth).toBe(0);
    expect(at(tree, 'INBOX.Lieferanten.Technik').depth).toBe(1);
    expect(at(tree, 'INBOX.Lieferanten.Technik.Telefonie').depth).toBe(2);
    expect(at(tree, 'INBOX.Lieferanten.Technik.Telefonie.NFon AG').depth).toBe(3);
    expect(at(tree, 'INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt').depth).toBe(4);
  });

  it('keeps two folders both named erledigt distinct, under their own parents', () => {
    const tree = buildMailboxTree(DOVECOT);
    const shallow = at(tree, 'INBOX.Lieferanten.Bestellungen.erledigt');
    const deep = at(tree, 'INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt');
    expect(shallow.name).toBe('erledigt');
    expect(deep.name).toBe('erledigt');
    expect(shallow.depth).toBe(2);
    expect(deep.depth).toBe(4);
  });

  it('sorts alphabetically within a level, not across the whole list', () => {
    const kids = at(buildMailboxTree(DOVECOT), 'INBOX.Lieferanten').children;
    expect(kids.map(k => k.name)).toEqual(['Apps', 'Bestellungen', 'Technik']);
  });

  it('synthesizes a parent the server never LISTed', () => {
    // A server may list a leaf whose parent is not itself a mailbox.
    const sparse = [box('INBOX'), box('INBOX.a.b.c')];
    const tree = buildMailboxTree(sparse);
    const b = at(tree, 'INBOX.a.b');
    expect(b).toBeTruthy();
    expect(b.noselect).toBe(true);
    expect(b.synthetic).toBe(true);
    expect(paths(b.children)).toEqual(['INBOX.a.b.c']);
  });

  it('does not lift the prefix when anything lives outside INBOX', () => {
    // Only a server that puts EVERY mailbox under INBOX is a prefixed one.
    const mixed = [box('INBOX'), box('INBOX.Sub'), box('Public')];
    const tree = buildMailboxTree(mixed);
    expect(paths(tree)).toEqual(['INBOX', 'Public']);
    expect(paths(at(tree, 'INBOX').children)).toEqual(['INBOX.Sub']);
  });

  it('hoists special-use out of a vendor container', () => {
    // Gmail hides Sent under [Gmail]; a collapsed container must not bury it.
    const gmail = [
      box('INBOX', '/'),
      box('[Gmail]', '/', { noselect: true }),
      box('[Gmail]/Sent Mail', '/', { specialUse: '\\Sent' }),
      box('[Gmail]/All Mail', '/', { specialUse: '\\All' }),
      box('Work', '/'),
    ];
    const tree = buildMailboxTree(gmail);
    expect(paths(tree)).toContain('[Gmail]/Sent Mail');
    expect(at(tree, '[Gmail]/Sent Mail').depth).toBe(0);
    // \All is not one of the five hoisted, so it stays where the server put it.
    expect(at(tree, '[Gmail]/All Mail').depth).toBe(1);
  });

  it('leaves a flat list flat', () => {
    const flat = [box('INBOX', '/'), box('Archive', '/'), box('Sent', '/')];
    const tree = buildMailboxTree(flat);
    expect(paths(tree)).toEqual(['INBOX', 'Archive', 'Sent']);
    expect(tree.every(n => n.depth === 0)).toBe(true);
  });

  it('treats a mailbox with no delimiter as a root', () => {
    // MailboxInfo.delimiter is Option<String> — NIL for a flat namespace.
    const tree = buildMailboxTree([box('INBOX', null), box('Some.Name', null)]);
    expect(paths(tree)).toEqual(['INBOX', 'Some.Name']);
  });

  it('splits a UTF-7 encoded name without decoding it', () => {
    // Decoding is display-only; path is the SELECT argument and the disk dir.
    const tree = buildMailboxTree([box('INBOX'), box('INBOX.Bokelmu&Awg-hle.erledigt')]);
    const parent = at(tree, 'INBOX.Bokelmu&Awg-hle');
    expect(parent).toBeTruthy();
    expect(paths(parent.children)).toEqual(['INBOX.Bokelmu&Awg-hle.erledigt']);
  });

  it('returns nothing for nothing', () => {
    expect(buildMailboxTree([])).toEqual([]);
    expect(buildMailboxTree(null)).toEqual([]);
    expect(buildMailboxTree(undefined)).toEqual([]);
  });

  it('does not mutate the flat list it was given', () => {
    const flat = [box('INBOX'), box('INBOX.a'), box('INBOX.a.b')];
    buildMailboxTree(flat);
    expect(flat.every(m => m.children.length === 0)).toBe(true);
    expect(flat.every(m => m.depth === undefined)).toBe(true);
  });
});

describe('mailboxDescendants', () => {
  it('returns the folder and everything beneath it', () => {
    expect(mailboxDescendants('INBOX.Lieferanten.Technik', DOVECOT)).toEqual([
      'INBOX.Lieferanten.Technik',
      'INBOX.Lieferanten.Technik.Telefonie',
      'INBOX.Lieferanten.Technik.Telefonie.NFon AG',
      'INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt',
    ]);
  });

  it('stops at the delimiter boundary — Technik does not swallow Technik-Alt', () => {
    const boxes = [box('INBOX.Technik'), box('INBOX.Technik-Alt'), box('INBOX.Technik.Sub')];
    expect(mailboxDescendants('INBOX.Technik', boxes))
      .toEqual(['INBOX.Technik', 'INBOX.Technik.Sub']);
  });

  it('returns just the folder when it has no children', () => {
    expect(mailboxDescendants('INBOX.Privat', DOVECOT)).toEqual(['INBOX.Privat']);
  });

  it('returns the folder itself when the list does not know it', () => {
    expect(mailboxDescendants('INBOX.Gone', DOVECOT)).toEqual(['INBOX.Gone']);
  });
});

describe('mailboxAncestors', () => {
  const tree = buildMailboxTree(DOVECOT);

  it('names every folder that has to be open for a deep one to be visible', () => {
    expect(mailboxAncestors('INBOX.Lieferanten.Technik.Telefonie.NFon AG.erledigt', tree)).toEqual([
      'INBOX.Lieferanten',
      'INBOX.Lieferanten.Technik',
      'INBOX.Lieferanten.Technik.Telefonie',
      'INBOX.Lieferanten.Technik.Telefonie.NFon AG',
    ]);
  });

  it('does not name INBOX for a server whose prefix was lifted', () => {
    // Lieferanten is drawn as a root there; opening INBOX would not reveal it.
    expect(mailboxAncestors('INBOX.Lieferanten', tree)).toEqual([]);
  });

  it('is empty for a folder the tree does not hold', () => {
    expect(mailboxAncestors('INBOX.Gone', tree)).toEqual([]);
    expect(mailboxAncestors(null, tree)).toEqual([]);
  });
});
