import { describe, it, expect, beforeEach, vi } from 'vitest';

// A Graph message has no UID. The allocator that mints one lives in Rust
// (mailvault_core::graph_ledger) and is the only writer of the ledger, because
// the backup files mail by it too. These cases pin what the JS side still
// owns: asking only about ids it does not know, stamping rows from the answer,
// and never keeping or inventing a number the ledger did not give.

const h = vi.hoisted(() => ({
  disk: new Map(),          // `${accountId}:${mailbox}` -> { uid: graphId }, what load_graph_id_map returns
  listing: { headers: [], graphMessageIds: [], nextLink: null },
  calls: [],                // graphAllocateUids arguments
  failAllocate: false,
  failLoad: false,
  shortReply: false,
}));

vi.mock('../db.js', () => ({
  loadGraphIdMap: vi.fn(async (accountId, mailbox) => {
    if (h.failLoad) throw new Error('load_graph_id_map: failed to read');
    return h.disk.get(`${accountId}:${mailbox}`) ?? null;
  }),
}));

vi.mock('../api.js', () => ({
  graphListMessages: vi.fn(async () => h.listing),
  graphListFolders: vi.fn(async () => []),
  // Stand-in for the Rust allocator: next free number after what is on "disk".
  graphAllocateUids: vi.fn(async (accountId, mailbox, entries) => {
    h.calls.push({ accountId, mailbox, entries });
    if (h.failAllocate) throw new Error('Outlook uid ledger could not be saved');
    const key = `${accountId}:${mailbox}`;
    const ledger = { ...(h.disk.get(key) || {}) };
    const byId = new Map(Object.entries(ledger).map(([uid, id]) => [id, Number(uid)]));
    let next = Math.max(0, ...Object.keys(ledger).map(Number));
    const uids = entries.map(([id]) => {
      if (!byId.has(id)) { next += 1; byId.set(id, next); ledger[next] = id; }
      return byId.get(id);
    });
    h.disk.set(key, ledger);
    return h.shortReply ? uids.slice(1) : uids;
  }),
}));

import { listGraphMessages, getGraphMessageId, clearGraphIdMap } from '../cacheManager';

/** A listing exactly as Rust hands it over: positional uids plus the parallel id array. */
function serverListing(graphIds, { skip = 0, nextLink = null } = {}) {
  return {
    headers: graphIds.map((id, i) => ({
      uid: skip + i + 1,
      seq: skip + i + 1,
      subject: `subject ${id}`,
      messageId: `<${id}@outlook.com>`,
    })),
    graphMessageIds: [...graphIds],
    nextLink,
  };
}

function serve(graphIds, opts) {
  h.listing = serverListing(graphIds, opts);
}

/** { graphId: uid } for the rows that came back. */
function uidsById(headers) {
  return Object.fromEntries(headers.map(row => [row._graphId, row.uid]));
}

const ACCT = 'acct-graph';

describe('Graph uid allocation (JS side)', () => {
  beforeEach(() => {
    h.disk.clear();
    h.calls = [];
    h.failAllocate = false;
    h.failLoad = false;
    h.shortReply = false;
    clearGraphIdMap(ACCT);
  });

  it('stamps uid, seq and the Graph id from the allocator, in listing order', async () => {
    serve(['a', 'b', 'c']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(headers.map(row => row.uid)).toEqual([1, 2, 3]);
    expect(headers.map(row => row.seq)).toEqual([1, 2, 3]);
    expect(headers.map(row => row._graphId)).toEqual(['a', 'b', 'c']);
  });

  it('asks only about ids it does not know, once each, with their Message-ID', async () => {
    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    serve(['z', 'a', 'b', 'z']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({ accountId: ACCT, mailbox: 'INBOX', entries: [['z', '<z@outlook.com>']] });
  });

  it('makes no call at all when every listed id is known', async () => {
    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    serve(['b', 'a']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(h.calls).toHaveLength(1);
    expect(uidsById(headers)).toEqual({ a: 1, b: 2 });
  });

  it('keeps every uid when a new message shifts all the positions', async () => {
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    serve(['z', 'a', 'b', 'c']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(uidsById(headers)).toEqual({ a: 1, b: 2, c: 3, z: 4 });
  });

  it('takes uids another writer allocated from the ledger on disk after a restart', async () => {
    // The backup allocated 1-3 while the app was closed.
    h.disk.set(`${ACCT}:INBOX`, { 1: 'a', 2: 'b', 3: 'c' });
    serve(['c', 'b', 'a', 'new']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(uidsById(headers)).toEqual({ a: 1, b: 2, c: 3, new: 4 });
    expect(h.calls.map(c => c.entries)).toEqual([[['new', '<new@outlook.com>']]]);
  });

  it('refuses to allocate when the ledger exists but cannot be read', async () => {
    h.failLoad = true;
    serve(['a', 'b']);
    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/failed to read/);
    expect(h.calls).toHaveLength(0);
  });

  it('fails the listing when the allocator fails, and keeps no trace of it', async () => {
    h.failAllocate = true;
    serve(['a', 'b']);
    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/could not be saved/);
    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe(null);

    h.failAllocate = false;
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(uidsById(headers)).toEqual({ a: 1, b: 2 });
    expect(h.calls).toHaveLength(2);
  });

  it('refuses an allocator answer that does not match the question', async () => {
    h.shortReply = true;
    serve(['a', 'b']);
    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/refusing to pair/);
    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe(null);
  });

  it('refuses to pair headers with ids by position when the two disagree', async () => {
    h.listing = { headers: serverListing(['a', 'b']).headers, graphMessageIds: ['a'], nextLink: null };
    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/refusing to pair them by position/);
    expect(h.calls).toHaveLength(0);
  });

  it('gives each mailbox its own uid space', async () => {
    serve(['inbox-a']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'inbox-folder');
    serve(['archive-a']);
    const archive = await listGraphMessages(ACCT, 'Archive', 'token', 'archive-folder');
    expect(uidsById(archive.headers)).toEqual({ 'archive-a': 1 });
    expect(h.calls.map(c => c.mailbox)).toEqual(['INBOX', 'Archive']);
    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe('inbox-a');
    expect(getGraphMessageId(ACCT, 'Archive', 1)).toBe('archive-a');
  });

  it('leaves the map able to answer for a row that has no id of its own', async () => {
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    serve(['z', 'a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe('a');
    expect(getGraphMessageId(ACCT, 'INBOX', 4)).toBe('z');
  });

  it('has no way left to write the ledger from JS', async () => {
    const caches = await import('../db/caches.js');
    expect(caches.saveGraphIdMap).toBeUndefined();
  });
});
