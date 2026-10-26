#!/usr/bin/env node
/** Enhance the existing, authoritative English articles; translations build afterward. */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../website');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, '../package.json'), 'utf8')).version;
// Advance this date after reviewing the documentation, not on every build.
const reviewed = '2026-10-22';
const reviewedLabel = new Intl.DateTimeFormat('en-GB', { day:'numeric', month:'long', year:'numeric', timeZone:'UTC' }).format(new Date(reviewed));
const versionInfo = `<div class="mv-help-version"><div>Version <span translate="no">${version}</span></div><div>Reviewed <time datetime="${reviewed}">${reviewedLabel}</time></div></div>`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const plain = value => new JSDOM(value).window.document.body.textContent.replace(/\s+/g, ' ').trim();
const files = ['faq', 'guides', 'blog'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.html')).map(f => `${dir}/${f}`));
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const mediaFile = path.join(ROOT,'help-media.json');
const helpMedia = fs.existsSync(mediaFile) ? JSON.parse(fs.readFileSync(mediaFile,'utf8')) : null;
// A demonstration must match a task discussed on the page.
const workflowPages = {
  'search-local': [
    'faq/explorer-and-insights.html',
    'blog/cloud-vs-local-email-search.html',
    'blog/how-to-search-thousands-of-emails-fast.html',
    'blog/offline-email-search-for-mac.html',
    'blog/search-50000-emails-in-milliseconds.html',
  ],
  'privacy-mode': ['faq/premium.html'],
  'manual-backup': [
    'docs.html', 'faq.html', 'blog.html',
    'faq/getting-started.html', 'faq/storage-and-vault.html', 'faq/backup-and-restore.html',
    'guides/archive-imap-emails-locally.html',
    'guides/back-up-outlook-com-email-to-mac.html',
    'guides/backup-email-before-closing-account.html',
    'guides/backup-email-linux.html',
    'guides/backup-gmail-to-eml.html',
    'guides/delete-thousands-of-old-emails-safely.html',
    'guides/download-all-emails-mac.html',
    'guides/download-all-gmail-emails.html',
    'guides/email-archiving-for-freelancers.html',
    'guides/email-archiving-for-mac.html',
    'guides/export-icloud-mail.html',
    'guides/export-outlook-to-eml.html',
    'guides/free-up-email-storage.html',
    'guides/free-up-space-hotmail-outlook-com.html',
    'guides/gmail-storage-full.html',
    'guides/imap-backup-tool-checklist.html',
    'guides/keep-emails-after-server-deletion.html',
    'guides/leave-gmail-keep-your-emails.html',
    'guides/linux-email-archive.html',
    'guides/outlook-hotmail-mailbox-full.html',
    'guides/outlook-storage-full-what-to-do.html',
    'guides/what-is-an-email-vault.html',
    'guides/yahoo-mail-backup.html',
    'blog/best-email-archive-app-for-mac.html',
    'blog/best-email-backup-software-for-mac.html',
    'blog/does-archiving-gmail-free-up-space.html',
    'blog/email-provider-not-a-backup.html',
    'blog/how-to-check-email-backup.html',
    'blog/leave-email-provider-safely.html',
    'blog/local-email-storage-vs-cloud-email.html',
    'blog/private-email-archive-for-mac.html',
  ],
};
const entries = files.map(rel => {
  const html = read(rel);
  return { rel, title:plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || rel), description:html.match(/<meta name="description" content="([^"]*)"/)?.[1] || '' };
});
const topics = entries.filter(e => e.rel.startsWith('faq/'));
const order = ['getting-started','storage-and-vault','providers','backup-and-restore','explorer-and-insights','scheduled-send','premium','troubleshooting'];
topics.sort((a,b) => order.indexOf(path.basename(a.rel,'.html')) - order.indexOf(path.basename(b.rel,'.html')));
const questions = topics.flatMap(topic => {
  const document = new JSDOM(read(topic.rel)).window.document;
  return [...document.querySelectorAll('article[id]')].map(article => ({ id:article.id, title:article.querySelector('h2')?.textContent.trim(), rel:`${topic.rel}#${article.id}` })).filter(q => q.title);
});

function sidebar(rel) {
  const link = (href, title, cls = '') => `<a href="${href}"${href === '/' + rel ? ' aria-current="page"' : ''}${cls ? ` class="${cls}"` : ''}>${title}</a>`;
  return `<details class="mv-help-sidebar" open><summary>Help topics</summary><nav aria-label="Help center topics">${link('/docs.html','<img src="/icon-128.webp" width="28" height="28" alt="">MailVault help','mv-help-home')}${topics.map(t => link('/'+t.rel,escape(t.title))).join('')}${link('/docs.html#guides','Practical guides','mv-help-divider')}${link('/docs.html#articles','Articles')}${link('/features.html','Feature reference')}${link('/changelog.html','Release notes')}</nav>${versionInfo}</details>`;
}
function search(hub) {
  if (!hub) return '<form class="mv-help-search" action="/docs.html" method="get" role="search"><label for="help-q">Search documentation, FAQ and articles</label><div class="mv-help-search-row"><input id="help-q" type="search" name="q" placeholder="Search every guide and answer" required><button type="submit">Search</button></div></form>';
  return '<div class="mv-help-search" data-mv-search-container hidden><label for="help-q">Search documentation, FAQ and articles</label><div class="mv-help-search-row"><input id="help-q" type="search" autocomplete="off" data-mv-search data-index="#help-directory" data-results="#help-results" data-empty="#help-empty" data-row=".mv-help-row" data-group=".mv-help-group" placeholder="Search every guide and answer" aria-controls="help-results"><button type="button" data-help-clear>Clear</button></div><p id="help-empty" hidden role="status">Nothing matches. Try a feature name, provider or task.</p></div><div id="help-results" hidden aria-live="polite"></div>';
}
function table(list, caption) {
  return `<table class="mv-help-table"><caption>${caption}</caption><thead><tr><th scope="col">Topic</th><th scope="col">What you will learn</th></tr></thead><tbody>${list.map(e => `<tr class="mv-help-row"><td><a href="/${e.rel}">${escape(e.title)}</a></td><td>${e.description}</td></tr>`).join('')}</tbody></table>`;
}
function hub(rel) {
  const heading = rel === 'faq.html' ? 'FAQ, documentation and articles' : rel === 'blog.html' ? 'Articles and practical guides' : 'MailVault help center';
  // Settings links to FAQ in App Store builds: this entry must stay price-free.
  const resources = rel === 'faq.html'
    ? '<section class="mv-help-group" id="guides"><h2>Practical guides</h2><p><a class="mv-help-row" href="/docs.html#guides">Browse practical guides</a></p></section><section class="mv-help-group" id="articles"><h2>Articles</h2><p><a class="mv-help-row" href="/docs.html#articles">Browse all articles</a></p></section>'
    : `<section class="mv-help-group" id="guides"><span id="backup-guides"></span><h2>Practical guides</h2>${table(entries.filter(e=>e.rel.startsWith('guides/')),'Step-by-step workflows for your mailbox')}</section><section class="mv-help-group" id="articles"><span id="email-client-series"></span><h2>Articles</h2>${table(entries.filter(e=>e.rel.startsWith('blog/')),'Product workflows, comparisons and development notes')}</section>`;
  return `<nav class="mv-help-breadcrumb" aria-label="Breadcrumb"><a href="/">MailVault</a> / Help center</nav><h1>${heading}</h1><p class="mv-lead">Connect your accounts, keep a local copy and find your way around MailVault. Guides, answers and articles in one place.</p>${search(true)}<div id="help-directory" class="mv-help-directory"><section class="mv-help-group" id="topics"><h2>Find your task</h2>${table(topics,'Start with a topic')}</section><section class="mv-help-group" id="questions"><h2>Quick answers</h2><ul id="mv-faq-index" class="mv-help-questions">${questions.map(q => `<li id="${q.id}" class="mv-help-row mv-faq-q"><a href="${q.rel}">${escape(q.title)}</a></li>`).join('')}</ul></section>${resources}</div>`;
}
function demo(rel) {
  if (!helpMedia) return '';
  const name = Object.entries(workflowPages).find(([,pages]) => pages.includes(rel))?.[0];
  if (!name) return '';
  const item = helpMedia.locales.en.workflows[name];
  const attribute = `data-mailvault-version="${helpMedia.version}" data-mailvault-version-kind="capture"`;
  const caption = item.imageAlt.replace(/ · MailVault version \d+\.\d+\.\d+ en$/, '');
  const transcript = Array.isArray(item.transcript) ? item.transcript.join(' ') : item.transcript;
  return `<!-- help-demo:start --><section class="mv-help-demo"><h2>See it in MailVault</h2><figure class="mv-help-media"><a data-help-image aria-haspopup="dialog" href="${item.image}"><img src="${item.image}" width="1440" height="1056" loading="lazy" alt="${escape(item.imageAlt)}" ${attribute}></a><figcaption>${escape(caption)}</figcaption><video controls playsinline preload="none" poster="${item.poster}" aria-label="${escape(item.videoLabel)}" ${attribute}><source src="${item.video}" type="video/mp4"><track kind="captions" src="${item.captions}" srclang="en" label="English" default></video></figure><details class="mv-help-contents"><summary>Video transcript</summary><p>${escape(transcript)}</p></details></section><!-- help-demo:end -->`;
}
function enhanceFigures(html) {
  return html.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, figure => {
    const fragment = JSDOM.fragment(figure);
    const element = fragment.querySelector('figure');
    for (const img of element.querySelectorAll('img')) {
      if (!img.getAttribute('alt')?.trim()) continue;
      let link = img.closest('a,button');
      if (link?.tagName === 'BUTTON') {
        const replacement = fragment.ownerDocument.createElement('a');
        replacement.innerHTML = link.innerHTML;
        replacement.className = link.className;
        link.replaceWith(replacement);
        link = replacement;
      }
      if (!link) {
        link = fragment.ownerDocument.createElement('a');
        const picture = img.closest('picture') || img;
        picture.replaceWith(link);
        link.appendChild(picture);
      }
      link.removeAttribute('data-image');
      link.setAttribute('data-help-image','');
      link.setAttribute('aria-haspopup','dialog');
      const current = link.querySelector('img');
      const capturedVersion = current.getAttribute('data-mailvault-version');
      if (capturedVersion) {
        const reviewed = current.getAttribute('data-mailvault-version-kind') === 'reviewed' ? 'Reviewed for ' : '';
        const label = `${reviewed}MailVault version ${capturedVersion} en`;
        current.alt = current.alt.replace(/ · (?:Reviewed for )?MailVault version \d+\.\d+\.\d+(?: en)?$/, '') + ' · ' + label;
        current.title = label;
        let stamp = link.querySelector('.mv-help-stamp');
        if (!stamp) {
          stamp = fragment.ownerDocument.createElement('span');
          stamp.className = 'mv-help-stamp';
          stamp.setAttribute('translate','no');
          link.appendChild(stamp);
        }
        stamp.setAttribute('aria-hidden','true');
        stamp.textContent = label;
      }
      const largest = current.srcset?.split(',').pop().trim().split(/\s+/)[0];
      link.setAttribute('href',largest || current.getAttribute('src'));
    }
    return element.outerHTML;
  });
}

for (const rel of ['docs.html','faq.html','blog.html',...files]) {
  let html = read(rel)
    .replace(/<!-- help-shell:start -->[\s\S]*?<!-- help-main:start -->\s*/g,'')
    .replace(/<!-- help-main:end -->[\s\S]*?<!-- help-shell:end -->/g,'')
    .replace(/<link rel="stylesheet" href="\/assets\/help-center.css[^>]*>\s*/g,'')
    .replace(/<script defer src="\/assets\/help-center.js[^>]*><\/script>\s*/g,'')
    .replace(/<dialog class="mv-help-lightbox"[\s\S]*?<\/dialog>\s*/g,'');
  const isHub = !rel.includes('/');
  html = html.replace(/<main\b[^>]*>([\s\S]*?)<\/main>/i, (_, original) => {
    const unwrapped = original.replace(/^\s*<div class="mv-help-content">([\s\S]*)<\/div>\s*$/,'$1');
    let content = isHub ? hub(rel) : unwrapped
      .replace(/<!-- help-intro:start -->[\s\S]*?<!-- help-intro:end -->/g,'')
      .replace(/<!-- help-contents:start -->[\s\S]*?<!-- help-contents:end -->/g,'')
      .replace(/<!-- help-version:start -->[\s\S]*?<!-- help-version:end -->/g,'')
      .replace(/<!-- help-demo:start -->[\s\S]*?<!-- help-demo:end -->/g,'');
    if (!isHub) {
      const h2 = [];
      let count = 0;
      content = content.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (tag,attrs,title) => {
        const id = attrs.match(/\bid="([^"]+)"/)?.[1] || `help-section-${++count}`;
        h2.push({ id, title:plain(title) });
        return attrs.includes('id=') ? tag : `<h2${attrs} id="${id}">${title}</h2>`;
      });
      const contents = h2.length > 2 ? `<details class="mv-help-contents" open><summary>On this page</summary><ul>${h2.map(h=>`<li><a href="#${h.id}">${escape(h.title)}</a></li>`).join('')}</ul></details>` : '';
      content = content.replace(/(<h1\b[^>]*>[\s\S]*?<\/h1>)/i, `$1<!-- help-intro:start -->${search(false)}<!-- help-intro:end --><!-- help-contents:start -->${contents}<!-- help-contents:end -->`);
      content = enhanceFigures(content);
    }
    return `<!-- help-shell:start --><div class="mv-wrap mv-help-layout">${sidebar(rel)}<!-- help-main:start --><main id="main" class="mv-help-main"><div class="mv-help-content">${content}${demo(rel)}<!-- help-version:start --><footer class="mv-help-review">${versionInfo}</footer><!-- help-version:end --></div></main><!-- help-main:end --></div><!-- help-shell:end -->`;
  });
  html = html.replace('</head>','<link rel="stylesheet" href="/assets/help-center.css?v=2">\n</head>');
  html = html.replace(/<a\b[^>]*href="\/demo\/[^>]*>/g, tag => tag.includes('aria-label=') ? tag : tag.replace(/>$/, ' aria-label="Open the MailVault demo in a new window">'));
  if (isHub && !html.includes('src="/search.js')) html = html.replace('</body>','<script defer src="/search.js?v=1"></script>\n</body>');
  if (isHub) html = html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,(block,json) => { try { return JSON.parse(json)['@type'] === 'FAQPage' ? '' : block; } catch { return block; } });
  const lightbox = '<dialog class="mv-help-lightbox" aria-label="Product screenshot"><button type="button">Close screenshot</button><p></p></dialog>';
  html = html.replace('</body>',`${lightbox}<script defer src="/assets/help-center.js?v=2"></script>\n</body>`);
  // The existing FAQ hash forwarder still reads the preserved question IDs.
  fs.writeFileSync(path.join(ROOT,rel),html);
}
console.log(`Enhanced ${files.length + 3} help pages for MailVault ${version}.`);
