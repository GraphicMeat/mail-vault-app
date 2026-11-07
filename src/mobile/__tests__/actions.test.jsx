// @vitest-environment jsdom
// Actions UI over a fake engine: swipe and toolbar actions, the move picker, the deferred move or
// delete with its undo toast (nothing reaches the engine until the toast runs out, the page is
// hidden, or the next move or delete comes), the "waiting to sync" chip, dropped-action toasts,
// marking a message read on open, and Android Back closing the viewer instead of the app.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({
  calls: [], handlers: new Map(), rows: [], gone: new Set(), skip: [], pending: [], seq: 0, gen: 1, failApply: false,
  folders: [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 2, total: 5, depth: 0, noselect: false },
    { path: 'Archive', name: 'Archive', specialUse: null, unseen: 0, total: 0, depth: 0, noselect: false },
    { path: 'Projects', name: 'Projects', specialUse: null, unseen: 0, total: 0, depth: 0, noselect: true },
    { path: 'Projects/Q4', name: 'Q4', specialUse: null, unseen: 0, total: 0, depth: 1, noselect: false },
    { path: 'Trash', name: 'Deleted Items', specialUse: '\\Trash', unseen: 0, total: 0, depth: 0, noselect: false },
  ],
}));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.folders.list':
        return { folders: engine.folders };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page': {
        const rows = engine.rows.filter((r) => !engine.gone.has(r.uid));
        return { rows, nextCursor: null, total: rows.length, listGen: engine.gen };
      }
      case 'mobile.actions.apply': {
        if (engine.failApply) throw Object.assign(new Error('nope'), { code: 'INTERNAL' });
        const skipped = params.uids.filter((u) => engine.skip.includes(u) || !engine.rows.some((r) => r.uid === u));
        // The engine hides moved and deleted rows at once; a skipped uid has no row to show.
        if (params.kind === 'move' || params.kind === 'delete') for (const u of params.uids) engine.gone.add(u);
        for (const u of skipped) engine.gone.add(u);
        return { queued: skipped.length === params.uids.length ? null : ++engine.seq, skipped };
      }
      case 'mobile.actions.pending':
        return { pending: engine.pending };
      case 'mobile.message.body':
        return { html: '<p>Body</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn((name, handler) => {
    if (!engine.handlers.has(name)) engine.handlers.set(name, new Set());
    engine.handlers.get(name).add(handler);
    return () => engine.handlers.get(name)?.delete(handler);
  }),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
// jsdom has no PointerEvent: a MouseEvent with a pointer id is enough for the swipe.
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

const { createMobileStore, UNDO_MS, MAX_APPLY } = await import('../store.js');
const { default: MessageRow } = await import('../MessageRow.jsx');
const { default: MovePicker } = await import('../MovePicker.jsx');
const { default: Viewer } = await import('../Viewer.jsx');

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const applies = () => engine.calls.filter(([m]) => m === 'mobile.actions.apply').map(([, p]) => p);
const ROWS = [5, 4, 3, 2, 1].map((uid) => ({
  uid, dateMs: uid * 1000, subject: `Mail ${uid}`, fromName: `Sender ${uid}`, fromAddress: `s${uid}@example.test`,
  snippet: '', seen: uid % 2 === 0, flagged: false, to: [],
}));

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

async function freshStore() {
  const store = createMobileStore();
  await store.getState().init({ sync: false });
  await store.getState().list.ensure(0);
  return store;
}
const uidsOf = (list) => Array.from({ length: list.total }, (_, i) => list.rowAt(i)?.uid);

function swipe(el, from, to) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from, clientY: 20, button: 0, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + Math.sign(to - from) * 20, clientY: 21, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
}

beforeEach(() => {
  engine.calls = [];
  engine.rows = ROWS.map((r) => ({ ...r }));
  engine.gone = new Set();
  engine.skip = [];
  engine.pending = [];
  engine.failApply = false;
  visibility = 'visible';
  // The store remembers the last folder: every test starts in INBOX.
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('deferred move and delete', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('swipe_delete_calls_apply_and_hides_row', async () => {
    const store = await freshStore();
    const { list } = store.getState();
    const onSwipe = (kind, row) => store.getState().act(kind, { accountId: 'a1', folder: 'INBOX', uids: [row.uid] });
    const { container } = render(<MessageRow row={list.rowAt(1)} index={1} start={0} onOpen={() => {}} onSwipe={onSwipe} />);
    swipe(container.querySelector('.mv-row'), 300, 20);
    // Gone from the list at once; nothing sent while the undo toast is up.
    expect(uidsOf(list)).toEqual([5, 3, 2, 1]);
    expect(store.getState().undo).toMatchObject({ kind: 'delete', count: 1 });
    expect(applies()).toEqual([]);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(applies()).toEqual([{ accountId: 'a1', folder: 'INBOX', uids: [4], kind: 'delete' }]);
    expect(store.getState().undo).toBeNull();
    await list.ensure(0);
    expect(uidsOf(list)).toEqual([5, 3, 2, 1]);
  });

  it('a short swipe leaves the row open on its button, and the button acts', async () => {
    const onSwipe = vi.fn();
    const { container } = render(<MessageRow row={ROWS[0]} index={0} start={0} onOpen={() => {}} onSwipe={onSwipe} />);
    const row = container.querySelector('.mv-row');
    swipe(row, 20, 90); // past half the button, short of a full swipe
    expect(onSwipe).not.toHaveBeenCalled();
    expect(row.style.transform).toContain('88px');
    const button = container.querySelector('[data-mv-swipe-action="leading"]');
    expect(button.getAttribute('aria-hidden')).toBeNull();
    expect(button.textContent).toBe(t('mobile.actions.markRead'));
    fireEvent.click(button);
    expect(onSwipe).toHaveBeenCalledWith('seen', ROWS[0]);
  });

  it('a leading full swipe toggles read; a drag never opens the message', async () => {
    const onSwipe = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(<MessageRow row={ROWS[1]} index={1} start={0} onOpen={onOpen} onSwipe={onSwipe} />);
    const row = container.querySelector('.mv-row');
    swipe(row, 10, 330);
    fireEvent.click(row);
    expect(onSwipe).toHaveBeenCalledWith('unseen', ROWS[1]);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.pointerDown(row, { pointerId: 2, clientX: 50, clientY: 20, button: 0, isPrimary: true });
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(ROWS[1], 1);
  });

  it('undo within 5 s sends nothing and restores the row', async () => {
    const store = await freshStore();
    const { list } = store.getState();
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [4] });
    expect(uidsOf(list)).toEqual([5, 3, 2, 1]);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1000);
    expect(store.getState().undoDeferred(store.getState().undo.id)).toBe(true);
    expect(uidsOf(list)).toEqual([5, 4, 3, 2, 1]);
    expect(store.getState().undo).toBeNull();
    await vi.advanceTimersByTimeAsync(UNDO_MS * 3);
    expect(applies()).toEqual([]);
  });

  it('expiry sends exactly one apply', async () => {
    const store = await freshStore();
    store.getState().act('move', { accountId: 'a1', folder: 'INBOX', uids: [3], target: 'Archive' });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 3);
    expect(applies()).toEqual([{ accountId: 'a1', folder: 'INBOX', uids: [3], kind: 'move', target: 'Archive' }]);
    // An undo after the send is refused: the action has gone.
    expect(store.getState().undoDeferred(1)).toBe(false);
  });

  it('visibilitychange to hidden flushes, and so does pagehide', async () => {
    const store = await freshStore();
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [4] });
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().map((p) => p.uids)).toEqual([[4]]);
    visibility = 'visible';
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [3] });
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().map((p) => p.uids)).toEqual([[4], [3]]);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(applies()).toHaveLength(2);
  });

  it('a second delete flushes the first', async () => {
    const store = await freshStore();
    const { list } = store.getState();
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [4] });
    const first = store.getState().undo.id;
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [2] });
    await vi.advanceTimersByTimeAsync(0);
    expect(applies().map((p) => p.uids)).toEqual([[4]]);
    expect(store.getState().undo.id).not.toBe(first);
    expect(store.getState().undoDeferred(first)).toBe(false);
    await list.ensure(0);
    expect(uidsOf(list)).toEqual([5, 3, 1]);
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(applies().map((p) => p.uids)).toEqual([[4], [2]]);
  });

  it('a folder switch flushes the deferred action', async () => {
    const store = await freshStore();
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [4] });
    await store.getState().selectFolder('Archive');
    expect(applies().map((p) => p.uids)).toEqual([[4]]);
  });

  it('a failed apply brings the rows back and says so', async () => {
    const store = await freshStore();
    const { list } = store.getState();
    engine.failApply = true;
    store.getState().act('delete', { accountId: 'a1', folder: 'INBOX', uids: [4] });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    await vi.waitFor(() => expect(store.getState().notice?.key).toBe('mobile.actions.failed'));
    await list.ensure(0);
    expect(uidsOf(list)).toEqual([5, 4, 3, 2, 1]);
  });
});

describe('immediate actions', () => {
  it('skipped uids: the stale row is dropped from the list', async () => {
    const store = await freshStore();
    const { list } = store.getState();
    engine.skip = [2];
    await store.getState().act('flag', { accountId: 'a1', folder: 'INBOX', uids: [2] });
    expect(applies()).toEqual([{ accountId: 'a1', folder: 'INBOX', uids: [2], kind: 'flag' }]);
    await list.ensure(0);
    expect(uidsOf(list)).toEqual([5, 4, 3, 1]);
  });

  it('read, unread and flag go out at once, in chunks of at most 199 uids', async () => {
    const store = await freshStore();
    const many = Array.from({ length: 450 }, (_, i) => i + 1);
    await store.getState().act('seen', { accountId: 'a1', folder: 'INBOX', uids: many });
    expect(MAX_APPLY).toBe(199);
    expect(applies().map((p) => p.uids.length)).toEqual([199, 199, 52]);
    expect(applies().every((p) => p.kind === 'seen' && !('target' in p))).toBe(true);
  });

  it('marking an already read message read sends nothing', async () => {
    const store = await freshStore();
    await store.getState().markSeen('a1', 'INBOX', { uid: 4, seen: true });
    expect(applies()).toEqual([]);
    await store.getState().markSeen('a1', 'INBOX', { uid: 5, seen: false });
    expect(applies()).toEqual([{ accountId: 'a1', folder: 'INBOX', uids: [5], kind: 'seen' }]);
  });
});

describe('viewer toolbar and move picker', () => {
  const row = { ...ROWS[0], seen: true, flagged: false };

  it('toolbar_flag_toggles', () => {
    const onAction = vi.fn();
    render(<Viewer accountId="a1" folder="INBOX" row={row} folders={engine.folders} onClose={() => {}} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.flag') }));
    expect(onAction).toHaveBeenLastCalledWith('flag');
    const unflag = screen.getByRole('button', { name: t('mobile.actions.unflag') });
    expect(unflag.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(unflag);
    expect(onAction).toHaveBeenLastCalledWith('unflag');
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.markUnread') }));
    expect(onAction).toHaveBeenLastCalledWith('unseen');
    expect(screen.getByRole('button', { name: t('mobile.actions.markRead') })).toBeTruthy();
  });

  it('move_picker_lists_folders_without_current', () => {
    const onPick = vi.fn();
    render(<MovePicker folders={engine.folders} current="INBOX" onPick={onPick} onClose={() => {}} />);
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Archive', 'Q4', t('mobile.folder.trash')]);
    expect(names).not.toContain(t('sidebar.inbox'));
    expect(screen.getByText('Projects').tagName).toBe('LI'); // a noselect folder is a heading
    fireEvent.click(screen.getByRole('button', { name: 'Q4' }));
    expect(onPick).toHaveBeenCalledWith('Projects/Q4');
  });

  it('the toolbar move opens the picker and moves to the picked folder', () => {
    const onMove = vi.fn();
    render(<Viewer accountId="a1" folder="INBOX" row={row} folders={engine.folders} onClose={() => {}} onMove={onMove} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.move') }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onMove).toHaveBeenCalledWith('Archive');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});

describe('App', () => {
  let offsetHeight;
  let offsetWidth;
  beforeEach(() => {
    // The virtualizer sizes its window from offsetHeight; jsdom reports 0, so no row would mount.
    offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(375);
  });
  afterEach(() => {
    offsetHeight.mockRestore();
    offsetWidth.mockRestore();
    vi.restoreAllMocks();
  });

  async function mount() {
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    const { default: App } = await import('../App.jsx');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-index="0"][data-loaded="1"]')).toBeTruthy());
  }

  it('pending_chip_counts', async () => {
    engine.pending = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    await mount();
    await waitFor(() => expect(screen.getByText(t('mobile.actions.waiting', { count: 3 }))).toBeTruthy());
    engine.pending = [{ seq: 3 }];
    await act(async () => { emit('mobile.action.result', { seq: 1, accountId: 'a1', outcome: 'done' }); });
    await waitFor(() => expect(screen.getByText(t('mobile.actions.waiting', { count: 1 }))).toBeTruthy());
    engine.pending = [];
    await act(async () => { emit('mobile.action.result', { seq: 3, accountId: 'a1', outcome: 'done' }); });
    await waitFor(() => expect(screen.queryByText(/waiting to sync/)).toBeNull());
  });

  it('dropped_result_shows_toast', async () => {
    await mount();
    for (const reason of ['GONE', 'FOLDER_GONE', 'REFUSED']) {
      await act(async () => { emit('mobile.action.result', { seq: 9, accountId: 'a1', outcome: 'dropped', reason }); });
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(t(`mobile.actions.dropped.${reason}`)));
    }
    expect(t('mobile.actions.dropped.FOLDER_GONE')).not.toBe('mobile.actions.dropped.FOLDER_GONE');
    // A retry is not news.
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.dismiss') }));
    await act(async () => { emit('mobile.action.result', { seq: 9, accountId: 'a1', outcome: 'retrying', reason: 'REFUSED' }); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opening a message marks it read; Back closes the picker, then the viewer, not the app', async () => {
    await mount();
    fireEvent.click(document.querySelector('[data-index="0"]')); // uid 5, unread
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 5' })).toBeTruthy());
    expect(applies()).toEqual([{ accountId: 'a1', folder: 'INBOX', uids: [5], kind: 'seen' }]);
    expect(screen.getByRole('button', { name: t('mobile.actions.markUnread') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.move') }));
    expect(screen.getByRole('dialog', { name: t('mobile.actions.moveTitle') })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.queryByRole('dialog', { name: t('mobile.actions.moveTitle') })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Mail 5' })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.queryByRole('dialog', { name: 'Mail 5' })).toBeNull();
    expect(screen.getByText('a1@example.test')).toBeTruthy();
  });

  it('viewer delete closing onto the next message sends the delete at once', async () => {
    await mount();
    fireEvent.click(document.querySelector('[data-index="1"]')); // uid 4, read
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 4' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 3' })).toBeTruthy());
    // The viewer moved on: no undo, the delete went; uid 3 was unread, so opening it marked it read.
    expect(screen.queryByText(t('mobile.actions.deleted', { count: 1 }))).toBeNull();
    await waitFor(() => expect(applies()).toEqual([
      { accountId: 'a1', folder: 'INBOX', uids: [4], kind: 'delete' },
      { accountId: 'a1', folder: 'INBOX', uids: [3], kind: 'seen' },
    ]));
  });

  it('viewer delete of the last row closes to the list; undo brings it back and sends nothing', async () => {
    await mount();
    fireEvent.click(document.querySelector('[data-index="4"]')); // uid 1, the last row
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 1' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mail 1' })).toBeNull());
    expect(screen.queryByText('Mail 1')).toBeNull();
    expect(screen.getByText(t('mobile.actions.deleted', { count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.undo') }));
    expect(screen.queryByText(t('mobile.actions.deleted', { count: 1 }))).toBeNull();
    await waitFor(() => expect(screen.getByText('Mail 1')).toBeTruthy());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(applies().filter((p) => p.kind === 'delete')).toEqual([]);
  });

  it('Back closes the folder drawer, not the app', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.drawer.open') }));
    expect(screen.getByRole('dialog', { name: t('mobile.drawer.title') })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.queryByRole('dialog', { name: t('mobile.drawer.title') })).toBeNull();
    expect(screen.getByText('a1@example.test')).toBeTruthy();
  });

  it('the toolbar flag goes to the engine at once', async () => {
    await mount();
    fireEvent.click(document.querySelector('[data-index="2"]')); // uid 3
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Mail 3' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('mobile.actions.flag') }));
    await waitFor(() => expect(applies().some((p) => p.kind === 'flag')).toBe(true));
    expect(applies().find((p) => p.kind === 'flag')).toEqual({ accountId: 'a1', folder: 'INBOX', uids: [3], kind: 'flag' });
  });
});
