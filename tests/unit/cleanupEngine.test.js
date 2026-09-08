// @vitest-environment jsdom
/**
 * The auto-cleanup engine, driven by the rule shape the app actually stores.
 *
 * Until 2026-08-31 the engine read a spec no writer ever implemented —
 * `accountEmail`, `olderThan: { value, unit }`, `'archive-delete'` — while the
 * Add/Edit form in StorageSettings.jsx has only ever written `account`,
 * `age` + `unit`, `'archive-then-delete'`. Every rule a paying user created was
 * silently inert, and the existing coverage missed it because it seeded rules
 * in the *engine's* vocabulary instead of the form's.
 *
 * So the rule under test here is built once, from the form's own literal, and
 * put on disk through the store's own action. Nothing in this file may invent
 * a field name. The same rule applies to the Tauri commands the engine calls:
 * `archive_emails` takes `account_json`, and the engine passed `account` - the
 * invoke was rejected, the catch swallowed it, and archive-then-delete never
 * archived anything. That argument name is asserted here by parsing it back.
 *
 * Every "nothing happened" case carries a positive control, because a refused
 * rule and a broken engine produce identical silence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so it survives vi.resetModules(): the relaunch cases below re-import
// the store, and a fresh module has to read back what the last run persisted.
const persisted = vi.hoisted(() => ({}));
vi.mock('../../src/stores/safeStorage', () => ({
  safeStorage: {
    getItem: (key) => persisted[key] || null,
    setItem: (key, val) => { persisted[key] = val; },
    removeItem: (key) => { delete persisted[key]; },
  },
}));

const mockAccounts = [
  { id: 'acc-1', email: 'luke@test.com' },
  { id: 'acc-2', email: 'leia@test.com' },
];
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: mockAccounts }) },
}));

const getEmailHeaders = vi.fn();
const getCachedMailboxEntry = vi.fn();
vi.mock('../../src/services/db', () => ({ getEmailHeaders, getCachedMailboxEntry }));

const deleteEmail = vi.fn().mockResolvedValue({});
const verifyArchivedEmails = vi.fn();
const backupScanUids = vi.fn();
vi.mock('../../src/services/api', () => ({
  deleteEmail, archiveEmail: vi.fn(), verifyArchivedEmails, backupScanUids,
}));

const markServerDeleted = vi.fn().mockResolvedValue(true);
vi.mock('../../src/services/workflows/messageMutations', () => ({ markServerDeleted }));

vi.mock('../../src/services/authUtils', () => ({
  ensureFreshToken: vi.fn(a => Promise.resolve(a)),
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { useSettingsStore, migrateSettings } = await import('../../src/stores/settingsStore');
const { runCleanupRules, shouldRunCleanup } = await import('../../src/services/cleanupEngine');

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/**
 * The exact object literal StorageSettings.jsx's Add/Save handler builds.
 * If that handler's field names ever change, this is the single line that has
 * to change with it — and every test below goes red until it does.
 */
function formRule(overrides = {}) {
  return {
    account: 'all',
    folder: 'INBOX',
    age: 30,
    unit: 'days',
    action: 'delete',
    enabled: true,
    ...overrides,
  };
}

/** Save a rule the way the form does — through the store's own action. */
function saveRule(overrides) {
  useSettingsStore.getState().addCleanupRule(formRule(overrides));
}

/** Only luke has mail: one message well past any threshold, one from this week. */
const STALE_UID = 1;
const FRESH_UID = 2;
const STALE_UID_2 = 3;
const STALE_ID = '<old@test.com>';

/** A Dovecot account - no folder except INBOX is named the way the picker is. */
const MAILBOXES = [
  { path: 'INBOX', name: 'INBOX' },
  { path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent' },
  { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' },
  { path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { path: 'INBOX.Junk', name: 'Junk' },
];

/** Put these headers in luke's folder; every other (account, folder) is empty. */
function seed(emails, folder = 'INBOX') {
  getEmailHeaders.mockImplementation((accountId, mailbox) => Promise.resolve({
    emails: accountId === 'acc-1' && mailbox === folder ? emails : [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  seed([{ uid: STALE_UID, date: daysAgo(60), messageId: STALE_ID }, { uid: FRESH_UID, date: daysAgo(3) }]);
  getCachedMailboxEntry.mockResolvedValue({ lastKnownGoodMailboxes: MAILBOXES });
  verifyArchivedEmails.mockImplementation((id, mailbox, uids) =>
    Promise.resolve({ verified: [...uids], missing: [], mismatched: [] }));
  backupScanUids.mockResolvedValue(null);
  useSettingsStore.setState({
    billingProfile: PREMIUM, cleanupRules: [], shareGrant: null,
    hiddenAccounts: {}, cleanupRulesDisarmed: false,
    cleanupLastRun: null, externalBackupLocation: null,
  });
  delete window.__TAURI__;
});

describe('a rule saved by the form is a rule the engine runs', () => {
  it('deletes exactly the messages past the threshold', async () => {
    saveRule();
    const result = await runCleanupRules();

    expect(deleteEmail).toHaveBeenCalledTimes(1);
    expect(deleteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc-1' }), STALE_UID, 'INBOX', false,
    );
    expect(result).toMatchObject({ archived: 0, deleted: 1, skipped: 0 });
  });

  it('control: the same rule with a wider threshold deletes nothing', async () => {
    // Only `age` differs from the case above. If that number stopped mattering,
    // the passing test above would be proving nothing.
    saveRule({ age: 90 });
    expect(await runCleanupRules()).toMatchObject({ archived: 0, deleted: 0 });
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  it('reads months as 30 days, not as days', async () => {
    saveRule({ age: 1, unit: 'months' });   // 30 days — catches the 60-day message
    expect((await runCleanupRules()).deleted).toBe(1);

    vi.clearAllMocks();
    useSettingsStore.setState({ cleanupRules: [] });
    saveRule({ age: 3, unit: 'months' });   // 90 days — catches nothing
    expect((await runCleanupRules()).deleted).toBe(0);
  });

  it('archives before deleting, and reports both', async () => {
    window.__TAURI__ = {};
    saveRule({ action: 'archive-then-delete' });

    const result = await runCleanupRules();

    expect(invoke).toHaveBeenCalledWith('archive_emails', expect.objectContaining({
      accountId: 'acc-1', uids: [STALE_UID], mailbox: 'INBOX',
    }));
    expect(deleteEmail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ archived: 1, deleted: 1 });
  });

  // THE regression: `archive_emails` declares `account_json: String`. The engine
  // sent `account`, so every invoke was rejected before it reached the archiver
  // and the catch turned that into "skip this account" - silently, for ever.
  it('hands the archiver the account as JSON, under the name the command declares', async () => {
    window.__TAURI__ = {};
    saveRule({ action: 'archive-then-delete' });

    await runCleanupRules();

    const [, args] = invoke.mock.calls.find(([cmd]) => cmd === 'archive_emails');
    expect(JSON.parse(args.accountJson)).toMatchObject({ id: 'acc-1', email: 'luke@test.com' });
  });

  it('does not delete when the archive step fails', async () => {
    window.__TAURI__ = {};
    invoke.mockRejectedValueOnce(new Error('disk full'));
    saveRule({ action: 'archive-then-delete' });

    expect(await runCleanupRules()).toMatchObject({ archived: 0, deleted: 0, skipped: 1 });
    expect(deleteEmail).not.toHaveBeenCalled();
  });
});

describe('nothing leaves the server without a copy that is proven to be here', () => {
  beforeEach(() => {
    seed([
      { uid: STALE_UID, date: daysAgo(60), messageId: STALE_ID },
      { uid: STALE_UID_2, date: daysAgo(60) },
    ]);
  });

  it('deletes only the uids the vault verified', async () => {
    verifyArchivedEmails.mockResolvedValue({ verified: [STALE_UID], missing: [STALE_UID_2], mismatched: [] });
    saveRule();

    const result = await runCleanupRules();

    expect(deleteEmail).toHaveBeenCalledTimes(1);
    expect(deleteEmail).toHaveBeenCalledWith(expect.anything(), STALE_UID, 'INBOX', false);
    expect(result).toMatchObject({ deleted: 1, skipped: 1 });
  });

  it('treats a Message-ID that does not match as no copy at all', async () => {
    verifyArchivedEmails.mockResolvedValue({ verified: [], missing: [], mismatched: [STALE_UID, STALE_UID_2] });
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 0, skipped: 2 });
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  it('asks the vault about the Message-ID it has on file for each uid', async () => {
    saveRule();
    await runCleanupRules();

    expect(verifyArchivedEmails).toHaveBeenCalledWith(
      'acc-1', 'INBOX', [STALE_UID, STALE_UID_2], { [STALE_UID]: STALE_ID },
    );
  });

  it('deletes nothing when the verification itself fails', async () => {
    verifyArchivedEmails.mockRejectedValue(new Error('vault unreadable'));
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 0, skipped: 2 });
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  // Control for all four: with both uids verified, both do go.
  it('control: both copies verified, both server copies deleted', async () => {
    saveRule();
    expect(await runCleanupRules()).toMatchObject({ deleted: 2, skipped: 0 });
  });
});

describe('a configured external mirror is a second copy the rule must see', () => {
  beforeEach(() => {
    seed([
      { uid: STALE_UID, date: daysAgo(60) },
      { uid: STALE_UID_2, date: daysAgo(60) },
    ]);
    useSettingsStore.setState({ externalBackupLocation: '/Volumes/Backup/MailVault' });
  });

  it('deletes only what the mirror also holds', async () => {
    backupScanUids.mockResolvedValue([STALE_UID]);
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 1, skipped: 1 });
    expect(deleteEmail).toHaveBeenCalledWith(expect.anything(), STALE_UID, 'INBOX', false);
  });

  it('deletes nothing while the mirror cannot be read - an unplugged drive is not an empty one', async () => {
    backupScanUids.mockResolvedValue(null);
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 0, skipped: 2 });
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  it('control: the same unreadable answer with no mirror configured is not a veto', async () => {
    useSettingsStore.setState({ externalBackupLocation: null });
    backupScanUids.mockResolvedValue(null);
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 2, skipped: 0 });
  });
});

describe('the picker\'s word is resolved against the account\'s own folder list', () => {
  it("'Sent' reaches INBOX.Sent, which is where the mail is", async () => {
    seed([{ uid: STALE_UID, date: daysAgo(60) }], 'INBOX.Sent');
    saveRule({ folder: 'Sent' });

    expect((await runCleanupRules()).deleted).toBe(1);
    expect(deleteEmail).toHaveBeenCalledWith(expect.anything(), STALE_UID, 'INBOX.Sent', false);
  });

  it("'all' walks every selectable folder except Drafts", async () => {
    saveRule({ folder: 'all' });
    await runCleanupRules();

    const folders = getEmailHeaders.mock.calls.filter(([id]) => id === 'acc-1').map(([, f]) => f);
    expect(folders).toEqual(['INBOX', 'INBOX.Sent', 'INBOX.Trash', 'INBOX.Junk']);
  });

  it('deletes permanently only from the Trash-role folder', async () => {
    seed([{ uid: STALE_UID, date: daysAgo(60) }], 'INBOX.Trash');
    saveRule({ folder: 'Trash' });

    await runCleanupRules();
    expect(deleteEmail).toHaveBeenCalledWith(expect.anything(), STALE_UID, 'INBOX.Trash', true);
  });

  it('skips an account whose folder list was never cached', async () => {
    getCachedMailboxEntry.mockResolvedValue(null);
    saveRule();

    expect(await runCleanupRules()).toMatchObject({ deleted: 0 });
    expect(getEmailHeaders).not.toHaveBeenCalled();
  });

  it('control: the same account with a cached list is cleaned', async () => {
    getCachedMailboxEntry.mockResolvedValue({ mailboxes: MAILBOXES });
    saveRule();
    expect((await runCleanupRules()).deleted).toBe(1);
  });
});

describe('a deleted server copy leaves the vault row marked as the only one', () => {
  it('stamps every uid it deleted, and only those', async () => {
    seed([
      { uid: STALE_UID, date: daysAgo(60) },
      { uid: STALE_UID_2, date: daysAgo(60) },
    ]);
    verifyArchivedEmails.mockResolvedValue({ verified: [STALE_UID], missing: [STALE_UID_2], mismatched: [] });
    saveRule();

    await runCleanupRules();

    expect(markServerDeleted).toHaveBeenCalledTimes(1);
    expect(markServerDeleted).toHaveBeenCalledWith('acc-1', 'INBOX', STALE_UID);
  });

  it('a failed stamp does not un-delete the message', async () => {
    markServerDeleted.mockRejectedValueOnce(new Error('no index'));
    saveRule();
    expect((await runCleanupRules()).deleted).toBe(1);
  });
});

describe('account scoping uses the form\'s own sentinel', () => {
  it("'all' reaches every visible account", async () => {
    saveRule({ account: 'all' });
    await runCleanupRules();
    expect(getEmailHeaders).toHaveBeenCalledWith('acc-1', 'INBOX');
    expect(getEmailHeaders).toHaveBeenCalledWith('acc-2', 'INBOX');
  });

  it('a specific address reaches only that account', async () => {
    saveRule({ account: 'luke@test.com' });
    expect((await runCleanupRules()).deleted).toBe(1);
    expect(getEmailHeaders).not.toHaveBeenCalledWith('acc-2', 'INBOX');
  });

  it("control: a rule scoped to the other account leaves luke's mail alone", async () => {
    saveRule({ account: 'leia@test.com' });
    expect((await runCleanupRules()).deleted).toBe(0);
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  it('a hidden account is not cleaned', async () => {
    useSettingsStore.setState({ hiddenAccounts: { 'acc-1': true } });
    saveRule();
    expect((await runCleanupRules()).deleted).toBe(0);
  });
});

describe('a rule the engine cannot read must refuse, never fall through to "everything"', () => {
  // `thresholdToMs` used to return 0 for an unreadable rule, and 0 was the same
  // value as "no threshold configured". Once the field names line up, 0 would
  // have meant a cutoff of *now* — every message stale.
  const refusals = [
    ['no age at all', { age: undefined }],
    ['an age that is not a number', { age: 'thirty' }],
    ['an age of zero', { age: 0 }],
    ['a negative age', { age: -30 }],
    ['an unknown unit', { unit: 'fortnights' }],
    ['an age below the 7-day floor the form enforces', { age: 1 }],
    ['the engine\'s old action spelling', { action: 'archive-delete' }],
    ['an action nobody recognises', { action: 'shred' }],
    ['a protected folder', { folder: 'Drafts' }],
  ];

  for (const [label, overrides] of refusals) {
    it(`refuses ${label}`, async () => {
      saveRule(overrides);
      expect(await runCleanupRules()).toMatchObject({ archived: 0, deleted: 0 });
      expect(deleteEmail).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    });
  }

  it('control: the same rule without the defect does delete', async () => {
    saveRule();
    expect((await runCleanupRules()).deleted).toBe(1);
  });
});

describe('the 24h guard is a stored fact, not a module variable', () => {
  it('records what the run did, where a relaunch can still read it', async () => {
    saveRule();
    const result = await runCleanupRules();

    const stored = useSettingsStore.getState().cleanupLastRun;
    expect(stored).toMatchObject({ archived: 0, deleted: 1, skipped: 0 });
    expect(stored.at).toBe(result.at);
    expect(shouldRunCleanup()).toBe(false);
  });

  it('a fresh module does not run again straight after a stored run', async () => {
    saveRule();
    await runCleanupRules();

    vi.resetModules();
    const fresh = await import('../../src/services/cleanupEngine');
    await new Promise(r => setTimeout(r, 0));   // let the store rehydrate
    expect(fresh.shouldRunCleanup()).toBe(false);
  });

  it('control: a fresh module with an old stored run does arm', async () => {
    useSettingsStore.setState({
      cleanupLastRun: { at: Date.now() - 3 * DAY, archived: 0, deleted: 0, skipped: 0 },
    });

    vi.resetModules();
    const fresh = await import('../../src/services/cleanupEngine');
    await new Promise(r => setTimeout(r, 0));
    expect(fresh.shouldRunCleanup()).toBe(true);
  });
});

describe('v4 → v5 migration disarms rules that were never able to run', () => {
  it('keeps the config and switches the rule off', () => {
    const stored = { cleanupRules: [{ ...formRule(), id: 'r1' }] };
    const next = migrateSettings(stored, 4);

    expect(next.cleanupRules).toEqual([{
      id: 'r1', account: 'all', folder: 'INBOX',
      age: 30, unit: 'days', action: 'delete', enabled: false,
    }]);
    expect(next.cleanupRulesDisarmed).toBe(true);
  });

  it('upgrades a rule written in the engine\'s old vocabulary', () => {
    const legacy = {
      id: 'r2', enabled: true, accountEmail: '*', folder: 'Trash',
      olderThan: { value: 90, unit: 'months' }, action: 'archive-delete',
    };
    const [rule] = migrateSettings({ cleanupRules: [legacy] }, 4).cleanupRules;

    expect(rule).toEqual({
      id: 'r2', account: 'all', folder: 'Trash',
      age: 90, unit: 'months', action: 'archive-then-delete', enabled: false,
    });
  });

  it('maps a named account out of accountEmail', () => {
    const legacy = { id: 'r3', accountEmail: 'luke@test.com', folder: 'INBOX', olderThan: { value: 30, unit: 'days' }, action: 'delete', enabled: true };
    expect(migrateSettings({ cleanupRules: [legacy] }, 4).cleanupRules[0].account).toBe('luke@test.com');
  });

  it('a disarmed rule does nothing when the engine next runs', async () => {
    const migrated = migrateSettings({ cleanupRules: [{ ...formRule(), id: 'r1' }] }, 4);
    useSettingsStore.setState({ cleanupRules: migrated.cleanupRules });

    expect(await runCleanupRules()).toEqual({ archived: 0, deleted: 0 });
    expect(getEmailHeaders).not.toHaveBeenCalled();
  });

  it('leaves rules alone once the migration has already run', () => {
    const already = { cleanupRules: [{ ...formRule(), id: 'r1' }], cleanupRulesDisarmed: false };
    const next = migrateSettings(already, 5);

    expect(next.cleanupRules[0].enabled).toBe(true);
    expect(next.cleanupRulesDisarmed).toBe(false);
  });

  it('still clears linkAlerts on the older hop, and disarms in the same pass', () => {
    const next = migrateSettings(
      { linkAlerts: { '42': 'suspicious' }, cleanupRules: [{ ...formRule(), id: 'r1' }] },
      3,
    );
    expect(next.linkAlerts).toEqual({});
    expect(next.cleanupRules[0].enabled).toBe(false);
  });

  it('a fresh install has nothing to migrate', () => {
    expect(migrateSettings(undefined, 4)).toBeUndefined();
    expect(migrateSettings({ cleanupRules: [] }, 4).cleanupRulesDisarmed).toBeUndefined();
  });
});
