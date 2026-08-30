import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, appCode, SHOT_DIRS } from '../../scripts/screenshots/locales.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('screenshot locale map', () => {
  it('maps every website directory to an app locale code', () => {
    expect(appCode('en')).toBe('en');
    expect(appCode('de')).toBe('de');
    expect(appCode('zh')).toBe('zh-Hans');
    expect(appCode('pt-br')).toBe('pt-BR');
  });

  it('rejects a directory it does not know', () => {
    expect(() => appCode('xx')).toThrow(/unknown screenshot locale: xx/);
  });

  it('names an app catalog that exists on disk for every locale', () => {
    for (const { app } of LOCALES) {
      const file = resolve(HERE, `../../src/i18n/locales/${app}.json`);
      expect(existsSync(file), `missing catalog ${app}.json`).toBe(true);
    }
  });

  it('covers the eight website locale directories plus English', () => {
    expect(SHOT_DIRS).toEqual(['en', 'de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br']);
  });
});
