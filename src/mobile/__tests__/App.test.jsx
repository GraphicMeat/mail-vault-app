// @vitest-environment jsdom
// The app's mount work (the ping line, the optional probe, the store's init) runs once per mount,
// however often the store changes afterwards.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen } from '@testing-library/react';

const engine = vi.hoisted(() => ({ handlers: new Map(), calls: [] }));

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
      case 'mobile.messages.page':
        return {
          rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: false }],
          nextCursor: null,
          total: 1,
          listGen: 1,
        };
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

const { default: App } = await import('../App.jsx');

const emit = (name, payload) => { for (const h of engine.handlers.get(name) || []) h(payload); };
const count = (method) => engine.calls.filter(([m]) => m === method).length;

afterEach(cleanup);

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
});
