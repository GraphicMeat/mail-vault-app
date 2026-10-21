// @vitest-environment jsdom
/**
 * Characterises src/services/cleanupEngine.js on the shared fixture
 * src-core/tests/fixtures/cleanup-rule-cases.json, before the rules move into
 * the daemon. Every vault copy verifies and no mirror is configured, so the
 * `imap_delete_email` calls ARE the rule's selection: which account, folder,
 * uid, and whether the delete is permanent. src-core/src/cleanup_rules.rs
 * must select exactly these.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync('src-core/tests/fixtures/cleanup-rule-cases.json', 'utf8'));

vi.mock('../../src/stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}));

const current = vi.hoisted(() => ({ kase: null }));
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: current.kase.accounts }) },
}));

const getEmailHeaders = vi.fn(async (accountId, mailbox) => ({
  emails: current.kase.headers?.[accountId]?.[mailbox] || [],
}));
const getCachedMailboxEntry = vi.fn(async (accountId) => {
  const entry = current.kase.mailboxes?.[accountId];
  if (entry === undefined) return null;
  // db.getCachedMailboxEntry's own reading of the old array shape.
  if (Array.isArray(entry)) return { mailboxes: entry, lastKnownGoodMailboxes: null };
  return { mailboxes: entry.mailboxes || null, lastKnownGoodMailboxes: entry.lastKnownGoodMailboxes || null };
});
vi.mock('../../src/services/db', () => ({ getEmailHeaders, getCachedMailboxEntry }));

const deleteEmail = vi.fn().mockResolvedValue({});
const verifyArchivedEmails = vi.fn(async (id, mailbox, uids) => ({ verified: [...uids], missing: [], mismatched: [] }));
vi.mock('../../src/services/api', () => ({
  deleteEmail, verifyArchivedEmails, backupScanUids: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/workflows/messageMutations', () => ({ markServerDeleted: vi.fn().mockResolvedValue(true) }));
const send = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/transport.js', () => ({ send }));

const { useSettingsStore } = await import('../../src/stores/settingsStore');
const { runCleanupRules } = await import('../../src/services/cleanupEngine');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fixture.now);
  vi.clearAllMocks();
  window.__TAURI__ = {};
});

afterEach(() => {
  vi.useRealTimers();
  delete window.__TAURI__;
});

describe('cleanupEngine.js on the shared cleanup fixture', () => {
  it.each(fixture.cases.map((c) => [c.name, c]))('%s', async (_name, kase) => {
    current.kase = kase;
    useSettingsStore.setState({
      billingProfile: kase.billingProfile,
      shareGrant: kase.shareGrant,
      hiddenAccounts: kase.hiddenAccounts,
      cleanupRules: kase.rules,
      externalBackupLocation: null,
      cleanupLastRun: null,
    });

    const result = await runCleanupRules();

    if (kase.expect.result.ran) {
      const { archived, deleted, skipped } = kase.expect.result;
      expect(result).toEqual({ archived, deleted, skipped, at: fixture.now });
    } else {
      expect(result).toEqual({ archived: 0, deleted: 0 });
    }
    const deletes = deleteEmail.mock.calls.map(([account, uid, folder, permanent, opts]) => {
      expect(opts).toEqual({ bin: false });
      return [account.id, folder, uid, permanent];
    });
    expect(deletes).toEqual(kase.expect.deletes);
    const archives = send.mock.calls
      .filter(([cmd]) => cmd === 'archive_emails')
      .map(([, args]) => [args.accountId, args.mailbox, args.uids]);
    expect(archives).toEqual(kase.expect.archives || []);
  });
});
