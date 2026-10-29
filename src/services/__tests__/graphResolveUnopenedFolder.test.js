import { describe, it, expect, beforeEach, vi } from 'vitest';

// A Notes to Self card addresses its copies by (account, folder, uid) without
// opening the folder, so the in-memory uid -> Graph id map was never restored
// for it. The ledger on disk still names the message: the delete has to find
// it there instead of relisting a window that may not reach it.

const h = vi.hoisted(() => ({ disk: new Map(), relists: 0 }));

vi.mock('../db.js', () => ({
  loadGraphIdMap: vi.fn(async (accountId, mailbox) => h.disk.get(`${accountId}:${mailbox}`) ?? null),
}));

vi.mock('../api.js', () => ({
  graphListMessages: vi.fn(async () => { h.relists += 1; return { headers: [], graphMessageIds: [], nextLink: null }; }),
  graphListFolders: vi.fn(async () => [{ id: 'f1', displayName: 'Sent', storageKey: 'Sent' }]),
  graphAllocateUids: vi.fn(async () => []),
}));

import { resolveGraphMessageId, clearGraphIdMap } from '../cacheManager';

const ACCT = 'acct-notes';
const account = { id: ACCT };

describe('resolveGraphMessageId for a folder this session never opened', () => {
  beforeEach(() => {
    clearGraphIdMap(ACCT);
    h.disk.clear();
    h.relists = 0;
  });

  it('answers from the ledger on disk without relisting', async () => {
    h.disk.set(`${ACCT}:Sent`, { 7: 'AAA-graph-id' });
    expect(await resolveGraphMessageId(ACCT, 'Sent', 7, { account })).toBe('AAA-graph-id');
    expect(h.relists).toBe(0);
  });

  it('takes a uid that arrives as a string off the wire', async () => {
    h.disk.set(`${ACCT}:Sent`, { 7: 'AAA-graph-id' });
    expect(await resolveGraphMessageId(ACCT, 'Sent', '7', { account })).toBe('AAA-graph-id');
  });

  it('still answers null for a uid the ledger never held', async () => {
    h.disk.set(`${ACCT}:Sent`, { 7: 'AAA-graph-id' });
    expect(await resolveGraphMessageId(ACCT, 'Sent', 8, { account })).toBeNull();
  });
});
