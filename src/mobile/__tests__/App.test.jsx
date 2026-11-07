// @vitest-environment jsdom
// The app's mount work (the ping line, the optional probe, the store's init) runs once per mount,
// however often the store changes afterwards. A tapped new-mail notification opens its account,
// folder and message, from the event or (a cold launch) from the shell's held tap on mount.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen } from '@testing-library/react';

const engine = vi.hoisted(() => ({ handlers: new Map(), calls: [], taps: [] }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }, { id: 'a2', email: 'a2@example.test', displayName: 'B' }] };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: engine.calls.length, total: 3, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page': {
        const tag = params.accountId === 'a2' ? 'Second' : 'Hello';
        return {
          rows: [{ uid: 1, dateMs: 1000, subject: tag, fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: false }],
          nextCursor: null,
          total: 1,
          listGen: 1,
        };
      }
      case 'mobile.message.body':
        return params.uid === 1 ? { html: null, text: 'Body text', attachments: [], remoteImages: 0, trackers: 0 } : { gone: true };
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
  // The shell's held tap: each one is taken once.
  takeNotificationTap: vi.fn(async () => engine.taps.shift() ?? null),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: App } = await import('../App.jsx');

// A new store per test (the store is a module singleton that remembers the open account).
async function fresh() {
  globalThis.localStorage?.clear();
  vi.resetModules();
  const { default: FreshApp } = await import('../App.jsx');
  const { useMobileStore } = await import('../store.js');
  return { App: FreshApp, store: useMobileStore };
}

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const count = (method) => engine.calls.filter(([m]) => m === method).length;

afterEach(() => {
  cleanup();
  engine.calls.length = 0;
  engine.taps.length = 0;
  engine.handlers.clear();
});

const bodyCalls = () => engine.calls.filter(([m]) => m === 'mobile.message.body').map(([, p]) => p);

describe('App', () => {
  it('pings and inits exactly once while the store keeps changing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        emit('mobile.sync.state', { accountId: 'a1', state: i % 2 ? 'idle' : 'syncing' });
        emit('mobile.folder.changed', { accountId: 'a2', folder: 'INBOX', added: 1, removed: 0, updated: 0, listGen: 2 + i });
        emit('mobile.folders.changed', { accountId: 'a1' });
      });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(count('mobile.ping')).toBe(1);
    expect(count('mobile.accounts.list')).toBe(1);
    expect(count('mobile.sync.refresh')).toBe(1);
    expect(log.mock.calls.filter(([l]) => String(l).includes('"ping"'))).toHaveLength(1);
    log.mockRestore();
  });

  it('mobile.notification.open selects the account and folder and opens the message', async () => {
    const { App: Fresh, store } = await fresh();
    render(<Fresh />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    engine.taps.push({ accountId: 'a2', folder: 'INBOX', uid: 1 });
    await act(async () => { emit('mobile.notification.open', { accountId: 'a2', folder: 'INBOX', uid: 1 }); });
    await waitFor(() => expect(bodyCalls()).toContainEqual({ accountId: 'a2', folder: 'INBOX', uid: 1 }));
    expect(store.getState().activeAccountId).toBe('a2');
    expect(store.getState().activeFolder).toBe('INBOX');
    // The viewer is up on that message (its subject as the heading).
    await waitFor(() => expect(document.querySelector('.mv-viewer__subject')?.textContent).toBe('Second'));
    // The tap was taken, so a second announcement of it opens nothing new.
    const opened = bodyCalls().length;
    await act(async () => { emit('mobile.notification.open', { accountId: 'a2', folder: 'INBOX', uid: 1 }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(bodyCalls()).toHaveLength(opened);
  });

  it('a notification for a message that is gone shows the gone notice', async () => {
    const { App: Fresh, store } = await fresh();
    render(<Fresh />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    engine.taps.push({ accountId: 'a1', folder: 'INBOX', uid: 42 });
    await act(async () => { emit('mobile.notification.open', { accountId: 'a1', folder: 'INBOX', uid: 42 }); });
    await waitFor(() => expect(screen.getByText('This message is no longer on the server.')).toBeTruthy());
    // The app is on that folder, with no blank viewer over it.
    expect(store.getState().activeFolder).toBe('INBOX');
    expect(document.querySelector('.mv-viewer__subject')).toBeNull();
    expect(bodyCalls()).toEqual([]);
  });

  it('a cold-launch tap is picked up by mobile_notification_take on mount', async () => {
    const { App: Fresh, store } = await fresh();
    engine.taps.push({ accountId: 'a2', folder: 'INBOX', uid: 1 });
    render(<Fresh />);
    await waitFor(() => expect(bodyCalls()).toContainEqual({ accountId: 'a2', folder: 'INBOX', uid: 1 }));
    await waitFor(() => expect(document.querySelector('.mv-viewer__subject')?.textContent).toBe('Second'));
    expect(store.getState().activeAccountId).toBe('a2');
  });
});
