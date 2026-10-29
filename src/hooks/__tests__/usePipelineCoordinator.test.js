// @vitest-environment jsdom
// The thin presentation hook of the native download-ahead pipeline (Wave 4 S7).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { create } from 'zustand';
import { readFileSync } from 'node:fs';

const calls = [];
let daemonRevision = 0;
const daemonCall = vi.fn(async (method, params) => {
  calls.push({ method, params });
  if (method === 'pipeline.status') return { instanceId: 'i1', revision: daemonRevision, accounts: {} };
  if (method === 'pipeline.focus') return { revision: params.revision, accepted: true };
  return {};
});
vi.mock('../../services/daemonClient.js', () => ({ daemonCall: (...args) => daemonCall(...args) }));

const listeners = new Map();
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, cb) => { listeners.set(name, cb); return () => listeners.delete(name); } }));

const refreshVaultSets = vi.fn(async () => true);
vi.mock('../../services/workflows/refreshVaultSets', () => ({ refreshVaultSets: (...args) => refreshVaultSets(...args) }));

const mail = create(() => ({ activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null, emails: [],
  accounts: [{ id: 'a' }, { id: 'b' }], loading: false }));
const facade = Object.assign(selector => mail(selector), { getState: () => mail.getState(), setState: value => mail.setState(value),
  subscribe: listener => mail.subscribe(listener) });
vi.mock('../../stores/mailStore', () => ({ useMailStore: facade }));
vi.mock('../../stores/accountStore', () => ({ useAccountStore: facade }));
vi.mock('../../stores/messageListStore', () => ({ useMessageListStore: facade }));
vi.mock('../../stores/syncStore', () => ({ useSyncStore: facade }));
const settings = create(() => ({ hiddenAccounts: {} }));
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: Object.assign(selector => settings(selector), { getState: () => settings.getState() }) }));

const { usePipelineCoordinator } = await import('../usePipelineCoordinator.js');
const { resetForTests } = await import('../../services/nativePipeline.js');

const rows = uids => uids.map(uid => ({ uid, date: '2026-08-10T12:00:00Z' }));
const focuses = () => calls.filter(call => call.method === 'pipeline.focus').map(call => call.params);
const advance = async ms => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0; listeners.clear(); daemonRevision = 0; resetForTests();
  daemonCall.mockClear(); refreshVaultSets.mockClear();
  mail.setState({ activeAccountId: 'a', activeMailbox: 'INBOX', mailboxScope: null, emails: [],
    accounts: [{ id: 'a' }, { id: 'b' }], loading: false });
  settings.setState({ hiddenAccounts: {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('usePipelineCoordinator', () => {
  it('reports the loaded list 200ms after it settles, as raw view facts and never earlier', async () => {
    renderHook(() => usePipelineCoordinator());
    await advance(500);
    expect(focuses()).toEqual([]);
    await act(async () => { mail.setState({ emails: rows([1, 2]) }); });
    await advance(199);
    expect(focuses()).toEqual([]);
    await advance(1);
    await settle();
    expect(focuses()).toHaveLength(1);
    expect(focuses()[0]).toEqual({ revision: 1, online: true, focus: { accountId: 'a', mailbox: 'INBOX', scope: 'folder',
      rows: [{ accountId: 'a', mailbox: 'INBOX', uid: 1, date: '2026-08-10T12:00:00Z', internalDate: null },
        { accountId: 'a', mailbox: 'INBOX', uid: 2, date: '2026-08-10T12:00:00Z', internalDate: null }] } });
    expect(JSON.stringify(focuses()[0])).not.toMatch(/token|password|keep|policy|cutoff/i);
  });

  it('does not report while the list is syncing or empty', async () => {
    mail.setState({ emails: rows([1]), loading: true });
    renderHook(() => usePipelineCoordinator());
    await advance(1000);
    expect(focuses()).toEqual([]);
    await act(async () => { mail.setState({ loading: false }); });
    await advance(200); await settle();
    expect(focuses()).toHaveLength(1);
  });

  it('numbers each report one higher, adopts a newer daemon revision once, and sends the online flag', async () => {
    daemonRevision = 40;
    mail.setState({ emails: rows([1]) });
    renderHook(() => usePipelineCoordinator());
    await advance(200); await settle();
    await act(async () => { mail.setState({ activeMailbox: 'Archive', emails: rows([5]) }); });
    await advance(200); await settle();
    await act(async () => { window.dispatchEvent(new Event('offline')); });
    await settle();
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await settle();
    const sent = focuses();
    expect(sent.map(p => p.revision)).toEqual([41, 42, 43, 44]);
    expect(sent.map(p => p.online)).toEqual([true, true, false, true]);
    expect(sent[1].focus.mailbox).toBe('Archive');
    expect(calls[0].method).toBe('pipeline.status');
  });

  it('sends unified rows with their own account and folder, and a branch listing with its root', async () => {
    mail.setState({ activeMailbox: 'UNIFIED', emails: [{ uid: 7, _accountId: 'a', _mailbox: 'INBOX' },
      { uid: 7, _accountId: 'b', _mailbox: 'Archive' }, { uid: 8 }] });
    renderHook(() => usePipelineCoordinator());
    await advance(200); await settle();
    expect(focuses()[0].focus).toMatchObject({ accountId: 'a', mailbox: 'UNIFIED', scope: 'unified' });
    expect(focuses()[0].focus.rows.map(r => [r.accountId, r.mailbox, r.uid])).toEqual([['a', 'INBOX', 7], ['b', 'Archive', 7]]);
    await act(async () => { mail.setState({ activeMailbox: 'Projects', mailboxScope: { root: 'Projects', paths: ['Projects', 'Projects/Child'] },
      emails: [{ uid: 1 }, { uid: 2, _mailbox: 'Projects/Child' }] }); });
    await advance(200); await settle();
    const subtree = focuses().at(-1).focus;
    expect(subtree).toMatchObject({ accountId: 'a', mailbox: 'Projects', scope: 'subtree' });
    expect(subtree.rows.map(r => [r.mailbox, r.uid])).toEqual([['Projects', 1], ['Projects/Child', 2]]);
  });

  it('hiding or unhiding an account reports the view again so the daemon replans', async () => {
    mail.setState({ emails: rows([1]) });
    renderHook(() => usePipelineCoordinator());
    await advance(200); await settle();
    await act(async () => { settings.setState({ hiddenAccounts: { b: true } }); });
    await advance(200); await settle();
    expect(focuses()).toHaveLength(2);
    await act(async () => { settings.setState({ hiddenAccounts: {} }); });
    await advance(200); await settle();
    expect(focuses()).toHaveLength(3);
  });

  it('after a reconnect or a lag it reads status first, then resends the latest view exactly once', async () => {
    mail.setState({ emails: rows([1]) });
    renderHook(() => usePipelineCoordinator());
    await advance(200); await settle();
    calls.length = 0;
    await settle();
    listeners.get('daemon-reconnected')({ payload: null });
    listeners.get('daemon-events-lagged')({ payload: null });
    await settle(); await settle();
    expect(calls.map(c => c.method)).toEqual(['pipeline.status', 'pipeline.focus']);
    expect(focuses()[0].revision).toBe(2);
    expect(focuses()[0].focus.mailbox).toBe('INBOX');
  });

  it('shows the saved set when the folder on screen settles and ignores other folders', async () => {
    renderHook(() => usePipelineCoordinator());
    await settle();
    listeners.get('pipeline-progress')({ payload: { accountId: 'a', mailbox: 'Archive', phase: 'done' } });
    listeners.get('pipeline-progress')({ payload: { accountId: 'b', mailbox: 'INBOX', phase: 'done' } });
    listeners.get('pipeline-progress')({ payload: { accountId: 'a', mailbox: 'INBOX', phase: 'content' } });
    await advance(400);
    expect(refreshVaultSets).not.toHaveBeenCalled();
    listeners.get('pipeline-progress')({ payload: { accountId: 'a', mailbox: 'INBOX', phase: 'done' } });
    await advance(299);
    expect(refreshVaultSets).not.toHaveBeenCalled();
    await advance(1);
    expect(refreshVaultSets).toHaveBeenCalledWith('a', 'INBOX');
  });

  it('unmounting retires only its own observation: no stop is sent and listeners are released', async () => {
    mail.setState({ emails: rows([1]) });
    const hook = renderHook(() => usePipelineCoordinator());
    await advance(200); await settle();
    const before = calls.length;
    hook.unmount();
    await settle();
    expect(calls.length).toBe(before);
    expect(focuses().some(p => p.focus === null)).toBe(false);
    expect([...listeners.keys()]).toEqual([]);
  });

  it('does not drive the old JS download engine at all', () => {
    const source = readFileSync('src/hooks/usePipelineCoordinator.js', 'utf8');
    expect(source).not.toMatch(/EmailPipelineManager|AccountPipeline|pipelineManager/);
    expect(source).not.toMatch(/saveEmailHeaders|setInterval/);
  });
});
