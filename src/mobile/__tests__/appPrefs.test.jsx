// @vitest-environment jsdom
// The preferences a desktop import carries, where the app acts on them (W1a): when opening marks
// a message read, the question before a delete, what the viewer shows after one, and hidden
// accounts left out of the switcher.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react';
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
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 3, depth: 0, noselect: false }] };
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
    await waitFor(() => expect(seenApplies()).toHaveLength(1), { timeout: 2500 });
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
});
