import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('website');
const PAGES = ['404','ai-setup','billing-cancel','billing-success','blog','changelog','docs','download-stats','faq','features','get-started','index','mentioned-in','pricing','privacy','start','terms','thank-you','updates-confirm','use-cases','windows-download'].map(n => n + '.html');
const load = (path) => new JSDOM(readFileSync(path, 'utf8')).window.document;
const english = (file) => load(resolve(root, file));
const css = readFileSync(resolve(root, 'assets/english-site.css'), 'utf8');

describe('footer Back to top', () => {
  it.each(PAGES)('%s has one footer Back to top link to #top', (file) => {
    const links = english(file).querySelectorAll('.mv-footer-bottom a[href="#top"]');
    expect(links.length).toBe(1);
    const link = links[0];
    expect(link.getAttribute('aria-label')).toBe('Back to top');
    expect(link.textContent).toBe('Back to top');
    const group = link.parentElement;
    expect(group.querySelector('a[href="/privacy.html"]')).not.toBeNull();
    expect(group.querySelector('a[href="/terms.html"]')).not.toBeNull();
    expect(group.lastElementChild).toBe(link);
  });

  it.each(PAGES)('%s body carries the top anchor', (file) => {
    const doc = english(file);
    expect(doc.body.id).toBe('top');
    expect(doc.querySelectorAll('#top').length).toBe(1);
  });

  it('uses byte-identical back-link markup on every English page', () => {
    const markup = new Set(PAGES.map(f => english(f).querySelector('.mv-back-to-top').outerHTML));
    expect(markup.size).toBe(1);
  });

  it('keeps root index.html footer in sync with website/index.html', () => {
    const rootDoc = load(resolve('index.html'));
    expect(rootDoc.querySelector('.mv-footer-bottom').outerHTML).toBe(english('index.html').querySelector('.mv-footer-bottom').outerHTML);
    expect(rootDoc.body.id).toBe('top');
  });

  it('enables smooth scroll only for pages with the top anchor', () => {
    expect(css).toMatch(/html:has\(body#top\)\s*\{\s*scroll-behavior:smooth;?\s*\}/);
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\s*\{\s*html:has\(body#top\)\s*\{\s*scroll-behavior:auto;?\s*\}\s*\}/);
  });

  it.each(['blog/notion-mail-closing.html'])('leaves %s untouched', (file) => {
    const doc = english(file);
    expect(doc.querySelector('a[href="#top"]')).toBeNull();
    expect(doc.querySelector('body#top')).toBeNull();
  });
});
