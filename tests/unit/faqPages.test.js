import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { collect, loadDict, LOCALES } from '../../website/i18n/i18n.mjs';
import { buildIndex } from '../../scripts/build-search-index.mjs';

const ORIGINAL_TOPICS = ['getting-started', 'storage-and-vault', 'providers', 'premium', 'backup-and-restore', 'troubleshooting'];
const TOPICS = [...ORIGINAL_TOPICS, 'your-questions'];
const hub = () => readFileSync('website/faq.html', 'utf8');
const topic = (t) => readFileSync(`website/faq/${t}.html`, 'utf8');

const questionsIn = (html) => {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  return m.flatMap((block) => {
    const json = block.replace(/<\/?script[^>]*>/g, '');
    const parsed = JSON.parse(json);
    if (parsed['@type'] !== 'FAQPage') return [];
    return (parsed.mainEntity || []).map(q => q.name);
  });
};

const faqSchema = (html) => [...new JSDOM(html).window.document.querySelectorAll('script[type="application/ld+json"]')]
  .map(script => JSON.parse(script.textContent)).find(item => item['@type'] === 'FAQPage');

const PROVIDER_ANSWER_KEYS = ['70549e28b3f7', '4a4009251ee1', 'edb2a4315dd4',
  'd4488842e423', '728c8ebce436', '81f908ad95bd', '8cd52f58d6ee'];
const PROVIDER_ANSWER_INDEXES = [0, 1, 2, 3, 4, 5, 7];

describe('FAQ hub and topic pages', () => {
  it('creates all required topic pages', () => {
    for (const t of TOPICS) expect(existsSync(`website/faq/${t}.html`), t).toBe(true);
  });

  it('keeps every one of the 23 original answers, each on exactly one topic page', () => {
    const all = ORIGINAL_TOPICS.flatMap(t => questionsIn(topic(t)));
    // 23 from the original single-page FAQ, plus later answers including
    // iCloud, adding an Outlook.com account over IMAP and the phone set-up, across the six original
    // topics; new topics have separate coverage below.
    expect(all.length).toBe(42);
    expect(new Set(all).size).toBe(42);
  });

  it('parses every FAQ JSON-LD block in every locale', () => {
    for (const loc of [{ dir: '' }, ...LOCALES]) {
      for (const name of ORIGINAL_TOPICS) {
        const html = readFileSync(`website/${loc.dir ? `${loc.dir}/` : ''}faq/${name}.html`, 'utf8');
        expect(() => questionsIn(html), `${loc.dir || 'en'}/${name}`).not.toThrow();
        if (name === 'providers') expect(questionsIn(html)).toHaveLength(8);
      }
    }
  });

  it('localizes provider structured answers', () => {
    const english = faqSchema(topic('providers')).mainEntity;
    for (const loc of LOCALES) {
      const translated = faqSchema(readFileSync(`website/${loc.dir}/faq/providers.html`, 'utf8')).mainEntity;
      const dict = loadDict(loc);
      for (const [position, key] of PROVIDER_ANSWER_KEYS.entries()) {
        const answer = translated[PROVIDER_ANSWER_INDEXES[position]].acceptedAnswer.text;
        expect(dict[key], `${loc.dir}: ${key}`).toBeTruthy();
        expect(answer, `${loc.dir}: ${key}`).toBe(dict[key]);
        expect(answer, `${loc.dir}: ${key}`).not.toBe(english[PROVIDER_ANSWER_INDEXES[position]].acceptedAnswer.text);
      }
    }
  });

  // MailVault links here when Outlook.com refuses an IMAP session because
  // "Let devices and apps use IMAP" is off; the Outlook.com setup answer points here too.
  it('answers the Outlook.com "User is authenticated but not connected" refusal and links to it', () => {
    const id = 'outlook-imap-not-connected';
    const question = 'MailVault says Outlook refused IMAP ("User is authenticated but not connected"). How do I fix it?';
    expect(hub()).toContain(`href="faq/troubleshooting.html#${id}"`);
    expect(topic('troubleshooting')).toContain(`id="${id}"`);
    expect(questionsIn(topic('troubleshooting'))).toContain(question);
    const settings = 'https://outlook.live.com/mail/options/mail/forwarding';
    const shot = '/assets/help/outlook-imap-setting.webp';
    for (const loc of [{ dir: '' }, ...LOCALES]) {
      const prefix = loc.dir ? `${loc.dir}/` : '';
      const doc = new JSDOM(readFileSync(`website/${prefix}faq/troubleshooting.html`, 'utf8')).window.document;
      const article = doc.getElementById(id);
      expect(article, `${loc.dir || 'en'} article`).toBeTruthy();
      const link = article.querySelector(`a[href="${settings}"]`);
      expect(link, `${loc.dir || 'en'} settings link`).toBeTruthy();
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      const img = article.querySelector(`img[src="${shot}"]`);
      expect(img, `${loc.dir || 'en'} screenshot`).toBeTruthy();
      expect(img.getAttribute('alt').length).toBeGreaterThan(20);
      expect(article.textContent).toContain('User is authenticated but not connected.');
      const providers = new JSDOM(readFileSync(`website/${prefix}faq/providers.html`, 'utf8')).window.document;
      expect(providers.querySelector(`#microsoft-outlook-oauth2 a[href="/${prefix}faq/troubleshooting.html#${id}"]`),
        `${loc.dir || 'en'} providers link`).toBeTruthy();
      // Outlook.com IMAP works once the setting is on: no answer may still blame a 2024 Microsoft problem.
      const providersHtml = readFileSync(`website/${prefix}faq/providers.html`, 'utf8');
      expect(providersHtml, `${loc.dir || 'en'} providers`).not.toMatch(/2024/);
      expect(questionsIn(providersHtml).length).toBeGreaterThan(0);
      // The dated engineering post keeps its history but carries a note pointing here.
      expect(readFileSync(`website/${prefix}blog/outlook-oauth-odyssey.html`, 'utf8'),
        `${loc.dir || 'en'} odyssey update note`).toContain(`href="/${prefix}faq/troubleshooting.html#${id}"`);
      if (loc.dir) {
        const dict = loadDict(loc);
        // Raw source slices, not a DOM re-serialization: the keys hash entities such as &rarr; as written.
        const slice = (html, articleId) => html.match(new RegExp(`<article id="${articleId}"[\\s\\S]*?</article>`))[0];
        for (const html of [slice(topic('troubleshooting'), id), slice(topic('providers'), 'microsoft-outlook-oauth2')]) {
          for (const entry of collect(html)) expect(dict[entry.key], `${loc.dir}: ${entry.text}`).toBeTruthy();
        }
        expect(questionsIn(doc.documentElement.outerHTML)).not.toContain(question);
      }
    }
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
      // search-index.json is gitignored and written at deploy: build the same content here.
      const index = JSON.stringify(buildIndex(`website/${prefix}`));
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
