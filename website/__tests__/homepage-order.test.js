import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// The locale homepages are built from the English homepage (its layout is tested in
// homepage-clips-layout.test.js): same sections in the same order, the same cards and
// clips, the hero lead and price lines translated.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const load = (file) => new JSDOM(readFileSync(file, 'utf8')).window.document;
const en = load('website/index.html');
const ids = (doc) => [...doc.querySelectorAll('main section[id]')].map((s) => s.id);
const classes = (nodes) => [...nodes].map((n) => n.className);

describe.each(LOCALES)('%s homepage', (l) => {
  const doc = load(`website/${l}/index.html`);

  it('has the English sections in the English order', () => {
    expect(ids(doc)).toEqual(ids(en));
  });

  it('has the same hero parts, key points and clip cards', () => {
    expect(classes(doc.querySelectorAll('.hm-hero-side > *'))).toEqual(classes(en.querySelectorAll('.hm-hero-side > *')));
    expect(doc.querySelectorAll('.hm-key-icon').length).toBe(en.querySelectorAll('.hm-key-icon').length);
    expect([...doc.querySelectorAll('figure.mv-clip')].map((f) => f.dataset.clip))
      .toEqual([...en.querySelectorAll('figure.mv-clip')].map((f) => f.dataset.clip));
  });

  it('has one primary download in the static hero and keeps the early-bird price template', () => {
    expect(doc.querySelectorAll('.hm-hero .mv-button[data-download]').length).toBe(en.querySelectorAll('.hm-hero .mv-button[data-download]').length);
    for (const sel of ['.hm-hero [data-mv-price="{yearly}"]', '#download [data-mv-price="{yearly}"]']) {
      expect(doc.querySelector(sel), sel).not.toBeNull();
    }
  });

  it('translates the free offer, the plan names and the clip captions', () => {
    for (const sel of ['.hm-offer-free-title', '.hm-offer-free-line', '.hm-offer-plan[data-plan="yearly"] dt', '.hm-offer-more']) {
      expect(doc.querySelector(sel).textContent, sel).not.toBe(en.querySelector(sel).textContent);
    }
    const caps = (d) => [...d.querySelectorAll('.hm-clip-group figcaption')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
    caps(en).forEach((c, i) => expect(caps(doc)[i], `caption ${i}`).not.toBe(c));
  });
});
