/**
 * Settings > Storage > Message format: every word of the format row, the
 * Convert dialog and the old-files row, and every code the daemon's
 * `storage_format_*` routes answer with, is a catalog key in all nine app
 * locales. The daemon's text after a code is internal and never shown
 * (src/services/storageFormat.js maps the code prefix).
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
  'settings.storage.formatLabel': 'Message format',
  'settings.storage.formatMaildir': 'Maildir (.eml files)',
  'settings.storage.formatJmap': 'JMAP (JSON records + blobs)',
  'settings.storage.formatHelp': "JMAP keeps every message's original bytes plus a JSON record other JMAP tools can read, and stores identical messages once. Maildir keeps one .eml file per message.",
  'settings.storage.convert': 'Convert',
  'settings.storage.convertTitle': 'Convert to {{format}}',
  'settings.storage.oldFilesRetire': 'Keep old files aside',
  'settings.storage.oldFilesDelete': 'Delete old files after each message is verified',
  'settings.storage.convertStart': 'Start conversion',
  'settings.storage.converting': 'Converting messages: {{done}} of {{total}}',
  'settings.storage.convertStopped': 'Conversion stopped at {{done}} of {{total}}',
  'settings.storage.convertPause': 'Pause',
  'settings.storage.convertBack': 'Convert back',
  'settings.storage.retiredSize': 'Old files kept aside: {{size}}',
  'settings.storage.retiredDelete': 'Delete old files',
  'settings.storage.retiredConfirm': 'Permanently delete {{size}} of old message files? Your converted mail is not affected.',
  'settings.storage.reclaim': 'Reclaim space',
  'errors.formatBusy': 'A conversion is already running.',
  'errors.formatNoSpace': 'Not enough free space to keep the old files aside. Free {{size}} or choose to delete them after verification.',
  'errors.formatFailed': 'Conversion stopped: {{reason}}. Nothing was deleted for the messages that failed.',
  'errors.formatMoveBlocked': 'Finish or cancel the format conversion before moving the vault.',
  'errors.formatSame': 'The vault is already in this format.',
  'errors.formatNotFound': 'There is no conversion to pause, resume or cancel.',
  'errors.formatReclaimFailed': 'Could not reclaim space. Check that the vault folder is reachable and try again.',
  'errors.formatPurgeFailed': 'Could not delete all the old files. Check that the vault folder is reachable and try again.',
  'errors.formatIo': 'The conversion could not be updated. Check that the vault folder is reachable and try again.',
};
const KEYS = Object.keys(ENGLISH);
const placeholders = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join();

describe('the message format catalog', () => {
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
