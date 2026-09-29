// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import itIT from '../locales/it.json';
import de from '../locales/de.json';
import ptBR from '../locales/pt-BR.json';
import ja from '../locales/ja.json';
import ko from '../locales/ko.json';
import zhHans from '../locales/zh-Hans.json';
import { KEPT_KEYS, PAUSE_KEYS, WAIT_KEYS } from '../../components/abd/abdText';

/**
 * Archive & delete copy is read by someone about to remove mail from a server:
 * it exists in all nine languages, uses no dash as punctuation (house rule for
 * customer-facing text), and names no person. `catalogs.test.js` already proves
 * parity and placeholders for every key; this pins the feature's own set.
 */
const CATALOGS = { en, es, fr, it: itIT, de, 'pt-BR': ptBR, ja, ko, 'zh-Hans': zhHans };
const OURS = (catalog) => Object.entries(catalog).filter(([k]) => /^(settings\.backup\.abd\.|abd\.|errors\.E_ABD_)/.test(k));

describe('Archive & delete catalog', () => {
  it('has the feature\'s keys in English', () => {
    const keys = OURS(en).map(([k]) => k);
    expect(keys.length).toBeGreaterThan(90);
    for (const key of [
      'settings.backup.abd.tab', 'settings.backup.abd.backupCard.title', 'settings.backup.abd.archiveCard.title',
      'settings.backup.abd.onlyCopyNote', 'settings.backup.abd.needsBackupFolder', 'settings.backup.abd.setup.datesOlderCutoff',
      'settings.backup.abd.setup.confirm', 'abd.panel.title', 'abd.panel.titleBackup', 'abd.pill', 'abd.pillWaiting',
      'errors.E_ABD_JOB_EXISTS', 'errors.E_ABD_PREVIEW_EXPIRED', 'errors.E_ABD_NO_BACKUP_DRIVE',
      'errors.E_ABD_CANNOT_DELETE', 'errors.E_ABD_NOT_CONFIRMED',
    ]) expect(en[key], key).toBeTruthy();
  });

  it('has a sentence for every reason, wait and pause the daemon can report', () => {
    for (const key of [...Object.values(KEPT_KEYS), ...Object.values(WAIT_KEYS), ...Object.values(PAUSE_KEYS)]) {
      for (const [locale, catalog] of Object.entries(CATALOGS)) expect(catalog[key], `${locale} ${key}`).toBeTruthy();
    }
  });

  it('says the vault is the only copy, in the words the product uses', () => {
    expect(en['settings.backup.abd.onlyCopyNote']).toBe('Your vault will be the only copy. Set up a backup folder for a second copy.');
    expect(en['settings.backup.abd.needsBackupFolder']).toBe('Choose a backup folder first');
    expect(en['settings.backup.abd.setup.confirm']).toBe('I understand these emails will be removed from the server');
  });

  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale}: no em or en dash in any of it`, () => {
      expect(OURS(catalog).filter(([, v]) => /[\u2013\u2014]/.test(v)).map(([k]) => k)).toEqual([]);
    });
  }

  it('every locale carries every key of the feature', () => {
    const keys = OURS(en).map(([k]) => k);
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(keys.filter(k => !(k in catalog)), locale).toEqual([]);
    }
  });

  it('has an errors key for every E_ABD code the daemon, the shell and the service can raise', () => {
    // The lookbehind keeps env names such as MAILVAULT_DISABLE_ABD_RESUME out of it.
    const CODE = /(?<![A-Za-z0-9_])E_ABD_[A-Z]+(?:_[A-Z]+)*/g;
    const SOURCES = [
      'src-daemon/src/handlers/abd.rs',
      'src-daemon/src/abd_worker.rs',
      'src-tauri/src/abd.rs',
      'src/services/abd.js',
      'src/services/api.js',
    ];
    const found = new Set();
    for (const file of SOURCES) for (const code of readFileSync(file, 'utf8').match(CODE) || []) found.add(code);
    // Reads the sources for real: the eight codes in use must be among them, so an empty scan cannot pass.
    for (const code of ['E_ABD_JOB_EXISTS', 'E_ABD_PREVIEW_EXPIRED', 'E_ABD_NOT_CONFIRMED', 'E_ABD_NO_BACKUP_DRIVE',
      'E_ABD_CANNOT_DELETE', 'E_ABD_JOB_UNFINISHED', 'E_ABD_NO_JOB', 'E_ABD_UNAVAILABLE']) expect(found.has(code), code).toBe(true);
    for (const code of found) {
      for (const [locale, catalog] of Object.entries(CATALOGS)) expect(catalog[`errors.${code}`], `${locale} errors.${code}`).toBeTruthy();
    }
  });
});
