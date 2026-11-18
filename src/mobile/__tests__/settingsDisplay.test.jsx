// @vitest-environment jsdom
// The new preference rows over a fake engine, and the readers that act on them in the viewer: each
// row writes its one preference; the toolbar shows its labels, a signature folds, attachments
// download as a message opens, notification sound and badge rows (badge on iOS only), and an
// account's colour in the account editor.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], prefs: {}, settings: null, local: null, body: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
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
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { MailMore, NotifyMore } = await import('../SettingsDisplay.jsx');
const { default: Appearance } = await import('../settings/Appearance.jsx');
const { default: SettingsPrefs } = await import('../SettingsPrefs.jsx');
const { default: Viewer } = await import('../Viewer.jsx');
const { default: AccountEditor } = await import('../AccountEditor.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');

const callsOf = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const pick = (name, value) => act(async () => {
  fireEvent.change(document.querySelector(`select[data-mv-pref="${name}"]`), { target: { value: String(value) } });
});
const flip = (name) => act(async () => { fireEvent.click(document.querySelector(`button[data-mv-pref="${name}"]`)); });

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

  it('mail: refresh on launch, attachments; swipes and same account with their sections', async () => {
    render(<><SettingsPrefs section="mail" /><MailMore /></>);
    await flip('refreshOnLaunch');
    await flip('autoDownloadAttachments');
    await flip('afterDeleteSameAccount');
    await flip('trackpadSwipeEnabled');
    expect(callsOf('mobile.prefs.set')).toEqual([
      { refreshOnLaunch: false }, { autoDownloadAttachments: true }, { afterDeleteSameAccount: true }, { trackpadSwipeEnabled: false },
    ]);
    // Swipes off: which way does what is not asked.
    expect(document.querySelector('select[data-mv-pref="swipeLeftAction"]')).toBe(null);
  });

  it('notifications: sound, and the badge with what it counts; nothing while notifications are off', async () => {
    const { rerender } = render(<NotifyMore enabled={false} />);
    expect(document.querySelector('[data-mv-settings-notify-more]')).toBe(null);
    rerender(<NotifyMore enabled />);
    await flip('notificationSound');
    expect(document.querySelector('select[data-mv-pref="badgeMode"]')).toBe(null);
    await flip('badgeEnabled');
    await pick('badgeMode', 'total');
    expect(callsOf('mobile.prefs.set')).toEqual([{ notificationSound: false }, { badgeEnabled: true }, { badgeMode: 'total' }]);
  });

  it('notifications on Android: no badge rows (the launcher badges from the notifications)', () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) AppleWebKit');
    render(<NotifyMore enabled />);
    expect(document.querySelector('button[data-mv-pref="notificationSound"]')).toBeTruthy();
    expect(document.querySelector('button[data-mv-pref="badgeEnabled"]')).toBe(null);
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

describe('the account editor', () => {
  const account = { id: 'a1', email: 'ada@example.test', displayName: 'Ada', kind: 'imap', oauth: false };

  it('picks a colour from desktop\'s palette, or automatic', async () => {
    engine.settings = { accountId: 'a1', displayName: 'Ada', color: null, hidden: false, signature: null, aliases: [], sendAs: '' };
    render(<AccountEditor account={account} onDone={() => {}} />);
    await flush();
    const auto = document.querySelector('.mv-acct-edit__swatch--auto');
    expect(auto.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-color="#14b8a6"]')); });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-acct-save]')); });
    expect(callsOf('mobile.accountSettings.set').at(-1).values).toMatchObject({ color: '#14b8a6' });
    cleanup();
    engine.calls = [];
    render(<AccountEditor account={account} onDone={() => {}} />);
    await flush();
    expect(document.querySelector('[data-mv-color="#14b8a6"]').getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(document.querySelector('.mv-acct-edit__swatch--auto')); });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-acct-save]')); });
    expect(callsOf('mobile.accountSettings.set').at(-1).values).toMatchObject({ color: null });
  });

  it('an unchanged colour is not written', async () => {
    engine.settings = { accountId: 'a1', displayName: 'Ada', color: '#8b5cf6', hidden: false, signature: null, aliases: [], sendAs: '' };
    render(<AccountEditor account={account} onDone={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-acct-save]')); });
    expect(callsOf('mobile.accountSettings.set').at(-1).values).not.toHaveProperty('color');
  });
});
