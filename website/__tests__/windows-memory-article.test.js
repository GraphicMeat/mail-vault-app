import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = resolve('website');
const slug = 'mailvault-windows-memory-use.html';
const locales = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const read = (...parts) => new JSDOM(readFileSync(resolve(root, ...parts), 'utf8')).window.document;

// The charts are HTML, not SVG text, so that the i18n build translates their
// labels: chart text inside an <svg> ships in English on every locale.
const chartLabels = (document) => [...document.querySelectorAll('article figure th, article figure td, article figure li')]
  .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
  .filter((text) => /[A-Za-z]{4}/.test(text.replace(/\d[\d.,–\s]*MB|WebView2|GPU/g, '')));

describe('Windows memory article', () => {
  it('is listed in the English blog index and the sitemap', () => {
    expect(readFileSync(resolve(root, 'blog.html'), 'utf8')).toContain(`/blog/${slug}`);
    expect(readFileSync(resolve(root, 'sitemap.xml'), 'utf8')).toContain(`/blog/${slug}`);
  });

  it('references only screenshots that exist', () => {
    const images = [...read('blog', slug).querySelectorAll('article img')].map((img) => img.getAttribute('src'));
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const src of images) expect(existsSync(resolve(root, `.${src}`)), src).toBe(true);
  });

  it('translates the chart labels in every locale', () => {
    const english = chartLabels(read('blog', slug));
    expect(english.length).toBeGreaterThan(5);
    for (const locale of locales) {
      const localized = chartLabels(read(locale, 'blog', slug));
      const untranslated = localized.filter((label) => english.includes(label));
      expect(untranslated, locale).toEqual([]);
    }
  });
});
