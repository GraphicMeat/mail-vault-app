// @vitest-environment jsdom
// `refreshOnLaunch`: opening the app (and bringing it back to the front) syncs, unless it is off;
// then only a pull does. The page also applies the text size and font before the first list.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, waitFor, screen } from '@testing-library/react';

const engine = vi.hoisted(() => ({ calls: [], prefs: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2 };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A', hidden: false }] };
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { notifications: 'off', notificationPreview: true };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return {
          rows: [{ uid: 10, dateMs: 1000, subject: 'Mail 1', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: false }],
          nextCursor: null, total: 1, listGen: 1,
        };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  takeNotificationTap: vi.fn(async () => null),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

async function launch() {
  globalThis.localStorage?.clear();
  vi.resetModules();
  const { default: App } = await import('../App.jsx');
  const { useMobileStore } = await import('../store.js');
  render(<App />);
  await waitFor(() => expect(screen.getByText('Mail 1')).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return useMobileStore;
}

const refreshes = () => engine.calls.filter(([m]) => m === 'mobile.sync.refresh');
const foreground = () => act(async () => {
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 10));
});

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
  engine.prefs = {};
  document.documentElement.style.removeProperty('font-size');
});

describe('refreshOnLaunch', () => {
  it('on (the default): the app syncs as it opens and as it comes back', async () => {
    await launch();
    expect(refreshes().length).toBeGreaterThan(0);
    const before = refreshes().length;
    await foreground();
    expect(refreshes().length).toBeGreaterThan(before);
  });

  it('off: neither opening nor coming back syncs', async () => {
    engine.prefs = { refreshOnLaunch: false };
    await launch();
    expect(refreshes()).toHaveLength(0);
    await foreground();
    expect(refreshes()).toHaveLength(0);
  });

  it('the text size reaches the page before the first list', async () => {
    engine.prefs = { textScale: 1.5, appFont: 'inter' };
    await launch();
    expect(document.documentElement.style.fontSize).toBe('24px');
    expect(document.documentElement.style.getPropertyValue('--app-font')).toContain('Inter');
  });
});
