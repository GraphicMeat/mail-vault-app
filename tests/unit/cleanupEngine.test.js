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
 * a field name.
 *
 * Every "nothing happened" case carries a positive control, because a refused
 * rule and a broken engine produce identical silence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

const mockAccounts = [
  { id: 'acc-1', email: 'luke@test.com' },
  { id: 'acc-2', email: 'leia@test.com' },
];
vi.mock('../../src/stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: mockAccounts }) },
}));

const getEmailHeaders = vi.fn();
vi.mock('../../src/services/db', () => ({ getEmailHeaders }));

const deleteEmail = vi.fn().mockResolvedValue({});
vi.mock('../../src/services/api', () => ({ deleteEmail, archiveEmail: vi.fn() }));

vi.mock('../../src/services/authUtils', () => ({
  ensureFreshToken: vi.fn(a => Promise.resolve(a)),
}));

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { useSettingsStore, migrateSettings } = await import('../../src/stores/settingsStore');
const { runCleanupRules } = await import('../../src/services/cleanupEngine');

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

beforeEach(() => {
  vi.clearAllMocks();
  getEmailHeaders.mockImplementation((accountId) => Promise.resolve({
    emails: accountId === 'acc-1'
      ? [{ uid: STALE_UID, date: daysAgo(60) }, { uid: FRESH_UID, date: daysAgo(3) }]
      : [],
  }));
  useSettingsStore.setState({
    billingProfile: PREMIUM, cleanupRules: [], shareGrant: null,
    hiddenAccounts: {}, cleanupRulesDisarmed: false,
  });
  delete window.__TAURI__;
});

describe('a rule saved by the form is a rule the engine runs', () => {
  it('deletes exactly the messages past the threshold', async () => {
    saveRule();
    const result = await runCleanupRules();

    expect(deleteEmail).toHaveBeenCalledTimes(1);
    expect(deleteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc-1' }), STALE_UID, 'INBOX',
    );
    expect(result).toEqual({ archived: 0, deleted: 1 });
  });

  it('control: the same rule with a wider threshold deletes nothing', async () => {
    // Only `age` differs from the case above. If that number stopped mattering,
    // the passing test above would be proving nothing.
    saveRule({ age: 90 });
    expect(await runCleanupRules()).toEqual({ archived: 0, deleted: 0 });
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
    expect(result).toEqual({ archived: 1, deleted: 1 });
  });

  it('does not delete when the archive step fails', async () => {
    window.__TAURI__ = {};
    invoke.mockRejectedValueOnce(new Error('disk full'));
    saveRule({ action: 'archive-then-delete' });

    expect(await runCleanupRules()).toEqual({ archived: 0, deleted: 0 });
    expect(deleteEmail).not.toHaveBeenCalled();
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
      expect(await runCleanupRules()).toEqual({ archived: 0, deleted: 0 });
      expect(deleteEmail).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    });
  }

  it('control: the same rule without the defect does delete', async () => {
    saveRule();
    expect((await runCleanupRules()).deleted).toBe(1);
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
