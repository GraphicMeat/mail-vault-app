// @vitest-environment jsdom
// Settings > Billing (desktop's Billing views): reached from the Premium section while Premium is on;
// the store's own manage page for a store subscription (none for a website one); the website account's devices,
// this phone marked, the others removable by their opaque key; and the translation report under
// Appearance's language row.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
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
const { useMobileStore } = await import('../store.js');
const { seenAgo } = await import('../settings/Billing.jsx');

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
/** Where clicking `el` sends the app: the link it hands to the system browser. */
function opens(el) {
  const opened = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { opened.push(this.href); });
  fireEvent.click(el);
  click.mockRestore();
  return opened;
}
const devices = () => document.querySelector('[data-mv-devices]');
// One detail line per device: its platform and version.
const deviceRows = () => (devices() ? within(devices()).queryAllByText(/ · v\d/) : []);
const removeButton = (name) => screen.queryByRole('button', { name: `${t('settings.billing.removeDevice')}: ${name}` });

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
    expect(document.querySelector('[data-mv-manage]').textContent).toBe(t('settings.billing.manageSubscription'));
    expect(opens(document.querySelector('[data-mv-manage]'))).toEqual(['https://apps.apple.com/account/subscriptions']);
    cleanup();
    premiumOn('google');
    render(<Settings page="billing" onClose={() => {}} />);
    expect(opens(document.querySelector('[data-mv-manage]'))).toEqual(['https://play.google.com/store/account/subscriptions']);
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
    await waitFor(() => expect(deviceRows()).toHaveLength(2));
    expect(devices().textContent).toContain('2 / 5');
    expect(screen.getByText(PHONE.name).textContent).toContain(t('settings.billing.thisDeviceParen'));
    expect(removeButton(PHONE.name)).toBeNull();
    const other = deviceRows()[1];
    expect(other.parentElement.textContent).toContain('Mac');
    expect(other.textContent).toContain('v2.22.1');
    expect(other.textContent).toContain(t('settings.billing.hAgo', { hrs: 2 }));

    await act(async () => { fireEvent.click(removeButton('Mac')); });
    expect(engine.calls.filter(([m]) => m === 'mobile.premium.removeDevice')).toEqual([['mobile.premium.removeDevice', { key: 'k-mac' }]]);
    await waitFor(() => expect(deviceRows()).toHaveLength(1));
  });

  it('says why a removal failed and keeps the list', async () => {
    premiumOn('web');
    engine.devices = { available: true, limit: 5, devices: [PHONE, MAC] };
    engine.remove = fail('NETWORK');
    render(<Settings page="billing" onClose={() => {}} />);
    await waitFor(() => expect(deviceRows()).toHaveLength(2));
    await act(async () => { fireEvent.click(removeButton('Mac')); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.NETWORK'));
    expect(deviceRows()).toHaveLength(2);
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
    await waitFor(() => expect(deviceRows()).toHaveLength(1));
  });

  it('words the last-seen time as desktop does', () => {
    expect(seenAgo(t, NOW, NOW)).toBe(t('settings.billing.justNow'));
    expect(seenAgo(t, NOW - 5 * 60_000, NOW)).toBe(t('settings.billing.mAgo', { mins: 5 }));
    expect(seenAgo(t, NOW - 3 * 86_400_000, NOW)).toBe(t('settings.billing.dAgo', { Math: 3 }));
  });
});

describe('translation report', () => {
  it('sits under the language list and opens a prefilled discussion once both texts are given', async () => {
    // Desktop's report (TranslationIssueReportView), in Appearance > Language; the link goes out as
    // a plain https anchor, which the shell hands to the system browser.
    const opened = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
      opened.push({ href: this.href, target: this.target });
    });
    render(<Settings onClose={() => {}} page="appearance" />);
    fireEvent.click(screen.getByRole('tab', { name: t('settings.tab.language') }));
    const submit = () => screen.getByTestId('tr-submit');
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('tr-lang'), { target: { value: 'de' } });
    fireEvent.change(screen.getByTestId('tr-wrong'), { target: { value: 'Alle Posteingang' } });
    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('tr-fix'), { target: { value: 'Alle Posteingänge' } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    click.mockRestore();
    expect(opened).toHaveLength(1);
    expect(opened[0].target).toBe('_blank');
    const url = new URL(opened[0].href);
    expect(url.origin + url.pathname).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/new');
    expect(url.searchParams.get('category')).toBe('bug-reports');
    expect(url.searchParams.get('title')).toBe('[i18n de] Alle Posteingang');
    expect(url.searchParams.get('body')).toContain('Alle Posteingänge');
    // Sent: the texts clear.
    expect(screen.getByTestId('tr-wrong').value).toBe('');
  });
});
