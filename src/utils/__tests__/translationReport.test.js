import { describe, it, expect } from 'vitest';
import { translationReportReady, translationReportUrl } from '../translationReport.js';

describe('translationReportUrl', () => {
  it('builds the discussion both apps open', () => {
    const url = new URL(translationReportUrl({ lang: 'de', version: '2.23.0', wrong: ' Alle Posteingang ', fix: 'Alle Posteingänge', where: 'Sidebar' }));
    expect(url.origin + url.pathname).toBe('https://github.com/GraphicMeat/mail-vault-app/discussions/new');
    expect(url.searchParams.get('category')).toBe('bug-reports');
    expect(url.searchParams.get('title')).toBe('[i18n de] Alle Posteingang');
    expect(url.searchParams.get('body')).toBe([
      '**Language:** de', '**App version:** 2.23.0', '',
      '**Current text**', '```', 'Alle Posteingang', '```', '',
      '**Suggested correction**', '```', 'Alle Posteingänge', '```', '',
      '**Where:** Sidebar',
    ].join('\n'));
  });

  it('leaves Where out when blank and caps the title text at 60 characters', () => {
    const url = new URL(translationReportUrl({ lang: 'fr', version: '1.0.0', wrong: 'x'.repeat(80), fix: 'y' }));
    expect(url.searchParams.get('body')).not.toContain('Where');
    expect(url.searchParams.get('title')).toBe(`[i18n fr] ${'x'.repeat(60)}`);
  });

  it('is ready only with both texts', () => {
    expect(translationReportReady({ wrong: 'a', fix: '' })).toBe(false);
    expect(translationReportReady({ wrong: ' ', fix: 'b' })).toBe(false);
    expect(translationReportReady({ wrong: 'a', fix: 'b' })).toBe(true);
  });
});
