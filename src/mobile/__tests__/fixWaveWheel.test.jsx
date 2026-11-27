// @vitest-environment jsdom
// The quick action wheel is on every list of message rows, not only the main list: Search results,
// a saved view's mail, a conversation's messages and a person's topics in the chat view. Lists
// that cannot select (only the main list has the sweep column and the bar) offer no Select wedge.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

const ROWS = [
  { uid: 1, accountId: 'a1', folder: 'INBOX', subject: 'One', fromName: 'Ada', fromAddress: 'a@example.test', dateMs: 1000, snippet: '', seen: false, flagged: false },
  { uid: 2, accountId: 'a1', folder: 'INBOX', subject: 'Two', fromName: 'Bob', fromAddress: 'b@example.test', dateMs: 2000, snippet: '', seen: true, flagged: false },
];
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    switch (method) {
      case 'mobile.search.local': return { rows: ROWS, cursor: null };
      case 'mobile.search.server': return { rows: [] };
      case 'mobile.views.evaluate': return { available: true, rows: ROWS, total: 2, cursor: null };
      case 'mobile.messages.thread': return { rows: ROWS, threadId: '<a@x>' };
      case 'mobile.chat.people': return { people: [{ email: 'a@example.test', name: 'Ada', count: 2, unread: 1, lastDateMs: 2000, lastSubject: 'Two' }] };
      case 'mobile.chat.topics': return { rows: ROWS };
      case 'mobile.folders.list': return { folders: [] };
      case 'mobile.tags.list': return { tags: [] };
      default: return {};
    }
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76 })),
    getTotalSize: () => count * 76,
    measure() {},
    scrollOffset: 0,
  }),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { default: Search } = await import('../Search.jsx');
const { default: ViewResults } = await import('../ViewResults.jsx');
const { default: ThreadView } = await import('../ThreadView.jsx');
const { default: ChatView } = await import('../ChatView.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const wheel = () => ({ onAction: vi.fn(), onMove: vi.fn(), onCompose: vi.fn() });
const press = (el) => fireEvent.pointerDown(el, { pointerId: 1, clientX: 120, clientY: 400, button: 0, isPrimary: true });
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });
const slots = () => [...document.querySelectorAll('.mv-row-slot')].filter((s) => s.getAttribute('data-loaded') !== '0');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });
  window.localStorage.clear();
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', folders: [], accounts: [{ id: 'a1', email: 'a@example.test' }], recentSearches: [] });
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function holdsOpenTheWheel() {
  expect(document.querySelector('.quick-actions-radial')).toBeNull();
  press(slots()[1]);
  await advance(360);
  expect(haptic.impact).toHaveBeenCalledWith('medium');
  expect(document.querySelector('.quick-actions-radial')).not.toBeNull();
}

describe('the wheel on every list of message rows', () => {
  it('Search results', async () => {
    render(<Search onOpen={() => {}} onSwipe={() => {}} onClose={() => {}} wheel={wheel()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'invoice' } });
    await advance(300);
    await settle();
    await holdsOpenTheWheel();
  });

  it('a saved view\'s mail', async () => {
    render(<ViewResults view={{ id: 'v1', name: 'Bills', icon: 'star', builtin: null, position: 0, def: {} }} onOpen={() => {}} onSwipe={() => {}} onClose={() => {}} wheel={wheel()} />);
    await settle();
    await holdsOpenTheWheel();
  });

  it('a conversation\'s messages', async () => {
    const head = { uid: 2, threadUids: [2, 1], threadCount: 2, subject: 'Two' };
    render(<ThreadView accountId="a1" folder="INBOX" row={head} onOpen={() => {}} onSwipe={() => {}} onClose={() => {}} wheel={wheel()} />);
    await settle();
    await holdsOpenTheWheel();
  });

  it('a person\'s topics in the chat view', async () => {
    render(<ChatView accountId="a1" folder="INBOX" list={null} onOpen={() => {}} onSwipe={() => {}} wheel={wheel()} />);
    await settle();
    fireEvent.click(document.querySelector('[data-mv-chat-person] button'));
    await settle();
    await holdsOpenTheWheel();
  });

  it('a list given no wheel cannot be held', async () => {
    render(<ViewResults view={{ id: 'v1', name: 'Bills', icon: 'star', builtin: null, position: 0, def: {} }} onOpen={() => {}} onSwipe={() => {}} onClose={() => {}} />);
    await settle();
    press(slots()[1]);
    await advance(500);
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
  });
});
