// @vitest-environment jsdom
// The toasts clear the compose button: while the button is on the screen the stack is lifted above
// it (`mv-toasts--lifted`), and only then.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2, perfGate: false };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.app.state':
        return { live: true };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return {
          rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: true }],
          nextCursor: null, total: 1, listGen: 1,
        };
      case 'mobile.message.body':
        return { html: '<p>x</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  takeNotificationTap: vi.fn(async () => null),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
  // The virtualizer sizes its window from offsetHeight; jsdom reports 0, so no row would mount.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(375);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stack = () => document.querySelector('.mv-toasts');
const fab = () => document.querySelector('[data-mv-compose]');

describe('toasts and the compose button', () => {
  it('Toasts is lifted only when asked', async () => {
    vi.resetModules();
    const { default: Toasts } = await import('../Toasts.jsx');
    const { useMobileStore } = await import('../store.js');
    useMobileStore.setState({ notice: { id: 1, key: 'common.retry' } });
    const r = render(<Toasts lifted />);
    expect(stack().classList.contains('mv-toasts--lifted')).toBe(true);
    r.rerender(<Toasts />);
    expect(stack().classList.contains('mv-toasts--lifted')).toBe(false);
    useMobileStore.setState({ notice: null });
  });

  it('the stack is lifted exactly while the compose button renders', async () => {
    vi.resetModules();
    const { default: App } = await import('../App.jsx');
    const { useMobileStore } = await import('../store.js');
    render(<App />);
    const row = () => document.querySelector('[data-mv-list] [data-index="0"][data-loaded="1"]');
    await waitFor(() => expect(row()).toBeTruthy());
    await act(async () => { useMobileStore.setState({ notice: { id: 1, key: 'common.retry' } }); });
    expect(fab()).toBeTruthy();
    expect(stack().classList.contains('mv-toasts--lifted')).toBe(true);
    // Opening a message takes the compose button away: the toasts go back down.
    await act(async () => { fireEvent.click(row()); });
    await waitFor(() => expect(document.querySelector('[data-mv-viewer-close]')).toBeTruthy());
    expect(fab()).toBeNull();
    expect(stack().classList.contains('mv-toasts--lifted')).toBe(false);
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-viewer-close]')); });
    await waitFor(() => expect(fab()).toBeTruthy());
    expect(stack().classList.contains('mv-toasts--lifted')).toBe(true);
  });

  it('lifted, the stack sits above the compose button (safe + 16 + 56)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    expect(css).toMatch(/\.mv-toasts--lifted \{[^}]*bottom: calc\(var\(--mv-safe-bottom\) \+ 84px\)/);
    expect(css).toMatch(/\.mv-fab \{[^}]*bottom: calc\(var\(--mv-safe-bottom\) \+ 16px\)[^}]*height: 56px/);
  });
});
