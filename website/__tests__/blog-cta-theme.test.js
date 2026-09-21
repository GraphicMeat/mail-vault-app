import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const websiteRoot = resolve('website');
const blogRoot = resolve(websiteRoot, 'blog');
const locales = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const contentCss = readFileSync(resolve(websiteRoot, 'assets/english-content.css'), 'utf8');

function readCtaAnchors(path) {
  const document = new JSDOM(readFileSync(path, 'utf8')).window.document;
  return [...document.querySelectorAll('a')].filter(anchor =>
    anchor.classList.contains('lamp-bg') || anchor.classList.contains('border-primary-300'),
  );
}

describe('blog article CTA theme colors', () => {
  it('marks every article CTA consistently in English and localized pages', () => {
    const articles = readdirSync(blogRoot)
      .filter(file => file.endsWith('.html'))
      .filter(file => readCtaAnchors(resolve(blogRoot, file)).length > 0);

    expect(articles).toHaveLength(6);

    for (const article of articles) {
      const englishPath = resolve(blogRoot, article);
      const englishCtas = readCtaAnchors(englishPath);
      expect(englishCtas.length, article).toBe(2);
      expect(readFileSync(englishPath, 'utf8'), englishPath)
        .toContain('/assets/english-content.css?v=3');

      for (const locale of locales) {
        const localizedPath = resolve(websiteRoot, locale, 'blog', article);
        expect(existsSync(localizedPath), localizedPath).toBe(true);
        const localizedCtas = readCtaAnchors(localizedPath);
        expect(localizedCtas.length, localizedPath).toBe(2);
        expect(readFileSync(localizedPath, 'utf8'), localizedPath)
          .toContain('/assets/english-content.css?v=3');

        for (const cta of [...englishCtas, ...localizedCtas]) {
          expect(cta.classList.contains('mv-blog-cta')).toBe(true);
          if (cta.classList.contains('lamp-bg')) {
            expect(cta.classList.contains('mv-blog-cta-primary')).toBe(true);
          } else {
            expect(cta.classList.contains('mv-blog-cta-secondary')).toBe(true);
          }
        }
      }
    }
  });

  it('keeps primary labels white in both themes and makes dark secondary labels white', () => {
    const dom = new JSDOM(`
      <html>
        <head><style>${contentCss}</style></head>
        <body>
          <div class="mv-content-page"><main><div class="prose">
            <a class="mv-blog-cta mv-blog-cta-primary text-white">Download</a>
            <a class="mv-blog-cta mv-blog-cta-secondary text-primary-600 dark:text-primary-400">See features</a>
            <a class="text-primary-500">Read the source</a>
          </div></main></div>
        </body>
      </html>
    `);
    const [primary, secondary, proseLink] = dom.window.document.querySelectorAll('.prose a');

    expect(dom.window.getComputedStyle(primary).color).toBe('rgb(255, 255, 255)');
    expect(dom.window.getComputedStyle(secondary).color).toBe('var(--mv-accent)');
    expect(dom.window.getComputedStyle(proseLink).color).toBe('var(--mv-accent)');

    dom.window.document.documentElement.classList.add('dark');
    expect(dom.window.getComputedStyle(primary).color).toBe('rgb(255, 255, 255)');
    expect(dom.window.getComputedStyle(secondary).color).toBe('rgb(255, 255, 255)');
    expect(dom.window.getComputedStyle(proseLink).color).toBe('var(--mv-accent)');
  });
});
