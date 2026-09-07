/**
 * What the active account's body pipeline is allowed to fetch.
 *
 * Two values used to come straight off the store, and in All Inboxes both were
 * wrong: `emails` holds EVERY account's rows, and `activeMailbox` is the
 * literal 'UNIFIED'. The app logged the result on every unified session —
 *
 *   [CMD] imap_get_email_light: FAILED uid=910 mailbox=UNIFIED
 *     Failed to fetch email: SELECT UNIFIED failed: [NONEXISTENT] Mailbox does not exist
 *
 * — so no body was ever cached in that view, and each refused uid went back on
 * the retry queue for the life of the session.
 *
 * A uid names a message only inside one (account, mailbox), so this is the
 * same class of bug as the unified delete/undo work: a spanning view's
 * `activeMailbox` is not a folder, and its rows are not all yours.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const startContentCaching = vi.fn(() => Promise.resolve());
const resume = vi.fn();

vi.mock('../AccountPipeline', () => ({
  AccountPipeline: class {
    constructor() {
      this._destroyed = false;
      this._activeSlots = 0;
      this.startContentCaching = startContentCaching;
      this.resume = resume;
    }
    destroy() { this._destroyed = true; }
    waitForComplete() { return Promise.resolve(); }
  },
}));

vi.mock('../authUtils', () => ({ hasValidCredentials: () => true }));

const store = vi.hoisted(() => ({ state: {} }));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => store.state, setState: vi.fn(), subscribe: () => () => {} },
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ hiddenAccounts: {}, localCacheDurationMonths: 0, cacheLimitMB: 128 }),
  },
}));

vi.mock('../db', () => ({
  getSavedEmailIds: vi.fn().mockResolvedValue(new Set()),
  saveMailboxes: vi.fn().mockResolvedValue(undefined),
  getCachedMailboxEntry: vi.fn().mockResolvedValue(null),
}));

vi.mock('../graphConfig', () => ({
  GRAPH_FOLDER_NAME_MAP: {},
  normalizeGraphFolderName: (n) => n,
  isGraphAccount: () => false,
}));

vi.mock('../../utils/sentFolder', () => ({ waitForSentMailboxPath: vi.fn().mockResolvedValue('Sent') }));

const { pipelineManager } = await import('../EmailPipelineManager');

const LUKE = { id: 'luke', email: 'luke@x' };
const YODA = { id: 'yoda', email: 'yoda@x' };

/** A unified row: stamped with the account and the folder resolved for it. */
const uRow = (uid, accountId, mailbox) => ({
  uid, _accountId: accountId, _mailbox: mailbox, date: '2026-09-01T10:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  pipelineManager.pipelines.clear();
  pipelineManager._activeAccountId = null;
  pipelineManager._contentCascadeDone.clear();
  // The two fan-outs this spec is not about. Left live they reach db and the
  // network on a timer and make the assertions below race them.
  pipelineManager._loadSentHeaders = vi.fn();
  pipelineManager._startBackgroundHeadersOnly = vi.fn();
});

describe('the active account pipeline in a view that spans mailboxes', () => {
  it('fetches its own account\'s uids from a real folder, never "UNIFIED"', async () => {
    store.state = {
      accounts: [LUKE, YODA],
      activeMailbox: 'UNIFIED',
      emails: [
        uRow(1, 'luke', 'INBOX'),
        uRow(2, 'luke', 'INBOX'),
        uRow(910, 'yoda', 'INBOX'),
      ],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    expect(startContentCaching).toHaveBeenCalledTimes(1);
    const [uids, mailbox] = startContentCaching.mock.calls[0];
    // yoda's 910 is not luke's to fetch — a uid names a message only inside
    // one (account, mailbox), so fetching it against luke reads a different
    // message or nothing at all.
    expect(uids).toEqual([1, 2]);
    expect(mailbox).toBe('INBOX');
    expect(mailbox).not.toBe('UNIFIED');
  });

  it('takes the folder from the rows, so a namespaced server gets its own path', async () => {
    // Dovecot/Hostinger resolve the unified folder to `INBOX.…` per account;
    // loadUnifiedInbox stamps that resolved path on every row it builds.
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'UNIFIED',
      emails: [uRow(4, 'luke', 'INBOX.Archive')],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    expect(startContentCaching).toHaveBeenCalledWith([4], 'INBOX.Archive');
  });

  it('leaves a single-folder view exactly as it was', async () => {
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'Archive',
      emails: [{ uid: 11, date: '2026-09-01T10:00:00Z' }, { uid: 12, date: '2026-09-01T10:00:00Z' }],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');

    // No `_accountId` on these rows and none needed: one folder, one account.
    expect(startContentCaching).toHaveBeenCalledWith([11, 12], 'Archive');
  });

  it('reuses an idle pipeline against the resolved folder, not the literal', async () => {
    store.state = {
      accounts: [LUKE],
      activeMailbox: 'UNIFIED',
      emails: [uRow(1, 'luke', 'INBOX')],
      savedEmailIds: new Set(),
    };

    await pipelineManager.startActiveAccountPipeline('luke');
    await pipelineManager.startActiveAccountPipeline('luke');

    // The second call reuses the live pipeline and resumes it — that path read
    // `activeMailbox` too.
    expect(resume).toHaveBeenCalledWith('INBOX');
    expect(resume).not.toHaveBeenCalledWith('UNIFIED');
  });
});
