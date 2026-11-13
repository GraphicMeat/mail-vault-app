// @vitest-environment jsdom
// All Inboxes on mobile, as desktop has it: with two or more accounts the folder drawer offers
// every account's inbox as one list, newest first, each row marked with its account's colour. A
// row's actions (open, read, flag, delete, swipe) go to that row's own account and folder, and a
// refresh syncs every account's inbox.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({
  calls: [], handlers: new Map(), accounts: [], folders: {}, rows: {}, gen: 1, pending: {},
}));

/** The engine's unified order: (dateMs DESC, uid DESC, accountId DESC). */
function unifiedOrder(a, b) {
  if (a.dateMs !== b.dateMs) return b.dateMs - a.dateMs;
  if (a.uid !== b.uid) return b.uid - a.uid;
  return a.accountId === b.accountId ? 0 : a.accountId < b.accountId ? 1 : -1;
}

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 6 };
      case 'mobile.accounts.list':
        return { accounts: engine.accounts.map((a) => ({ ...a })) };
      case 'mobile.accounts.remove':
        engine.accounts = engine.accounts.filter((a) => a.id !== params.accountId);
        return { removed: true };
      case 'mobile.folders.list':
        return { folders: (engine.folders[params.accountId] || []).map((f) => ({ ...f })) };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.actions.pending':
        return { pending: (engine.pending[params.accountId] || []).map((p) => ({ ...p })) };
      case 'mobile.actions.apply':
        return { queued: 1, skipped: [] };
      case 'mobile.message.body':
        return { html: '<p>Body</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      case 'mobile.messages.page': {
        if (params.scope === 'allInboxes') {
          expect(params.accountId).toBeUndefined();
          expect(params.folder).toBeUndefined();
          const rows = engine.accounts
            .flatMap((a) => (engine.rows[`${a.id}/INBOX`] || []).map((r) => ({ ...r, accountId: a.id, folder: 'INBOX' })))
            .sort(unifiedOrder);
          return { rows, nextCursor: null, total: rows.length, listGen: engine.gen };
        }
        const rows = engine.rows[`${params.accountId}/${params.folder}`] || [];
        return { rows, nextCursor: null, total: rows.length, listGen: engine.gen };
      }
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    if (!engine.handlers.has(name)) engine.handlers.set(name, new Set());
    engine.handlers.get(name).add(handler);
    return () => engine.handlers.get(name)?.delete(handler);
  }),
  takeNotificationTap: vi.fn(async () => null),
}));
vi.mock('../oauth.js', () => ({ oauthSignIn: vi.fn(), oauthReauth: vi.fn(), cancelOAuth: vi.fn() }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
      this.pointerType = init.pointerType ?? 'touch';
    }
  };
}

const { createMobileStore, ALL_INBOXES, STORAGE_ACCOUNT, STORAGE_FOLDER } = await import('../store.js');
const { default: FolderDrawer } = await import('../FolderDrawer.jsx');
const { default: MessageRow } = await import('../MessageRow.jsx');
const { accountColor, ACCOUNT_COLORS } = await import('../accountColor.js');
const { createPageCache, compareKeys } = await import('../messagePages.js');

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const inbox = (unseen) => ({ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen, total: 10, depth: 0, noselect: false });
const folder = (path) => ({ path, name: path, specialUse: null, unseen: 0, total: 0, depth: 0, noselect: false });
const acct = (id) => ({ id, email: `${id}@example.test`, displayName: id });
const row = (uid, dateMs, extra = {}) => ({
  uid, dateMs, subject: `Mail ${uid}@${dateMs}`, fromName: 'S', fromAddress: 's@example.test', snippet: '', seen: false, flagged: false, to: [], ...extra,
});

function swipe(el, from, to) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from, clientY: 20, button: 0, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + Math.sign(to - from) * 20, clientY: 21, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
}

beforeEach(() => {
  engine.calls = [];
  engine.handlers = new Map();
  engine.gen = 1;
  engine.pending = {};
  engine.accounts = [acct('a1'), acct('a2')];
  engine.folders = { a1: [inbox(3), folder('Sent')], a2: [inbox(4)] };
  // uid 5 lives in both accounts: only the account tells the two apart.
  engine.rows = {
    'a1/INBOX': [row(5, 5000), row(2, 2000, { seen: true })],
    'a2/INBOX': [row(9, 6000), row(5, 3000)],
    'a1/Sent': [row(1, 9000)],
  };
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function unifiedStore() {
  const store = createMobileStore();
  await store.getState().init({ sync: false });
  await store.getState().selectAllInboxes();
  await store.getState().list.ensure(0);
  return store;
}
const keysOf = (list) => Array.from({ length: list.total }, (_, i) => `${list.rowAt(i)?.accountId}:${list.rowAt(i)?.uid}`);

describe('All Inboxes store', () => {
  it('lists every inbox merged newest first through the one page RPC', async () => {
    const store = await unifiedStore();
    const s = store.getState();
    expect(s.activeFolder).toBe(ALL_INBOXES);
    // A real account stays in front: compose and drafts keep working.
    expect(s.activeAccountId).toBe('a1');
    expect(keysOf(s.list)).toEqual(['a2:9', 'a1:5', 'a2:5', 'a1:2']);
    expect(callsOf('mobile.messages.page').at(-1)).toEqual({ scope: 'allInboxes', cursor: null, limit: 100 });
    // The sentinel is never sent as a folder.
    expect(engine.calls.some(([, p]) => p && p.folder === ALL_INBOXES)).toBe(false);
  });

  it('a delete acts on the row\'s own account and hides only that row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = await unifiedStore();
    const { list } = store.getState();
    const target = list.rowAt(2); // a2's uid 5; a1 also has a uid 5
    expect(target).toMatchObject({ accountId: 'a2', uid: 5 });
    store.getState().act('delete', { ...store.getState().placeOf(target), uids: [target.uid] });
    expect(keysOf(list)).toEqual(['a2:9', 'a1:5', 'a1:2']);
    await store.getState().flush();
    expect(callsOf('mobile.actions.apply')).toEqual([{ accountId: 'a2', folder: 'INBOX', uids: [5], kind: 'delete' }]);
  });

  it('read and flag go to the row\'s own account', async () => {
    const store = await unifiedStore();
    const { list } = store.getState();
    const a2 = list.rowAt(0);
    await store.getState().markSeen(a2.accountId, a2.folder, a2);
    await store.getState().act('flag', { ...store.getState().placeOf(list.rowAt(1)), uids: [5] });
    expect(callsOf('mobile.actions.apply')).toEqual([
      { accountId: 'a2', folder: 'INBOX', uids: [9], kind: 'seen' },
      { accountId: 'a1', folder: 'INBOX', uids: [5], kind: 'flag' },
    ]);
  });

  it('refresh syncs every account\'s inbox', async () => {
    const store = await unifiedStore();
    engine.calls = [];
    await store.getState().refresh();
    expect(callsOf('mobile.sync.refresh')).toEqual([{ accountId: 'a1' }, { accountId: 'a2' }]);
  });

  it('new mail in any account\'s inbox reloads the list; another folder does not', async () => {
    const store = await unifiedStore();
    const before = callsOf('mobile.messages.page').length;
    engine.rows['a1/Sent'].unshift(row(3, 9500));
    await act(async () => { emit('mobile.folder.changed', { accountId: 'a1', folder: 'Sent', listGen: 7 }); });
    await store.getState().list.ensure(0);
    expect(callsOf('mobile.messages.page').length).toBe(before);
    engine.rows['a2/INBOX'].unshift(row(10, 8000));
    engine.gen = 2;
    await act(async () => { emit('mobile.folder.changed', { accountId: 'a2', folder: 'INBOX', listGen: 2 }); });
    await store.getState().list.ensure(0);
    expect(keysOf(store.getState().list)[0]).toBe('a2:10');
    // One reload, not a second one when the page comes back with the summed generation.
    expect(callsOf('mobile.messages.page').length).toBe(before + 1);
  });

  it('is remembered for the next launch, and left when fewer than two accounts remain', async () => {
    await unifiedStore();
    expect(JSON.parse(localStorage.getItem(STORAGE_FOLDER))).toEqual({ accountId: 'a1', path: ALL_INBOXES });
    const again = createMobileStore();
    await again.getState().init({ sync: false });
    expect(again.getState().activeFolder).toBe(ALL_INBOXES);

    await again.getState().removeAccount('a2');
    expect(again.getState().activeFolder).toBe('INBOX');
    expect(again.getState().activeAccountId).toBe('a1');

    localStorage.setItem(STORAGE_ACCOUNT, 'a1');
    localStorage.setItem(STORAGE_FOLDER, JSON.stringify({ accountId: 'a1', path: ALL_INBOXES }));
    const single = createMobileStore();
    await single.getState().init({ sync: false });
    expect(single.getState().activeFolder).toBe('INBOX');
  });

  it('counts every account\'s waiting actions, and only the active one\'s once it is left', async () => {
    engine.pending = { a1: [], a2: [{ id: 1 }, { id: 2 }] };
    const store = await unifiedStore();
    await waitFor(() => expect(store.getState().pending).toBe(2));
    engine.pending = { a1: [{ id: 3 }], a2: [{ id: 1 }, { id: 2 }] };
    await store.getState().selectAccount('a1');
    await waitFor(() => expect(store.getState().pending).toBe(1));
    expect(store.getState().activeFolder).not.toBe(ALL_INBOXES);
  });

  it('tells the engine every account is on screen while All Inboxes is open, and narrows it after', async () => {
    const store = createMobileStore();
    await store.getState().init({ sync: true });
    const states = () => callsOf('mobile.app.state');
    expect(states().at(-1)).toEqual({ foreground: true, accountId: 'a1' });

    await store.getState().selectAllInboxes();
    // Every inbox is listed, so every account is live and its mail counts as seen on leaving.
    expect(states().at(-1)).toEqual({ foreground: true, accountId: 'a1', shownAccountIds: ['a1', 'a2'] });

    // Visibility changes carry the same set.
    await store.getState().appState(false);
    expect(states().at(-1)).toEqual({ foreground: false, accountId: 'a1', shownAccountIds: ['a1', 'a2'] });

    // Back on one account's folder: only that account.
    await store.getState().selectFolder('INBOX');
    expect(states().at(-1)).toEqual({ foreground: true, accountId: 'a1' });
  });

  it('picking an account in the switcher opens that account, not All Inboxes', async () => {
    const store = await unifiedStore();
    await store.getState().selectAccount('a2');
    expect(store.getState().activeAccountId).toBe('a2');
    expect(store.getState().activeFolder).toBe('INBOX');
  });
});

describe('All Inboxes drawer entry', () => {
  const props = { account: acct('a1'), folders: [inbox(3)], activeFolder: 'INBOX', onSelect: () => {}, onClose: () => {} };

  it('sits at the top of the drawer with every inbox\'s unread count when there are two accounts', () => {
    const onAllInboxes = vi.fn();
    render(<FolderDrawer {...props} allInboxes={{ unread: 7 }} onAllInboxes={onAllInboxes} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.classList.contains('mv-folder'));
    expect(buttons[0].textContent).toContain(t('sidebar.allInboxes'));
    expect(buttons[0].textContent).toContain('7');
    fireEvent.click(buttons[0]);
    expect(onAllInboxes).toHaveBeenCalledTimes(1);
  });

  it('is marked when open, and absent without a second account', () => {
    const { unmount } = render(<FolderDrawer {...props} activeFolder={ALL_INBOXES} allInboxes={{ unread: 0 }} onAllInboxes={() => {}} />);
    expect(screen.getByRole('button', { name: t('sidebar.allInboxes') }).getAttribute('aria-current')).toBe('true');
    unmount();
    render(<FolderDrawer {...props} allInboxes={null} onAllInboxes={() => {}} />);
    expect(screen.queryByText(t('sidebar.allInboxes'))).toBeNull();
  });
});

describe('account marker', () => {
  it('a unified row shows its account\'s colour; a single-folder row shows none', () => {
    const a = acct('a2');
    const { container, unmount } = render(<MessageRow row={{ ...row(5, 1), accountId: 'a2', folder: 'INBOX' }} index={0} onOpen={() => {}} account={a} />);
    const dot = container.querySelector('.mv-row__acct');
    expect(dot).toBeTruthy();
    expect(dot.getAttribute('aria-label')).toBe('a2@example.test');
    expect(dot.style.backgroundColor).not.toBe('');
    unmount();
    const plain = render(<MessageRow row={row(5, 1)} index={0} onOpen={() => {}} />);
    expect(plain.container.querySelector('.mv-row__acct')).toBeNull();
  });

  it('uses desktop\'s colour for the same account', () => {
    // jsdom's import.meta.url is not a file URL: read from the repo root vitest runs in.
    const src = readFileSync(resolve(process.cwd(), 'src/stores/settingsStore.js'), 'utf8');
    const block = src.slice(src.indexOf('AVATAR_COLORS = ['), src.indexOf('];', src.indexOf('AVATAR_COLORS = [')));
    expect(ACCOUNT_COLORS).toEqual(block.match(/#[0-9a-f]{6}/gi));
    // desktop's hashColor, run on the same address
    const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; } return ACCOUNT_COLORS[Math.abs(h) % ACCOUNT_COLORS.length]; };
    for (const email of ['a1@example.test', 'rokas@example.test', 'x@y.z']) expect(accountColor({ id: 'i', email })).toBe(hash(email));
    expect(accountColor({ id: 'i', email: 'a@b.c', color: '#123456' })).toBe('#123456');
  });
});

describe('spanning page cache', () => {
  it('orders ties by account like the engine, and hides by account and uid', async () => {
    expect(compareKeys({ dateMs: 1, uid: 5, accountId: 'b' }, { dateMs: 1, uid: 5, accountId: 'a' })).toBeLessThan(0);
    const rows = [{ dateMs: 1, uid: 5, accountId: 'b' }, { dateMs: 1, uid: 5, accountId: 'a' }];
    const c = createPageCache(async () => ({ rows, nextCursor: null, total: 2, listGen: 1 }), 100, { spansAccounts: true });
    await c.ensure(0);
    c.hide([c.keyFor('a', 5)]);
    expect(c.total).toBe(1);
    expect(c.rowAt(0).accountId).toBe('b');
    expect(c.indexOf(c.keyFor('b', 5))).toBe(0);
    expect(c.indexOf(c.keyFor('a', 5))).toBe(-1);
  });
});

describe('All Inboxes in the app', () => {
  let offsetHeight;
  let offsetWidth;
  let storeModule;
  beforeEach(() => {
    offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(375);
  });
  afterEach(() => {
    offsetHeight.mockRestore();
    offsetWidth.mockRestore();
    vi.restoreAllMocks();
  });
  const store = () => storeModule.useMobileStore.getState();

  async function mountUnified() {
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    const { default: App } = await import('../App.jsx');
    storeModule = await import('../store.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-index="0"][data-loaded="1"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drawer.open') }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('sidebar.allInboxes')) }));
    await waitFor(() => expect(document.querySelectorAll('.mv-row__acct').length).toBe(4));
  }

  it('lists the merged rows, each with its account\'s marker, under the All Inboxes title', async () => {
    await mountUnified();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('sidebar.allInboxes'));
    const dots = [...document.querySelectorAll('.mv-row__acct')];
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual(['a2@example.test', 'a1@example.test', 'a2@example.test', 'a1@example.test']);
    expect(dots[0].style.backgroundColor).toBe(dots[2].style.backgroundColor);
    expect(dots[1].style.backgroundColor).toBe(dots[3].style.backgroundColor);
  });

  it('opening a row reads it in its own account; its toolbar flag goes there too', async () => {
    await mountUnified();
    engine.calls = [];
    fireEvent.click(document.querySelector('[data-index="2"]')); // a2's uid 5
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 5@3000' })).toBeTruthy());
    expect(callsOf('mobile.message.body')[0]).toMatchObject({ accountId: 'a2', folder: 'INBOX', uid: 5 });
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.flag') }));
    await waitFor(() => expect(callsOf('mobile.actions.apply').length).toBe(2));
    expect(callsOf('mobile.actions.apply')).toEqual([
      { accountId: 'a2', folder: 'INBOX', uids: [5], kind: 'seen' },
      { accountId: 'a2', folder: 'INBOX', uids: [5], kind: 'flag' },
    ]);
  });

  it('a swipe delete hides that row only and is sent to its own account', async () => {
    await mountUnified();
    engine.calls = [];
    swipe(document.querySelector('[data-index="2"] .mv-row'), 300, 20);
    await waitFor(() => expect(document.querySelectorAll('.mv-row__acct').length).toBe(3));
    await act(async () => { await store().flush(); });
    expect(callsOf('mobile.actions.apply')).toEqual([{ accountId: 'a2', folder: 'INBOX', uids: [5], kind: 'delete' }]);
  });

  it('a viewer delete opens the next merged row, from whichever account it is', async () => {
    await mountUnified();
    fireEvent.click(document.querySelector('[data-index="1"]')); // a1's uid 5
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 5@5000' })).toBeTruthy());
    engine.calls = [];
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 5@3000' })).toBeTruthy());
    expect(callsOf('mobile.actions.apply')).toEqual([{ accountId: 'a2', folder: 'INBOX', uids: [5], kind: 'seen' }]);
    await act(async () => { await store().flush(); });
    expect(callsOf('mobile.actions.apply').at(-1)).toEqual({ accountId: 'a1', folder: 'INBOX', uids: [5], kind: 'delete' });
  });

  it('a single account gets no All Inboxes entry', async () => {
    engine.accounts = [acct('a1')];
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    const { default: App } = await import('../App.jsx');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-index="0"][data-loaded="1"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drawer.open') }));
    expect(screen.getByRole('dialog', { name: t('mobile.drawer.title') })).toBeTruthy();
    expect(screen.queryByText(t('sidebar.allInboxes'))).toBeNull();
    expect(document.querySelector('.mv-row__acct')).toBeNull();
  });

  const syncState = (accountId, state, code) => act(async () => { emit('mobile.sync.state', { accountId, state, ...(code ? { code } : {}) }); });
  const later = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

  it('shows another inbox\'s sync and its failure, not only the account in front', async () => {
    await mountUnified();
    await syncState('a1', 'idle');
    await syncState('a2', 'syncing');
    expect(screen.getByText(t('mobile.sync.syncing'))).toBeTruthy();
    await syncState('a2', 'error', 'NETWORK');
    const chip = screen.getByRole('button', { name: new RegExp(t('mobile.sync.failed')) });
    expect(chip).toBeTruthy();
    // Retry syncs every inbox again.
    engine.calls = [];
    await act(async () => { fireEvent.click(chip); });
    expect(callsOf('mobile.sync.refresh')).toEqual([{ accountId: 'a1' }, { accountId: 'a2' }]);
    await syncState('a2', 'idle');
    expect(screen.queryByRole('button', { name: new RegExp(t('mobile.sync.failed')) })).toBeNull();
  });

  it('the pull spinner runs until every account\'s pass is done', async () => {
    await mountUnified();
    const list = document.querySelector('.mv-list');
    fireEvent.touchStart(list, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(list, { touches: [{ clientY: 300 }] });
    await act(async () => { fireEvent.touchEnd(list, { touches: [] }); });
    expect(document.querySelector('.mv-pull--busy')).toBeTruthy();
    await later();
    await syncState('a1', 'idle');
    expect(document.querySelector('.mv-pull--busy')).toBeTruthy();
    await syncState('a2', 'idle');
    expect(document.querySelector('.mv-pull--busy')).toBeNull();
  });

  it('pull to refresh syncs every account', async () => {
    await mountUnified();
    engine.calls = [];
    await act(async () => { await store().refresh(); });
    expect(callsOf('mobile.sync.refresh')).toEqual([{ accountId: 'a1' }, { accountId: 'a2' }]);
  });
});
