// @vitest-environment jsdom
// The screenshot and network-probe query hooks (`?ui=viewer`, `&loadImagesAfter`) act only on a
// perf-gate build, which the engine's ping says; on a shipping build the same URL opens nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor, screen, act } from '@testing-library/react';

const engine = vi.hoisted(() => ({ perfGate: false }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2, perfGate: engine.perfGate };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return {
          rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: false }],
          nextCursor: null, total: 1, listGen: 1,
        };
      case 'mobile.message.body':
        return { html: '<p>x</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

async function mount(perfGate) {
  engine.perfGate = perfGate;
  window.history.replaceState({}, '', '/mobile.html?ui=viewer&row=0');
  vi.resetModules();
  const { default: App } = await import('../App.jsx');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  render(<App />);
  await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('test query hooks', () => {
  it('a shipping build ignores ?ui=viewer', async () => {
    await mount(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a perf-gate build opens the asked-for row', async () => {
    await mount(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });
});
