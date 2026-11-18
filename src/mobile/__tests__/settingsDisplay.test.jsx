// @vitest-environment jsdom
// The new preference rows over a fake engine (Mail preferences: desktop's views over the phone's
// preferences, settings/MailPreferences.jsx), and the readers that act on them in the viewer: each
// row writes its one preference; the toolbar shows its labels, a signature folds, attachments
// download as a message opens, and notification sound and badge rows (badge on iOS only). An
// account's colour is on Settings > Accounts > Advanced (Accounts.test.jsx).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], prefs: {}, settings: null, local: null, body: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.accountSettings.get':
        return { ...engine.settings };
      case 'mobile.accountSettings.set':
        engine.settings = { ...engine.settings, ...params.values };
        return { ...engine.settings };
      case 'mobile.accounts.list':
        return { accounts: [] };
      case 'mobile.message.body':
        return engine.body;
      case 'mobile.attachment.local':
        return { path: engine.local };
      case 'mobile.attachment.fetch':
        return { jobId: 9 };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { Behavior, Notifications } = await import('../settings/MailPreferences.jsx');
const { default: Appearance } = await import('../settings/Appearance.jsx');
const { default: Viewer } = await import('../Viewer.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
// Desktop's views: each row by its desktop label (or the phone's own words for it).
const pick = (label, value) => act(async () => {
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value: String(value) } });
});
const flip = (label) => act(async () => { fireEvent.click(screen.getByRole('switch', { name: label })); });

beforeEach(() => {
  engine.calls = [];
  engine.prefs = { ...PREF_DEFAULTS };
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS } });
});
afterEach(cleanup);

describe('the preference rows', () => {
  it('appearance: text size, font, density, preview lines, signatures, toolbar', async () => {
    // Desktop's Appearance views: each row found by its desktop label.
    render(<Appearance />);
    const tab = (key) => fireEvent.click(screen.getByRole('tab', { name: t(key) }));
    const percent = new Intl.NumberFormat('en', { style: 'percent' }).format(1.25);
    tab('settings.appearance.section.text');
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: percent })); });
    await act(async () => { fireEvent.click(screen.getByTestId('font-ibm-plex-sans')); });
    // The font row offers desktop's bundled fonts, and no download.
    expect(screen.getByTestId('font-system')).toBeTruthy();
    expect(document.querySelector('[data-testid^="font-google"]')).toBe(null);
    expect(screen.queryByRole('button', { name: new RegExp(t('settings.text.moreFonts')) })).toBe(null);
    tab('settings.appearance.section.layout');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('workspace.sidebarDensityCompact') })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('listPreview.off') })); });
    tab('settings.appearance.section.reading');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: t('settings.appearance.signatureDisplay') }), { target: { value: 'collapsed' } }); });
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: t('settings.appearance.actionButtonStyle') }), { target: { value: 'icon-label' } }); });
    expect(callsOf('mobile.prefs.set')).toEqual([
      { textScale: 1.25 }, { appFont: 'ibm-plex-sans' }, { listDensity: 'compact' }, { listPreviewLines: 0 },
      { signatureDisplay: 'collapsed' }, { actionButtonDisplay: 'icon-label' },
    ]);
    expect(useMobileStore.getState().prefs).toMatchObject({ textScale: 1.25, listPreviewLines: 0 });
  });

  it('mail: refresh on launch, its interval, attachments; swipes and same account with their sections', async () => {
    render(<Behavior />);
    await flip(t('settings.behavior.refreshAppLaunch'));
    await pick(t('settings.behavior.autoRefreshInterval'), 15);
    await flip(t('settings.behavior.autoDownloadAttachments'));
    await flip(t('settings.behavior.afterDeleteSameAccount'));
    await flip(t('mobile.prefs.swipeRows'));
    expect(callsOf('mobile.prefs.set')).toEqual([
      { refreshOnLaunch: false }, { refreshInterval: 15 }, { autoDownloadAttachments: true }, { afterDeleteSameAccount: true },
      { trackpadSwipeEnabled: false },
    ]);
    // Swipes off: which way does what is not asked.
    expect(screen.queryByRole('combobox', { name: t('settings.behavior.swipe.left') })).toBe(null);
    // Only what the phone can do: its swipes, and no unread-only pick after a delete.
    cleanup();
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS } });
    render(<Behavior />);
    expect([...screen.getByRole('combobox', { name: t('settings.behavior.swipe.left') }).options].map((o) => o.value))
      .toEqual(['toggleRead', 'delete', 'flag', 'move', 'none']);
    expect([...screen.getByRole('combobox', { name: t('settings.behavior.whenAnEmailIsDeleted') }).options].map((o) => o.value))
      .toEqual(['none', 'next', 'previous']);
  });

  it('notifications: sound, and the badge with what it counts; the sound only while notifications are on', async () => {
    engine.settings = { notifications: 'off', notificationPreview: true };
    const { unmount } = render(<Notifications />);
    await flush();
    expect(screen.queryByRole('switch', { name: t('settings.notifications.newEmailSound') })).toBe(null);
    unmount();
    engine.settings = { notifications: 'on', notificationPreview: true };
    render(<Notifications />);
    await flush();
    await flip(t('settings.notifications.newEmailSound'));
    expect(screen.queryByRole('combobox', { name: t('settings.notifications.badgeShows') })).toBe(null);
    await flip(t('settings.notifications.showBadgeCount'));
    await pick(t('settings.notifications.badgeShows'), 'total');
    expect(callsOf('mobile.prefs.set').filter((p) => !('importantSenders' in p)))
      .toEqual([{ notificationSound: false }, { badgeEnabled: true }, { badgeMode: 'total' }]);
  });

  it('notifications on Android: no badge rows (the launcher badges from the notifications)', async () => {
    engine.settings = { notifications: 'on', notificationPreview: true };
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) AppleWebKit');
    render(<Notifications />);
    await flush();
    expect(screen.getByRole('switch', { name: t('settings.notifications.newEmailSound') })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: t('settings.notifications.showBadgeCount') })).toBe(null);
    ua.mockRestore();
  });
});

describe('the viewer', () => {
  const row = { uid: 7, subject: 'Hi', fromName: 'Bob', fromAddress: 'bob@example.test', dateMs: 1, seen: true, flagged: false };
  const sigMail = '<p>Hello</p><div class="gmail_signature">Bob Ltd</div>';
  const show = async (prefs) => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, ...prefs } });
    render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  };
  beforeEach(() => {
    engine.local = null;
    engine.body = { html: sigMail, text: null, attachments: [{ section: '2', filename: 'a.pdf', mime: 'application/pdf', size: 10 }], remoteImages: 0, trackers: 0 };
  });

  it('the toolbar: icons only by default, labels under icons, labels alone', async () => {
    await show({});
    const label = () => document.querySelector('[data-mv-tool="delete"] .mv-tool__label');
    expect(label()).toBe(null);
    cleanup();
    await show({ actionButtonDisplay: 'icon-label' });
    expect(label().textContent).toBe(t('common.delete'));
    expect(document.querySelector('[data-mv-tool="delete"] svg')).toBeTruthy();
    cleanup();
    await show({ actionButtonDisplay: 'text-only' });
    expect(label().textContent).toBe(t('common.delete'));
    expect(document.querySelector('[data-mv-tool="delete"] svg')).toBe(null);
    expect(screen.getByRole('button', { name: t('common.delete') })).toBeTruthy();
  });

  it('a signature: shown by default, folded under Show signature, or gone', async () => {
    const doc = () => document.querySelector('iframe').getAttribute('srcdoc');
    await show({});
    expect(doc()).not.toContain('<details');
    cleanup();
    await show({ signatureDisplay: 'smart' });
    expect(doc()).toContain('<details data-mv-signature=""');
    expect(doc()).toContain(t('util.iframeQuoteFolding.showSignature'));
    cleanup();
    await show({ signatureDisplay: 'always-hide' });
    expect(doc()).not.toContain('Bob Ltd');
  });

  it('attachments download as the message opens only with autoDownloadAttachments', async () => {
    await show({});
    await flush();
    expect(callsOf('mobile.attachment.fetch')).toHaveLength(0);
    cleanup();
    await show({ autoDownloadAttachments: true });
    await waitFor(() => expect(callsOf('mobile.attachment.fetch')).toEqual([{ accountId: 'a1', folder: 'INBOX', uid: 7, section: '2' }]));
    // A file already on the phone is not fetched again.
    cleanup();
    engine.calls = [];
    engine.local = '/cache/a.pdf';
    await show({ autoDownloadAttachments: true });
    await flush();
    expect(callsOf('mobile.attachment.fetch')).toHaveLength(0);
  });
});
