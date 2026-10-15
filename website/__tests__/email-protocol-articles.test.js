import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = resolve('website');
const articles = [
  ['why-email-is-still-complicated', 'why-email-is-hard-to-build'],
  ['how-jmap-modernizes-email', 'jmap-modern-email-apps'],
];
const locales = ['', 'de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const read = path => readFileSync(resolve(root, path), 'utf8');

describe('email protocol article series', () => {
  it('publishes both articles with metadata, sources and matching language links', () => {
    const sitemap = read('sitemap.xml');
    for (const locale of locales) {
      const prefix = locale ? `/${locale}` : '';
      const index = read(`${locale ? locale + '/' : ''}blog.html`);
      for (const [slug, companion] of articles) {
        const url = `https://mailvaultapp.com${prefix}/blog/${slug}.html`;
        const document = new JSDOM(read(`${locale ? locale + '/' : ''}blog/${slug}.html`)).window.document;
        expect(document.querySelectorAll('h1').length, url).toBe(1);
        expect(document.documentElement.lang).toBe(locale === 'zh' ? 'zh-Hans' : locale === 'pt-br' ? 'pt-BR' : locale || 'en');
        expect(document.querySelector('link[rel="canonical"]').href).toBe(url);
        expect(document.querySelector('meta[property="og:url"]').content).toBe(url);
        expect(document.querySelector('meta[name="description"]').content.length).toBeGreaterThan(40);
        expect(document.querySelectorAll('link[hreflang]').length).toBe(10);
        const schema = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
        expect(schema.mainEntityOfPage).toBe(url);
        expect(schema.inLanguage).toBe(document.documentElement.lang);
        const links = [...document.querySelectorAll('article a')].map(a => a.getAttribute('href'));
        const other = articles.find(([candidate]) => candidate !== slug)[0];
        expect(links).toContain(`${prefix}/blog/${other}.html`);
        const companionPrefix = locale ? `/${locale === 'zh' ? 'zh-hans' : locale}` : '';
        expect(links).toContain(`https://graphicmeat.com${companionPrefix}/blog/${companion}`);
        expect(links.some(link => link.startsWith('https://www.rfc-editor.org/'))).toBe(true);
        expect(index).toContain(`${prefix}/blog/${slug}.html`);
        expect(sitemap).toContain(url);
        if (locale) {
          const english = new JSDOM(read(`blog/${slug}.html`)).window.document;
          expect(document.querySelector('h1').textContent).not.toBe(english.querySelector('h1').textContent);
          const originals = [...english.querySelectorAll('article p')].map(p => p.textContent);
          for (const paragraph of document.querySelectorAll('article p')) {
            if (paragraph.textContent.length > 60) expect(originals).not.toContain(paragraph.textContent);
          }
        }
      }
    }
  });
});
