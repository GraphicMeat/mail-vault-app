import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLocale } from '../../src/i18n/index.js';
import { formatEmailDate } from '../../src/utils/dateFormat.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * Three strings survived the localization pass because nothing reads them as
 * text: a literal in a date helper, a raw store value printed straight into
 * the DOM, and a bare word beside an interpolated number. The DOM probe the
 * screenshot harness uses could not see them either — they only showed up in
 * the picture, sitting in English inside an otherwise German window.
 */
describe('list chrome is localized', () => {
  afterAll(async () => { await setLocale('en'); });

  it('translates yesterday', async () => {
    await setLocale('de');
    const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
    expect(formatEmailDate(yesterday)).not.toBe('Yesterday');
  });

  it('names the weekday through Intl, not date-fns with no locale', () => {
    // Whether a given date lands in `isThisWeek` shifts with the day this test
    // runs, so assert the mechanism rather than an output that is only
    // sometimes produced.
    const src = readFileSync(resolve(SRC, 'utils/dateFormat.js'), 'utf-8');
    expect(src).not.toMatch(/format\(date,\s*'EEEE'\)/);
  });

  it('does not print the raw view mode as a label', () => {
    const src = readFileSync(resolve(SRC, 'components/EmailList.jsx'), 'utf-8');
    expect(src).not.toMatch(/<span className="capitalize">\{viewMode\}<\/span>/);
  });

  it('does not hardcode the word emails beside the count', () => {
    const src = readFileSync(resolve(SRC, 'components/Sidebar.jsx'), 'utf-8');
    expect(src).not.toMatch(/\{totalEmails\.toLocaleString\(\)\}\s*emails/);
  });
});
