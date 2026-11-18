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
    const preview = screen.getByRole('switch', { name: t('settings.notifications.showEmailPreview') });
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
    // Desktop's page: the preview row shows only while notifications are on.
    render(<Settings page="notifications" onClose={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByRole('switch', { name: t('settings.notifications.showEmailPreview') })).toBeNull();
    engine.granted = true;
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(screen.getByRole('switch', { name: t('settings.notifications.showEmailPreview') }).disabled).toBe(false));
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
    const name = (email) => `${t('settings.notifications.notifications')}: ${useMobileStore.getState().accounts.find((a) => a.email === email).displayName || email}`;
    const perAccount = (email) => screen.getByRole('switch', { name: name(email) });
    render(<Settings page="notifications" onClose={() => {}} />);
    // Notifications off: the per-account choice waits for them (desktop's page shows it only then).
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByRole('switch', { name: name('ada@example.test') })).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => expect(perAccount('grace@example.test').getAttribute('aria-checked')).toBe('false'));
    expect(perAccount('ada@example.test').getAttribute('aria-checked')).toBe('true');
    expect(perAccount('ada@example.test').disabled).toBe(false);
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
  const heading = () => screen.getByRole('heading', { level: 1 }).textContent;

  it('the first screen is desktop\'s sidebar: its groups and pages less what a phone lacks, with no settings of its own', () => {
    render(<Settings onClose={() => {}} />);
    // Desktop's order (settingsManifest.js); Migration, Views, Auto-tags, Cleanup, Backup,
    // Portable and Time Capsule are not on the phone. Billing joins the footer while Premium is on.
    expect(pageRows()).toEqual(['appearance', 'mail-preferences', 'accounts', 'templates', 'ai-providers', 'unsubscribe', 'storage', 'privacy', 'diagnostics', 'help']);
    expect([...document.querySelectorAll('.settings-nav-item')]).toHaveLength(10);
    const headings = [...document.querySelectorAll('.settings-nav-heading')].map((h) => h.textContent);
    expect(headings).toEqual([
      t('common.premium'),
      t('settings.navigation.general'),
      t('settings.navigation.accountsImport'),
      t('settings.navigation.organize'),
      t('settings.navigation.vaultPrivacy'),
    ]);
    expect(screen.getByRole('searchbox', { name: t('settings.navigation.searchSetting') })).toBeTruthy();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(document.querySelector('[data-mv-pref]')).toBeNull();
    expect(document.querySelector('[data-mv-premium-row]')).toBeTruthy();
  });

  it('Billing is in the footer while Premium is on', () => {
    useMobileStore.setState({ premium: { ...useMobileStore.getState().premium, premium: true } });
    try {
      render(<Settings onClose={() => {}} />);
      expect(pageRows().slice(-3)).toEqual(['billing', 'diagnostics', 'help']);
    } finally {
      useMobileStore.setState({ premium: { ...useMobileStore.getState().premium, premium: false } });
    }
  });

  it('a page opens under its own title; Back returns to the list, and Back there closes Settings', async () => {
    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);
    fireEvent.click(document.querySelector('[data-mv-settings-page="mail-preferences"]'));
    expect(heading()).toBe(t('settings.navigation.mailPreferences'));
    fireEvent.click(screen.getByRole('tab', { name: t('settings.notifications.notifications') }));
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(pageRows()).toHaveLength(10);
    expect(heading()).toBe(t('mobile.settings.title'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('each page holds its desktop page\'s settings', () => {
    // Desktop's views: each control named by its desktop label (the phone's own words where
    // desktop's name a desktop part: settingsManifest.js MOBILE_LABELS).
    const controls = (page) => {
      const r = render(<Settings onClose={() => {}} page={page} />);
      const names = [...document.querySelectorAll('[role="switch"], select, input[type="range"]')]
        .map((e) => e.getAttribute('aria-label') || document.getElementById(e.getAttribute('aria-labelledby'))?.textContent);
      r.unmount();
      return names;
    };
    expect(controls('mail')).toEqual([
      t('settings.behavior.refreshAppLaunch'), t('settings.behavior.autoRefreshInterval'),
      t('settings.behavior.autoDownloadAttachments'), t('settings.behavior.attachmentReminder'),
      t('settings.behavior.sendDelay'), t('settings.accounts.automaticallyAddOutgoingEmails'),
      t('settings.behavior.markEmailsRead'),
      t('mobile.prefs.swipeRows'), t('settings.behavior.swipe.left'), t('settings.behavior.swipe.right'),
      t('settings.behavior.confirmBeforeDelete'), t('settings.behavior.whenAnEmailIsDeleted'), t('settings.behavior.afterDeleteSameAccount'),
    ]);
    // Remote content is a privacy choice on desktop (Privacy & security > Security); tracking
    // pixels have desktop's Tracking tab (a switch with Premium, the upsell without).
    expect(controls('privacy')).toEqual([
      t('settings.security.linkSafetyScanning'), t('settings.security.clickConfirmation'), t('settings.security.askBeforeExternalContent'),
    ]);
    render(<Settings onClose={() => {}} page="tracking" />);
    expect(screen.getByTestId('tracker-upsell')).toBeTruthy();
    cleanup();
    const on = (page) => {
      const r = render(<Settings onClose={() => {}} page={page} />);
      const prefs = [...document.querySelectorAll('[data-mv-pref]')].map((e) => e.getAttribute('data-mv-pref'));
      r.unmount();
      return prefs;
    };
    // AI is off by default: only its switch until it is on (AiSettings.test.jsx).
    expect(controls('ai')).toEqual([t('ai.settings.enable')]);
    // The search index sits on the Storage page, as on desktop.
    expect(on('search')).toEqual(expect.arrayContaining(['searchIndexBodies', 'searchIndexAttachments']));
  });

  it('a setting the phone words its own way is found and landed on under that name', async () => {
    render(<Settings onClose={() => {}} />);
    const box = screen.getByRole('searchbox', { name: t('settings.navigation.searchSetting') });
    fireEvent.change(box, { target: { value: t('mobile.prefs.swipeRows') } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('mobile.prefs.swipeRows')) }));
    expect(heading()).toBe(t('settings.navigation.mailPreferences'));
    const row = await waitFor(() => {
      const hit = document.querySelector('.settings-search-target');
      expect(hit).toBeTruthy();
      return hit;
    });
    expect(row.textContent).toContain(t('mobile.prefs.swipeRows'));
  });

  it('Appearance is desktop\'s Appearance: its sections as tabs, the Colors section first', () => {
    render(<Settings onClose={() => {}} page="appearance" />);
    expect(heading()).toBe(t('settings.appearance.appearance'));
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      t('settings.appearance.section.colors'), t('settings.appearance.section.text'), t('settings.appearance.section.layout'),
      t('settings.appearance.section.reading'), t('settings.appearance.section.dateTime'), t('quickActions.title'), t('settings.tab.language'),
    ]);
    expect(screen.getByRole('button', { name: t('settings.section.system') }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: t('settings.colors.indigo') }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('combobox', { name: t('settings.appearance.emailViewerTheme') })).toBeTruthy();
    expect(screen.getByRole('group', { name: t('settings.icons.title') })).toBeTruthy();
  });

  it('Encryption is a tab of Privacy & security, as on desktop, and Back returns to the list', () => {
    render(<Settings onClose={() => {}} page="privacy" />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      t('settings.tab.security'), t('settings.tab.tracking'), t('pgp.tab'), t('settings.tab.networkActivity'),
    ]);
    fireEvent.click(screen.getByRole('tab', { name: t('pgp.tab') }));
    expect(heading()).toBe(t('settings.tab.privacySecurity'));
    expect(screen.getByText(t('pgp.decryptOnly'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
  });

  it('Offline opened from Storage goes back to Storage, then to the list', async () => {
    render(<Settings onClose={() => {}} page="storage" />);
    await waitFor(() => expect(document.querySelector('[data-mv-storage-offline]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-mv-storage-offline]'));
    expect(heading()).toBe(t('mobile.settings.offline'));
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(heading()).toBe(t('settings.tab.storage'));
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
  });

  it('Move to another computer opens from Accounts and goes back there', () => {
    render(<Settings onClose={() => {}} page="accounts" />);
    fireEvent.click(document.querySelector('[data-mv-settings-page="transfer"]'));
    expect(heading()).toBe(t('settings.transfer.title'));
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(heading()).toBe(t('settings.tab.accounts'));
  });

  it('search finds a setting the phone has and opens its page; one it lacks is not offered', async () => {
    render(<Settings onClose={() => {}} />);
    const box = screen.getByRole('searchbox', { name: t('settings.navigation.searchSetting') });
    fireEvent.change(box, { target: { value: t('settings.text.size') } });
    const hit = screen.getByRole('button', { name: new RegExp(t('settings.text.size')) });
    fireEvent.change(box, { target: { value: t('settings.behavior.closeToTray') } });
    expect(screen.queryByRole('button', { name: new RegExp(t('settings.behavior.closeToTray')) })).toBeNull();
    fireEvent.change(box, { target: { value: t('settings.text.size') } });
    expect(hit).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('settings.text.size')) }));
    expect(heading()).toBe(t('settings.appearance.appearance'));
    expect(screen.getByRole('tab', { name: t('settings.appearance.section.text') }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('radiogroup', { name: t('settings.text.size') })).toBeTruthy();
  });

  it('every page search can open renders a page on the phone', async () => {
    const { mobileSearchPages } = await import('../../components/settings/settingsManifest');
    const { placeOf } = await import('../Settings.jsx');
    const ids = [...new Set(mobileSearchPages.map((p) => p.id))];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const r = render(<Settings onClose={() => {}} page={id} />);
      const body = document.querySelector('[data-mv-settings-on]');
      expect(body.getAttribute('data-mv-settings-on'), id).toBe(placeOf(id).sub || placeOf(id).nav);
      expect(body.children.length, `${id} opens an empty page`).toBeGreaterThan(0);
      r.unmount();
    }
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
