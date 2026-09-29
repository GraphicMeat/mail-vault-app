/**
 * "Import and restore to the server" (MBOX import mode 1): every code the
 * daemon job answers with, and every word of its chip and dialog, is a catalog
 * key in all nine app locales. The daemon's own text after a code is internal
 * and never shown (src/services/mboxUpload.js maps the code prefix).
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

// As src-daemon/src/mbox_upload_job.rs and mbox_upload.rs build them.
const DAEMON_CODES = [
  'E_MBOX_UPLOAD_RUNNING', 'E_MBOX_UPLOAD_RESUMABLE', 'E_MBOX_UPLOAD_NOT_FOUND',
  'E_MBOX_UPLOAD_SIGN_IN', 'E_MBOX_UPLOAD_READ', 'E_MBOX_SERVER_GRAPH',
];
const DIALOG_KEYS = [
  'settings.backup.restore.mboxServerLongUpload',
  'settings.backup.restore.mboxUploadResumable',
  'settings.backup.restore.mboxUploadResume',
  'settings.backup.restore.mboxUploadStartOver',
];
const CHIP_KEYS = [
  'mboxUpload.actionFailed', 'mboxUpload.counts', 'mboxUpload.etaHours', 'mboxUpload.etaMinutes',
  'mboxUpload.etaUnderMinute', 'mboxUpload.needsSignIn', 'mboxUpload.pause', 'mboxUpload.signIn',
  'mboxUpload.throttled', 'mboxUpload.title', 'mboxUpload.titleDone', 'mboxUpload.titlePaused',
  'mboxUpload.titleStopped',
  // The file picked again to resume: the panel's title, and the refusal of
  // a file by another name. The stopped row's note that Cancel kept it.
  'mboxUpload.pickAgainTitle', 'mboxUpload.otherFile', 'mboxUpload.stoppedHint',
];
const NEW_KEYS = [...DAEMON_CODES.map((c) => `errors.${c}`), ...DIALOG_KEYS, ...CHIP_KEYS];

describe('the MBOX upload catalog', () => {
  it('carries every new key, non-empty, in all nine locales', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(NEW_KEYS.filter((k) => !String(catalog[k] ?? '').trim()), locale).toEqual([]);
    }
  });

  it('holds the same chip keys in every locale, and no other', () => {
    const chipKeys = (catalog) => Object.keys(catalog).filter((k) => k.startsWith('mboxUpload.')).sort();
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(chipKeys(catalog), locale).toEqual([...CHIP_KEYS].sort());
    }
  });

  it('dropped the key of the refusal the daemon no longer sends, everywhere', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect('errors.E_MBOX_MODE_UNAVAILABLE' in catalog, locale).toBe(false);
    }
  });

  it('writes no em dash, and never a bare code, in any of them', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const k of NEW_KEYS) {
        expect(catalog[k], `${locale} ${k}`).not.toContain('\u2014');
        expect(catalog[k], `${locale} ${k}`).not.toMatch(/E_MBOX_/);
      }
    }
  });

  it('keeps the placeholders the chip fills', () => {
    const vars = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join(',');
    const expected = {
      'mboxUpload.counts': '{{failed}},{{skipped}},{{uploaded}}',
      'mboxUpload.etaHours': '{{hours}},{{minutes}}',
      'mboxUpload.etaMinutes': '{{minutes}}',
      'mboxUpload.title': '{{file}}',
      'mboxUpload.titleDone': '{{file}}',
      'mboxUpload.titlePaused': '{{file}}',
      'mboxUpload.titleStopped': '{{file}}',
      'mboxUpload.pickAgainTitle': '{{file}}',
      'mboxUpload.otherFile': '',
      'mboxUpload.stoppedHint': '',
    };
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [k, v] of Object.entries(expected)) expect(vars(catalog[k]), `${locale} ${k}`).toBe(v);
    }
  });

  // Gmail's sign-in is OAuth: there is no password to check.
  it('a refused sign-in asks to sign in again, not to check a password', () => {
    expect(en['errors.E_MBOX_UPLOAD_SIGN_IN']).toMatch(/sign in to this account again/i);
    expect(en['errors.E_MBOX_UPLOAD_SIGN_IN']).not.toMatch(/password/i);
  });

  it('the size warning names no number: the daemon measures, the dialog does not guess', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(catalog['settings.backup.restore.mboxServerLongUpload'], locale).not.toMatch(/\d/);
    }
  });
});
