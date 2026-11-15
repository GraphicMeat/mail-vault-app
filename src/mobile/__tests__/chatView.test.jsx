// @vitest-environment jsdom
// Mail view chat (Settings > Appearance > Mail view, `viewStyle`): in place of the message list,
// the folder's people (`mobile.chat.people`), then a person's conversations
// (`mobile.chat.topics`); a conversation opens on the conversation screen as in the list. The
// list view stays the default, and All Inboxes stays a list.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, fireEvent } from '@testing-library/react';

const engine = vi.hoisted(() => ({ handlers: new Map(), calls: [], prefs: {} }));

const TOPIC = {
  uid: 3, dateMs: 3000, subject: 'Re: Plans', fromName: 'Ann', fromAddress: 'ann@example.test', snippet: '', seen: true, flagged: false,
  threadId: '<a@x>', threadCount: 2, threadUnread: 0, threadFlagged: false, threadUids: [3, 1],
};
const SINGLE = { uid: 5, dateMs: 1000, subject: 'Lunch', fromName: 'Me', fromAddress: 'me@example.test', snippet: '', seen: true, flagged: false };

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'me@example.test', displayName: 'Me' }] };
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { notifications: 'off', notificationPreview: true };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 3, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return { rows: [TOPIC, SINGLE], nextCursor: null, total: 2, listGen: 1 };
      case 'mobile.chat.people':
        return {
          people: [
            { email: 'ann@example.test', name: 'Ann Lee', count: 3, unread: 1, lastDateMs: 3000, lastSubject: 'Re: Plans' },
            { email: 'bob@example.test', name: 'bob', count: 1, unread: 0, lastDateMs: 2000, lastSubject: 'Hello' },
          ],
        };
      case 'mobile.chat.topics':
        return { rows: params.email === 'ann@example.test' ? [TOPIC, SINGLE] : [] };
      case 'mobile.messages.thread':
        return { rows: [{ ...SINGLE, uid: 1, subject: 'Plans', accountId: 'a1', folder: 'INBOX' }, { ...TOPIC, accountId: 'a1', folder: 'INBOX' }], threadId: '<a@x>' };
      case 'mobile.message.body':
        return { html: null, text: `Body ${params.uid}`, attachments: [], remoteImages: 0, trackers: 0, alerts: [] };
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
  setAppIcon: vi.fn(async () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

async function fresh() {
  globalThis.localStorage?.clear();
  vi.resetModules();
  const { default: App } = await import('../App.jsx');
  return App;
}

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const person = (email) => document.querySelector(`[data-mv-chat-person="${email}"] button`);

let offsetHeight;
let offsetWidth;
beforeEach(() => {
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

describe('mail view chat', () => {
  it('the list view is the default: no people are asked for', async () => {
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-mv-list] [data-loaded="1"]')).toBeTruthy());
    expect(document.querySelector('[data-mv-chat]')).toBeNull();
    expect(callsOf('mobile.chat.people')).toEqual([]);
  });

  it('shows the folder by person, then a person’s conversations, which open as in the list', async () => {
    engine.prefs = { viewStyle: 'chat' };
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(person('ann@example.test')).toBeTruthy());
    expect(callsOf('mobile.chat.people')[0]).toEqual({ accountId: 'a1', folder: 'INBOX' });
    expect(document.querySelector('[data-mv-chat="people"] [data-mv-chat-person]')).toBeTruthy();
    expect(person('ann@example.test').textContent).toContain('Ann Lee');
    expect(person('ann@example.test').className).toContain('mv-row--unread');
    expect(person('bob@example.test').className).not.toContain('mv-row--unread');

    await act(async () => { fireEvent.click(person('ann@example.test')); });
    await waitFor(() => expect(document.querySelectorAll('[data-mv-chat="topics"] [data-loaded="1"]')).toHaveLength(2));
    expect(callsOf('mobile.chat.topics')[0]).toEqual({ accountId: 'a1', folder: 'INBOX', email: 'ann@example.test' });

    // A conversation opens the conversation screen; a single message, the viewer.
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-chat="topics"] [data-index="0"]')); });
    await waitFor(() => expect(document.querySelector('[data-mv-thread]')).toBeTruthy());
    expect(callsOf('mobile.messages.thread')[0]).toMatchObject({ accountId: 'a1', folder: 'INBOX', uid: 3 });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-thread-close]')); });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-chat="topics"] [data-index="1"]')); });
    await waitFor(() => expect(callsOf('mobile.message.body')).toHaveLength(1));
    expect(callsOf('mobile.message.body')[0]).toMatchObject({ uid: 5 });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-viewer-close]')); });

    // Back goes to the people.
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-chat-back]')); });
    expect(document.querySelector('[data-mv-chat="people"]')).toBeTruthy();
  });

  it('a person with nothing left goes back to the people', async () => {
    engine.prefs = { viewStyle: 'chat' };
    const App = await fresh();
    render(<App />);
    await waitFor(() => expect(person('bob@example.test')).toBeTruthy());
    await act(async () => { fireEvent.click(person('bob@example.test')); });
    await waitFor(() => expect(callsOf('mobile.chat.topics')).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('[data-mv-chat="people"]')).toBeTruthy());
  });
});
