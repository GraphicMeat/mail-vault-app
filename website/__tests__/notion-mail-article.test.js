import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = resolve('website');
const slug = 'notion-mail-closing.html';
const locales = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];

describe('Notion Mail closure article', () => {
  it('publishes the article in the English blog index', () => {
    const index = readFileSync(resolve(root, 'blog.html'), 'utf8');
    expect(index).toContain(`/blog/${slug}`);
    expect(index).toContain('Notion Mail Is Closing');
    expect(readFileSync(resolve(root, 'sitemap.xml'), 'utf8')).toContain(`/blog/${slug}`);
  });

  it('keeps the English article sourced and grounded in MailVault features', () => {
    const html = readFileSync(resolve(root, 'blog', slug), 'utf8');
    const document = new JSDOM(html).window.document;
    const text = document.querySelector('article').textContent;

    expect(html).toContain('https://www.notion.com/help/notion-mail-inbox-is-going-away-what-to-do-next');
    expect(text).toContain('September 22, 2026');
    for (const feature of ['local', 'offline', 'search', '.eml', 'scheduled backups']) {
      expect(text.toLowerCase()).toContain(feature.toLowerCase());
    }
  });

  it('generates a matching localized article for every supported site locale', () => {
    for (const locale of locales) {
      const path = resolve(root, locale, 'blog', slug);
      expect(existsSync(path), path).toBe(true);
      const document = new JSDOM(readFileSync(path, 'utf8')).window.document;
      expect(document.documentElement.lang, path).toBe(locale === 'zh' ? 'zh-Hans' : locale === 'pt-br' ? 'pt-BR' : locale);
      expect(document.querySelector('link[hreflang="en"]')?.getAttribute('href'), path)
        .toBe(`https://mailvaultapp.com/blog/${slug}`);
      expect(document.querySelector('article'), path).not.toBeNull();
    }
  });
});
