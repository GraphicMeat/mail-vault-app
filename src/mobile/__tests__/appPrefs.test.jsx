// @vitest-environment jsdom
// The preferences a desktop import carries, where the app acts on them (W1a): when opening marks
// a message read, the question before a delete, what the viewer shows after one, and hidden
// accounts left out of the switcher.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen, fireEvent, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ handlers: new Map(), calls: [], prefs: {}, hidden: false, rows: 1 }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return {
          accounts: [
            { id: 'a1', email: 'a1@example.test', displayName: 'A', hidden: false },
            { id: 'a2', email: 'a2@example.test', displayName: 'B', hidden: engine.hidden },
            { id: 'a3', email: 'a3@example.test', displayName: 'C', hidden: false },
          ],
        };
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { notifications: 'off', notificationPreview: true };
      case 'mobile.folders.list':
        return {
          folders: [
            { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 3, depth: 0, noselect: false },
            { path: 'Archive', name: 'Archive', specialUse: null, unseen: 0, total: 0, depth: 0, noselect: false },
          ],
        };
      case 'mobile.search.local':
        return { rows: [{ uid: 42, accountId: 'a1', folder: 'INBOX', dateMs: 900, subject: 'Found 42', fromName: 'Bea', fromAddress: 'bea@example.test', snippet: '', seen: true, flagged: false }], cursor: null };
      case 'mobile.search.server':
        return { rows: [] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return {
          rows: Array.from({ length: engine.rows }, (_, i) => ({
            uid: 10 - i, dateMs: 1000 - i, subject: `Mail ${i + 1}`, fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: false,
          })),
          nextCursor: null,
          total: engine.rows,
          listGen: 1,
        };
      case 'mobile.message.body':
        return { html: null, text: 'Body text', attachments: [], remoteImages: 0, trackers: 0 };
      case 'mobile.actions.apply':
        return { queued: 1, skipped: [] };
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
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
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

function swipe(el, from, to) {
  fireEvent.pointerDown(el, { pointerId: 1, clientX: from, clientY: 20, button: 0, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: from + Math.sign(to - from) * 20, clientY: 21, isPrimary: true });
  fireEvent.pointerMove(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: to, clientY: 22, isPrimary: true });
}

async function fresh() {
  globalThis.localStorage?.clear();
  vi.resetModules();
  const { default: App } = await import('../App.jsx');
  const { useMobileStore } = await import('../store.js');
  return { App, store: useMobileStore };
}

// The list is virtualized: it lays rows out only with a measured viewport.
let sizes = [];
beforeEach(() => {
  sizes = [
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(375),
  ];
  window.history.replaceState({}, '', '/mobile.html');
});

afterEach(() => {
  for (const s of sizes) s.mockRestore();
  cleanup();
  engine.calls.length = 0;
  engine.handlers.clear();
  engine.prefs = {};
  engine.hidden = false;
  engine.rows = 1;
  vi.useRealTimers();
});

const seenApplies = () => engine.calls.filter(([m, p]) => m === 'mobile.actions.apply' && p.kind === 'seen');

async function openFirst(App, store) {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Mail 1')).toBeTruthy());
  await waitFor(() => expect(store.getState().prefs).toMatchObject(engine.prefs));
  await act(async () => { fireEvent.click(screen.getByText('Mail 1')); });
  await waitFor(() => expect(document.querySelector('[data-mv-tool="delete"]')).toBeTruthy());
}

describe('preferences in the app', () => {
  it('opening marks read at once by default', async () => {
    const { App, store } = await fresh();
    await openFirst(App, store);
    await waitFor(() => expect(seenApplies()).toHaveLength(1));
  });

  it('markAsReadMode manual never marks on open', async () => {
    engine.prefs = { markAsReadMode: 'manual' };
    const { App, store } = await fresh();
    await openFirst(App, store);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(seenApplies()).toHaveLength(0);
  });

  it('markAsReadMode delay marks after the delay, while still open', async () => {
    engine.prefs = { markAsReadMode: 'delay', markAsReadDelay: 1 };
    const { App, store } = await fresh();
    await openFirst(App, store);
    expect(seenApplies()).toHaveLength(0);
    const tool = () => document.querySelector('[data-mv-tool="seen"]');
    expect(tool().getAttribute('aria-label')).toBe(t('mobile.actions.markRead'));
    await waitFor(() => expect(seenApplies()).toHaveLength(1), { timeout: 2500 });
    // The viewer's toggle follows: the message is read now, so it offers Mark unread.
    await waitFor(() => expect(tool().getAttribute('aria-label')).toBe(t('mobile.actions.markUnread')));
  });

  it('confirmBeforeDelete asks first; Cancel keeps the message', async () => {
    engine.prefs = { confirmBeforeDelete: true };
    const { App, store } = await fresh();
    await openFirst(App, store);
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-tool="delete"]')); });
    expect(screen.getByText(t('mobile.confirmDelete.title'))).toBeTruthy();
    expect(store.getState().undo).toBe(null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })); });
    expect(store.getState().undo).toBe(null);
    expect(document.querySelector('[data-mv-tool="delete"]')).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-tool="delete"]')); });
    const sheet = document.querySelector('[data-mv-confirm-delete]');
    await act(async () => { fireEvent.click(sheet.querySelector('.mv-textbtn--danger')); });
    expect(store.getState().undo).toMatchObject({ kind: 'delete', count: 1 });
  });

  it('afterDeleteSelect none goes back to the list; next opens the one below', async () => {
    engine.rows = 3;
    engine.prefs = { afterDeleteSelect: 'none' };
    let { App, store } = await fresh();
    await openFirst(App, store);
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-tool="delete"]')); });
    expect(document.querySelector('[data-mv-tool="delete"]')).toBe(null);
    cleanup();
    engine.prefs = { afterDeleteSelect: 'next' };
    ({ App, store } = await fresh());
    await openFirst(App, store);
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-tool="delete"]')); });
    await waitFor(() => expect(screen.getAllByText('Mail 2').length).toBeGreaterThan(0));
    expect(document.querySelector('[data-mv-tool="delete"]')).toBeTruthy();
  });

  it('a hidden account is left out of the switcher and All Inboxes still counts the rest', async () => {
    engine.hidden = true;
    const { App, store } = await fresh();
    render(<App />);
    await waitFor(() => expect(store.getState().accounts).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole('button', { name: t('mobile.switcher.open', { email: 'a1@example.test' }) })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.switcher.open', { email: 'a1@example.test' }) })); });
    expect(screen.queryByText('a3@example.test')).toBeTruthy();
    expect(screen.queryByText('a2@example.test')).toBe(null);
  });
  // Search rows swipe the way list rows do (`swipeLeftAction` / `swipeRightAction`).
  async function searchFor(App, store) {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Mail 1')).toBeTruthy());
    await waitFor(() => expect(store.getState().prefs).toMatchObject(engine.prefs));
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-search-open]')); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'found' } });
    await waitFor(() => expect(screen.getByText('Found 42')).toBeTruthy());
    return () => document.querySelector('.mv-search .mv-row');
  }
  const applies = () => engine.calls.filter(([m]) => m === 'mobile.actions.apply').map(([, p]) => p);

  it('a search row swiped to delete asks first when confirmBeforeDelete is on', async () => {
    engine.prefs = { confirmBeforeDelete: true, swipeLeftAction: 'delete' };
    const { App, store } = await fresh();
    const row = await searchFor(App, store);
    await act(async () => { swipe(row(), 300, 20); });
    expect(document.querySelector('[data-mv-confirm-delete]')).toBeTruthy();
    expect(store.getState().undo).toBe(null);
    expect(screen.getByText('Found 42')).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-confirm-delete] .mv-textbtn--danger')); });
    expect(store.getState().undo).toMatchObject({ kind: 'delete', count: 1 });
    await waitFor(() => expect(screen.queryByText('Found 42')).toBe(null));
  });

  it('a search row swiped to move opens the folder picker and moves where picked', async () => {
    engine.prefs = { swipeLeftAction: 'move' };
    const { App, store } = await fresh();
    const row = await searchFor(App, store);
    await act(async () => { swipe(row(), 300, 20); });
    // Nothing moves before a folder is picked.
    expect(store.getState().undo).toBe(null);
    expect(screen.getByText('Found 42')).toBeTruthy();
    const picker = screen.getByRole('dialog', { name: t('mobile.actions.moveTitle') });
    await act(async () => { fireEvent.click(within(picker).getByText('Archive')); });
    expect(store.getState().undo).toMatchObject({ kind: 'move', count: 1, target: 'Archive' });
    await waitFor(() => expect(screen.queryByText('Found 42')).toBe(null));
  });

  it('a search row swiped to flag is flagged, not marked unread', async () => {
    engine.prefs = { swipeRightAction: 'flag' };
    const { App, store } = await fresh();
    const row = await searchFor(App, store);
    await act(async () => { swipe(row(), 10, 330); });
    await waitFor(() => expect(applies().map((p) => p.kind)).toEqual(['flag']));
    expect(applies()[0]).toMatchObject({ accountId: 'a1', folder: 'INBOX', uids: [42] });
    expect(row().className).not.toContain('mv-row--unread');
    expect(row().querySelector('.mv-row__flag')).toBeTruthy();
  });
});
