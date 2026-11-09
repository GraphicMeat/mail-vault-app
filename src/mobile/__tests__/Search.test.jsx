// @vitest-environment jsdom
// The search screen: typing waits 250 ms, the scope chips restart the search, the server is asked
// by a tap or by itself when the device finds nothing, a result opens from its own account and
// folder, more local rows load as the list nears its end, and recent searches can be cleared.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';

const engine = vi.hoisted(() => ({ calls: [], local: null, server: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    if (method === 'mobile.search.local') return engine.local(params);
    if (method === 'mobile.search.server') return engine.server(params);
    throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
  }),
  listen: vi.fn(() => () => {}),
}));

import Search, { SEARCH_DEBOUNCE_MS } from '../Search.jsx';
import { useMobileStore, STORAGE_RECENT_SEARCHES } from '../store.js';

const row = (uid, extra = {}) => ({
  uid, accountId: 'a1', folder: 'INBOX', dateMs: 1000 + uid, subject: `Subject ${uid}`, fromName: 'Ada',
  fromAddress: 'ada@example.test', snippet: '', seen: true, ...extra,
});
const calls = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });
const type = (value) => fireEvent.change(screen.getByRole('searchbox'), { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  engine.calls = [];
  engine.local = () => ({ rows: [row(1), row(2)], cursor: null });
  engine.server = () => ({ rows: [] });
  window.localStorage.clear();
  useMobileStore.setState({ activeAccountId: 'a1', activeFolder: 'INBOX', recentSearches: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('search screen', () => {
  it('waits for typing to stop before it asks the engine', async () => {
    render(<Search onOpen={() => {}} onClose={() => {}} />);
    type('inv');
    await advance(SEARCH_DEBOUNCE_MS - 50);
    type('invoice');
    await advance(SEARCH_DEBOUNCE_MS - 50);
    expect(calls('mobile.search.local')).toEqual([]);
    await advance(50);
    expect(calls('mobile.search.local')).toEqual([{ query: 'invoice', accountId: 'a1', folder: 'INBOX' }]);
    expect(screen.getByText('Subject 1')).toBeTruthy();
    expect(screen.getByText('Subject 2')).toBeTruthy();
  });

  it('scope chips: this folder names the folder, all accounts names none', async () => {
    render(<Search onOpen={() => {}} onClose={() => {}} />);
    type('invoice');
    await advance(SEARCH_DEBOUNCE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'All accounts' }));
    await advance(SEARCH_DEBOUNCE_MS);
    expect(calls('mobile.search.local')).toEqual([
      { query: 'invoice', accountId: 'a1', folder: 'INBOX' },
      { query: 'invoice' },
    ]);
    expect(screen.getByRole('button', { name: 'All accounts' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'This folder' }));
    await advance(SEARCH_DEBOUNCE_MS);
    expect(calls('mobile.search.local')[2]).toEqual({ query: 'invoice', accountId: 'a1', folder: 'INBOX' });
  });

  it('asks the server by itself when the device finds nothing, and shows what it returns', async () => {
    engine.local = () => ({ rows: [], cursor: null });
    engine.server = () => ({ rows: [row(9, { subject: 'Old invoice' })] });
    const onOpen = vi.fn();
    render(<Search onOpen={onOpen} onClose={() => {}} />);
    type('invoice');
    await advance(SEARCH_DEBOUNCE_MS);
    await settle();
    expect(calls('mobile.search.server')).toEqual([{ accountId: 'a1', folder: 'INBOX', query: 'invoice' }]);
    fireEvent.click(screen.getByText('Old invoice'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ uid: 9 }));
  });

  it('offers the server under local results and asks only on the tap', async () => {
    engine.server = () => ({ rows: [row(2, { subject: 'dup' }), row(7, { subject: 'Server only' })] });
    render(<Search onOpen={() => {}} onClose={() => {}} />);
    type('invoice');
    await advance(SEARCH_DEBOUNCE_MS);
    expect(calls('mobile.search.server')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Search on server' }));
    await settle();
    expect(calls('mobile.search.server')).toHaveLength(1);
    expect(screen.getByText('Server only')).toBeTruthy();
    // A row the device already showed is not listed twice.
    expect(screen.queryByText('dup')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search on server' })).toBeNull();
  });

  it('shows the translated message when the index is unavailable, then tries the server', async () => {
    engine.local = () => { throw Object.assign(new Error('x'), { code: 'SEARCH_UNAVAILABLE' }); };
    render(<Search onOpen={() => {}} onClose={() => {}} />);
    type('invoice');
    await advance(SEARCH_DEBOUNCE_MS);
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/isn't ready/);
    expect(calls('mobile.search.server')).toHaveLength(1);
  });

  it('opening a result remembers the search and hands the row on', async () => {
    const onOpen = vi.fn();
    render(<Search onOpen={onOpen} onClose={() => {}} />);
    type('  invoice ');
    await advance(SEARCH_DEBOUNCE_MS);
    fireEvent.click(screen.getByText('Subject 2'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ uid: 2, accountId: 'a1', folder: 'INBOX' }));
    expect(useMobileStore.getState().recentSearches).toEqual(['invoice']);
  });

  it('loads the next page with the cursor when the list nears its end', async () => {
    const proto = HTMLElement.prototype;
    const sh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 600 });
    try {
      engine.local = ({ cursor }) => (cursor == null
        ? { rows: [row(1), row(2)], cursor: 2 }
        : { rows: [row(3)], cursor: null });
      render(<Search onOpen={() => {}} onClose={() => {}} />);
      type('invoice');
      await advance(SEARCH_DEBOUNCE_MS);
      expect(calls('mobile.search.local')).toHaveLength(1);
      expect(screen.queryByText('Subject 3')).toBeNull();
      const results = document.querySelector('[data-mv-search-results]');
      results.scrollTop = 4100;
      fireEvent.scroll(results);
      await settle();
      expect(calls('mobile.search.local')[1]).toEqual({ query: 'invoice', cursor: 2, accountId: 'a1', folder: 'INBOX' });
      expect(screen.getByText('Subject 3')).toBeTruthy();
      fireEvent.scroll(results);
      await settle();
      expect(calls('mobile.search.local')).toHaveLength(2); // cursor null: the end
    } finally {
      if (sh) Object.defineProperty(proto, 'scrollHeight', sh); else delete proto.scrollHeight;
      delete proto.clientHeight;
    }
  });

  it('keeps the last 8 recent searches, offers them while the field is empty, and clears them', async () => {
    for (let i = 1; i <= 10; i++) useMobileStore.getState().addRecentSearch(`q${i}`);
    useMobileStore.getState().addRecentSearch('Q5');
    const recent = useMobileStore.getState().recentSearches;
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe('Q5');
    expect(recent.filter((q) => q.toLowerCase() === 'q5')).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_RECENT_SEARCHES))).toEqual(recent);

    render(<Search onOpen={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText('q10'));
    expect(screen.getByRole('searchbox').value).toBe('q10');
    type('');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useMobileStore.getState().recentSearches).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_RECENT_SEARCHES)).toBeNull();
    expect(screen.queryByText('Recent searches')).toBeNull();
  });
});
