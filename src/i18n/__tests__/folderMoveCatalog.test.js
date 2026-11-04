/**
 * Move folder: every code the daemon job answers with, and every word of its
 * dialog and chip, is a catalog key in all nine app locales. The daemon's own
 * text after a code is internal and never shown (src/services/folderMove.js
 * maps the code).
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

// As src-core/src/folder_move.rs (PlanError::code) and src-daemon/src/folder_move_job.rs build them.
const DAEMON_CODES = [
  'E_FOLDER_MOVE_RESERVED', 'E_FOLDER_MOVE_INTO_ITSELF', 'E_FOLDER_MOVE_RUNNING', 'E_FOLDER_MOVE_NOT_FOUND',
  'E_FOLDER_MOVE_SOURCE_MISSING', 'E_FOLDER_MOVE_SIGN_IN', 'E_FOLDER_MOVE_GRAPH_SUBFOLDERS',
  'E_FOLDER_MOVE_NO_HIERARCHY', 'E_FOLDER_MOVE_NAME',
];
const KEYS = [
  // The dialog.
  'title', 'account', 'accountLocked', 'into', 'topLevel', 'loadingFolders', 'foldersFailed',
  'planCount_one', 'planCount_other', 'planUnknown', 'fastRename', 'vaultNote', 'retireNote', 'premiumUpsell',
  'confirm', 'failed',
  // The chip.
  'pause', 'titleRunning', 'titleVerifying', 'titleRetiring', 'titlePaused', 'titleStopped', 'titleCancelled',
  'titleFailed', 'titleKept', 'titleDone', 'counts', 'retiredTo', 'keptUnverified', 'keptFailed', 'keptNoTrash',
  'keptRenameFailed', 'stoppedHint', 'rateLimited', 'vaultIncomplete',
].map((k) => `folderMove.${k}`);
const NEW_KEYS = [...DAEMON_CODES.map((c) => `errors.${c}`), ...KEYS, 'sidebar.moveFolder'];

describe('the Move folder catalog', () => {
  it('carries every key, non-empty, in all nine locales', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(NEW_KEYS.filter((k) => !String(catalog[k] ?? '').trim()), locale).toEqual([]);
    }
  });

  it('holds the same folderMove keys in every locale, and no other', () => {
    const own = (catalog) => Object.keys(catalog).filter((k) => k.startsWith('folderMove.')).sort();
    for (const [locale, catalog] of Object.entries(CATALOGS)) expect(own(catalog), locale).toEqual([...KEYS].sort());
  });

  it('writes no em dash, and never a bare code, in any of them', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const k of NEW_KEYS) {
        expect(catalog[k], `${locale} ${k}`).not.toContain('—');
        expect(catalog[k], `${locale} ${k}`).not.toMatch(/E_[A-Z]/);
      }
    }
  });

  it('keeps the placeholders the dialog and the chip fill, the count in every plural form', () => {
    const vars = (s) => (String(s).match(/\{\{(\w+)\}\}/g) || []).sort().join(',');
    const named = ['title', 'topLevel', 'titleRunning', 'titleVerifying', 'titleRetiring', 'titlePaused', 'titleStopped',
      'titleCancelled', 'titleFailed', 'titleKept', 'titleDone'];
    const expected = {
      'folderMove.accountLocked': '{{email}}',
      'folderMove.counts': '{{copied}},{{failed}},{{skipped}}',
      'folderMove.retiredTo': '{{path}}',
      'folderMove.planCount_one': '{{count}}',
      'folderMove.planCount_other': '{{count}}',
      ...Object.fromEntries(named.map((k) => [`folderMove.${k}`, '{{name}}'])),
    };
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [k, v] of Object.entries(expected)) expect(vars(catalog[k]), `${locale} ${k}`).toBe(v);
    }
  });

  it('says in English that only server mail moves and that the original goes to Trash', () => {
    expect(en['folderMove.vaultNote']).toMatch(/Only mail on the server moves/);
    expect(en['folderMove.retireNote']).toMatch(/Trash once every message is confirmed/);
  });
});
