import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const TOPICS = ['getting-started', 'storage-and-vault', 'providers', 'premium', 'backup-and-restore', 'troubleshooting'];
const hub = () => readFileSync('website/faq.html', 'utf8');
const topic = (t) => readFileSync(`website/faq/${t}.html`, 'utf8');

const questionsIn = (html) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  return m.flatMap((block) => {
    const json = block.replace(/<\/?script[^>]*>/g, '');
    let parsed; try { parsed = JSON.parse(json); } catch { return []; }
    if (parsed['@type'] !== 'FAQPage') return [];
    return (parsed.mainEntity || []).map(q => q.name);
  });
};

describe('FAQ hub and topic pages', () => {
  it('creates all six topic pages', () => {
    for (const t of TOPICS) expect(existsSync(`website/faq/${t}.html`), t).toBe(true);
  });

  it('keeps every one of the 23 original answers, each on exactly one topic page', () => {
    const all = TOPICS.flatMap(t => questionsIn(topic(t)));
    expect(all.length).toBe(23);
    expect(new Set(all).size).toBe(23);
  });

  it('links the hub to every topic and every topic back to the hub', () => {
    for (const t of TOPICS) {
      expect(hub()).toContain(`faq/${t}.html`);
      expect(topic(t)).toMatch(/href="(\.\.\/)?faq\.html"/);
    }
  });

  // The condition on shipping the app's FAQ link ungated in an App Store build:
  // a page that quotes a price is an external purchase path.
  it('quotes no price anywhere in the FAQ', () => {
    for (const t of TOPICS) {
      expect(topic(t), t).not.toMatch(/[$€£]\s?\d/);
    }
    expect(hub()).not.toMatch(/[$€£]\s?\d/);
  });

  it('registers the new directory with the localizer', () => {
    const gen = readFileSync('website/i18n/i18n.mjs', 'utf8');
    expect(gen).toMatch(/PAGE_DIRS = \[[^\]]*'faq'/);
  });

  it('lists the new pages in the sitemap', () => {
    const sitemap = readFileSync('website/sitemap.xml', 'utf8');
    for (const t of TOPICS) expect(sitemap).toContain(`/faq/${t}.html`);
  });
});
