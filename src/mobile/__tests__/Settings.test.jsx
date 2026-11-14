// @vitest-environment jsdom
// The settings screen: accounts (sign in again, remove after a confirm), notifications (asks the
// system's permission first; stays off when it is denied), and About.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], settings: null, granted: true, failRemove: false, permissionAsked: 0, osAllows: true, statusAsked: 0, notify: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.settings.set':
        engine.settings = { ...engine.settings, ...params };
        return { ...engine.settings };
      case 'mobile.accountSettings.get':
        return { accountId: params.accountId, notify: engine.notify[params.accountId] ?? true };
      case 'mobile.accountSettings.set':
        engine.notify[params.accountId] = params.values.notify;
        return { accountId: params.accountId, notify: engine.notify[params.accountId] ?? true };
      case 'mobile.accounts.remove':
        if (engine.failRemove) throw Object.assign(new Error('no'), { code: 'INTERNAL' });
        return { removed: true };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  requestNotificationPermission: vi.fn(async () => {
    engine.permissionAsked++;
    return { granted: engine.granted };
  }),
  // The OS's current answer, never a prompt.
  notificationPermission: vi.fn(async () => {
    engine.statusAsked++;
    return { granted: engine.osAllows };
  }),
}));

const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');

const A1 = { id: 'a1', email: 'ada@example.test', displayName: 'Ada', needsAuth: false };
const A2 = { id: 'a2', email: 'grace@example.test', displayName: 'Grace', needsAuth: true };

beforeEach(() => {
  engine.calls = [];
  engine.settings = { notifications: 'off', notificationPreview: true };
  engine.granted = true;
  engine.failRemove = false;
  engine.permissionAsked = 0;
  engine.osAllows = true;
  engine.statusAsked = 0;
  engine.notify = {};
  useMobileStore.setState({ accounts: [A1, A2], activeAccountId: 'a1', reauthState: null });
});
afterEach(cleanup);

/** Opens `account`'s own page in Settings > Accounts and taps its Remove. */
async function openRemove(account) {
  const row = screen.getByText(account.email).closest('li');
  await act(async () => { fireEvent.click(row.querySelector('[data-mv-acct-edit]')); });
  const remove = await waitFor(() => screen.getByRole('button', { name: t('settings.accounts.removeAccount2') }));
  fireEvent.click(remove);
}

const toggle = () => screen.getByRole('switch', { name: t('mobile.settings.notifyToggle') });
const sets = () => engine.calls.filter(([m]) => m === 'mobile.settings.set').map(([, p]) => p);

describe('Settings', () => {
  it('turning notifications on asks permission and stays off when denied', async () => {
    engine.granted = false;
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(t('mobile.settings.notifyDenied'))).toBeTruthy());
    expect(engine.permissionAsked).toBe(1);
    expect(sets()).toEqual([]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    // Allowed in the system settings: the next tap turns it on, and the notice goes.
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(sets()).toEqual([{ notifications: 'on' }]);
    expect(screen.queryByText(t('mobile.settings.notifyDenied'))).toBeNull();

    // Off needs no permission.
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(engine.permissionAsked).toBe(2);
    expect(sets()).toEqual([{ notifications: 'on' }, { notifications: 'off' }]);
  });

  it('shows the stored values and saves the preview choice', async () => {
    engine.settings = { notifications: 'on', notificationPreview: true };
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    const preview = screen.getByRole('switch', { name: t('mobile.settings.preview') });
    expect(preview.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(preview);
    await waitFor(() => expect(preview.getAttribute('aria-checked')).toBe('false'));
    expect(sets()).toEqual([{ notificationPreview: false }]);
    expect(engine.permissionAsked).toBe(0);
  });

  it('Download in the background shows the stored value and saves the choice, no permission asked', async () => {
    engine.settings = { notifications: 'off', notificationPreview: true, backgroundDownload: true };
    render(<Settings page="offline" onClose={() => {}} />);
    const download = () => screen.getByRole('switch', { name: t('mobile.settings.downloadToggle') });
    await waitFor(() => expect(download().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(download());
    await waitFor(() => expect(download().getAttribute('aria-checked')).toBe('false'));
    expect(sets()).toEqual([{ backgroundDownload: false }]);
    expect(engine.permissionAsked).toBe(0);
  });

  it('has no remove button next to an account: removing is inside the account', async () => {
    render(<Settings onClose={() => {}} />);
    expect(document.querySelector('.mv-acct__remove')).toBeNull();
    expect(screen.queryByRole('button', { name: t('mobile.switcher.remove', { email: A1.email }) })).toBeNull();
  });

  it('remove account confirms, then calls mobile.accounts.remove', async () => {
    render(<Settings page="accounts" onClose={() => {}} />);
    await openRemove(A1);
    expect(engine.calls.some(([m]) => m === 'mobile.accounts.remove')).toBe(false);
    expect(screen.getByText(t('mobile.switcher.removeConfirm', { email: A1.email }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.remove') }));
    await waitFor(() => expect(engine.calls.filter(([m]) => m === 'mobile.accounts.remove')).toEqual([['mobile.accounts.remove', { accountId: 'a1' }]]));
    await waitFor(() => expect(screen.queryByText(A1.email)).toBeNull());
    expect(screen.getByText(A2.email)).toBeTruthy();
  });

  it('keeps the account and its question when the removal fails', async () => {
    engine.failRemove = true;
    render(<Settings page="accounts" onClose={() => {}} />);
    await openRemove(A1);
    fireEvent.click(screen.getByRole('button', { name: t('common.remove') }));
    await waitFor(() => expect(engine.calls.some(([m]) => m === 'mobile.accounts.remove')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: t('common.remove') }).disabled).toBe(false));
    expect(screen.getByText(t('mobile.switcher.removeConfirm', { email: A1.email }))).toBeTruthy();
    // The question's own Cancel (the editor has one too).
    fireEvent.click(document.querySelector('.mv-acct-edit__danger').querySelector('button'));
    expect(screen.getByRole('button', { name: t('settings.accounts.removeAccount2') })).toBeTruthy();
    // The editor stays open: its title (and the default From's choices) name the account.
    expect(screen.getAllByText(A1.email).length).toBeGreaterThan(0);
  });

  it('offers Sign in again only on an account that needs it, through the store reauth', async () => {
    const reauth = vi.fn(async () => ({ ok: true }));
    useMobileStore.setState({ reauth });
    render(<Settings page="accounts" onClose={() => {}} />);
    const buttons = screen.getAllByRole('button', { name: t('mobile.reauth.action') });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(reauth).toHaveBeenCalledWith('a2');
  });

  it('links the source as a plain https anchor for the shell navigation guard, with the version', async () => {
    render(<Settings page="help" onClose={() => {}} version="9.8.7" />);
    const link = screen.getByRole('link', { name: t('mobile.settings.source') });
    expect(link.getAttribute('href')).toBe('https://github.com/GraphicMeat/mail-vault-app');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(t('mobile.settings.version', { version: '9.8.7' }))).toBeTruthy();
    expect(document.body.textContent.toLowerCase()).not.toContain('open source');
  });

  it('Back closes it', async () => {
    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Show preview cannot be changed while notifications are off', async () => {
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    const preview = screen.getByRole('switch', { name: t('mobile.settings.preview') });
    expect(preview.disabled).toBe(true);
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(screen.getByRole('switch', { name: t('mobile.settings.preview') }).disabled).toBe(false));
  });

  it('notifications turned off in the system settings show as off, with the pointer there', async () => {
    engine.settings = { notifications: 'on', notificationPreview: true };
    engine.osAllows = false;
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t('mobile.settings.notifyDenied'))).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(sets()).toEqual([{ notifications: 'off' }]);
    expect(engine.permissionAsked).toBe(0);
    // Turned on again here, then off in the system settings while the app was away: checked
    // again when it comes back to the front.
    engine.osAllows = true;
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    engine.osAllows = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(sets()).toEqual([{ notifications: 'off' }, { notifications: 'on' }, { notifications: 'off' }]);
  });

  it('each account has its own notifications switch, usable while notifications are on', async () => {
    engine.notify = { a2: false };
    const perAccount = (email) => screen.getByRole('switch', { name: t('mobile.settings.notifyAccount', { account: email }) });
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(perAccount('grace@example.test').getAttribute('aria-checked')).toBe('false'));
    expect(perAccount('ada@example.test').getAttribute('aria-checked')).toBe('true');
    // Notifications off: the per-account choice waits for them.
    expect(perAccount('ada@example.test').disabled).toBe(true);
    fireEvent.click(toggle());
    await waitFor(() => expect(perAccount('ada@example.test').disabled).toBe(false));
    fireEvent.click(perAccount('ada@example.test'));
    await waitFor(() => expect(perAccount('ada@example.test').getAttribute('aria-checked')).toBe('false'));
    expect(engine.calls.filter(([m]) => m === 'mobile.accountSettings.set').map(([, p]) => p))
      .toEqual([{ accountId: 'a1', values: { notify: false } }]);
  });

  it('Replay tour hands over to the tour', () => {
    const onReplayTour = vi.fn();
    render(<Settings page="help" onClose={() => {}} onReplayTour={onReplayTour} />);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.settings.replayTour') }));
    expect(onReplayTour).toHaveBeenCalledTimes(1);
  });
});

describe('Settings pages, as desktop lays them out', () => {
  const pageRows = () => [...document.querySelectorAll('[data-mv-settings-page]')].map((b) => b.getAttribute('data-mv-settings-page'));

  it('the first screen lists the pages in desktop order, under desktop\'s groups, with no settings of its own', () => {
    render(<Settings onClose={() => {}} />);
    expect(pageRows()).toEqual(['appearance', 'mail', 'notifications', 'accounts', 'offline', 'privacy', 'help']);
    const headings = [...document.querySelectorAll('.mv-settings__heading')].map((h) => h.textContent);
    expect(headings).toEqual([
      t('common.premium'),
      t('settings.navigation.general'),
      t('settings.navigation.accountsImport'),
      t('settings.navigation.vaultPrivacy'),
      t('settings.tab.help'),
    ]);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(document.querySelector('[data-mv-pref]')).toBeNull();
    expect(document.querySelector('[data-mv-premium-row]')).toBeTruthy();
  });

  it('a page opens under its own title; Back returns to the list, and Back there closes Settings', async () => {
    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);
    fireEvent.click(document.querySelector('[data-mv-settings-page="notifications"]'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('mobile.settings.notifications'));
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(pageRows()).toHaveLength(7);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('mobile.settings.title'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('each page holds its desktop page\'s settings', () => {
    const on = (page) => {
      const r = render(<Settings onClose={() => {}} page={page} />);
      const prefs = [...document.querySelectorAll('[data-mv-pref]')].map((e) => e.getAttribute('data-mv-pref'));
      r.unmount();
      return prefs;
    };
    expect(on('appearance')).toEqual(['theme', 'palette', 'language', 'emailViewerTheme', 'dateFormat', 'timeFormat']);
    expect(on('mail')).toEqual(['markAsReadMode', 'confirmBeforeDelete', 'afterDeleteSelect', 'swipeLeftAction', 'swipeRightAction', 'sendDelay', 'defaultSignatureEnabled', 'attachmentReminder']);
    // Remote content is a privacy choice on desktop (Privacy & security > Security).
    expect(on('privacy')).toEqual(['holdExternalContent', 'trackerBlockingEnabled']);
  });

  it('the accounts page lists the accounts; the help page has the version and the source', () => {
    const r = render(<Settings onClose={() => {}} page="accounts" />);
    expect(screen.getByText(A1.email)).toBeTruthy();
    r.unmount();
    render(<Settings onClose={() => {}} page="help" version="1.2.3" />);
    expect(screen.getByText(t('mobile.settings.version', { version: '1.2.3' }))).toBeTruthy();
  });

  it('Help has desktop\'s links: FAQ, report a bug, Discord, website and privacy policy, each a plain https anchor', () => {
    render(<Settings onClose={() => {}} page="help" />);
    const links = [...document.querySelectorAll('[data-mv-help-link]')];
    expect(links.map((a) => a.getAttribute('data-mv-help-link'))).toEqual(['faq', 'bug', 'discord', 'website', 'privacy']);
    for (const a of links) expect(a.getAttribute('href')).toMatch(/^https:\/\//);
    expect(links[0].getAttribute('href')).toContain('mailvaultapp.com/faq.html');
    expect(links[1].getAttribute('href')).toBe('https://github.com/GraphicMeat/mail-vault-app/issues');
  });
});
