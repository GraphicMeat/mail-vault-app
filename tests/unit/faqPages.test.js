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
    // 23 from the original single-page FAQ, plus every answer added since.
    expect(all.length).toBe(31);
    expect(new Set(all).size).toBe(31);
  });

  // Every answer on a topic page has its row in the hub's index, which the
  // search and the old /faq.html#id deep links both read.
  it('lists the alias and "No internet connection" answers in the hub', () => {
    expect(hub()).toContain('href="faq/providers.html#send-from-an-alias"');
    expect(hub()).toContain('href="faq/troubleshooting.html#no-internet-connection"');
    expect(topic('providers')).toContain('id="send-from-an-alias"');
    expect(topic('troubleshooting')).toContain('id="no-internet-connection"');
    expect(questionsIn(topic('providers'))).toContain('How do I send from an alias?');
    expect(questionsIn(topic('troubleshooting'))).toContain('MailVault says "No internet connection", but my internet works. Why?');
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
