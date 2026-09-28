/**
 * `applyServerRemoval` takes one off `totalEmails` only when a row actually
 * left the view.
 *
 * In a view that spans mailboxes (All inboxes, a branch listing) the count is
 * the view's own sum, and the removed uid may name no row in it at all: the
 * body pass of a branch listing fetches the ROOT folder, whose own uids are
 * all the root knows, and a gone-prune for a root uid the branch never listed
 * used to drop the branch count anyway. A branch listing is the trap: its
 * `activeMailbox` is the root, a real folder, so "the view is the target
 * folder" read true while nothing in the list was the message.
 *
 * A single folder keeps today's rule. Its list is paged (500 of a 15,000
 * INBOX), so a row that is not loaded is still in the count.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';

if (!globalThis.window) {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
} else {
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
}

const mockSaveEmailHeaders = vi.fn().mockResolvedValue(undefined);

vi.mock('../../db', () => ({
  isEmailSaved: vi.fn().mockResolvedValue(false),
  archiveEmail: vi.fn().mockResolvedValue(undefined),
  getVaultUidSets: vi.fn().mockResolvedValue({ saved: new Set(), archived: new Set() }),
  getLocalEmails: vi.fn().mockResolvedValue([]),
  getLocalEmailLight: vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta: vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial: vi.fn().mockResolvedValue({ emails: [], totalEmails: 0 }),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
  readLocalEmailIndex: vi.fn().mockResolvedValue(null),
  getArchivedEmails: vi.fn().mockResolvedValue([]),
  deleteLocalEmail: vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders: (...a) => mockSaveEmailHeaders(...a),
  initDB: vi.fn().mockResolvedValue(undefined),
  getAccounts: vi.fn().mockResolvedValue([]),
  ensureAccountsInFile: vi.fn().mockResolvedValue(undefined),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api', () => ({
  fetchEmail: vi.fn(),
  appendLocalIndex: vi.fn().mockResolvedValue(undefined),
  fetchEmailLight: vi.fn().mockResolvedValue(null),
  updateEmailFlags: vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../authUtils', () => ({
  hasValidCredentials: () => true,
  ensureFreshToken: (a) => Promise.resolve(a),
  resolveServerAccount: (id, account) => Promise.resolve({ ok: true, account }),
}));

vi.mock('../../attachmentUtils', () => ({ hasRealAttachments: () => false }));

vi.mock('../../graphConfig', () => ({
  isGraphAccount: () => false,
  graphMessageToEmail: (m) => m,
}));

vi.mock('../../cacheManager', () => ({
  getRestoreDescriptor: vi.fn().mockReturnValue(null),
  saveRestoreDescriptor: vi.fn(),
  invalidateRestoreDescriptors: () => {},
  getAccountCacheMailboxes: () => null,
  listGraphMessages: vi.fn().mockResolvedValue({ headers: [], graphMessageIds: [] }),
  getGraphMessageId: () => null,
  resolveGraphMessageId: async () => null,
  clearGraphIdMap: () => {},
}));

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      cacheLimitMB: 128,
      hiddenAccounts: {},
      getLastMailbox: () => 'INBOX',
      emailListStyle: 'default',
      linkAlerts: {},
      linkSafetyEnabled: false,
      setUnreadForAccount: () => {},
    }),
  },
}));

vi.mock('../../safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

vi.mock('../../transport', () => ({ send: vi.fn().mockResolvedValue(undefined) }));

const { useMailStore } = await import('../../../stores/mailStore');
const { applyServerRemoval } = await import('../messageMutations.js');

const ACCOUNT = { id: 'acct1', email: 'luke@mock.test' };
const OTHER = { id: 'acct2', email: 'vader@mock.test' };

const row = (uid, mailbox, accountId = ACCOUNT.id) => ({
  uid, subject: `Message ${uid}`, flags: [], messageId: `<${accountId}-${mailbox}-${uid}@mock>`,
  from: { address: 'sender@mock.test' }, date: '2026-08-27T09:00:00Z',
  _accountId: accountId, _mailbox: mailbox,
});

/** A branch listing rooted at `Kunden`, the shape loadSubtree leaves. */
function branchListing(emails, totalEmails) {
  useMailStore.setState({
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'Kunden',
    mailboxScope: { root: 'Kunden', paths: ['Kunden', 'Kunden/Nord'] },
    emails,
    totalEmails,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useMailStore.setState({
    accounts: [ACCOUNT, OTHER],
    activeAccountId: ACCOUNT.id,
    activeMailbox: 'INBOX',
    mailboxScope: null,
    viewMode: 'all',
    emails: [],
    sentEmails: [],
    localEmails: [],
    savedEmailIds: new Set(),
    archivedEmailIds: new Set(),
    serverUids: serverUids([], { complete: false }),
    deleteTombstones: new Set(),
    totalEmails: 0,
    selectedEmailIds: new Set(),
    selectedEmailId: null,
    error: null,
    _sortedEmailsFingerprint: '',
  });
});

describe('applyServerRemoval: the count follows the rows', () => {
  it('leaves a branch listing\'s count alone when no row in it was the message', async () => {
    // Six rows under Kunden/Nord; the root's uid 7 was never listed here.
    const rows = [1, 2, 3, 4, 5, 6].map((uid) => row(uid, 'Kunden/Nord'));
    branchListing(rows, 6);

    await applyServerRemoval(7, { accountId: ACCOUNT.id, mailbox: 'Kunden', skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(6);
    expect(useMailStore.getState().emails).toHaveLength(6);
  });

  it('does not take a subfolder row that shares the uid off a branch listing', async () => {
    // uid 3 in the ROOT is gone; uid 3 in Kunden/Nord is another message.
    branchListing([row(3, 'Kunden/Nord'), row(4, 'Kunden/Nord')], 2);

    await applyServerRemoval(3, { accountId: ACCOUNT.id, mailbox: 'Kunden', skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(2);
    expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([3, 4]);
  });

  it('drops a branch listing\'s count by one when the row was in it', async () => {
    branchListing([row(7, 'Kunden'), row(1, 'Kunden/Nord'), row(2, 'Kunden/Nord')], 3);

    await applyServerRemoval(7, { accountId: ACCOUNT.id, mailbox: 'Kunden', skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(2);
    expect(useMailStore.getState().emails.map((e) => e.uid)).toEqual([1, 2]);
  });

  it('leaves All inboxes\' count alone when no row in it was the message', async () => {
    useMailStore.setState({
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'UNIFIED',
      emails: [row(9, 'INBOX', OTHER.id), row(10, 'INBOX')],
      totalEmails: 2,
    });

    await applyServerRemoval(9, { accountId: ACCOUNT.id, mailbox: 'INBOX', isUnified: true, skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(2);
    expect(useMailStore.getState().emails).toHaveLength(2);
  });

  it('drops All inboxes\' count by one when the row was in it', async () => {
    useMailStore.setState({
      activeAccountId: ACCOUNT.id,
      activeMailbox: 'UNIFIED',
      emails: [row(9, 'INBOX', OTHER.id), row(9, 'INBOX')],
      totalEmails: 2,
    });

    await applyServerRemoval(9, { accountId: ACCOUNT.id, mailbox: 'INBOX', isUnified: true, skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(1);
    expect(useMailStore.getState().emails.map((e) => e._accountId)).toEqual([OTHER.id]);
  });

  it('still counts a single folder\'s row that is not loaded', async () => {
    // 500 rows of a 1,000-message INBOX on screen; uid 3 is further down.
    useMailStore.setState({ emails: [row(900, 'INBOX')], totalEmails: 1000 });

    await applyServerRemoval(3, { accountId: ACCOUNT.id, mailbox: 'INBOX', skipRefresh: true, clearSelection: false });

    expect(useMailStore.getState().totalEmails).toBe(999);
  });
});
