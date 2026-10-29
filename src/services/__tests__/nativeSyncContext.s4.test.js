// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
const listeners = new Map();
let accounts = [];
let view = { activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false };
let saved = { graphFolderKeysAdopted: {}, graphFolderKeysAdoptedFromListing: {} };
let refreshReply = null;
let refreshError = null;
let settingsReply = undefined;

window.__TAURI__ = { core: { invoke: vi.fn(async (name, args) => {
  calls.push([name, args]);
  if (name === 'daemon_channel_notify') {
    queueMicrotask(() => listeners.get('sync-owner')?.({ payload: {
      ...args.params, instanceId: 'native-1', accepted: true,
    } }));
  }
}) } };
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, cb) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
} }));
vi.mock('../../stores/mailStore.js', () => ({ useMailStore: { getState: () => ({ ...view, accounts }) } }));
vi.mock('../../stores/settingsStore.js', () => ({ useSettingsStore: { getState: () => ({
  graphFolderKeysAdoptedFromListing: saved.graphFolderKeysAdoptedFromListing,
  setLastRefreshTime: vi.fn(),
}) } }));
vi.mock('../graphConfig.js', () => ({ isGraphAccount: account => account?.transport === 'graph' }));
vi.mock('../workflows/adoptGraphFolderKeys.js', () => ({
  adoptGraphFolderKeys: vi.fn(async () => {}),
  adoptGraphFolderKeysFromListing: vi.fn(async account => {
    saved.graphFolderKeysAdoptedFromListing[account.id] = true;
  }),
}));
vi.mock('../api.js', () => ({ graphListFolders: vi.fn(async () => []) }));
vi.mock('../db/accounts.js', () => ({ accountExpectedContext: account => ({
  id: account.id, email: account.email, transport: account.transport,
}) }));
vi.mock('../daemonClient.js', () => ({ daemonCall: vi.fn(async (method, params) => {
  calls.push([method, params]);
  if (method === 'sync.refresh_status') return params?.requestId
    ? { instanceId: 'native-1', found: true, receipts: [refreshReply || { status: 'complete' }] }
    : { instanceId: 'native-1', lastRefreshTime: 123 };
  if (method === 'sync.context') return { instanceId: 'native-1', accepted: true, revision: params.revision };
  if (method === 'settings.get') return settingsReply !== undefined ? settingsReply
    : { values: { 'mailvault-settings': { state: saved } }, version: 1 };
  if (method === 'sync.refresh') {
    if (refreshError) throw refreshError;
    return { instanceId: 'native-1', receipt: refreshReply || { status: 'complete' } };
  }
  throw new Error(`Unexpected native method: ${method}`);
}) }));

let bridge;
const methods = method => calls.filter(([name]) => name === method).map(([, params]) => params);

beforeEach(async () => {
  vi.resetModules();
  bridge = await import('../nativeSyncContext.js');
  calls.length = 0;
  accounts = [{ id: 'a', email: 'a@test', transport: 'imap' },
    { id: 'b', email: 'b@test', transport: 'imap' }];
  view = { activeAccountId: 'a', activeMailbox: 'INBOX', unifiedInbox: false };
  saved = { graphFolderKeysAdopted: {}, graphFolderKeysAdoptedFromListing: {} };
  refreshReply = { status: 'complete', accountResults: [{ accountId: 'a', success: true }] };
  refreshError = null;
  settingsReply = undefined;
});

describe('native sync context and intent bridge', () => {
  it('waits for the same-channel owner ACK before the first context and resumes one launch', async () => {
    await bridge.observeNativeView();
    await bridge.connectNativeSync({ channelChanged: true });
    expect(calls.map(([name]) => name).slice(0, 3)).toEqual([
      'sync.refresh_status', 'daemon_channel_notify', 'sync.context',
    ]);
    const first = methods('sync.context')[0];
    expect(first).toMatchObject({ phase: 'start', view: { accountId: 'a', mailbox: 'INBOX' } });
    await bridge.connectNativeSync({ channelChanged: true });
    const second = methods('sync.context')[1];
    expect(second).toMatchObject({ phase: 'resume', launchId: first.launchId,
      revision: first.revision + 1 });
    expect(methods('daemon_channel_notify')).toHaveLength(2);
  });

  it('sends strict unified and subtree view facts while preserving the launch ID', async () => {
    await bridge.observeNativeView();
    await bridge.connectNativeSync();
    const first = methods('sync.context').at(-1).launchId;
    view = { activeMailbox: 'UNIFIED', unifiedInbox: true, unifiedFolder: 'Archive' };
    await bridge.observeNativeView();
    expect(methods('sync.context').at(-1)).toMatchObject({ phase: 'resume', launchId: first,
      view: { accountId: null, mailbox: 'UNIFIED', unifiedFolder: 'Archive' } });
    view = { activeAccountId: 'a', activeMailbox: 'Projects', unifiedInbox: false,
      mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/A', 'Projects/A'] } };
    await bridge.observeNativeView();
    expect(methods('sync.context').at(-1).view).toEqual({ accountId: 'a', mailbox: 'Projects',
      scopePaths: ['Projects', 'Projects/A'] });
  });

  it('queries the same request ID after an uncertain ACK and never mints a second intent', async () => {
    refreshError = new Error('lost reply');
    const result = await bridge.requestNativeRefresh({ accountId: 'a', mailbox: 'INBOX' });
    expect(result.receipt.status).toBe('complete');
    expect(methods('sync.refresh')).toHaveLength(1);
    expect(methods('sync.refresh_status').at(-1).requestId)
      .toBe(methods('sync.refresh')[0].requestId);
  });

  it('requires a valid settings snapshot after the real ordinary flush before minting Graph intent', async () => {
    accounts = [{ id: 'g', email: 'g@test', transport: 'graph' }, accounts[1]];
    saved.graphFolderKeysAdopted.g = true;
    saved.graphFolderKeysAdoptedFromListing.g = true;
    for (const invalid of [
      null,
      { values: null, version: 1 },
      { values: { 'mailvault-settings': { state: saved } } },
      { values: { 'mailvault-settings': { state: saved } }, version: -1 },
      { values: { 'mailvault-settings': { state: saved } }, version: 1, recovered: true },
      { values: { 'mailvault-settings': { state: [] } }, version: 1 },
    ]) {
      settingsReply = invalid;
      await expect(bridge.requestNativeRefresh({ accountId: 'g', mailbox: 'INBOX' }))
        .rejects.toThrow(/Graph/);
      expect(methods('sync.refresh')).toHaveLength(0);
    }
    settingsReply = undefined;
    await bridge.requestNativeRefresh({ accountId: 'g', mailbox: 'INBOX' });
    expect(methods('sync.refresh')).toHaveLength(1);
    expect(methods('sync.refresh')[0]).toMatchObject({ accountId: 'g', mailbox: 'INBOX' });
  });

  it('refuses a Graph source changed during adoption before minting an intent', async () => {
    accounts = [{ id: 'g', email: 'g@test', transport: 'graph' }, accounts[1]];
    saved.graphFolderKeysAdopted.g = true;
    await bridge.connectNativeSync();
    saved.graphFolderKeysAdoptedFromListing.g = false;
    const { graphListFolders } = await import('../api.js');
    graphListFolders.mockImplementationOnce(async () => {
      accounts = [{ ...accounts[0], email: 'replacement@test' }, accounts[1]];
      return [];
    });
    await expect(bridge.requestNativeRefresh({ accountId: 'g', mailbox: 'INBOX' }))
      .rejects.toThrow(/Graph/);
    expect(methods('sync.refresh')).toHaveLength(0);
  });

  it('refuses Graph intent before its ID when persisted adoption proof is absent; B remains usable', async () => {
    accounts = [{ id: 'g', email: 'g@test', transport: 'graph' }, accounts[1]];
    await expect(bridge.requestNativeRefresh({ accountId: 'g', mailbox: 'INBOX' }))
      .rejects.toThrow('Graph folder adoption');
    expect(methods('sync.refresh')).toHaveLength(0);
    await bridge.requestNativeRefresh({ accountId: 'b', mailbox: 'INBOX' });
    expect(methods('sync.refresh')).toHaveLength(1);
    expect(methods('sync.refresh')[0].accountId).toBe('b');
  });
});
