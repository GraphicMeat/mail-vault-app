import { describe, it, expect } from 'vitest';
import { faqUrl } from '../../src/services/faqUrl.js';
import { LOCALES } from '../../src/i18n/index.js';

describe('faqUrl', () => {
  it('sends English to the root page', () => {
    expect(faqUrl('en')).toBe('https://mailvaultapp.com/faq.html');
  });

  // The app's locale codes and the website's directory names are not the same
  // set — pt-BR/zh-Hans would 404 if passed through unchanged.
  it('maps the two codes whose website directory differs', () => {
    expect(faqUrl('pt-BR')).toBe('https://mailvaultapp.com/pt-br/faq.html');
    expect(faqUrl('zh-Hans')).toBe('https://mailvaultapp.com/zh/faq.html');
  });

  it('passes the other six through unchanged', () => {
    for (const code of ['de', 'fr', 'es', 'it', 'ja', 'ko']) {
      expect(faqUrl(code)).toBe(`https://mailvaultapp.com/${code}/faq.html`);
    }
  });

  it('covers every locale the app offers', () => {
    for (const l of LOCALES) expect(faqUrl(l.code)).toMatch(/^https:\/\/mailvaultapp\.com\/[a-z-]*\/?faq\.html$/);
  });

  it('falls back to English for anything unknown', () => {
    expect(faqUrl(undefined)).toBe('https://mailvaultapp.com/faq.html');
    expect(faqUrl('kl')).toBe('https://mailvaultapp.com/faq.html');
  });
});
