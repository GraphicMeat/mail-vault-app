import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

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
