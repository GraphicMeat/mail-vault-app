import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { collect, loadDict, LOCALES } from '../../website/i18n/i18n.mjs';

const ORIGINAL_TOPICS = ['getting-started', 'storage-and-vault', 'providers', 'premium', 'backup-and-restore', 'troubleshooting'];
const TOPICS = [...ORIGINAL_TOPICS, 'your-questions'];
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
  it('creates all required topic pages', () => {
    for (const t of TOPICS) expect(existsSync(`website/faq/${t}.html`), t).toBe(true);
  });

  it('keeps every one of the 23 original answers, each on exactly one topic page', () => {
    const all = ORIGINAL_TOPICS.flatMap(t => questionsIn(topic(t)));
    // 23 from the original single-page FAQ, plus later answers including
    // iCloud across the six original topics; new topics have separate coverage below.
    expect(all.length).toBe(39);
    expect(new Set(all).size).toBe(39);
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

  it('publishes all three new answers with matching visible and structured text in every language', () => {
    const source = topic('your-questions');
    for (const loc of [{ dir: '' }, ...LOCALES]) {
      const prefix = loc.dir ? `${loc.dir}/` : '';
      const html = readFileSync(`website/${prefix}faq/your-questions.html`, 'utf8');
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      expect(doc.querySelectorAll('article[id]')).toHaveLength(3);
      const schema = [...doc.querySelectorAll('script[type="application/ld+json"]')]
        .map(script => JSON.parse(script.textContent)).find(item => item['@type'] === 'FAQPage');
      expect(schema.mainEntity).toHaveLength(3);
      for (const [i, article] of [...doc.querySelectorAll('article[id]')].entries()) {
        expect(article.querySelector('h2').textContent).toBe(schema.mainEntity[i].name);
        expect(article.querySelector('p').textContent).toBe(schema.mainEntity[i].acceptedAnswer.text);
      }
      expect(html).toContain(`href="/${prefix}pricing.html"`);
      expect(html).not.toMatch(/[$€£]\s?\d/);
      expect(html).not.toMatch(/bytemail/i);
      const localHub = readFileSync(`website/${prefix}faq.html`, 'utf8');
      expect(localHub).toContain(`faq/your-questions.html#lifetime-purchase`);
      expect(localHub).not.toMatch(/bytemail/i);
      const index = readFileSync(`website/${prefix}search-index.json`, 'utf8');
      expect(index).toContain('faq/your-questions.html');
      expect(index).not.toMatch(/bytemail/i);
      dom.window.close();
      if (loc.dir) {
        const dict = loadDict(loc);
        for (const entry of collect(source)) expect(dict[entry.key], `${loc.dir}: ${entry.text}`).toBeTruthy();
        expect(questionsIn(html)).not.toContain('Can I use MailVault without a subscription?');
      }
    }
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
