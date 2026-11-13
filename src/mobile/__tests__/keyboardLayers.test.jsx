// @vitest-environment jsdom
// Every full-screen layer with a text field stays on the visible part of the screen while the iOS
// keyboard is up (keyboardViewport.js): the add-account overlay, the first-run tour (and the
// import and manual flows it hosts), Settings and Premium's web sign-in, as Compose and Search do.
// WKWebView keeps innerHeight, shrinks the visual viewport (`resize`) and pans it (`scroll`).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const engine = vi.hoisted(() => ({ calls: [], accounts: [] }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.ping': return { engine: 'test', schema: 6 };
      case 'mobile.accounts.list': return { accounts: engine.accounts.map((a) => ({ ...a })) };
      case 'mobile.settings.get': return { notifications: 'off', notificationPreview: true, onboardingComplete: true };
      case 'mobile.settings.set': return { notifications: 'off', notificationPreview: true, onboardingComplete: true, ...params };
      case 'mobile.folders.list':
        return { folders: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 0, total: 1, depth: 0, noselect: false }] };
      case 'mobile.sync.refresh': return { queued: true };
      case 'mobile.actions.pending': return { pending: [] };
      case 'mobile.messages.page':
        return { rows: [{ uid: 1, dateMs: 1000, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', snippet: '', seen: true }], nextCursor: null, total: 1, listGen: 1 };
      case 'mobile.premium.status': return { premium: false, source: null, expiresMs: null };
      default: throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  takeNotificationTap: vi.fn(async () => null),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
  storeProducts: vi.fn(async () => []),
  storePurchase: vi.fn(),
  storeRestore: vi.fn(async () => []),
}));

vi.mock('../scanner.js', () => ({
  cameraAccess: vi.fn(async () => 'granted'),
  scanQr: vi.fn(),
  cancelScan: vi.fn(async () => {}),
  openCameraSettings: vi.fn(async () => {}),
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { t } = await import('../i18n.js');
const { scanQr } = await import('../scanner.js');
const { default: Settings } = await import('../Settings.jsx');
const { default: Premium } = await import('../Premium.jsx');
const { default: Onboarding } = await import('../onboarding/Onboarding.jsx');
const { useMobileStore } = await import('../store.js');

const saved = {};
let vv;
beforeEach(() => {
  engine.calls = [];
  engine.accounts = [];
  saved.innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  vv = new EventTarget();
  vv.height = 844;
  vv.offsetTop = 0;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  useMobileStore.setState({ accounts: [], premium: { premium: false, source: null, expiresMs: null }, premiumLost: null, premiumLapsed: false, reauthState: null });
});
afterEach(() => {
  cleanup();
  delete window.visualViewport;
  Object.defineProperty(window, 'innerHeight', saved.innerHeight);
  document.documentElement.classList.remove('mv-import-scanning');
});

// The order iOS reports it in: the shrink first (offsetTop still 0), the pan after.
const keyboardUp = (offsetTop) => {
  act(() => { vv.height = 508; vv.dispatchEvent(new Event('resize')); });
  act(() => { vv.offsetTop = offsetTop; vv.dispatchEvent(new Event('scroll')); });
};
const keyboardDown = () => {
  act(() => { vv.height = 844; vv.offsetTop = 0; vv.dispatchEvent(new Event('resize')); });
};

/** The layer sits on the visible box while the keyboard is up, and on the whole screen after. */
function expectFollowsKeyboard(layer) {
  expect(layer).toBeTruthy();
  keyboardUp(240);
  expect(layer.style.getPropertyValue('--mv-vv-top')).toBe('240px');
  expect(layer.style.getPropertyValue('--mv-vv-height')).toBe('508px');
  expect(layer.hasAttribute('data-mv-keyboard')).toBe(true);
  expect(layer.classList.contains('mv-kb-layer')).toBe(true);
  keyboardDown();
  expect(layer.style.getPropertyValue('--mv-vv-top')).toBe('');
  expect(layer.style.getPropertyValue('--mv-vv-height')).toBe('');
  expect(layer.hasAttribute('data-mv-keyboard')).toBe(false);
}

/** A scroller whose scrollTop jsdom keeps, and fixed rects for it and `field`. */
function fakeLayout(scroller, field) {
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; } });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 375, height: 300, width: 375 });
  field.getBoundingClientRect = () => ({ top: 400, bottom: 440, left: 0, right: 375, height: 40, width: 375 });
  return () => top;
}

describe('the shared keyboard layer rule', () => {
  // Read from disk: vitest stubs CSS imports (even `?raw`) to an empty string.
  const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
  const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';

  it('places every keyboard-aware layer on the visual viewport from one rule', () => {
    expect(css.length).toBeGreaterThan(1000);
    const shared = rule('.mv-kb-layer');
    expect(shared).toContain('position: fixed');
    expect(shared).toContain('var(--mv-vv-top');
    expect(shared).toContain('var(--mv-vv-height');
  });

  it('leaves no layer its own inset or bottom, which would fight the shared top and height', () => {
    for (const sel of ['.mv-compose', '.mv-search', '.mv-settings', '.mv-tour', '.mv-add-overlay', '.mv-app']) {
      const own = rule(sel);
      expect(own, sel).not.toBe('');
      expect(own, sel).not.toMatch(/(^|[\s;])(inset|bottom|top|height|position)\s*:/);
    }
  });
});

describe('Settings over the iOS keyboard', () => {
  it('follows the visible box', async () => {
    render(<Settings onClose={() => {}} />);
    await act(async () => {});
    expectFollowsKeyboard(screen.getByRole('dialog', { name: t('mobile.settings.title') }));
  });
});

describe('Premium web sign-in over the iOS keyboard', () => {
  it('follows the visible box, and keeps the focused email field in view', async () => {
    render(<Premium signIn onClose={() => {}} />);
    await act(async () => {});
    const layer = screen.getByRole('dialog', { name: t('mobile.premium.title') });
    const email = layer.querySelector('input[type="email"]');
    expect(email).toBeTruthy();
    const scrolled = fakeLayout(layer.querySelector('.mv-settings__body'), email);
    act(() => { email.focus(); });
    keyboardUp(240);
    expect(scrolled()).toBeGreaterThan(0);
    keyboardDown();
    expectFollowsKeyboard(layer);
  });
});

describe('the first-run tour over the iOS keyboard', () => {
  const renderTour = () => render(
    <Onboarding steps={['account', 'done']} onAdd={vi.fn(async () => ({ ok: true }))} onOAuth={vi.fn()} onOAuthCancel={vi.fn()} onFinish={vi.fn()} />,
  );

  it('the tour layer follows the visible box', () => {
    const { container } = renderTour();
    expectFollowsKeyboard(container.querySelector('.mv-tour'));
  });

  it('the manual add flow it hosts follows it too', () => {
    const { container } = renderTour();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.onboarding.addManually') }));
    expectFollowsKeyboard(container.querySelector('.mv-tour--flow'));
  });

  it('the import password step keeps its field above the keyboard', async () => {
    const frames = ['MVQR1:aaaaaaaa:1/1:QUJD1'];
    scanQr.mockImplementation(async () => frames.shift() ?? new Promise(() => {}));
    const { container } = renderTour();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.import.entry') }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('mobile.import.scan') })); });
    const password = await screen.findByLabelText(t('mobile.import.password'));
    const layer = container.querySelector('.mv-tour--flow');
    const scrolled = fakeLayout(layer.querySelector('.mv-add'), password);
    act(() => { password.focus(); });
    keyboardUp(240);
    expect(layer.style.getPropertyValue('--mv-vv-height')).toBe('508px');
    expect(scrolled()).toBeGreaterThan(0);
  });
});

describe('the add-account screens in the app over the iOS keyboard', () => {
  async function freshApp() {
    globalThis.localStorage?.clear();
    window.history.replaceState({}, '', '/mobile.html');
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { default: App } = await import('../App.jsx');
    return App;
  }
  afterEach(() => vi.restoreAllMocks());

  it('the Add account overlay follows the visible box', async () => {
    engine.accounts = [{ id: 'a1', email: 'a1@example.test', displayName: 'A' }];
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: t('mobile.switcher.open', { email: 'a1@example.test' }) })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('mobile.switcher.open', { email: 'a1@example.test' }) }));
    fireEvent.click(screen.getByRole('button', { name: t('sidebar.addAccount') }));
    expectFollowsKeyboard(document.querySelector('.mv-add-overlay'));
  });

  it('the first add-account screen (no account yet) follows it too', async () => {
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByText(t('mobile.add.title'))).toBeTruthy());
    expectFollowsKeyboard(document.querySelector('.mv-add').closest('.mv-app'));
  });
});
