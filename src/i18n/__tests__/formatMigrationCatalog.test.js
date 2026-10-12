/**
 * The storage format conversion's corner chip (Plan B, Task 9) and the
 * reasons a conversion stops with: every word is a catalog key in all nine
 * app locales. The daemon's codes are mapped by
 * src/services/storageFormat.js (`failureText`).
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

// The English words, as the plan fixed them.
const ENGLISH = {
  'formatMigration.running': 'Converting message format',
  'formatMigration.paused': 'Message format conversion paused',
  'formatMigration.failed': 'Message format conversion stopped',
  'formatMigration.done': 'Message format converted',
  'formatMigration.counts': '{{done}} of {{total}} messages',
  'errors.formatUnverified': 'some messages did not verify ({{count}})',
  'errors.formatRehomePending': 'some folders wait for their first full sync ({{count}})',
  'errors.formatDisk': 'the disk is full or failing',
  'errors.formatUnreadable': 'a folder of the vault could not be read',
  'errors.formatDamaged': 'some message records are damaged and were left as they are ({{count}})',
};
const KEYS = Object.keys(ENGLISH);
const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join();

describe('the format conversion catalog', () => {
  it('holds the English words as fixed', () => {
    expect(Object.fromEntries(KEYS.map((k) => [k, en[k]]))).toEqual(ENGLISH);
  });

  it('carries every key, non-empty and translated, in all nine locales', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(KEYS.filter((k) => !String(catalog[k] ?? '').trim()), locale).toEqual([]);
      if (locale !== 'en') expect(KEYS.filter((k) => catalog[k] === en[k]), locale).toEqual([]);
    }
  });

  it('keeps every placeholder and uses no em dash', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(KEYS.filter((k) => placeholders(catalog[k]) !== placeholders(en[k])), locale).toEqual([]);
      expect(KEYS.filter((k) => /[\u2014\u2015\u2E3A\u2E3B]/.test(String(catalog[k]))), locale).toEqual([]);
    }
  });
});
