#!/usr/bin/env node
// Static editorial pages: edit the source copy in content/email-client-reviews.json,
// then run node scripts/generate-email-client-reviews.mjs. No app/build dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'website');
const assets = '/assets/blog/email-client-reviews/';
const date = '2026-10-02';
const origin = 'https://mailvaultapp.com';
const articles = JSON.parse(readFileSync(resolve(root, 'scripts/content/email-client-reviews.json'), 'utf8'));
const images = JSON.parse(readFileSync(resolve(site, `.${assets}image-sources.json`), 'utf8'));
const template = readFileSync(resolve(site, 'blog/cloud-vs-local-email-search.html'), 'utf8');
const header = template.match(/<header class="mv-header">[\s\S]*?<\/header>/)[0];
const footer = template.slice(template.indexOf('  <aside class="mv-studio"'));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
const source = (href, label = 'Official guidance') => `<span class="mv-review-source">${link(href, label)} ↗</span>`;
const paragraph = (copy, href) => `<p>${esc(copy)}${href ? ` ${source(href)}` : ''}</p>`;
const h2 = (id, title) => `<h2 id="${id}">${esc(title)}</h2>`;
function figure(file, alt, caption, sourceUrl, extraClass = '') {
  const image = images.find(i => i.file === file);
  return `<figure class="mv-review-figure ${extraClass}"><a href="${assets}${file}" aria-label="${esc(`Open full-size image: ${alt}`)}"><img src="${assets}${file}" width="${image?.width || 1200}" height="${image?.height || 630}" loading="lazy" decoding="async" alt="${esc(alt)}"></a><figcaption>${esc(caption)}${sourceUrl ? ` ${source(sourceUrl, 'Image source')}` : ''}</figcaption></figure>`;
}
function wrap(copy, limit = 35) {
  const lines = [''];
  for (const word of copy.split(' ')) {
    if ((lines.at(-1) + word).length > limit) lines.push('');
    lines[lines.length - 1] += `${lines.at(-1) ? ' ' : ''}${word}`;
  }
  return lines;
}
function graphic(d) {
  const panel = (x, title, rows, accent) => `<rect x="${x}" y="180" width="530" height="348" rx="20" fill="${accent ? '#ece9ff' : '#fff'}" stroke="${accent ? '#bdb2ee' : '#d9d7cd'}"/><text x="${x + 30}" y="231" font-size="31" font-weight="700" fill="#24222b">${esc(title)}</text>${rows.map((row, i) => `<circle cx="${x + 37}" cy="${288 + i * 80}" r="16" fill="${accent ? '#6950b0' : '#333644'}"/><text x="${x + 37}" y="${294 + i * 80}" text-anchor="middle" font-size="18" fill="#fff">${i + 1}</text><text x="${x + 68}" y="${287 + i * 80}" font-size="22" fill="#35313f">${wrap(row).map((l, j) => `<tspan x="${x + 68}" dy="${j ? 28 : 0}">${esc(l)}</tspan>`).join('')}</text>`).join('')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc"><title id="title">${esc(d.name)} and MailVault: two approaches</title><desc id="desc">MailVault: read and reply, save original messages as .eml, and search saved mail offline. ${esc(d.name)}: ${esc(d.graphic.join('; '))}. Editorial comparison, not a measured score.</desc><rect width="1200" height="630" fill="#f5f4ef"/><g font-family="Inter, Arial, sans-serif"><text x="50" y="54" font-size="18" font-weight="700" letter-spacing="3" fill="#6950b0">MAILVAULT / EMAIL CLIENT GUIDE</text><text x="50" y="110" font-size="40" font-weight="700" fill="#24222b">${esc(d.name)} vs MailVault</text><text x="50" y="149" font-size="22" fill="#65616d">Choose around the job you need your email to do.</text>${panel(50, 'MailVault', ['Read + reply in your client', 'Save original mail as .eml', 'Search your saved mail offline'], true)}${panel(620, d.name, d.graphic, false)}<text x="50" y="577" font-size="19" fill="#65616d">Winner for local email ownership: MailVault</text><text x="50" y="607" font-size="16" fill="#65616d">Editorial recommendation by MailVault’s makers · Sources checked October 2, 2026 · No benchmark scores</text></g></svg>`;
}
function comparison(d) {
  const rows = [
    ['Recommended use', 'Daily email with local ownership and a portable archive', d.fit],
    ['Platforms', 'macOS, Windows, Linux desktop', d.platform],
    ['Accounts', 'Existing Gmail, Microsoft, and IMAP accounts; verify workplace access', d.account],
    ['Archive / recovery', 'Saved .eml originals; free manual backups; Premium scheduling and snapshots', d.archivePath],
    ['AI approach', 'On-device writing/summaries on supported setups; optional compatible endpoints; Gmail mail stays on-device', d.aiPath],
    ['Pricing', 'Free core client and manual backups; Premium $4/month or $25/year', d.price],
  ];
  return `<div class="mv-review-table-wrap" role="region" aria-label="${esc(d.name)} and MailVault comparison" tabindex="0"><table class="mv-review-table"><caption>${esc(d.name)} vs MailVault at a glance</caption><thead><tr><th scope="col">What matters</th><th scope="col">MailVault — our winner</th><th scope="col">${esc(d.name)}</th></tr></thead><tbody>${rows.map(([label, a, b]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table></div><p class="mv-review-small">This table describes workflows, not measured scores. ${link('/pricing.html', 'MailVault plan details')} · ${link(d.priceSource, `${d.name} plan details`)}. Prices are in USD where shown; tax, location, promotions, and feature availability can change.</p>`;
}
function related(d) {
  return `<nav class="mv-review-series" aria-label="Email client review series"><h2 id="series">Explore all ten reviews</h2>${['Email clients', 'AI email clients'].map(category => `<h3>${category}</h3><ul>${articles.filter(a => a.category === category).map(a => `<li>${a.slug === d.slug ? `<span aria-current="page">${esc(a.name)} — this review</span>` : link(`/blog/${a.slug}.html`, `${a.name} review`)}</li>`).join('')}</ul>`).join('')}</nav>`;
}
for (const d of articles) {
  const url = `${origin}/blog/${d.slug}.html`;
  writeFileSync(resolve(site, `.${assets}${d.image}-comparison.svg`), graphic(d));
  const vendorImage = images.find(i => i.file === `${d.image}.webp`);
  const body = `${paragraph(d.intro)}
<aside class="mv-review-pick" aria-label="Our recommendation"><p class="mv-eyebrow">Comparison winner for local email ownership</p><h2>MailVault</h2><p>Read and reply. Keep portable originals. Search saved mail offline. Add on-device AI on a supported setup.</p><a class="mv-button" href="/get-started.html?plan=free">Try MailVault free</a></aside>
<details class="mv-review-method"><summary>About this comparison</summary><p>Written by MailVault’s makers. We recommend MailVault for local ownership, portable archives, and on-device AI options. Alternative features and prices are based on linked official documentation checked October 2, 2026. These are editorial evaluations, not independent hands-on benchmarks. Vendor images are credited product screenshots or illustrations; MailVault images use demo data.</p></details>
<nav class="mv-review-toc" aria-label="In this review"><a href="#strengths">Strengths</a><a href="#limitations">Tradeoffs</a><a href="#comparison">Comparison</a><a href="#mailvault">Why MailVault</a><a href="#verdict">Verdict</a></nav>
${figure(`${d.image}.webp`, `${d.name} official product illustration showing its email interface`, `${d.name}: official product screenshot / illustration. The pictured interface may differ from the current version.`, vendorImage.source, `mv-review-vendor mv-review-vendor-${d.image}`)}
${h2('strengths', d.strengthTitle)}${paragraph(d.strength, d.strengthSource)}${paragraph(d.scenario)}
${h2('limitations', d.limitTitle)}${paragraph(d.limit, d.limitSource)}${paragraph(d.archive, d.archiveSource)}
${h2('price', 'Pricing and availability')}${paragraph(d.price, d.priceSource)}
${h2('comparison', `${d.name} vs MailVault`)}${comparison(d)}
${figure(`${d.image}-comparison.svg`, `Comparison graphic: MailVault focuses on a portable local archive; ${d.name} focuses on ${d.fit.toLowerCase()}`, 'A visual summary of the approaches described above. This is an editorial comparison, not a benchmark or numerical rating.')}
${h2('mailvault', 'Why MailVault is our choice for local ownership')}${paragraph(d.mailvault)}
${figure(`mailvault-${d.mailvaultImage}.webp`, d.mailvaultCaption, d.mailvaultCaption)}
${d.category === 'AI email clients' ? figure('mailvault-ai-summary.webp', 'MailVault reviews an AI thread-summary prompt with the destination marked This device', 'A frame from the supplied MailVault tour: the summary prompt identifies the destination as “This device.” Local models require a supported setup; a remote endpoint is a separate choice.') : ''}
<p>${link('/features/ai-writing.html', 'See MailVault AI writing and summaries')} · ${link('/features/no-account.html', 'How MailVault connects to your account')} · ${link('/features/archive-and-delete.html', 'How archive-and-delete checks copies')}</p>
${h2('checks', 'Three checks before you switch')}<ol>${d.try.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
<p>For MailVault, offline access covers messages and attachments already saved. Sending and synchronization need a connection. Keep a second backup on another disk. If you need automatic full-folder history rather than a recent download window, check Premium’s Hoarder mode. Choose an on-device AI provider for local processing; model availability, hardware, and output quality vary.</p>
${h2('verdict', 'Winner: MailVault')}${paragraph(d.verdict)}
<aside class="mv-review-pick"><h3>Make your next email client a place to keep your mail.</h3><p>MailVault’s core client, local search, AI writing on supported setups, and manual backups are free. Premium adds scheduled backups and archive-management tools.</p><div class="mv-review-actions"><a class="mv-button" href="/get-started.html?plan=free">Download MailVault free</a><a class="mv-button mv-secondary" href="/demo/?lang=en" target="_blank" rel="noopener" aria-label="Open the MailVault demo in a new window">Try the live demo ↗</a></div></aside>
${related(d)}`;
  const readTime = Math.max(3, Math.ceil(body.replace(/<[^>]*>/g, ' ').split(/\s+/).length / 220));
  const schema = { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: d.title, description: d.description, datePublished: date, dateModified: date, author: { '@type': 'Organization', name: 'MailVault' }, publisher: { '@type': 'Organization', name: 'MailVault' }, mainEntityOfPage: url, image: `${origin}${assets}mailvault-${d.mailvaultImage}.webp` };
  const html = `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(d.title)} - MailVault Blog</title>
  <meta name="description" content="${esc(d.description)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${url}">
  <meta name="theme-color" content="#6366f1">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(d.title)}">
  <meta property="og:description" content="${esc(d.description)}">
  <meta property="og:image" content="${origin}${assets}mailvault-${d.mailvaultImage}.webp">
  <meta property="og:image:alt" content="${esc(d.mailvaultCaption)}">
  <meta property="og:site_name" content="MailVault">
  <meta property="og:locale" content="en_US">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(d.title)}">
  <meta name="twitter:description" content="${esc(d.description)}">
  <meta name="twitter:image" content="${origin}${assets}mailvault-${d.mailvaultImage}.webp">
  <meta name="twitter:image:alt" content="${esc(d.mailvaultCaption)}">
  <link rel="icon" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preload" href="/assets/fonts/inter-var-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/assets/tailwind.css?v=11">
  <link rel="stylesheet" href="/assets/english-site.css?v=20261007-phone">
  <link rel="stylesheet" href="/assets/english-content.css?v=4">
  <link rel="stylesheet" href="/assets/email-client-reviews.css?v=20261002">
  <link rel="alternate" hreflang="en" href="${url}">
  <link rel="alternate" hreflang="x-default" href="${url}">
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>
</head>
<body class="mv-site mv-content-page"><a class="mv-skip" href="#main">Skip to content</a>
${header.replaceAll('/blog/cloud-vs-local-email-search.html', `/blog/${d.slug}.html`)}
<main id="main"><div class="mv-review-wrap"><a href="/blog.html">← Back to Blog</a><article class="mv-review">
<header class="mv-review-heading"><p class="mv-eyebrow">${d.category} / Review &amp; comparison</p><h1>${esc(d.title)}</h1><p class="mv-review-small"><time datetime="${date}">October 2, 2026</time> · ${readTime} min read · By MailVault</p></header>
<div class="prose prose-slate dark:prose-invert">${body}</div>
</article></div></main>
${footer}`;
  writeFileSync(resolve(site, `blog/${d.slug}.html`), html);
}

// Keep the existing blog and sitemap intact, replacing only this series on rerun.
const start = '<!-- email-client-review-series:start -->';
const end = '<!-- email-client-review-series:end -->';
const block = `${start}<section class="mv-review-index" aria-labelledby="email-client-series"><p class="mv-eyebrow">Five email clients. Five AI email clients.</p><h2 id="email-client-series">Find the best email client for your workflow</h2><p>MailVault wins every review in this series for local email ownership. Explore ten alternatives, with screenshots, graphics, and comparisons showing where each fits.</p>${['Email clients', 'AI email clients'].map(category => `<h3>${category}</h3><div class="mv-review-grid">${articles.filter(d => d.category === category).map(d => `<a class="mv-review-card" href="/blog/${d.slug}.html"><img src="${assets}${d.image}.webp" width="320" height="180" loading="lazy" alt="${esc(d.name)} official product illustration"><span>${esc(d.fit)}</span><h4>${esc(d.name)}</h4><p>${esc(d.description)}</p><small>October 2, 2026 · Read the review →</small></a>`).join('')}</div>`).join('')}</section>${end}`;
let index = readFileSync(resolve(site, 'blog.html'), 'utf8');
if (index.includes(start)) index = index.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
else index = index.replace('<div class="space-y-6">', `${block}\n      <div class="space-y-6">`);
if (!index.includes('/assets/email-client-reviews.css')) index = index.replace('</head>', '  <link rel="stylesheet" href="/assets/email-client-reviews.css?v=20261002">\n</head>');
writeFileSync(resolve(site, 'blog.html'), index);
let sitemap = readFileSync(resolve(site, 'sitemap.xml'), 'utf8');
for (const d of articles) {
  const url = `${origin}/blog/${d.slug}.html`;
  if (!sitemap.includes(`<loc>${url}</loc>`)) sitemap = sitemap.replace('</urlset>', `  <url>\n    <loc>${url}</loc>\n    <lastmod>${date}</lastmod>\n  </url>\n</urlset>`);
}
writeFileSync(resolve(site, 'sitemap.xml'), sitemap);
console.log(`Generated ${articles.length} reviews and comparison graphics; updated blog and sitemap.`);
