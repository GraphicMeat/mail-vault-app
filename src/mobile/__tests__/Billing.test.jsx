// @vitest-environment jsdom
// Settings > Billing: reached from the Premium section while Premium is on; the store's own
// manage page for a store subscription (none for a website one); the website account's devices,
// this phone marked, the others removable by their opaque key; and the translation report under
// Appearance's language row.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], devices: null, remove: null }));
const fail = (code) => Object.assign(new Error(code), { code });

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    const run = (v) => {
      const out = typeof v === 'function' ? v(params) : v;
      if (out instanceof Error) throw out;
      return out;
    };
    switch (method) {
      case 'mobile.settings.get': return { notifications: 'off', notificationPreview: true };
      case 'mobile.premium.devices': return run(engine.devices);
      case 'mobile.premium.removeDevice': return run(engine.remove);
      default: throw fail('UNSUPPORTED');
    }
  }),
  listen: vi.fn(() => () => {}),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
}));

const { default: Settings } = await import('../Settings.jsx');
const { default: SettingsPrefs } = await import('../SettingsPrefs.jsx');
const { useMobileStore } = await import('../store.js');
const { seenAgo } = await import('../Billing.jsx');

const NOW = Date.now();
const PHONE = { key: 'k-phone', name: 'MailVault for iPhone', platform: 'ios', appVersion: '2.23.0', lastSeenMs: NOW, current: true };
const MAC = { key: 'k-mac', name: 'Mac', platform: 'macos', appVersion: '2.22.1', lastSeenMs: NOW - 2 * 3_600_000, current: false };

function premiumOn(source) {
  useMobileStore.setState({ premium: { premium: true, source, expiresMs: NOW + 86_400_000 }, premiumLost: null });
}

beforeEach(() => {
  engine.calls = [];
  engine.devices = { available: false };
  engine.remove = null;
  useMobileStore.setState({ accounts: [], premium: { premium: false, source: null, expiresMs: null }, premiumLost: null });
});
afterEach(cleanup);

const billingRow = () => document.querySelector('[data-mv-settings-page="billing"]');

describe('Billing', () => {
  it('is offered under Premium only while Premium is on', async () => {
    render(<Settings onClose={() => {}} />);
    expect(billingRow()).toBeNull();
    act(() => premiumOn('apple'));
    expect(billingRow()).toBeTruthy();
    await act(async () => { fireEvent.click(billingRow()); });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('settings.tab.billing'));
  });

  it('sends an App Store subscription to Apple and a Play one to Play', async () => {
    premiumOn('apple');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.premium.devices')).toBe(true));
    expect(document.querySelector('[data-mv-manage]').getAttribute('href')).toBe('https://apps.apple.com/account/subscriptions');
    cleanup();
    premiumOn('google');
    render(<Settings page="billing" onClose={() => {}} />);
    expect(document.querySelector('[data-mv-manage]').getAttribute('href')).toBe('https://play.google.com/store/account/subscriptions');
  });

  it('offers no link for a website subscription', async () => {
    premiumOn('web');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.premium.devices')).toBe(true));
    expect(document.querySelector('[data-mv-manage]')).toBeNull();
    expect(document.querySelector('a[href*="stripe"], a[href*="mailvaultapp.com"]')).toBeNull();
  });

  it('lists the devices, marks this phone, and removes another by its key', async () => {
    premiumOn('web');
    engine.devices = { available: true, limit: 5, devices: [PHONE, MAC] };
    engine.remove = { available: true, limit: 5, devices: [PHONE] };
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('[data-mv-device]').length).toBe(2));
    expect(document.querySelector('[data-mv-device-count]').textContent).toContain('2 / 5');
    const current = document.querySelector('[data-mv-device="current"]');
    expect(current.textContent).toContain(t('settings.billing.thisDeviceParen'));
    expect(current.querySelector('[data-mv-device-remove]')).toBeNull();
    const other = document.querySelector('[data-mv-device="other"]');
    expect(other.textContent).toContain('Mac');
    expect(other.textContent).toContain('v2.22.1');
    expect(other.textContent).toContain(t('settings.billing.hAgo', { hrs: 2 }));

    await act(async () => { fireEvent.click(other.querySelector('[data-mv-device-remove]')); });
    expect(engine.calls.filter(([m]) => m === 'mobile.premium.removeDevice')).toEqual([['mobile.premium.removeDevice', { key: 'k-mac' }]]);
    await waitFor(() => expect(document.querySelectorAll('[data-mv-device]').length).toBe(1));
  });

  it('says why a removal failed and keeps the list', async () => {
    premiumOn('web');
    engine.devices = { available: true, limit: 5, devices: [PHONE, MAC] };
    engine.remove = fail('NETWORK');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll('[data-mv-device]').length).toBe(2));
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-device-remove]')); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.NETWORK'));
    expect(document.querySelectorAll('[data-mv-device]').length).toBe(2);
  });

  it('shows no device list without a website account, and a retry when the list fails', async () => {
    premiumOn('apple');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.premium.devices')).toBe(true));
    expect(document.querySelector('[data-mv-devices]')).toBeNull();
    cleanup();
    engine.devices = fail('RATE_LIMITED');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(t('mobile.error.RATE_LIMITED')));
    engine.devices = { available: true, limit: 5, devices: [PHONE] };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.retry') })); });
    await waitFor(() => expect(document.querySelectorAll('[data-mv-device]').length).toBe(1));
  });

  it('words the last-seen time as desktop does', () => {
    expect(seenAgo(t, NOW, NOW)).toBe(t('settings.billing.justNow'));
    expect(seenAgo(t, NOW - 5 * 60_000, NOW)).toBe(t('settings.billing.mAgo', { mins: 5 }));
    expect(seenAgo(t, NOW - 3 * 86_400_000, NOW)).toBe(t('settings.billing.dAgo', { Math: 3 }));
  });
});

describe('translation report', () => {
  it('opens under the language row and links a prefilled discussion once both texts are given', async () => {
    render(<SettingsPrefs section="appearance" />);
    fireEvent.click(document.querySelector('[data-mv-tr-open]'));
    const submit = () => document.querySelector('[data-mv-tr-submit]');
    expect(submit().tagName).toBe('BUTTON');
    expect(submit().disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-mv-tr="lang"]'), { target: { value: 'de' } });
    fireEvent.change(document.querySelector('[data-mv-tr="wrong"]'), { target: { value: 'Alle Posteingang' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-mv-tr="fix"]'), { target: { value: 'Alle Posteingänge' } });
    expect(submit().tagName).toBe('A');
    const url = new URL(submit().getAttribute('href'));
    expect(url.origin + url.pathname).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/new');
    expect(url.searchParams.get('category')).toBe('bug-reports');
    expect(url.searchParams.get('title')).toBe('[i18n de] Alle Posteingang');
    expect(url.searchParams.get('body')).toContain('Alle Posteingänge');
  });
});
