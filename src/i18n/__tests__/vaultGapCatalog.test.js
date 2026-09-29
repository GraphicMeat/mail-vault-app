/**
 * Settings > Backup's "not yet in your vault" row (Phase 5, D7): every word it
 * shows and every daemon code it can meet is a catalog key in all nine app
 * locales. The daemon's text after a code is internal and never shown
 * (VaultGapRow's `errorKey` maps the code). The count is per folder copy, so
 * the counting lines say copies; each carries its count in every plural form.
 */
import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import itIT from '../locales/it.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import ptBR from '../locales/pt-BR.json';
import zhHans from '../locales/zh-Hans.json';

const CATALOGS = { en, de, es, fr, it: itIT, ja, ko, 'pt-BR': ptBR, 'zh-Hans': zhHans };

// As src-daemon/src/vault_gap.rs answers them (E_VAULT_UNAVAILABLE was already a key).
const DAEMON_CODES = ['E_ACCOUNT_NOT_FOUND', 'E_HEADER_CACHE_UNAVAILABLE', 'E_VAULT_GAP_GRAPH', 'E_VAULT_UNAVAILABLE'];
// noneRecent / hintRecent: under Keep Recent the lines name the window in months.
const PLURALS = ['count', 'atLeast', 'failed', 'noneRecent', 'hintRecent'];
const ROW_KEYS = [
  'title', 'hint', 'partial', 'none', 'byDesign', 'countFailed', 'save', 'saveFailed', 'progress', 'joined',
  ...PLURALS.flatMap((k) => [`${k}_one`, `${k}_other`]),
].map((k) => `settings.backup.vaultGap.${k}`);
const NEW_KEYS = [...DAEMON_CODES.map((c) => `errors.${c}`), ...ROW_KEYS];

describe('the not-in-vault catalog', () => {
  it('carries every key, non-empty, in all nine locales', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(NEW_KEYS.filter((k) => !String(catalog[k] ?? '').trim()), locale).toEqual([]);
    }
  });

  it('holds the same row keys in every locale, and no other', () => {
    const rowKeys = (catalog) => Object.keys(catalog).filter((k) => k.startsWith('settings.backup.vaultGap.')).sort();
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(rowKeys(catalog), locale).toEqual([...ROW_KEYS].sort());
    }
  });

  it('writes no em dash, and never a bare code, in any of them', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const k of NEW_KEYS) {
        expect(catalog[k], `${locale} ${k}`).not.toContain('\u2014');
        expect(catalog[k], `${locale} ${k}`).not.toMatch(/E_[A-Z]/);
      }
    }
  });

  it('keeps the placeholders the row fills, the count in every plural form', () => {
    const vars = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join(',');
    const expected = {
      'settings.backup.vaultGap.progress': '{{done}},{{folder}},{{saved}},{{total}}',
      ...Object.fromEntries(PLURALS.flatMap((k) => ['one', 'other'].map((f) => [`settings.backup.vaultGap.${k}_${f}`, '{{count}}']))),
    };
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [k, v] of Object.entries(expected)) expect(vars(catalog[k]), `${locale} ${k}`).toBe(v);
    }
  });

  it('counts copies, not messages, in English', () => {
    for (const k of ['count', 'atLeast', 'failed']) {
      expect(en[`settings.backup.vaultGap.${k}_one`]).toMatch(/\bcopy\b/);
      expect(en[`settings.backup.vaultGap.${k}_other`]).toMatch(/\bcopies\b/);
    }
    expect(en['settings.backup.vaultGap.none']).toMatch(/\bcopy\b/);
  });

  it('under Keep Recent never claims every copy, and says older mail stays on the server', () => {
    for (const f of ['one', 'other']) {
      expect(en[`settings.backup.vaultGap.noneRecent_${f}`]).toMatch(/last \{\{count\}\} months?/);
      expect(en[`settings.backup.vaultGap.noneRecent_${f}`]).toMatch(/Older mail stays on the server/);
      expect(en[`settings.backup.vaultGap.hintRecent_${f}`]).toMatch(/Older mail stays on the server/);
    }
  });

  it('never tells an Outlook user to use a button a free user cannot reach', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(catalog['errors.E_VAULT_GAP_GRAPH'], locale).not.toContain(catalog['settings.backup.account.backUpNow']);
    }
  });
});
