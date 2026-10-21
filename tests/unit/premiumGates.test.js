// @vitest-environment jsdom
/**
 * Premium gates that live BELOW the UI.
 *
 * Every gated screen is easy to see and easy to test. The gates that actually
 * decide whether work happens are in services, and one of them was missing
 * entirely until 2026-08-27 (automatic backups ran for anyone who flipped the
 * master switch). These are the remaining three, pinned so the next one that
 * goes missing shows up as a red test rather than as a support question.
 *
 * Each case has a negative control: without one, "no premium → nothing
 * happened" passes for free, because "nothing to do" also produces nothing.
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

const daemonCall = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../../src/services/daemonClient.js', () => ({ daemonCall }));

const { useSettingsStore } = await import('../../src/stores/settingsStore');
const { syncNow } = await import('../../src/services/syncService.js');

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const FREE = { hasSubscription: false };

/**
 * A rule in the shape StorageSettings.jsx saves. Whether rules RUN without
 * premium is the daemon's gate now (`cleanup_rules::has_premium_access`,
 * pinned with the old engine's answers in
 * src-core/tests/fixtures/cleanup-rule-cases.json); the store's own gate on
 * writing them stays here.
 */
const liveRule = {
  id: 'rule-1', enabled: true, account: 'all', folder: 'INBOX',
  age: 30, unit: 'days', action: 'delete',
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ billingProfile: FREE, cleanupRules: [], shareGrant: null, hiddenAccounts: {} });
});

describe('syncNow — auto-classification is the premium half of a sync', () => {
  const account = { id: 'acc-1', email: 'luke@test.com' };

  it('asks the daemon not to classify without premium', async () => {
    useSettingsStore.setState({ billingProfile: FREE });
    await syncNow(account, 'INBOX');
    expect(daemonCall).toHaveBeenCalledWith('sync.now', { account, mailbox: 'INBOX', autoClassify: false });
  });

  it('asks it to classify with premium — the sync itself is never gated', async () => {
    useSettingsStore.setState({ billingProfile: PREMIUM });
    await syncNow(account, 'INBOX');
    expect(daemonCall).toHaveBeenCalledWith('sync.now', { account, mailbox: 'INBOX', autoClassify: true });
    // Both calls happened: mail keeps syncing either way, only the extra work
    // is withheld.
    expect(daemonCall).toHaveBeenCalledTimes(1);
  });
});

describe('cleanup rules — the store refuses to write them without premium', () => {
  const rule = { enabled: true, accountEmail: '*', folder: 'INBOX', olderThan: { value: 30, unit: 'days' }, action: 'delete' };

  it('will not add a rule', () => {
    useSettingsStore.setState({ billingProfile: FREE, cleanupRules: [] });
    useSettingsStore.getState().addCleanupRule(rule);
    expect(useSettingsStore.getState().cleanupRules).toEqual([]);
  });

  it('control: adds it with premium', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM, cleanupRules: [] });
    useSettingsStore.getState().addCleanupRule(rule);
    expect(useSettingsStore.getState().cleanupRules).toHaveLength(1);
    expect(useSettingsStore.getState().cleanupRules[0].id).toBeTruthy();
  });

  it('will not edit or toggle a rule left behind by a lapsed subscription', () => {
    useSettingsStore.setState({ billingProfile: FREE, cleanupRules: [{ ...liveRule }] });
    useSettingsStore.getState().updateCleanupRule('rule-1', { folder: 'Archive' });
    useSettingsStore.getState().toggleCleanupRule('rule-1');
    const [after] = useSettingsStore.getState().cleanupRules;
    expect(after.folder).toBe('INBOX');
    expect(after.enabled).toBe(true);
  });

  // Deliberate asymmetry: removal is not gated. Someone whose subscription
  // ended must still be able to delete a rule they can no longer edit.
  it('always lets a rule be removed, premium or not', () => {
    useSettingsStore.setState({ billingProfile: FREE, cleanupRules: [{ ...liveRule }] });
    useSettingsStore.getState().removeCleanupRule('rule-1');
    expect(useSettingsStore.getState().cleanupRules).toEqual([]);
  });
});
