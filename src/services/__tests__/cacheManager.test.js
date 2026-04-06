import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveRestoreDescriptor,
  getRestoreDescriptor,
  invalidateRestoreDescriptors,
  getAccountCacheMailboxes,
} from '../cacheManager';

describe('cacheManager RestoreDescriptor', () => {
  beforeEach(() => {
    invalidateRestoreDescriptors('acc1');
    invalidateRestoreDescriptors('acc2');
    // Clean up eviction test accounts
    for (let i = 0; i < 12; i++) {
      invalidateRestoreDescriptors(`acc${i}`);
    }
  });

  it('saves and retrieves a restore descriptor by accountId+mailbox+viewMode', () => {
    const descriptor = {
      accountId: 'acc1',
      mailbox: 'INBOX',
      viewMode: 'all',
      totalEmails: 500,
      topVisibleIndex: 0,
      selectedUid: null,
      mailboxes: [{ path: 'INBOX', name: 'INBOX' }],
      mailboxesFetchedAt: Date.now(),
      firstWindow: [{ uid: 1, subject: 'Hello' }, { uid: 2, subject: 'World' }],
      firstWindowSavedUids: [1],
      firstWindowArchivedUids: [],
      timestamp: Date.now(),
    };
    saveRestoreDescriptor(descriptor);
    const result = getRestoreDescriptor('acc1', 'INBOX', 'all');
    expect(result).not.toBeNull();
    expect(result.totalEmails).toBe(500);
    expect(result.firstWindow).toHaveLength(2);
    expect(result.firstWindowSavedUids).toEqual([1]);
  });

  it('returns null for missing descriptor', () => {
    expect(getRestoreDescriptor('acc1', 'INBOX', 'all')).toBeNull();
  });

  it('keeps INBOX and Sent descriptors separate', () => {
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all',
      totalEmails: 100, topVisibleIndex: 0, selectedUid: null,
      mailboxes: [], mailboxesFetchedAt: null,
      firstWindow: [{ uid: 1 }], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: Date.now(),
    });
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'Sent', viewMode: 'all',
      totalEmails: 50, topVisibleIndex: 0, selectedUid: null,
      mailboxes: [], mailboxesFetchedAt: null,
      firstWindow: [{ uid: 99 }], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: Date.now(),
    });
    expect(getRestoreDescriptor('acc1', 'INBOX', 'all').totalEmails).toBe(100);
    expect(getRestoreDescriptor('acc1', 'Sent', 'all').totalEmails).toBe(50);
  });

  it('evicts oldest descriptors when exceeding max entries (8)', () => {
    for (let i = 0; i < 10; i++) {
      saveRestoreDescriptor({
        accountId: `acc${i}`, mailbox: 'INBOX', viewMode: 'all',
        totalEmails: i, topVisibleIndex: 0, selectedUid: null,
        mailboxes: [], mailboxesFetchedAt: null,
        firstWindow: [], firstWindowSavedUids: [], firstWindowArchivedUids: [],
        timestamp: Date.now() + i,
      });
    }
    // acc0 and acc1 should be evicted (oldest timestamps)
    expect(getRestoreDescriptor('acc0', 'INBOX', 'all')).toBeNull();
    expect(getRestoreDescriptor('acc1', 'INBOX', 'all')).toBeNull();
    expect(getRestoreDescriptor('acc9', 'INBOX', 'all')).not.toBeNull();
  });

  it('invalidates all descriptors for an account', () => {
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all',
      totalEmails: 10, topVisibleIndex: 0, selectedUid: null,
      mailboxes: [], mailboxesFetchedAt: null,
      firstWindow: [], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: Date.now(),
    });
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'Sent', viewMode: 'all',
      totalEmails: 5, topVisibleIndex: 0, selectedUid: null,
      mailboxes: [], mailboxesFetchedAt: null,
      firstWindow: [], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: Date.now(),
    });
    invalidateRestoreDescriptors('acc1');
    expect(getRestoreDescriptor('acc1', 'INBOX', 'all')).toBeNull();
    expect(getRestoreDescriptor('acc1', 'Sent', 'all')).toBeNull();
  });

  it('getAccountCacheMailboxes returns mailboxes from most recent descriptor', () => {
    const boxes = [{ path: 'INBOX' }, { path: 'Sent' }];
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all',
      totalEmails: 10, topVisibleIndex: 0, selectedUid: null,
      mailboxes: boxes, mailboxesFetchedAt: Date.now(),
      firstWindow: [], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: Date.now(),
    });
    expect(getAccountCacheMailboxes('acc1')).toEqual(boxes);
  });

  it('getAccountCacheMailboxes returns null for unknown account', () => {
    expect(getAccountCacheMailboxes('unknown')).toBeNull();
  });

  it('timestamp is not mutated on read (stale-age check stays reliable)', () => {
    const beforeSave = Date.now();
    saveRestoreDescriptor({
      accountId: 'acc1', mailbox: 'INBOX', viewMode: 'all',
      totalEmails: 10, topVisibleIndex: 0, selectedUid: null,
      mailboxes: [], mailboxesFetchedAt: null,
      firstWindow: [], firstWindowSavedUids: [], firstWindowArchivedUids: [],
      timestamp: beforeSave,
    });
    const saved = getRestoreDescriptor('acc1', 'INBOX', 'all');
    const originalTimestamp = saved.timestamp;

    // Read again — timestamp should not change
    const readAgain = getRestoreDescriptor('acc1', 'INBOX', 'all');
    expect(readAgain.timestamp).toBe(originalTimestamp);
  });
});
