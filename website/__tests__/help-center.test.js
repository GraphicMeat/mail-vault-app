import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { LOCALES, render, keyOf } from '../i18n/i18n.mjs';
import { tagMedia, validateMedia } from '../../scripts/website-media-policy.mjs';

describe('help center navigation', () => {
  it('makes FAQ, guides and articles available from one accessible directory', () => {
    const document = new JSDOM(readFileSync('website/docs.html', 'utf8')).window.document;
    const navigation = document.querySelector('.mv-help-sidebar nav');
    expect(navigation, 'shared topic navigation').not.toBeNull();
    for (const href of ['/faq/getting-started.html', '/faq/storage-and-vault.html', '/docs.html#guides', '/docs.html#articles']) {
      expect(navigation.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
    expect(document.querySelector('#help-directory a[href="/blog/find-emails-you-havent-replied-to.html"]')).not.toBeNull();
    expect(document.querySelector('#help-directory a[href="/guides/backup-gmail-to-eml.html"]')).not.toBeNull();
  });

  it('localizes help recordings, tracks and capture language without translating provenance', () => {
    const html = '<video data-mailvault-version="2.20.0" data-mailvault-version-kind="capture" aria-label="Search saved email · MailVault version 2.20.0 en" poster="/assets/help-media/en/search-local.jpg"><source src="/assets/help-media/en/search-local.mp4"><track src="/assets/help-media/en/search-local.vtt" srclang="en" label="English"></video>';
    const out = render(html, 'docs.html', LOCALES[0], { [keyOf('Search saved email')]: 'Gespeicherte E-Mails durchsuchen' });
    const video = new JSDOM(out).window.document.querySelector('video');
    expect(video.getAttribute('aria-label')).toBe('Gespeicherte E-Mails durchsuchen · MailVault version 2.20.0 de');
    expect(video.querySelector('source').src).toBe('/assets/help-media/de/search-local.mp4');
    expect(video.querySelector('track').src).toBe('/assets/help-media/de/search-local.vtt');
    expect(video.querySelector('track').srclang).toBe('de');
  });

  it('preserves the verified capture language when tagging new help screenshots', () => {
    const records = [{ version:'2.20.0', locale:'en', assets:['/assets/help-media/en/search-local'] }];
    const out = tagMedia('<img src="/assets/help-media/en/search-local.webp" alt="Search saved email">', records).html;
    expect(new JSDOM(out).window.document.querySelector('img').alt).toBe('Search saved email · MailVault version 2.20.0 en');
    expect(validateMedia(out, records)).toEqual([]);
  });

  it('shows the search controls only when the search script is available', () => {
    const dom = new JSDOM(readFileSync('website/docs.html','utf8'), { runScripts:'outside-only' });
    const search = dom.window.document.querySelector('.mv-help-search');
    expect(search.hidden).toBe(true);
    dom.window.eval(readFileSync('website/search.js','utf8'));
    expect(search.hidden).toBe(false);
  });

  it('keeps bookmarked guide and comparison fragment destinations', () => {
    for (const [file,fragment] of [['docs.html','backup-guides'],['blog.html','backup-guides'],['blog.html','email-client-series']]) {
      const document = new JSDOM(readFileSync('website/'+file,'utf8')).window.document;
      expect(document.getElementById(fragment), `${file}#${fragment}`).not.toBeNull();
    }
  });

  it('shows workflow demonstrations only on relevant help pages', () => {
    for (const file of ['faq/scheduled-send.html','blog/email-templates-for-client-replies.html']) {
      const document = new JSDOM(readFileSync('website/'+file,'utf8')).window.document;
      expect(!!document.querySelector('.mv-help-demo'), file).toBe(false);
    }
    const document = new JSDOM(readFileSync('website/faq/backup-and-restore.html','utf8')).window.document;
    expect(document.querySelector('.mv-help-demo video source')?.getAttribute('src')).toBe('/assets/help-media/en/manual-backup.mp4');
  });
});

describe('help center in-place navigation', () => {
  const script = readFileSync('website/assets/help-center.js', 'utf8');
  const page = (slug, { title = slug, layout = true, lang = 'en', hub = false } = {}) => `<!doctype html><html lang="${lang}"><head><title>${title} — FAQ</title>
<meta name="description" content="About ${slug}"><link rel="canonical" href="https://mailvaultapp.com/faq/${slug}.html">
<link rel="alternate" hreflang="de" href="https://mailvaultapp.com/de/faq/${slug}.html">
<link rel="stylesheet" href="/assets/tailwind.css?v=11">
<script type="application/ld+json">{"@type":"FAQPage","name":"${slug}"}</script></head>
<body class="mv-site"><header><div class="mv-language"><a hreflang="de" href="/de/faq/${slug}.html">DE</a></div></header>
${layout ? `<div class="mv-wrap mv-help-layout"><details class="mv-help-sidebar" open><nav>
<a href="/faq/one.html">One</a><a href="/faq/two.html">Two</a><a href="/faq.html">Hub</a><a href="https://example.com/x.html">Out</a><a href="#top">Top</a></nav></details>
<main class="mv-help-main">${hub ? '<div data-mv-search-container></div>' : ''}<h1>${title}</h1><section id="part">Body of ${slug}</section></main></div>` : '<main>No layout</main>'}
</body></html>`;

  const boot = async (pages, { url = 'https://mailvaultapp.com/faq/one.html' } = {}) => {
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    const requests = [];
    const dom = new JSDOM(pages[new URL(url).pathname], { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
    const { window } = dom;
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    window.scrollTo = () => {};
    window.Element.prototype.scrollIntoView = function () { window.__scrolledTo = this.id; };
    window.fetch = async (path) => {
      requests.push(path);
      const body = pages[path];
      return body ? { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body } : { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
    };
    window.eval(script);
    const click = async (selector, init = {}) => {
      const link = window.document.querySelector(selector);
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      link.dispatchEvent(event);
      for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
      return event;
    };
    return { window, document: window.document, click, requests, errors };
  };

  it('swaps the layout and page metadata without leaving the document', async () => {
    const pages = { '/faq/one.html': page('one'), '/faq/two.html': page('two', { title: 'Second' }) };
    const { window, document, click } = await boot(pages);
    document.body.dataset.sameDocument = 'yes';
    const event = await click('a[href="/faq/two.html"]');
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.dataset.sameDocument).toBe('yes');
    expect(window.location.pathname).toBe('/faq/two.html');
    expect(document.querySelector('h1').textContent).toBe('Second');
    expect(document.title).toBe('Second — FAQ');
    expect(document.querySelector('link[rel="canonical"]').href).toBe('https://mailvaultapp.com/faq/two.html');
    expect(document.querySelector('meta[name="description"]').content).toBe('About two');
    expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
    expect(JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent).name).toBe('two');
    expect(document.querySelector('.mv-language a').getAttribute('href')).toBe('/de/faq/two.html');
    expect(document.querySelector('link[rel="alternate"][hreflang="de"]').href).toBe('https://mailvaultapp.com/de/faq/two.html');
    expect(window.history.length).toBe(2);
    expect(document.activeElement.tagName).toBe('H1');
  });

  it('follows back and forward through the loaded articles', async () => {
    const pages = { '/faq/one.html': page('one'), '/faq/two.html': page('two') };
    const { window, document, click } = await boot(pages);
    await click('a[href="/faq/two.html"]');
    window.history.back();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(window.location.pathname).toBe('/faq/one.html');
    expect(document.querySelector('h1').textContent).toBe('one');
    window.history.forward();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('h1').textContent).toBe('two');
  });

  it('leaves hubs, external links, hash links and modified clicks to the browser', async () => {
    const pages = { '/faq/one.html': page('one'), '/faq/two.html': page('two'), '/faq.html': page('hub', { hub: true }) };
    const { document, click, requests } = await boot(pages);
    for (const [selector, init] of [['a[href="/faq.html"]', {}], ['a[href^="https://example.com"]', {}], ['a[href="#top"]', {}], ['a[href="/faq/two.html"]', { ctrlKey: true }], ['a[href="/faq/two.html"]', { button: 1 }]]) {
      const event = await click(selector, init);
      expect(event.defaultPrevented, selector).toBe(false);
    }
    expect(document.querySelector('h1').textContent).toBe('one');
    expect(requests).toEqual([]);
  });

  it('falls back to a normal navigation when the next page cannot be swapped in', async () => {
    const pages = {
      '/faq/one.html': page('one'), '/faq/bare.html': page('bare', { layout: false }), '/faq/search.html': page('s', { hub: true }),
      '/faq/other-language.html': page('x', { lang: 'de' }),
    };
    for (const slug of ['bare', 'search', 'other-language', 'missing']) {
      const { document, click, errors } = await boot(pages);
      document.querySelector('nav').insertAdjacentHTML('beforeend', `<a id="t" href="/faq/${slug}.html">t</a>`);
      const event = await click('#t');
      expect(event.defaultPrevented, slug).toBe(true);
      expect(document.querySelector('h1').textContent, slug).toBe('one');
      expect(errors.some(message => /navigation/i.test(message)), slug).toBe(true);
    }
  });

  it('scrolls to a hash target after the swap', async () => {
    const pages = { '/faq/one.html': page('one'), '/faq/two.html': page('two') };
    const { window, document, click } = await boot(pages);
    document.querySelector('nav').insertAdjacentHTML('beforeend', '<a id="deep" href="/faq/two.html#part">deep</a>');
    await click('#deep');
    expect(window.location.hash).toBe('#part');
    expect(window.__scrolledTo).toBe('part');
  });
});

