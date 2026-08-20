import { describe, it, expect, beforeEach, vi } from 'vitest';

// A Graph message has no UID. `graph_list_messages` numbers each row by its
// 1-based position in a `receivedDateTime desc` listing, so one arrival
// renumbers the whole folder — and the header sidecar, the persisted map and
// the vault Maildir each end up holding a different generation of that
// numbering. These cases pin the allocator that replaces it: a Graph id keeps
// the first uid it was given, for as long as the ledger survives.

const h = vi.hoisted(() => ({
  disk: new Map(),
  listing: { headers: [], graphMessageIds: [], nextLink: null },
  saves: 0,
  failSave: false,
  failLoad: false,
}));

vi.mock('../db.js', () => ({
  saveGraphIdMap: vi.fn(async (accountId, mailbox, obj) => {
    h.saves++;
    if (h.failSave) throw new Error('save_graph_id_map: failed to write');
    h.disk.set(`${accountId}:${mailbox}`, { ...obj });
  }),
  loadGraphIdMap: vi.fn(async (accountId, mailbox) => {
    if (h.failLoad) throw new Error('load_graph_id_map: failed to read');
    return h.disk.get(`${accountId}:${mailbox}`) ?? null;
  }),
}));

vi.mock('../api.js', () => ({
  graphListMessages: vi.fn(async () => h.listing),
  graphListFolders: vi.fn(async () => []),
}));

import { listGraphMessages, getGraphMessageId, clearGraphIdMap } from '../cacheManager';

/**
 * A listing exactly as Rust hands it over: headers already carrying the
 * positional uid, plus the parallel id array. Tests that pass by ignoring the
 * ledger would have to reproduce these positions, so they show up as failures.
 */
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

describe('Graph uid allocation', () => {
  beforeEach(() => {
    h.disk.clear();
    h.saves = 0;
    h.failSave = false;
    h.failLoad = false;
    clearGraphIdMap(ACCT);
  });

  it('adopts the listing order on a mailbox it has never seen', async () => {
    // An upgrade must not renumber what is already in the vault: with no
    // ledger yet, the numbers the allocator hands out are the numbers the
    // positional scheme was handing out.
    serve(['a', 'b', 'c']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(headers.map(row => row.uid)).toEqual([1, 2, 3]);
    expect(headers.map(row => row._graphId)).toEqual(['a', 'b', 'c']);
    expect(headers.map(row => row.seq)).toEqual([1, 2, 3]);
  });

  it('keeps every uid when a new message shifts all the positions', async () => {
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    // Graph lists newest first, so an arrival takes position 1 and pushes
    // every other message down one. This is the 15 Apr case: under positional
    // numbering 'a' moved from 1 to 2 and its body was refetched into the
    // vault under a number that already belonged to something else.
    serve(['z', 'a', 'b', 'c']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(uidsById(headers)).toEqual({ a: 1, b: 2, c: 3, z: 4 });
  });

  it('leaves the survivors alone when a message is deleted', async () => {
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    serve(['a', 'c']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(uidsById(headers)).toEqual({ a: 1, c: 3 });
  });

  it('never reissues the uid of a message that left the folder', async () => {
    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    serve(['a']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    // 'b' is gone and uid 2 goes with it. Handing 2 to the next arrival would
    // file its body over b's vault copy.
    serve(['new', 'a']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    expect(uidsById(headers)).toEqual({ a: 1, new: 3 });
  });

  it('continues the allocation across pages instead of restarting it', async () => {
    serve(['a', 'b'], { nextLink: 'next' });
    const page0 = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id', { top: 2, skip: 0 });

    serve(['c', 'd'], { skip: 2 });
    const page1 = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id', { top: 2, skip: 2 });

    expect(uidsById(page0.headers)).toEqual({ a: 1, b: 2 });
    expect(uidsById(page1.headers)).toEqual({ c: 3, d: 4 });
  });

  it('reads the ledger back off disk before allocating anything', async () => {
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    // Next launch: memory is empty, the ledger is not. Allocating from an
    // empty ledger would give uid 1 to whatever is newest today and write its
    // body over the message that already owns 1 in the vault.
    clearGraphIdMap(ACCT);
    serve(['c', 'b', 'a']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(uidsById(headers)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('refuses to allocate when the ledger exists but cannot be read', async () => {
    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    clearGraphIdMap(ACCT);
    h.failLoad = true;
    h.saves = 0;
    serve(['a', 'b']);

    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/failed to read/);
    expect(h.saves).toBe(0);
    expect(h.disk.get(`${ACCT}:INBOX`)).toEqual({ 1: 'a', 2: 'b' });
  });

  it('fails the listing when the allocation cannot be persisted', async () => {
    // A uid handed out in memory but not on disk is handed out again next
    // launch, to a different message.
    h.failSave = true;
    serve(['a', 'b']);

    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow(/failed to write/);
  });

  it('keeps no trace of an allocation whose write failed', async () => {
    h.failSave = true;
    serve(['a', 'b']);
    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id')).rejects.toThrow();

    // The failed uids must not survive in memory: if they did, this session
    // would go on using numbers the next one will hand to other messages.
    h.failSave = false;
    serve(['a', 'b']);
    const { headers } = await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(uidsById(headers)).toEqual({ a: 1, b: 2 });
    expect(h.disk.get(`${ACCT}:INBOX`)).toEqual({ 1: 'a', 2: 'b' });
  });

  it('writes nothing when a listing allocates nothing', async () => {
    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    const afterFirst = h.saves;

    serve(['a', 'b']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(h.saves).toBe(afterFirst);
  });

  it('refuses to pair headers with ids by position when the two disagree', async () => {
    h.listing = { headers: serverListing(['a', 'b']).headers, graphMessageIds: ['a'], nextLink: null };

    await expect(listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id'))
      .rejects.toThrow(/refusing to pair them by position/);
  });

  it('gives each mailbox its own uid space', async () => {
    serve(['inbox-a']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'inbox-folder');

    serve(['archive-a']);
    const archive = await listGraphMessages(ACCT, 'Archive', 'token', 'archive-folder');

    expect(uidsById(archive.headers)).toEqual({ 'archive-a': 1 });
    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe('inbox-a');
    expect(getGraphMessageId(ACCT, 'Archive', 1)).toBe('archive-a');
  });

  it('leaves the map able to answer for a row that has no id of its own', async () => {
    // A row repainted from the sidecar carries _graphId, but a row rebuilt by
    // a path that drops it still has to resolve — the ledger is what answers.
    serve(['a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');
    serve(['z', 'a', 'b', 'c']);
    await listGraphMessages(ACCT, 'INBOX', 'token', 'folder-id');

    expect(getGraphMessageId(ACCT, 'INBOX', 1)).toBe('a');
    expect(getGraphMessageId(ACCT, 'INBOX', 4)).toBe('z');
  });
});
