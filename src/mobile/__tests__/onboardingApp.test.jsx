// @vitest-environment jsdom
// When the app shows the tour: a fresh install (no accounts, tour never finished) gets it before
// anything else; an install that already has accounts is marked done without seeing it; Settings
// has "Replay tour", which runs it again without the account step.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor, screen, fireEvent, act } from '@testing-library/react';
import en from '../../i18n/locales/en.json';

const engine = vi.hoisted(() => ({ calls: [], accounts: [], settings: {}, settingsGate: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping':
        return { engine: 'test', schema: 5 };
      case 'mobile.accounts.list':
        return { accounts: engine.accounts };
      case 'mobile.settings.get':
        if (engine.settingsGate) await engine.settingsGate;
        return { notifications: 'off', notificationPreview: true, language: null, onboardingComplete: false, ...engine.settings };
      case 'mobile.settings.set':
        engine.settings = { ...engine.settings, ...params };
        return { notifications: 'off', notificationPreview: true, language: null, onboardingComplete: false, ...engine.settings };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh':
        return { queued: true };
      case 'mobile.messages.page':
        return { rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: true }], nextCursor: null, total: 1, listGen: 1 };
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

async function freshApp() {
  globalThis.localStorage?.clear();
  vi.resetModules();
  const { default: App } = await import('../App.jsx');
  return App;
}

const progress = (current, total) => en['onboarding.progress'].replace('{{current}}', current).replace('{{total}}', total);
const sets = () => engine.calls.filter(([m]) => m === 'mobile.settings.set').map(([, p]) => p);
const ACCOUNT = { id: 'a1', email: 'a1@example.test', displayName: 'A', oauth: false };

beforeEach(() => {
  engine.calls = [];
  engine.accounts = [];
  engine.settings = {};
  engine.settingsGate = null;
});

afterEach(() => cleanup());

describe('App onboarding gate', () => {
  it('a fresh install opens the tour on the language step, not the add-account screen', async () => {
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('onboarding-language')).toBeTruthy());
    expect(screen.getByText(progress(1, 5))).toBeTruthy();
    expect(screen.queryByText(en['mobile.add.title'])).toBeNull();
  });

  it('a fresh install with a slow engine shows loading until the tour, never the add-account screen', async () => {
    let release;
    engine.settingsGate = new Promise((resolve) => { release = resolve; });
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.accounts.list')).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    // The account list is in (no accounts) and the tour check still waits on the engine: an
    // add-account screen here would unmount when the tour replaces it, sign-in and all.
    expect(screen.queryByText(en['mobile.add.title'])).toBeNull();
    expect(screen.getByText(en['explorer.loading'])).toBeTruthy();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('onboarding-language')).toBeTruthy());
    expect(screen.queryByText(en['mobile.add.title'])).toBeNull();
  });

  it('finishing the tour without an account lands on the add-account screen', async () => {
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('onboarding-language')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('onboarding-skip')); });
    await waitFor(() => expect(screen.getByText(en['mobile.add.title'])).toBeTruthy());
    expect(sets()).toContainEqual({ onboardingComplete: true });
  });

  it('a completed tour with no accounts goes straight to adding one', async () => {
    engine.settings = { onboardingComplete: true };
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByText(en['mobile.add.title'])).toBeTruthy());
    expect(screen.queryByTestId('onboarding-language')).toBeNull();
  });

  it('an existing install with accounts skips the tour and is marked complete', async () => {
    engine.accounts = [ACCOUNT];
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    await waitFor(() => expect(sets()).toContainEqual({ onboardingComplete: true }));
    expect(screen.queryByTestId('onboarding-language')).toBeNull();
  });

  it('Replay tour in Settings runs the tour again without the account step', async () => {
    engine.accounts = [ACCOUNT];
    engine.settings = { onboardingComplete: true };
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: en['mobile.drawer.open'] }));
    fireEvent.click(await screen.findByText(en['mobile.settings.title']));
    fireEvent.click(await screen.findByRole('button', { name: en['mobile.settings.replayTour'] }));
    await waitFor(() => expect(screen.getByTestId('onboarding-language')).toBeTruthy());
    expect(screen.getByText(progress(1, 4))).toBeTruthy();
    // Settings closed under it.
    expect(screen.queryByRole('dialog', { name: en['mobile.settings.title'] })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('onboarding-skip')); });
    await waitFor(() => expect(screen.getByText('a1@example.test')).toBeTruthy());
    expect(screen.queryByTestId('onboarding-language')).toBeNull();
  });
});
