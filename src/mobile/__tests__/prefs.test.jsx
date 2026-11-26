// @vitest-environment jsdom
// The phone's preferences (prefs.js) and the places that show or change them: list row swipes,
// Settings' preference rows and the account editor (W1a: what the desktop's settings set).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { t } from '../i18n.js';
import { revealSide } from './fixtures/swipe.js';
import {
  PREF_DEFAULTS, readPrefs, visibleAccounts, markReadPlan, afterDeleteRow, swipeKind, htmlToText, signatureFor, withSignature, applyLook,
} from '../prefs.js';

const engine = vi.hoisted(() => ({ calls: [], prefs: {}, account: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.prefs.get':
        return { ...engine.prefs };
      case 'mobile.prefs.set':
        if (params.theme === 'neon') throw Object.assign(new Error('no'), { code: 'INVALID' });
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      case 'mobile.settings.get':
        return { notifications: 'off', notificationPreview: true, language: null };
      case 'mobile.settings.set':
        return { notifications: 'off', notificationPreview: true, ...params };
      case 'mobile.accountSettings.get':
        return { ...engine.account };
      case 'mobile.accountSettings.set':
        engine.account = { ...engine.account, ...params.values };
        return { ...engine.account };
      case 'mobile.accounts.list':
        return { accounts: [{ id: 'a1', email: 'ada@example.test', displayName: engine.account?.displayName || 'Ada', hidden: !!engine.account?.hidden }] };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  notificationPermission: vi.fn(async () => ({ granted: true })),
  requestNotificationPermission: vi.fn(async () => ({ granted: true })),
}));

const { default: MessageRow } = await import('../MessageRow.jsx');
const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');

const ROW = { uid: 7, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', dateMs: Date.UTC(2024, 2, 3, 10, 0), snippet: '', seen: false, flagged: false };

beforeEach(() => {
  engine.calls = [];
  engine.prefs = {};
  engine.account = { accountId: 'a1', displayName: 'Ada', hidden: false, signature: null, notify: true };
  useMobileStore.setState({ prefs: PREF_DEFAULTS, accounts: [{ id: 'a1', email: 'ada@example.test', displayName: 'Ada' }], reauthState: null });
});
afterEach(cleanup);

describe('prefs.js', () => {
  it('reads the engine answer over the defaults, keeping a default for a wrong type', () => {
    expect(readPrefs(null)).toEqual(PREF_DEFAULTS);
    const p = readPrefs({ theme: 'dark', sendDelay: '10', confirmBeforeDelete: true, extra: 1 });
    expect(p).toMatchObject({ theme: 'dark', sendDelay: 0, confirmBeforeDelete: true });
    expect(p).not.toHaveProperty('extra');
  });

  it('leaves hidden accounts out', () => {
    expect(visibleAccounts([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c', hidden: false }]).map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('plans when opening marks read', () => {
    expect(markReadPlan(PREF_DEFAULTS)).toEqual({ now: true });
    expect(markReadPlan({ markAsReadMode: 'delay', markAsReadDelay: 3 })).toEqual({ afterMs: 3000 });
    expect(markReadPlan({ markAsReadMode: 'delay', markAsReadDelay: 0 })).toEqual({ now: true });
    expect(markReadPlan({ markAsReadMode: 'manual' })).toEqual({ never: true });
  });

  it('picks the row after a delete', () => {
    const rows = ['r0', 'r1', 'r2'];
    const at = (i) => rows[i];
    const same = (r) => r === 'r1';
    expect(afterDeleteRow('next', 1, at, same)).toBe('r2');
    expect(afterDeleteRow('previous', 1, at, same)).toBe('r0');
    expect(afterDeleteRow('none', 1, at, same)).toBe(undefined);
    // the last row: next falls back to the one above; the first: previous to the one below
    expect(afterDeleteRow('next', 2, at, (r) => r === 'r2')).toBe('r1');
    expect(afterDeleteRow('previous', 0, at, (r) => r === 'r0')).toBe('r1');
    expect(afterDeleteRow('next', -1, at, same)).toBe(undefined);
  });

  it('maps a swipe action to what the row does', () => {
    expect(swipeKind('toggleRead', { seen: false })).toBe('seen');
    expect(swipeKind('toggleRead', { seen: true })).toBe('unseen');
    expect(swipeKind('flag', { flagged: true })).toBe('unflag');
    expect(swipeKind('flag', { flagged: false })).toBe('flag');
    expect(swipeKind('delete', {})).toBe('delete');
    expect(swipeKind('move', {})).toBe('move');
    expect(swipeKind('none', {})).toBe(null);
    expect(swipeKind('archive', {})).toBe(null);
  });

  it('turns a signature into plain text; the account\'s own switch is the only one', () => {
    expect(htmlToText('<p>Ann&nbsp;<b>Example</b></p><div>CEO<br>Corp</div>')).toBe('Ann Example\nCEO\nCorp');
    const html = { signature: { html: '<p>Ann</p>', text: '', enabled: true } };
    expect(signatureFor(html)).toBe('Ann');
    expect(signatureFor({ signature: { html: '<p>x</p>', text: 'Plain', enabled: true } })).toBe('Plain');
    expect(signatureFor({ signature: { text: 'Plain', enabled: false } })).toBe('');
    // Desktop has no signatures-overall setting, so the phone keeps none: no preference turns it off.
    expect(PREF_DEFAULTS).not.toHaveProperty('defaultSignatureEnabled');
    expect(signatureFor({ signature: null })).toBe('');
    expect(withSignature('', 'Ann')).toBe('\n\n-- \nAnn');
    expect(withSignature('Hi', '-- Ann')).toBe('Hi\n\n-- Ann');
    expect(withSignature('Hi', '')).toBe('Hi');
  });

  it('puts theme and palette on the root', () => {
    const root = document.createElement('html');
    applyLook({ theme: 'light', palette: 'teal' }, root);
    expect([root.getAttribute('data-theme'), root.getAttribute('data-palette')]).toEqual(['light', 'teal']);
    // `system` is resolved to what the system shows (the shared tokens need an explicit theme):
    // dark where the system says nothing.
    applyLook({ theme: 'system', palette: 'nope' }, root);
    expect([root.getAttribute('data-theme'), root.getAttribute('data-palette')]).toEqual([window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark', 'indigo']);
  });
});

describe('row swipes follow the preferences', () => {
  const sides = (container) => [...container.querySelectorAll('[data-mv-swipe-action]')].map((b) => [b.dataset.mvSwipeAction, b.textContent]);

  it('defaults: right reveals read, left reveals delete', () => {
    const { container } = render(<MessageRow row={ROW} index={0} onOpen={() => {}} onSwipe={() => {}} />);
    expect(sides(container)).toEqual([]); // at rest neither side is in the DOM
    revealSide(container, 'leading');
    expect(sides(container)).toEqual([['leading', t('mobile.actions.markRead')]]);
    cleanup();
    const r2 = render(<MessageRow row={ROW} index={0} onOpen={() => {}} onSwipe={() => {}} />);
    revealSide(r2.container, 'trailing');
    expect(sides(r2.container)).toEqual([['trailing', t('common.delete')]]);
  });

  it('flag and move, and none leaves that side out', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, swipeLeftAction: 'flag', swipeRightAction: 'none' } });
    const onSwipe = vi.fn();
    const { container } = render(<MessageRow row={ROW} index={0} onOpen={() => {}} onSwipe={onSwipe} />);
    revealSide(container, 'leading'); // none: the row does not move that way
    expect(sides(container)).toEqual([]);
    revealSide(container, 'trailing');
    expect(sides(container)).toEqual([['trailing', t('mobile.actions.flag')]]);
    fireEvent.click(container.querySelector('[data-mv-swipe-action="trailing"]'));
    expect(onSwipe).toHaveBeenCalledWith('flag', ROW);
    cleanup();
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, swipeRightAction: 'move' } });
    const r2 = render(<MessageRow row={ROW} index={0} onOpen={() => {}} onSwipe={onSwipe} />);
    fireEvent.click(revealSide(r2.container, 'leading'));
    expect(onSwipe).toHaveBeenLastCalledWith('move', ROW);
  });

  it('dates follow dateFormat and timeFormat', () => {
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, dateFormat: 'yyyy-MM-dd' } });
    const { container } = render(<MessageRow row={{ ...ROW, dateMs: Date.UTC(2020, 0, 5, 12) }} index={0} onOpen={() => {}} />);
    expect(container.querySelector('.mv-row__date').textContent).toContain('2020-01-05');
  });
});

describe('the system theme', () => {
  it('system resolves to what the system shows, and follows it live', async () => {
    const { watchSystemTheme } = await import('../prefs.js');
    let light = true;
    const listeners = new Set();
    const had = window.matchMedia;
    window.matchMedia = (query) => ({
      get matches() { return query.includes('light') ? light : false; },
      media: query,
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    });
    const root = document.documentElement;
    try {
      applyLook({ ...PREF_DEFAULTS, theme: 'system' }, root);
      expect(root.getAttribute('data-theme')).toBe('light');
      const stop = watchSystemTheme(() => ({ ...PREF_DEFAULTS, theme: 'system' }));
      light = false;
      listeners.forEach((fn) => fn());
      expect(root.getAttribute('data-theme')).toBe('dark');
      // A picked theme wins over the system.
      applyLook({ ...PREF_DEFAULTS, theme: 'light' }, root);
      expect(root.getAttribute('data-theme')).toBe('light');
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      window.matchMedia = had;
    }
  });
});

describe('Settings preference rows', () => {
  // The first screen's entries are desktop's nav ids (settingsManifest.js).
  const NAV = { mail: 'mail-preferences' };
  const go = (page) => {
    const back = document.querySelector('[data-mv-settings-on]:not([data-mv-settings-on="root"])');
    if (back) fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    fireEvent.click(document.querySelector(`[data-mv-settings-page="${NAV[page] || page}"]`));
  };
  // Appearance is desktop's view: its rows are found by their labels, not phone hooks.
  const tab = (key) => fireEvent.click(screen.getByRole('tab', { name: t(key) }));
  const select = (key) => screen.queryByRole('combobox', { name: t(key) });
  const toggle = (key) => screen.queryByRole('switch', { name: t(key) });

  it('changing a row writes the preference and the page follows', async () => {
    render(<Settings onClose={() => {}} />);
    go('appearance');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('settings.colors.dark') })); });
    await waitFor(() => expect(useMobileStore.getState().prefs.theme).toBe('dark'));
    expect(engine.calls).toContainEqual(['mobile.prefs.set', { theme: 'dark' }]);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // Mail preferences and Privacy are desktop's views: their rows found by their desktop labels.
    go('mail');
    await act(async () => { fireEvent.change(select('settings.behavior.swipe.left'), { target: { value: 'flag' } }); });
    await waitFor(() => expect(useMobileStore.getState().prefs.swipeLeftAction).toBe('flag'));
    await act(async () => { fireEvent.change(select('settings.behavior.confirmBeforeDelete'), { target: { value: 'ask' } }); });
    await waitFor(() => expect(useMobileStore.getState().prefs.confirmBeforeDelete).toBe(true));
    go('privacy');
    await act(async () => { fireEvent.click(toggle('settings.security.askBeforeExternalContent')); });
    await waitFor(() => expect(useMobileStore.getState().prefs.holdExternalContent).toBe(false));
    go('mail');
    await act(async () => { fireEvent.change(select('settings.behavior.sendDelay'), { target: { value: '30' } }); });
    await waitFor(() => expect(useMobileStore.getState().prefs.sendDelay).toBe(30));
    // the delay row shows only for the delay mode
    const delay = () => screen.queryByRole('slider', { name: t('settings.behavior.delayBeforeMarkingRead') });
    expect(delay()).toBe(null);
    await act(async () => { fireEvent.change(select('settings.behavior.markEmailsRead'), { target: { value: 'delay' } }); });
    await waitFor(() => expect(delay()).toBeTruthy());
  });

  it('link safety rows: scanning and click confirmation, each its own switch as on desktop', async () => {
    expect(PREF_DEFAULTS.linkSafetyEnabled).toBe(true);
    expect(PREF_DEFAULTS.linkSafetyClickConfirm).toBe(true);
    expect(readPrefs({ linkSafetyClickConfirm: false }).linkSafetyClickConfirm).toBe(false);
    render(<Settings onClose={() => {}} page="privacy" />);
    expect(toggle('settings.security.linkSafetyScanning').getAttribute('aria-checked')).toBe('true');
    expect(toggle('settings.security.clickConfirmation').getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(toggle('settings.security.clickConfirmation')); });
    await waitFor(() => expect(useMobileStore.getState().prefs.linkSafetyClickConfirm).toBe(false));
    expect(engine.calls).toContainEqual(['mobile.prefs.set', { linkSafetyClickConfirm: false }]);
    await act(async () => { fireEvent.click(toggle('settings.security.linkSafetyScanning')); });
    await waitFor(() => expect(useMobileStore.getState().prefs.linkSafetyEnabled).toBe(false));
    // Desktop keeps the confirmation row while scanning is off (the viewer asks only for a
    // scanned link, so it has no effect then).
    expect(toggle('settings.security.clickConfirmation')).toBeTruthy();
  });

  it('conversation rows: the mode, and the order while the list is threaded', async () => {
    expect(PREF_DEFAULTS.threadMode).toBe('expandable');
    expect(PREF_DEFAULTS.threadSortOrder).toBe('oldest-first');
    expect(readPrefs({ threadMode: 'flat' }).threadMode).toBe('flat');
    render(<Settings onClose={() => {}} page="appearance" />);
    tab('settings.appearance.section.reading');
    const mode = select('settings.appearance.threadMode');
    expect([...mode.options].map((o) => [o.value, o.textContent])).toEqual([
      ['grouped', t('settings.appearance.threadModeGrouped')],
      ['expandable', t('settings.appearance.threadModeExpandable')],
      ['flat', t('settings.appearance.threadModeFlat')],
    ]);
    expect([...select('settings.appearance.threadSortOrder').options].map((o) => o.textContent)).toEqual([t('settings.appearance.oldestFirst'), t('settings.appearance.newestFirst')]);
    await act(async () => { fireEvent.change(select('settings.appearance.threadSortOrder'), { target: { value: 'newest-first' } }); });
    expect(engine.calls).toContainEqual(['mobile.prefs.set', { threadSortOrder: 'newest-first' }]);
    await act(async () => { fireEvent.change(mode, { target: { value: 'flat' } }); });
    await waitFor(() => expect(useMobileStore.getState().prefs.threadMode).toBe('flat'));
    expect(engine.calls).toContainEqual(['mobile.prefs.set', { threadMode: 'flat' }]);
    // Desktop's Reading section keeps the order row in every mode; so does the phone now.
    expect(select('settings.appearance.threadSortOrder')).toBeTruthy();
  });

  it('the language row stores the language', async () => {
    render(<Settings onClose={() => {}} page="appearance" />);
    tab('settings.tab.language');
    await act(async () => { fireEvent.click(screen.getByTestId('language-row-de')); });
    expect(engine.calls).toContainEqual(['mobile.settings.set', { language: 'de' }]);
    await act(async () => { fireEvent.click(screen.getByTestId('language-row-en')); });
  });

  it('the account page saves the name, the signature and hidden, as desktop does', async () => {
    engine.account = { accountId: 'a1', displayName: 'Ada', hidden: false, signature: { html: '<p>Desk sig</p>', text: '', enabled: true }, notify: true };
    render(<Settings onClose={() => {}} page="accounts" />);
    const nameInput = await screen.findByLabelText(t('settings.accounts.displayName'));
    expect(nameInput.value).toBe('Ada');
    const sig = screen.getByLabelText(t('settings.accounts.signatureContent'));
    expect(sig.value).toBe('Desk sig');
    fireEvent.change(nameInput, { target: { value: 'Ada L' } });
    fireEvent.change(sig, { target: { value: 'Ada, phone' } });
    // Desktop's autosave: a moment after typing stops, in one write.
    await act(() => new Promise((r) => { setTimeout(r, 450); }));
    await waitFor(() => expect(engine.calls.filter(([m]) => m === 'mobile.accountSettings.set')).toHaveLength(1));
    expect(engine.calls.find(([m]) => m === 'mobile.accountSettings.set')[1]).toEqual({
      accountId: 'a1',
      values: { displayName: 'Ada L', signature: { html: '', text: 'Ada, phone', enabled: true } },
    });
    fireEvent.click(screen.getByRole('tab', { name: t('settings.accounts.sectionAdvanced') }));
    const visibility = screen.getByRole('group', { name: t('settings.accounts.accountVisible') });
    await act(async () => { fireEvent.click(within(visibility).getByRole('button', { name: t('settings.accounts.accountHidden') })); });
    expect(engine.calls.filter(([m]) => m === 'mobile.accountSettings.set').at(-1)[1]).toEqual({ accountId: 'a1', values: { hidden: true } });
    await waitFor(() => expect(useMobileStore.getState().accounts[0]).toMatchObject({ displayName: 'Ada L', hidden: true }));
    // Still listed, marked hidden, so it can be shown again.
    await waitFor(() => expect(document.querySelector('.account-settings-status').textContent).toContain(t('settings.accounts.accountHidden')));
  });
});

describe('email viewer theme', () => {
  it('follows desktop: its own choice first, else the app\'s theme, else the system', async () => {
    const { viewerTheme } = await import('../prefs.js');
    expect(viewerTheme(true, { theme: 'system', emailViewerTheme: 'system' })).toBe('light');
    expect(viewerTheme(false, { theme: 'system', emailViewerTheme: 'system' })).toBe('dark');
    expect(viewerTheme(false, { theme: 'light', emailViewerTheme: 'system' })).toBe('light');
    expect(viewerTheme(true, { theme: 'dark', emailViewerTheme: 'system' })).toBe('dark');
    expect(viewerTheme(true, { theme: 'light', emailViewerTheme: 'dark' })).toBe('dark');
    expect(viewerTheme(false, { theme: 'dark', emailViewerTheme: 'light' })).toBe('light');
  });

  it('is a preference the engine reads and Settings > Appearance writes', async () => {
    const { readPrefs } = await import('../prefs.js');
    expect(readPrefs({ emailViewerTheme: 'dark' }).emailViewerTheme).toBe('dark');
    expect(readPrefs({}).emailViewerTheme).toBe('system');
    render(<Settings onClose={() => {}} page="appearance" />);
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: t('settings.appearance.emailViewerTheme') }), { target: { value: 'light' } }); });
    expect(engine.calls).toContainEqual(['mobile.prefs.set', { emailViewerTheme: 'light' }]);
  });
});
