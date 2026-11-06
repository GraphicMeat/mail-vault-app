// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { pickLocale, loadMobileLocale, getMobileLocale, t } from '../i18n.js';
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
});
