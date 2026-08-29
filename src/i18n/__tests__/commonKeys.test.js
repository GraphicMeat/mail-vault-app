import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';

const REQUIRED = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.upgrade': 'Upgrade',
  'common.discard': 'Discard',
  'common.delete': 'Delete',
  'common.from': 'From',
  'common.to': 'To',
  'common.reset': 'Reset',
  'common.resetToDefault': 'Reset to default',
  'common.export': 'Export',
  'common.archive': 'Archive',
  'common.done': 'Done',
  'common.minimize': 'Minimize',
  'common.resume': 'Resume',
  'common.premium': 'Premium',
  'common.premiumFeature': 'Premium Feature',
  'common.clear': 'Clear',
  'common.retry': 'Retry',
  'common.folder': 'Folder',
  'common.open': 'Open',
  'common.save': 'Save',
  'common.noAccountsConfigured': 'No accounts configured',
};

describe('common namespace', () => {
  it('defines every shared string with its exact English wording', () => {
    for (const [k, v] of Object.entries(REQUIRED)) expect(en[k], k).toBe(v);
  });

  // A shared string must live in common.* once, not be re-minted per file.
  it('does not duplicate a common value under a file-scoped key', () => {
    const commonValues = new Set(Object.entries(en)
      .filter(([k]) => k.startsWith('common.')).map(([, v]) => v));
    const offenders = Object.entries(en)
      .filter(([k, v]) => !k.startsWith('common.') && commonValues.has(v))
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    expect(offenders).toEqual([]);
  });
});
