import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { LOCALES, render, keyOf } from '../../website/i18n/i18n.mjs';
import { cacheControlForPath, retainedDemoAssets, shouldRetainDemoAsset } from '../../scripts/website-release.mjs';

const root = resolve('website');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function englishPages(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory() && !['api', 'assets', 'demo', 'i18n', 'node_modules', 'screenshots'].includes(entry.name)) {
      return englishPages(file);
    }
    if (entry.isFile() && entry.name.endsWith('.html') && /<html[^>]*lang="en"/.test(readFileSync(file, 'utf8'))) {
      return [file];
    }
    return [];
  });
}

describe('homepage demo launcher', () => {
  it('uses a separate-window live demo image with no app preload', () => {
    const html = read('index.html');
    const dom = new JSDOM(html);
    const image = dom.window.document.querySelector('.mv-hero-product .mv-shot');
    expect(image?.tagName).toBe('A');
    expect(image?.getAttribute('href')).toBe('/demo/?lang=en');
    expect(image?.getAttribute('target')).toBe('_blank');
    expect(image?.getAttribute('rel')).toContain('noopener');
    expect(image?.getAttribute('aria-label')).toBe('Open the demo in a new window');
    expect(image?.querySelectorAll('a')).toHaveLength(0);
    expect(image?.querySelector('.mv-demo-badge')?.textContent).toBe('Interactive demo');
    expect(image?.querySelector('.mv-demo-launch')?.textContent).toContain('Open the demo');
    expect(image?.querySelector('img')?.getAttribute('alt')).toMatch(/inbox/i);
    expect(dom.window.document.querySelector('.mv-hero .mv-actions a')?.getAttribute('href')).toBe('/demo/?lang=en');
    expect(dom.window.document.querySelector('.mv-hero .mv-actions a')?.getAttribute('aria-label')).toBe('Try the live demo in a new window');
    expect(dom.window.document.querySelector('#hero-download')?.className).toContain('mv-secondary');
    expect(html).not.toContain('See how it works');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('A real inbox. Ready to explore.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('Search mail, switch views, and try archiving.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('3 accounts · 300 sample emails');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption')?.textContent).toContain('No signup. No installation.');
    expect(dom.window.document.querySelector('.mv-hero-product figcaption a')).toBeNull();
    expect(html).not.toMatch(/<iframe[^>]+demo|<(?:link|script)[^>]+(?:prefetch|preload|modulepreload)[^>]+demo|<script[^>]+\/demo\/assets\//i);
  });
});

describe('demo navigation and locale handoff', () => {
  it('makes every English demo link a named separate-window handoff', () => {
    const links = englishPages().flatMap((file) => Array.from(new JSDOM(readFileSync(file, 'utf8')).window.document.querySelectorAll('a[href^="/demo/"]')));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe('/demo/?lang=en');
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(link.getAttribute('aria-label')).toMatch(/new window/i);
    }
  });

  it.each(LOCALES)('renders the app locale code for $dir', (locale) => {
    const source = '<a href="/demo/?lang=en" target="_blank" rel="noopener" aria-label="Open the MailVault demo in a new window">Try the demo</a>';
    const output = render(source, 'index.html', locale, {});
    expect(output).toContain(`/demo/?lang=${locale.app}`);
  });

  it.each(LOCALES)('localizes captured preview assets for $dir', (locale) => {
    const source = '<img src="/demo/assets/demo-preview-en-light-wide-abc123456789.webp" srcset="/demo/assets/demo-preview-en-light-compact-abc123456789.webp 720w">';
    const output = render(source, 'index.html', locale, {});
    const manifest = JSON.parse(readFileSync(resolve(root, 'demo-preview-manifest.json'), 'utf8'));
    expect(output).toContain(`/demo/assets/${manifest[`${locale.dir}-light-wide`]}`);
    expect(output).toContain(`/demo/assets/${manifest[`${locale.dir}-light-compact`]}`);
  });

  it.each(LOCALES)('ships the localized homepage handoff for $dir', (locale) => {
    const html = read(`${locale.dir}/index.html`);
    const link = new JSDOM(html).window.document.querySelector('.mv-demo-card .mv-shot');
    expect(link?.getAttribute('href')).toBe(`/demo/?lang=${locale.app}`);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(html).toContain('mv-demo-caption');
  });
});

describe('static cache policy', () => {
  it('caches hashed demo assets for seven days and validates HTML', () => {
    expect(cacheControlForPath('/demo/assets/index-abc123.js')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/assets/index-abc123.js?v=1')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/assets/index-abc123.css')).toBe('public, max-age=604800, immutable');
    expect(cacheControlForPath('/demo/index.html')).toBe('no-cache');
    expect(cacheControlForPath('/demo/')).toBe('no-cache');
    expect(cacheControlForPath('/index.html')).toBe('no-cache');
  });

  it('retains hashed demo assets through the eight-day grace window', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/assets/index-abc123.js', now - 8 * 86400000, now)).toBe(true);
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/assets/index-abc123.js', now - 8 * 86400000 - 1, now)).toBe(false);
    expect(shouldRetainDemoAsset('/var/www/mailvaultapp/demo/index.html', now - 99 * 86400000, now)).toBe(false);
  });

  it('retains active old chunks and ages retired chunks from retirement', () => {
    const now = Date.parse('2026-09-12T00:00:00Z');
    const active = '/demo/assets/shared-old-abc123.js';
    const retired = '/demo/assets/retired-old-def456.js';
    const expired = '/demo/assets/expired-old-ghi789.js';
    const keep = retainedDemoAssets({
      current: [active],
      previous: [active, retired, expired],
      retiredAt: { [retired]: now - 7 * 86400000, [expired]: now - 9 * 86400000 },
      nowMs: now,
    });
    expect(keep).toEqual(new Set([active, retired]));
  });

  it('keeps deployment retention and cache policy coupled to the workflow', () => {
    const workflow = readFileSync('.github/workflows/deploy-website.yml', 'utf8');
    expect(workflow).toContain("--exclude='demo/assets/'");
    expect(workflow).toContain('Cache-Control \\\"public, max-age=604800, immutable\\\"');
    expect(workflow).toContain('Cache-Control \\\"no-cache\\\"');
    expect(workflow).toContain('mmin +11520');
    expect(workflow).toContain('grep -Fxq "$name" "$MANIFEST"');
  });
});

it('keeps the homepage demo handoff source strings in the corpus', () => {
  const corpus = JSON.parse(readFileSync(resolve(root, 'i18n/corpus.json'), 'utf8'));
  const strings = Object.values(corpus).flatMap((chunk) => Object.entries(chunk));
  for (const text of ['A real inbox. Ready to explore.', 'Search mail, switch views, and try archiving.', 'Interactive demo', 'Open the demo', 'Open the demo in a new window', 'Try the live demo in a new window', '3 accounts · 300 sample emails', 'No signup. No installation.', 'Try the live demo ↗']) {
    expect(strings).toContainEqual([keyOf(text), text]);
  }
});
