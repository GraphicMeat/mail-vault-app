// @vitest-environment jsdom
//
// In-app lifecycle messages: the daemon decides what is due (`lifecycle.sync`),
// the store only holds the rows it answers, opens one in the reader and tells
// the daemon what was read or dismissed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ appStore: false }));
vi.mock('../../utils/buildFlags', () => ({
  get IS_APPSTORE_BUILD() { return flags.appStore; },
  IAP_PRODUCT_BACKUPS: 'com.mailvault.app.backups',
}));
vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  lifecycleSync: vi.fn(),
  lifecycleMarkSeen: vi.fn(),
  lifecycleDismiss: vi.fn(),
}));

const api = await import('../../services/api');
const { useSettingsStore } = await import('../settingsStore');
const { useLifecycleStore, lifecycleState, lifecycleInView, lifecycleKeys } = await import('../lifecycleStore');

const ROW = { id: 'trial-ending:20400', kind: 'trial-ending', atMs: 1000, seen: false, dismissed: false };
const OTHER = { id: 'free-nudge', kind: 'free-nudge', atMs: 500, seen: false, dismissed: false };

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useLifecycleStore.setState({ rows: [], openId: null, lastSyncAt: 0 });
  flags.appStore = false;
  for (const fn of [api.lifecycleSync, api.lifecycleMarkSeen, api.lifecycleDismiss]) fn.mockReset();
  api.lifecycleSync.mockResolvedValue({ rows: [ROW] });
  api.lifecycleMarkSeen.mockResolvedValue({ rows: [{ ...ROW, seen: true }] });
  api.lifecycleDismiss.mockResolvedValue({ rows: [] });
});

describe('lifecycleState', () => {
  it('hands the daemon the four facts it decides on and nothing else of the profile', () => {
    const state = lifecycleState({
      lifecycleMessages: true, onboardingComplete: true, lifecycleCheckoutAt: 5,
      language: 'de', billingEmail: 'me@example.com',
      billingProfile: {
        premiumAccess: true, hasSubscription: true, status: 'trialing', currentPeriodEnd: '2026-11-05T10:00:00Z',
        customerId: 'cus_1', customerEmail: 'me@example.com', activeClients: [{ clientId: 'c' }],
      },
    });
    expect(state).toEqual({
      lifecycleMessages: true, onboardingComplete: true, lifecycleCheckoutAt: 5,
      billingProfile: { premiumAccess: true, hasSubscription: true, status: 'trialing', currentPeriodEnd: '2026-11-05T10:00:00Z' },
    });
  });

  it('sends no profile when there is none', () => {
    expect(lifecycleState({ lifecycleMessages: true, onboardingComplete: false, lifecycleCheckoutAt: null, billingProfile: null }).billingProfile)
      .toBeNull();
  });
});

describe('sync', () => {
  it('asks the daemon with the current settings and keeps the rows it answers', async () => {
    useSettingsStore.setState({ onboardingComplete: true, lifecycleCheckoutAt: 7, billingProfile: { premiumAccess: false, hasSubscription: false, status: null } });
    await useLifecycleStore.getState().sync();
    expect(api.lifecycleSync).toHaveBeenCalledWith({
      lifecycleMessages: true, onboardingComplete: true, lifecycleCheckoutAt: 7,
      billingProfile: { premiumAccess: false, hasSubscription: false, status: null, currentPeriodEnd: undefined },
    });
    expect(useLifecycleStore.getState().rows).toEqual([ROW]);
  });

  it('switched off: shows nothing and does not ask', async () => {
    useLifecycleStore.setState({ rows: [ROW], openId: ROW.id });
    useSettingsStore.setState({ lifecycleMessages: false });
    await useLifecycleStore.getState().sync();
    expect(api.lifecycleSync).not.toHaveBeenCalled();
    expect(useLifecycleStore.getState()).toMatchObject({ rows: [], openId: null });
  });

  it('never asks in the App Store build', async () => {
    flags.appStore = true;
    await useLifecycleStore.getState().sync();
    expect(api.lifecycleSync).not.toHaveBeenCalled();
    expect(useLifecycleStore.getState().rows).toEqual([]);
  });

  it('keeps what it had when the daemon cannot answer', async () => {
    useLifecycleStore.setState({ rows: [ROW] });
    api.lifecycleSync.mockRejectedValue(new Error('no daemon'));
    await useLifecycleStore.getState().sync();
    expect(useLifecycleStore.getState().rows).toEqual([ROW]);
  });

  it('shares one request between callers that overlap', async () => {
    let answer;
    api.lifecycleSync.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const a = useLifecycleStore.getState().sync();
    const b = useLifecycleStore.getState().sync();
    answer({ rows: [ROW] });
    await Promise.all([a, b]);
    expect(api.lifecycleSync).toHaveBeenCalledTimes(1);
  });

  it('closes a message the daemon no longer lists', async () => {
    useLifecycleStore.setState({ rows: [ROW], openId: ROW.id });
    api.lifecycleSync.mockResolvedValue({ rows: [OTHER] });
    await useLifecycleStore.getState().sync();
    expect(useLifecycleStore.getState().openId).toBeNull();
  });

  it('records when it last asked, so a caller can leave a fresh answer alone', async () => {
    expect(useLifecycleStore.getState().lastSyncAt).toBe(0);
    await useLifecycleStore.getState().sync();
    expect(useLifecycleStore.getState().lastSyncAt).toBeGreaterThan(0);
  });
});

describe('open, seen and dismiss', () => {
  it('opening a message shows it, marks it read at once and tells the daemon', async () => {
    useLifecycleStore.setState({ rows: [ROW, OTHER] });
    useLifecycleStore.getState().open(ROW.id);
    const state = useLifecycleStore.getState();
    expect(state.openId).toBe(ROW.id);
    expect(state.rows.find(r => r.id === ROW.id).seen).toBe(true);
    expect(state.rows.find(r => r.id === OTHER.id).seen).toBe(false);
    expect(api.lifecycleMarkSeen).toHaveBeenCalledWith(ROW.id);
  });

  it('opening a message that is already read does not tell the daemon again', () => {
    useLifecycleStore.setState({ rows: [{ ...ROW, seen: true }] });
    useLifecycleStore.getState().open(ROW.id);
    expect(api.lifecycleMarkSeen).not.toHaveBeenCalled();
    expect(useLifecycleStore.getState().openId).toBe(ROW.id);
  });

  it('dismissing removes the row at once, closes it if open and tells the daemon', () => {
    useLifecycleStore.setState({ rows: [ROW, OTHER], openId: ROW.id });
    useLifecycleStore.getState().dismiss(ROW.id);
    expect(useLifecycleStore.getState()).toMatchObject({ rows: [OTHER], openId: null });
    expect(api.lifecycleDismiss).toHaveBeenCalledWith(ROW.id);
  });

  it('dismissing another row leaves the open one open', () => {
    useLifecycleStore.setState({ rows: [ROW, OTHER], openId: ROW.id });
    useLifecycleStore.getState().dismiss(OTHER.id);
    expect(useLifecycleStore.getState().openId).toBe(ROW.id);
  });

  it('close leaves the rows alone', () => {
    useLifecycleStore.setState({ rows: [ROW], openId: ROW.id });
    useLifecycleStore.getState().close();
    expect(useLifecycleStore.getState()).toMatchObject({ rows: [ROW], openId: null });
  });

  it('a daemon that fails to record the read changes nothing the user sees', async () => {
    api.lifecycleMarkSeen.mockRejectedValue(new Error('no daemon'));
    useLifecycleStore.setState({ rows: [ROW] });
    useLifecycleStore.getState().open(ROW.id);
    await Promise.resolve();
    expect(useLifecycleStore.getState().rows[0].seen).toBe(true);
  });
});

describe('where the rows are pinned', () => {
  const rows = [ROW];
  it('above an account inbox and above All inboxes', () => {
    expect(lifecycleInView({ activeMailbox: 'INBOX' }, rows)).toEqual(rows);
    expect(lifecycleInView({ activeMailbox: 'UNIFIED', unifiedFolder: 'INBOX' }, rows)).toEqual(rows);
  });

  it('nowhere else: another folder, another unified folder, a branch listing', () => {
    expect(lifecycleInView({ activeMailbox: 'Sent' }, rows)).toEqual([]);
    expect(lifecycleInView({ activeMailbox: 'UNIFIED', unifiedFolder: 'Sent' }, rows)).toEqual([]);
    expect(lifecycleInView({ activeMailbox: 'INBOX', mailboxScope: { path: 'Work' } }, rows)).toEqual([]);
  });
});

describe('lifecycleKeys', () => {
  it('names the catalog keys of every kind the daemon can deliver', () => {
    for (const kind of ['trial-ending', 'checkout-left', 'plan-ended', 'free-nudge']) {
      const keys = lifecycleKeys(kind);
      expect(keys.subjectKey, kind).toMatch(/^lifecycle\.[a-zA-Z]+\.subject$/);
      expect(keys.bodyKey, kind).toMatch(/^lifecycle\.[a-zA-Z]+\.body$/);
    }
  });

  it('answers nothing for a kind a newer daemon invented', () => {
    expect(lifecycleKeys('from-the-future')).toBeNull();
  });
});
