// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { pickLocale, loadMobileLocale, getMobileLocale, startMobileLocale, subscribeLocale, t } from '../i18n.js';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import ja from '../../i18n/locales/ja.json';

afterEach(() => loadMobileLocale(['en']));

describe('mobile locale', () => {
  it('maps the system languages to one of the nine catalogs', () => {
    expect(pickLocale(['de-AT'])).toBe('de');
    expect(pickLocale(['pt-PT'])).toBe('pt-BR');
    expect(pickLocale(['zh-Hant-TW', 'ja-JP'])).toBe('zh-Hans');
    expect(pickLocale(['sv-SE', 'fr-CA'])).toBe('fr');
    expect(pickLocale(['sv-SE'])).toBe('en');
    expect(pickLocale([])).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
    expect(pickLocale(['KO'])).toBe('ko');
  });

  it('loads the picked catalog and falls back to English per key', async () => {
    expect(getMobileLocale()).toBe('en');
    expect(t('sidebar.inbox')).toBe(en['sidebar.inbox']);
    await loadMobileLocale(['de-DE']);
    expect(getMobileLocale()).toBe('de');
    expect(t('mobile.list.loadFailed')).toBe(de['mobile.list.loadFailed']);
    expect(t('common.messageCount', { count: 2 })).toBe(de['common.messageCount_other'].replace('{{count}}', '2'));
    await loadMobileLocale(['ja']);
    expect(t('mobile.add.signIn')).toBe(ja['mobile.add.signIn']);
    await loadMobileLocale(['en-GB']);
    expect(getMobileLocale()).toBe('en');
    expect(t('mobile.add.signIn')).toBe(en['mobile.add.signIn']);
  });

  it('picks the plural form of the unread count', async () => {
    expect(t('mobile.unreadCount', { count: 1 })).toBe('1 unread');
    await loadMobileLocale(['fr-FR']);
    expect(t('mobile.unreadCount', { count: 1 })).toBe('1 non lu');
    expect(t('mobile.unreadCount', { count: 3 })).toBe('3 non lus');
    await loadMobileLocale(['pt-BR']);
    expect(t('mobile.unreadCount', { count: 1 })).toBe('1 não lida');
    expect(t('mobile.unreadCount', { count: 2 })).toBe('2 não lidas');
    await loadMobileLocale(['ja']);
    expect(t('mobile.unreadCount', { count: 1 })).toBe('未読 1 件');
  });

  it('prefers the language the user picked over the system one', async () => {
    await loadMobileLocale(['fr-FR'], 'de');
    expect(getMobileLocale()).toBe('de');
    // Anything but one of the nine codes is ignored: the system decides.
    await loadMobileLocale(['fr-FR'], 'sv');
    expect(getMobileLocale()).toBe('fr');
    await loadMobileLocale(['fr-FR'], null);
    expect(getMobileLocale()).toBe('fr');
  });

  it('starts with the stored language, and with the system one when the engine has none or fails', async () => {
    await startMobileLocale(async () => ({ language: 'ja' }), ['de']);
    expect(getMobileLocale()).toBe('ja');
    await startMobileLocale(async () => ({ language: null }), ['de']);
    expect(getMobileLocale()).toBe('de');
    await startMobileLocale(async () => { throw new Error('no engine'); }, ['ko']);
    expect(getMobileLocale()).toBe('ko');
  });

  it('does not wait long for a slow engine before the first paint', async () => {
    const started = Date.now();
    await startMobileLocale(() => new Promise(() => {}), ['it'], 30);
    expect(getMobileLocale()).toBe('it');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('tells subscribers when the language changes; the last pick wins', async () => {
    let calls = 0;
    const off = subscribeLocale(() => { calls++; });
    const slow = loadMobileLocale(['de']);
    const fast = loadMobileLocale(['es']);
    await Promise.all([slow, fast]);
    expect(getMobileLocale()).toBe('es');
    expect(calls).toBeGreaterThan(0);
    off();
    const before = calls;
    await loadMobileLocale(['fr']);
    expect(calls).toBe(before);
  });
});
