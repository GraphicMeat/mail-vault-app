// @vitest-environment jsdom
// The mobile store over a fake transport: `daemonCall` answers from an in-memory engine and
// `listen` hands the test each event handler, so events can be fired by hand.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({
  accounts: [],
  folders: {}, // accountId -> folder rows
  rows: {}, // `${accountId}/${folder}` -> message rows, newest first
  listGen: {},
  handlers: new Map(), // event name -> Set of handlers
  calls: [],
}));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.accounts.list':
        return { accounts: engine.accounts.map((a) => ({ ...a })) };
      case 'mobile.folders.list':
        return { folders: (engine.folders[params.accountId] || []).map((f) => ({ ...f })) };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.accounts.remove':
        engine.accounts = engine.accounts.filter((a) => a.id !== params.accountId);
        return { removed: true };
      case 'mobile.accounts.add': {
        if (params.password !== 'right') return { ok: false, code: 'AUTH_FAILED', message: 'no' };
        const account = { id: `acc_${params.email}`, email: params.email, displayName: params.email };
        engine.accounts.push(account);
        return { ok: true, account };
      }
      case 'mobile.transfer.import': {
        if (params.password !== 'right-password') return { ok: false, code: params.password === 'odd' ? 'SOMETHING_NEW' : 'BAD_PASSWORD' };
        const account = { id: 'acc_imp', email: 'imp@example.test', displayName: 'imp@example.test' };
        engine.accounts.push(account);
        engine.folders.acc_imp = [inbox(0)];
        return { ok: true, imported: ['imp@example.test'], existing: ['a1@example.test'], skipped: [{ email: 'x@example.test', reason: 'invalid' }] };
      }
      case 'mobile.messages.page': {
        const key = `${params.accountId}/${params.folder}`;
        const rows = engine.rows[key] || [];
        const from = params.cursor ? rows.findIndex((r) => r.dateMs < params.cursor.dateMs || (r.dateMs === params.cursor.dateMs && r.uid < params.cursor.uid)) : 0;
        const start = from < 0 ? rows.length : from;
        const page = rows.slice(start, start + params.limit);
        const more = start + params.limit < rows.length;
        const last = page[page.length - 1];
        return { rows: page, nextCursor: more ? { dateMs: last.dateMs, uid: last.uid } : null, total: rows.length, listGen: engine.listGen[key] ?? 1 };
      }
      default:
        throw Object.assign(new Error(`unsupported ${method}`), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    if (!engine.handlers.has(name)) engine.handlers.set(name, new Set());
    engine.handlers.get(name).add(handler);
    return () => engine.handlers.get(name)?.delete(handler);
  }),
}));

vi.mock('../oauth.js', () => ({ oauthSignIn: vi.fn(), oauthReauth: vi.fn(), cancelOAuth: vi.fn() }));

import { createMobileStore, STORAGE_ACCOUNT, STORAGE_FOLDER } from '../store.js';
import { oauthSignIn, oauthReauth, cancelOAuth } from '../oauth.js';

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const inbox = (unseen) => ({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen, total: 10, depth: 0, noselect: false });
const folder = (path, unseen = 0) => ({ path, name: path, specialUse: null, unseen, total: 5, depth: 0, noselect: false });
const rowsOf = (n) => Array.from({ length: n }, (_, k) => ({ uid: n - k, dateMs: (n - k) * 1000, subject: `m${n - k}` }));
const acct = (id) => ({ id, email: `${id}@example.test`, displayName: id, imapHost: 'imap.example.test', imapPort: 993, security: 'ssl' });

beforeEach(() => {
  engine.accounts = [acct('a1'), acct('a2'), acct('a3')];
  engine.folders = { a1: [inbox(3), folder('Sent'), folder('Work', 2)], a2: [inbox(7)], a3: [inbox(0)] };
  engine.rows = { 'a1/INBOX': rowsOf(250), 'a1/Work': rowsOf(20), 'a2/INBOX': rowsOf(30), 'a3/INBOX': rowsOf(5) };
  engine.listGen = {};
  engine.handlers = new Map();
  engine.calls = [];
  localStorage.clear();
});

describe('mobile store', () => {
  it('init_selects_first_account_and_inbox', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.accounts.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    expect(s.activeAccountId).toBe('a1');
    expect(s.activeFolder).toBe('INBOX');
    expect(s.folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Work']);
    expect(s.unread).toEqual({ a1: 3, a2: 7, a3: 0 });
    // Start refreshes the active folder; without a folder the engine also lists folders.
    expect(callsOf('mobile.sync.refresh')).toEqual([{ accountId: 'a1' }]);
    expect(localStorage.getItem(STORAGE_ACCOUNT)).toBe('a1');
    await s.list.ensure(0);
    expect(s.list.rowAt(0).uid).toBe(250);
    expect(callsOf('mobile.messages.page')[0]).toEqual({ accountId: 'a1', folder: 'INBOX', cursor: null, limit: 100 });
  });

  it('init restores the saved account and folder, and falls back when they are gone', async () => {
    localStorage.setItem(STORAGE_ACCOUNT, 'a1');
    localStorage.setItem(STORAGE_FOLDER, JSON.stringify({ accountId: 'a1', path: 'Work' }));
    const store = createMobileStore();
    await store.getState().init();
    expect(store.getState().activeFolder).toBe('Work');
    expect(callsOf('mobile.sync.refresh')).toContainEqual({ accountId: 'a1', folder: 'Work' });

    localStorage.setItem(STORAGE_ACCOUNT, 'gone');
    const again = createMobileStore();
    await again.getState().init();
    expect(again.getState().activeAccountId).toBe('a1');
  });

  it('init with no account asks for one', async () => {
    engine.accounts = [];
    const store = createMobileStore();
    await store.getState().init();
    expect(store.getState().status).toBe('noAccount');
    expect(store.getState().list).toBeNull();
  });

  it('init is idempotent: one subscription per event', async () => {
    const store = createMobileStore();
    await Promise.all([store.getState().init(), store.getState().init()]);
    for (const name of ['mobile.folder.changed', 'mobile.folders.changed', 'mobile.sync.state']) {
      expect(engine.handlers.get(name)?.size).toBe(1);
    }
  });

  it('folder_changed_for_active_folder_invalidates_list', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const list = store.getState().list;
    await list.ensure(0);
    const before = callsOf('mobile.messages.page').length;
    engine.rows['a1/INBOX'] = rowsOf(252);
    engine.listGen['a1/INBOX'] = 2;
    engine.folders.a1[0] = inbox(5);
    emit('mobile.folder.changed', { accountId: 'a1', folder: 'INBOX', added: 2, removed: 0, updated: 0, listGen: 2 });
    expect(store.getState().listGen).toBe(2);
    expect(list.rowAt(0)).toBeUndefined();
    await list.ensure(0);
    expect(callsOf('mobile.messages.page').length).toBe(before + 1);
    expect(list.rowAt(0).uid).toBe(252);
    await vi.waitFor(() => expect(store.getState().unread.a1).toBe(5));
  });

  it('folder_changed_for_other_account_updates_unread_only', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const list = store.getState().list;
    await list.ensure(0);
    const pages = callsOf('mobile.messages.page').length;
    const folderReads = callsOf('mobile.folders.list').length;
    engine.folders.a2 = [inbox(9)];
    emit('mobile.folder.changed', { accountId: 'a2', folder: 'INBOX', added: 2, removed: 0, updated: 0, listGen: 4 });
    await vi.waitFor(() => expect(store.getState().unread.a2).toBe(9));
    expect(callsOf('mobile.folders.list').slice(folderReads)).toEqual([{ accountId: 'a2' }]);
    expect(store.getState().list).toBe(list);
    expect(list.rowAt(0)).toBeDefined();
    expect(callsOf('mobile.messages.page').length).toBe(pages);
    expect(store.getState().folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Work']);
  });

  it('folder_changed for another folder of the active account keeps the list', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const list = store.getState().list;
    await list.ensure(0);
    engine.folders.a1[2] = folder('Work', 4);
    emit('mobile.folder.changed', { accountId: 'a1', folder: 'Work', added: 2, removed: 0, updated: 0, listGen: 9 });
    await vi.waitFor(() => expect(store.getState().folders[2].unseen).toBe(4));
    expect(list.rowAt(0)).toBeDefined();
  });

  it('sync state is kept per account', async () => {
    const store = createMobileStore();
    await store.getState().init();
    emit('mobile.sync.state', { accountId: 'a1', state: 'syncing' });
    expect(store.getState().syncState.a1).toMatchObject({ state: 'syncing', code: null });
    emit('mobile.sync.state', { accountId: 'a1', state: 'error', code: 'AUTH_FAILED' });
    expect(store.getState().syncState.a1).toMatchObject({ state: 'error', code: 'AUTH_FAILED' });
  });

  it('folders.changed reloads the active account folders', async () => {
    const store = createMobileStore();
    await store.getState().init();
    engine.folders.a1 = [inbox(3), folder('Sent'), folder('Work', 2), folder('New')];
    emit('mobile.folders.changed', { accountId: 'a1' });
    await vi.waitFor(() => expect(store.getState().folders).toHaveLength(4));
  });

  it('selectFolder opens a new list and refreshes that folder', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const old = store.getState().list;
    await store.getState().selectFolder('Work');
    const s = store.getState();
    expect(s.activeFolder).toBe('Work');
    expect(s.list).not.toBe(old);
    expect(callsOf('mobile.sync.refresh').at(-1)).toEqual({ accountId: 'a1', folder: 'Work' });
    expect(JSON.parse(localStorage.getItem(STORAGE_FOLDER))).toEqual({ accountId: 'a1', path: 'Work' });
    await s.list.ensure(0);
    expect(s.list.total).toBe(20);
  });

  it('selectAccount switches to that account inbox', async () => {
    const store = createMobileStore();
    await store.getState().init();
    await store.getState().selectFolder('Work');
    await store.getState().selectAccount('a2');
    const s = store.getState();
    expect(s.activeAccountId).toBe('a2');
    expect(s.activeFolder).toBe('INBOX');
    expect(s.folders.map((f) => f.path)).toEqual(['INBOX']);
    expect(localStorage.getItem(STORAGE_ACCOUNT)).toBe('a2');
    expect(callsOf('mobile.sync.refresh').at(-1)).toEqual({ accountId: 'a2' });
  });

  it('refresh refreshes the active folder', async () => {
    const store = createMobileStore();
    await store.getState().init();
    await store.getState().selectFolder('Work');
    engine.calls = [];
    await store.getState().refresh();
    expect(callsOf('mobile.sync.refresh')).toEqual([{ accountId: 'a1', folder: 'Work' }]);
  });

  it('remove_active_account_selects_next', async () => {
    localStorage.setItem(STORAGE_ACCOUNT, 'a2');
    const store = createMobileStore();
    await store.getState().init();
    expect(store.getState().activeAccountId).toBe('a2');
    await store.getState().removeAccount('a2');
    let s = store.getState();
    expect(callsOf('mobile.accounts.remove')).toEqual([{ accountId: 'a2' }]);
    expect(s.accounts.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(s.activeAccountId).toBe('a3');
    expect(s.activeFolder).toBe('INBOX');
    expect(s.unread.a2).toBeUndefined();
    // The last account in the list falls back to the one before it.
    await store.getState().removeAccount('a3');
    expect(store.getState().activeAccountId).toBe('a1');
    await store.getState().removeAccount('a1');
    s = store.getState();
    expect(s.status).toBe('noAccount');
    expect(s.activeAccountId).toBeNull();
    expect(localStorage.getItem(STORAGE_ACCOUNT)).toBeNull();
  });

  it('removing another account keeps the active one', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const list = store.getState().list;
    await store.getState().removeAccount('a3');
    expect(store.getState().activeAccountId).toBe('a1');
    expect(store.getState().list).toBe(list);
  });

  it('addAccount selects the new account and keeps no password', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const form = { email: 'new@example.test', password: 'right', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl', smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls' };
    await expect(store.getState().addAccount(form)).resolves.toEqual({ ok: true });
    expect(callsOf('mobile.accounts.add')[0]).toMatchObject({ smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls' });
    const s = store.getState();
    expect(s.activeAccountId).toBe('acc_new@example.test');
    expect(s.accounts).toHaveLength(4);
    expect(JSON.stringify(s)).not.toContain('right');
    expect(JSON.stringify({ ...localStorage })).not.toContain('right');
  });

  it('importFromDesktop lists the imported accounts, and opens the first once the user is done', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const frames = ['MVQR1:aaaaaaaa:1/1:QUJD'];
    await expect(store.getState().importFromDesktop({ frames, password: 'right-password' })).resolves.toEqual({
      ok: true, imported: ['imp@example.test'], existing: ['a1@example.test'], skipped: [{ email: 'x@example.test', reason: 'invalid' }],
    });
    expect(callsOf('mobile.transfer.import')).toEqual([{ frames, password: 'right-password' }]);
    // Listed at once; the screen with the result stays until Done.
    expect(store.getState().accounts.map((a) => a.id)).toContain('acc_imp');
    expect(store.getState().activeAccountId).toBe('a1');
    await store.getState().openImported(['imp@example.test']);
    expect(store.getState().activeAccountId).toBe('acc_imp');
    expect(callsOf('mobile.sync.refresh').some((p) => p.accountId === 'acc_imp')).toBe(true);
    expect(JSON.stringify(store.getState())).not.toContain('right-password');
  });

  it('importFromDesktop on a fresh install keeps the add screen until Done', async () => {
    engine.accounts = [];
    const store = createMobileStore();
    await store.getState().init();
    expect(store.getState().status).toBe('noAccount');
    await store.getState().importFromDesktop({ frames: ['f'], password: 'right-password' });
    expect(store.getState().status).toBe('noAccount');
    await store.getState().openImported(['imp@example.test']);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().activeAccountId).toBe('acc_imp');
    // Nothing imported: nothing to open.
    await store.getState().openImported([]);
    expect(store.getState().activeAccountId).toBe('acc_imp');
  });

  it('importFromDesktop answers the engine code, and an unknown or thrown one as INTERNAL', async () => {
    const store = createMobileStore();
    await store.getState().init();
    await expect(store.getState().importFromDesktop({ frames: ['f'], password: 'wrong-password' })).resolves.toEqual({ ok: false, code: 'BAD_PASSWORD' });
    await expect(store.getState().importFromDesktop({ frames: ['f'], password: 'odd' })).resolves.toEqual({ ok: false, code: 'INTERNAL' });
    expect(store.getState().accounts).toHaveLength(3);
  });

  it('signIn adds and opens the provider account; a cancel changes nothing', async () => {
    const store = createMobileStore();
    await store.getState().init();
    oauthSignIn.mockResolvedValueOnce({ ok: false, code: 'CANCELLED' });
    expect(await store.getState().signIn('google')).toEqual({ ok: false, code: 'CANCELLED' });
    expect(store.getState().accounts).toHaveLength(3);
    const account = { id: 'g1', email: 'ada@gmail.test', displayName: 'ada@gmail.test', kind: 'imap', provider: 'google', needsAuth: false };
    engine.folders.g1 = [inbox(0)];
    oauthSignIn.mockResolvedValueOnce({ ok: true, account });
    expect(await store.getState().signIn('google')).toEqual({ ok: true });
    expect(oauthSignIn).toHaveBeenLastCalledWith('google');
    expect(store.getState().activeAccountId).toBe('g1');
    expect(store.getState().accounts.map((a) => a.id)).toContain('g1');
  });

  it('a NEEDS_AUTH sync state parks the account until reauth succeeds', async () => {
    const store = createMobileStore();
    await store.getState().init();
    emit('mobile.sync.state', { accountId: 'a1', state: 'error', code: 'NEEDS_AUTH' });
    expect(store.getState().accounts.find((a) => a.id === 'a1').needsAuth).toBe(true);
    expect(store.getState().accounts.find((a) => a.id === 'a2').needsAuth).toBeUndefined();
    // Another error code parks nothing.
    emit('mobile.sync.state', { accountId: 'a2', state: 'error', code: 'TIMEOUT' });
    expect(store.getState().accounts.find((a) => a.id === 'a2').needsAuth).toBeUndefined();
    let fail;
    oauthReauth.mockReturnValueOnce(new Promise((r) => { fail = r; }));
    const running = store.getState().reauth('a1');
    expect(store.getState().reauthState).toEqual({ accountId: 'a1', busy: true, code: null });
    // One run at a time, whichever control asks.
    expect(await store.getState().reauth('a1')).toEqual({ ok: false, code: 'SIGNIN_BUSY' });
    expect(oauthReauth).toHaveBeenCalledTimes(1);
    fail({ ok: false, code: 'AUTH_FAILED' });
    expect(await running).toEqual({ ok: false, code: 'AUTH_FAILED' });
    expect(store.getState().reauthState).toEqual({ accountId: 'a1', busy: false, code: 'AUTH_FAILED' });
    store.getState().cancelSignIn();
    expect(cancelOAuth).toHaveBeenCalledTimes(1);
    expect(store.getState().accounts.find((a) => a.id === 'a1').needsAuth).toBe(true);
    const refreshes = callsOf('mobile.sync.refresh').length;
    oauthReauth.mockResolvedValueOnce({ ok: true, account: { ...acct('a1'), needsAuth: false } });
    expect(await store.getState().reauth('a1')).toEqual({ ok: true });
    expect(oauthReauth).toHaveBeenLastCalledWith('a1');
    expect(store.getState().accounts.find((a) => a.id === 'a1').needsAuth).toBe(false);
    expect(store.getState().syncState.a1).toBeUndefined();
    expect(store.getState().reauthState).toEqual({ accountId: 'a1', busy: false, code: null });
    expect(callsOf('mobile.sync.refresh').length).toBe(refreshes + 1);
  });

  it('addAccount reports the engine code, and a thrown error as a code too', async () => {
    const store = createMobileStore();
    await store.getState().init();
    const form = { email: 'x@example.test', password: 'wrong', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl' };
    await expect(store.getState().addAccount(form)).resolves.toEqual({ ok: false, code: 'AUTH_FAILED' });
    const { daemonCall } = await import('../transport.js');
    daemonCall.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'RPC_ERROR' }));
    await expect(store.getState().addAccount(form)).resolves.toEqual({ ok: false, code: 'INTERNAL' });
    expect(store.getState().activeAccountId).toBe('a1');
  });
});
