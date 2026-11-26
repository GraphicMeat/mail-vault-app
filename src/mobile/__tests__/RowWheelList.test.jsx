// @vitest-environment jsdom
// Holding a list row opens the wheel on it (MessageList.jsx, MessageRow.jsx): a medium tick, desktop's
// wheel at the finger; a swipe or a short press opens nothing; a list without `wheel` cannot be held.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));
vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async () => ({ folders: [], tags: [] })),
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

const { default: MessageList } = await import('../MessageList.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const rows = [
  { uid: 1, subject: 'One', fromName: 'Ada', fromAddress: 'a@example.test', dateMs: 1, snippet: '', seen: false, flagged: false },
  { uid: 2, subject: 'Two', fromName: 'Bob', fromAddress: 'b@example.test', dateMs: 2, snippet: '', seen: true, flagged: false },
];
const cache = {
  total: 2, version: 1, pageSize: 50, anchor: null, topIndex: 0,
  subscribe: () => () => {}, rowAt: (i) => rows[i], ensure: async () => {}, clearAnchor() {},
};
const wheel = () => ({ onAction: vi.fn(), onMove: vi.fn(), onCompose: vi.fn() });
const slots = () => [...document.querySelectorAll('.mv-row-slot')];
const press = (el, x = 120, y = 400) => fireEvent.pointerDown(el, { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });
  useMobileStore.setState({ prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX', folders: [], accounts: [{ id: 'a1', email: 'a@example.test' }] });
  for (const f of Object.values(haptic)) f.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('holding a list row', () => {
  it('opens desktop\'s wheel on it with a medium tick', () => {
    render(<MessageList cache={cache} onOpen={() => {}} onSwipe={() => {}} onRefresh={() => {}} wheel={wheel()} />);
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
    press(slots()[1]);
    act(() => { vi.advanceTimersByTime(360); });
    expect(haptic.impact).toHaveBeenCalledWith('medium');
    expect(document.querySelector('.quick-actions-radial')).not.toBeNull();
    // The second row is read: its wheel offers Mark unread's side of the toggle.
    expect(document.querySelector('.quick-actions-radial-center')).not.toBeNull();
  });

  it('opens nothing for a swipe or a short press', () => {
    render(<MessageList cache={cache} onOpen={() => {}} onSwipe={() => {}} onRefresh={() => {}} wheel={wheel()} />);
    press(slots()[0]);
    fireEvent.pointerMove(slots()[0], { pointerId: 1, clientX: 150, clientY: 401, isPrimary: true });
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
    press(slots()[0]);
    fireEvent.pointerUp(slots()[0], { pointerId: 1, clientX: 120, clientY: 400, isPrimary: true });
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
    expect(haptic.impact).not.toHaveBeenCalled();
  });

  it('cannot be held without a wheel', () => {
    render(<MessageList cache={cache} onOpen={() => {}} onSwipe={() => {}} onRefresh={() => {}} />);
    press(slots()[0]);
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.quick-actions-radial')).toBeNull();
  });
});
