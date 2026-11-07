// @vitest-environment jsdom
// The screenshot and network-probe query hooks (`?ui=viewer`, `&loadImagesAfter`) act only on a
// perf-gate build, which the engine's ping says; on a shipping build the same URL opens nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor, screen, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const engine = vi.hoisted(() => ({ perfGate: false, accounts: null }));
const A1 = { id: 'a1', email: 'a1@example.test', displayName: 'A' };

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 2, perfGate: engine.perfGate };
      case 'mobile.accounts.list':
        return { accounts: engine.accounts ?? [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }] };
      case 'mobile.app.state':
        return { live: true };
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
  engine.accounts = null;
  delete document.visibilityState;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.history.replaceState({}, '', '/');
});

describe('test query hooks', () => {
  it('a shipping build ignores ?ui=viewer', async () => {
    await mount(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a perf-gate build opens the asked-for row', async () => {
    vi.stubEnv('MV_PERF_GATE', '1');
    await mount(true);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('a bundle built without MV_PERF_GATE never runs the viewer script, whatever the ping says', async () => {
    vi.stubEnv('MV_PERF_GATE', '0');
    await mount(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the screenshot demo hooks (?ui=swipe, ?ui=toast) act only in a perf-gate bundle', async () => {
    for (const [gate, shown] of [['0', false], ['1', true]]) {
      vi.stubEnv('MV_PERF_GATE', gate);
      engine.perfGate = gate === '1';
      window.history.replaceState({}, '', '/mobile.html?ui=swipe&toast=1');
      vi.resetModules();
      const { default: App } = await import('../App.jsx');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      render(<App />);
      await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(Boolean(screen.queryByText('Message deleted')), `gate ${gate}`).toBe(shown);
      cleanup();
      vi.unstubAllEnvs();
    }
  });

  it('a shipping bundle has no viewer probe: the import sits behind the build constant', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/mobile/App.jsx'), 'utf8');
    expect(app).not.toMatch(/^import[^;]*viewerProbe/m);
    expect(app).toMatch(/import\.meta\.env\.MV_PERF_GATE !== '1'\) return;[\s\S]*import\('\.\/viewerProbe\.js'\)/);
    const config = readFileSync(resolve(process.cwd(), 'vite.mobile.config.js'), 'utf8');
    expect(config).toMatch(/'import\.meta\.env\.MV_PERF_GATE'/);
    const run = readFileSync(resolve(process.cwd(), 'scripts/mobile-run.sh'), 'utf8');
    expect(run).toMatch(/\*,perf-gate,\*\) export MV_PERF_GATE=1/);
  });
});

describe('live mail', () => {
  function setVisibility(state) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('sends mobile.app.state on visibility change and account switch', async () => {
    engine.accounts = [A1, { id: 'a2', email: 'a2@example.test', displayName: 'B' }];
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    const { daemonCall } = await import('../transport.js');
    const { useMobileStore } = await import('../store.js');
    const { default: App } = await import('../App.jsx');
    daemonCall.mockClear(); // the mock outlives the module reset: earlier tests' calls are on it
    render(<App />);
    const states = () => daemonCall.mock.calls.filter(([m]) => m === 'mobile.app.state').map(([, p]) => p);

    // At launch: listening on the account in front, with no visibility change yet.
    await waitFor(() => expect(states()).toEqual([{ foreground: true, accountId: 'a1' }]));

    setVisibility('hidden');
    await waitFor(() => expect(states().at(-1)).toEqual({ foreground: false, accountId: 'a1' }));
    // Visible again is a resume: the engine replaces a listener that may have died meanwhile.
    setVisibility('visible');
    await waitFor(() => expect(states().at(-1)).toEqual({ foreground: true, accountId: 'a1', resumed: true }));

    await act(async () => { await useMobileStore.getState().selectAccount('a2'); });
    await waitFor(() => expect(states().at(-1)).toEqual({ foreground: true, accountId: 'a2' }));
    expect(states()).toHaveLength(4);
  });
});
