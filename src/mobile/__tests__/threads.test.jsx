// @vitest-environment jsdom
// Conversations in the list (Settings > Appearance > Conversations): a row that stands for several
// messages shows their count, opens a screen with the conversation's messages in
// `threadSortOrder`, from which a message opens in the viewer; a swipe on it acts on every message.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ handlers: new Map(), calls: [], prefs: {} }));

const HEAD = {
  uid: 3, dateMs: 3000, subject: 'Re: Plans', fromName: 'Bea', fromAddress: 'bea@example.test', snippet: '', seen: true, flagged: false,
  threadId: '<a@x>', threadCount: 3, threadUnread: 1, threadFlagged: false, threadUids: [3, 2, 1],
};
const MEMBERS = [
  { uid: 1, dateMs: 1000, subject: 'Plans', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: true, accountId: 'a1', folder: 'INBOX' },
  { uid: 2, dateMs: 2000, subject: 'Re: Plans', fromName: 'Cy', fromAddress: 'cy@example.test', snippet: '', seen: false, accountId: 'a1', folder: 'INBOX' },
  { uid: 3, dateMs: 3000, subject: 'Re: Plans', fromName: 'Bea', fromAddress: 'bea@example.test', snippet: '', seen: true, accountId: 'a1', folder: 'INBOX' },
];

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { notifications: 'off', notificationPreview: true };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 1, total: 3, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return params.threads
          ? { rows: [HEAD], nextCursor: null, total: 1, listGen: 1 }
          : { rows: [...MEMBERS].reverse().map(({ accountId, folder, ...r }) => r), nextCursor: null, total: 3, listGen: 1 };
      case 'mobile.messages.thread': {
        const rows = params.order === 'newest-first' ? [...MEMBERS].reverse() : MEMBERS;
        return { rows, threadId: '<a@x>' };
      }
      case 'mobile.message.body':
        return { html: null, text: `Body ${params.uid}`, attachments: [], remoteImages: 0, trackers: 0, alerts: [] };
      case 'mobile.actions.apply':
        return { queued: params.uids.length, skipped: [] };
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
  return App;
}

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const listRow = () => document.querySelector('[data-mv-list] [data-index="0"][data-loaded="1"]');

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
  cleanup();
  engine.calls.length = 0;
  engine.handlers.clear();
  engine.prefs = {};
});

describe('conversations', () => {
  it('a conversation row opens its messages in thread order, and a message opens in the viewer', async () => {
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(listRow()).toBeTruthy());
    expect(callsOf('mobile.messages.page')[0]).toMatchObject({ threads: true });
    expect(listRow().querySelector('[data-mv-thread-count]').textContent).toBe('3');

    await act(async () => { fireEvent.click(listRow()); });
    await waitFor(() => expect(document.querySelectorAll('[data-mv-thread] [data-loaded="1"]')).toHaveLength(3));
    expect(callsOf('mobile.messages.thread')[0]).toEqual({ accountId: 'a1', folder: 'INBOX', uid: 3, order: 'oldest-first' });
    expect(callsOf('mobile.message.body')).toEqual([]);
    const senders = [...document.querySelectorAll('[data-mv-thread] .mv-row__sender')].map((e) => e.textContent);
    expect(senders).toEqual(['Ada', 'Cy', 'Bea']);

    // The middle message opens in the viewer, above the conversation.
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-thread] [data-index="1"]')); });
    await waitFor(() => expect(callsOf('mobile.message.body')).toHaveLength(1));
    expect(callsOf('mobile.message.body')[0]).toMatchObject({ accountId: 'a1', folder: 'INBOX', uid: 2 });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-viewer-close]')); });
    expect(document.querySelector('.mv-viewer')).toBeNull();
    expect(document.querySelector('[data-mv-thread]')).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-thread-close]')); });
    expect(document.querySelector('[data-mv-thread]')).toBeNull();
  });

  it('newest first when the preference says so', async () => {
    engine.prefs = { threadSortOrder: 'newest-first' };
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(listRow()).toBeTruthy());
    await act(async () => { fireEvent.click(listRow()); });
    await waitFor(() => expect(document.querySelectorAll('[data-mv-thread] [data-loaded="1"]')).toHaveLength(3));
    expect(callsOf('mobile.messages.thread')[0]).toMatchObject({ order: 'newest-first' });
    const senders = [...document.querySelectorAll('[data-mv-thread] .mv-row__sender')].map((e) => e.textContent);
    expect(senders).toEqual(['Bea', 'Cy', 'Ada']);
  });

  it('a swipe on a conversation row acts on every message of it', async () => {
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(listRow()).toBeTruthy());
    await act(async () => { fireEvent.click(listRow().querySelector('[data-mv-swipe-action="leading"]')); });
    await waitFor(() => expect(callsOf('mobile.actions.apply')).toHaveLength(1));
    expect(callsOf('mobile.actions.apply')[0]).toEqual({ accountId: 'a1', folder: 'INBOX', uids: [3, 2, 1], kind: 'seen' });
    expect(t('email.thread.messagesInThread', { count: 3 })).not.toBe('email.thread.messagesInThread');
  });

  it('flat lists every message and opens it straight away', async () => {
    engine.prefs = { threadMode: 'flat' };
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(listRow()).toBeTruthy());
    expect(callsOf('mobile.messages.page')[0]).not.toHaveProperty('threads');
    expect(document.querySelector('[data-mv-thread-count]')).toBeNull();
    await act(async () => { fireEvent.click(listRow()); });
    await waitFor(() => expect(callsOf('mobile.message.body')).toHaveLength(1));
    expect(callsOf('mobile.messages.thread')).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Re: Plans' })).toBeTruthy();
  });
});
