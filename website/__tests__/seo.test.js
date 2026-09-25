import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { sourcePages } from '../i18n/i18n.mjs';

const root = resolve('website');
const doc = (rel) => new JSDOM(readFileSync(resolve(root, rel), 'utf8')).window.document;
const app = (d) => [...d.querySelectorAll('script[type="application/ld+json"]')]
  .map((s) => JSON.parse(s.textContent))
  .find((j) => j['@type'] === 'SoftwareApplication');

describe('structured data', () => {
  it.each(['index.html', 'de/index.html', 'ja/index.html'])('%s describes the app the page shows', (rel) => {
    const d = doc(rel);
    const ld = app(d);
    expect(ld.operatingSystem).toBe('macOS, Windows, Linux');
    expect(ld.applicationCategory).toBe('CommunicationApplication');
    // One description for people and machines: the meta description, translated with it.
    expect(ld.description).toBe(d.querySelector('meta[name="description"]').content);
    expect(ld.featureList.some((f) => /Windows/.test(f))).toBe(true);
  });

  it('keeps the root copy of the homepage identical', () => {
    expect(readFileSync('index.html', 'utf8')).toBe(readFileSync(resolve(root, 'index.html'), 'utf8'));
  });
});

describe('llms.txt', () => {
  const file = resolve(root, 'llms.txt');

  it('exists and follows the llmstxt.org shape', () => {
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# MailVault\n')).toBe(true);
    expect(text).toMatch(/^> .+/m);
    expect(text).toMatch(/^## /m);
  });

  it('links only to pages that exist', () => {
    const text = readFileSync(file, 'utf8');
    for (const [, url] of text.matchAll(/\]\((https:\/\/mailvaultapp\.com[^)]*)\)/g)) {
      const p = new URL(url).pathname;
      if (p.startsWith('/demo/')) continue; // built only in the deploy
      expect(existsSync(resolve(root, '.' + (p.endsWith('/') ? p + 'index.html' : p))), url).toBe(true);
    }
  });
});

describe('404 page', () => {
  it.each(['404.html', 'de/404.html'])('%s is noindex and works from any path', (rel) => {
    const d = doc(rel);
    expect(d.querySelector('meta[name="robots"]').content).toMatch(/noindex/);
    expect(d.querySelector('link[rel="canonical"]')).toBeNull();
    expect(d.querySelector('a[href="/"], a[href="/de/"]')).not.toBeNull();
    // Served at whatever URL was missing, so a relative URL resolves somewhere random.
    for (const el of d.querySelectorAll('[href], [src]')) {
      const v = el.getAttribute('href') ?? el.getAttribute('src');
      expect(/^(\/|#|https?:|mailto:)/.test(v), `${rel}: ${v}`).toBe(true);
    }
  });
});

describe('sitemap', () => {
  const xml = readFileSync(resolve(root, 'sitemap.xml'), 'utf8');
  const locs = new Set([...xml.matchAll(/<loc>https:\/\/mailvaultapp\.com([^<]*)<\/loc>/g)].map((m) => m[1]));
  const noindex = (rel) => /<meta name="robots" content="noindex/.test(readFileSync(resolve(root, rel), 'utf8'));
  const url = (rel) => (rel === 'index.html' ? '/' : '/' + rel);

  it('lists every indexable page and no noindex page', () => {
    for (const rel of [...sourcePages(), 'changelog.html', 'privacy.html', 'terms.html']) {
      expect(locs.has(url(rel)), rel).toBe(!noindex(rel));
    }
    expect(locs.has('/de/features/tags.html')).toBe(true);
    expect(locs.has('/404.html')).toBe(false);
  });

  it('dates every entry', () => {
    const entries = xml.match(/<url>[\s\S]*?<\/url>/g);
    for (const e of entries) expect(e, e.slice(0, 80)).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });
});
