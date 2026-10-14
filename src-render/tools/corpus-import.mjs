#!/usr/bin/env node
// Builds the third-party part of tests/fixtures/blitz-corpus/ from pinned MIT
// template repos, plus ours/bg-images.html (generated PNGs). Re-runnable and
// deterministic. It needs the network, so run it on the dev Mac from the repo
// root (it is a fixture generator, not a test):
//   node src-render/tools/corpus-import.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

const ROOT = new URL('../../tests/fixtures/blitz-corpus/', import.meta.url).pathname;
const SOURCES = {
  cerberus: {
    repo: 'emailmonday/Cerberus', commit: 'af3cec9dd12fbbea0c6e9a1b0bf82a0479726957', license: 'LICENSE',
    files: { 'cerberus/hybrid': 'cerberus-hybrid.html', 'cerberus/fluid': 'cerberus-fluid.html', 'cerberus/responsive': 'cerberus-responsive.html' },
  },
  leemunroe: {
    repo: 'leemunroe/responsive-html-email-template', commit: '60b5b6ddf9600e4b7d7e1ef60e5a3a8f1e56e186', license: 'license.txt',
    files: { 'leemunroe/inlined': 'email-inlined.html' },
  },
  postmark: {
    repo: 'ActiveCampaign/postmark-templates', commit: 'fa73527acb4eb59cf673a54572d213e908f1515c', license: 'LICENSE',
    files: {
      'postmark/welcome': 'templates-inlined/basic/welcome/content.html',
      'postmark/receipt': 'templates-inlined/basic/receipt/content.html',
      'postmark/password-reset': 'templates-inlined/basic/password-reset/content.html',
      'postmark/invoice': 'templates-inlined/basic/invoice/content.html',
    },
  },
};
const OURS = ['basic-typography', 'tables-legacy', 'style-media-attr', 'already-dark', 'inline-important', 'css-variables', 'gradients-shadows', 'preheader-hidden', 'bg-images', 'table-600-narrow', 'table-border-attr', 'table-cell-edges'];

const raw = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
const write = (rel, text) => { const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };

function png(w, h, paint) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(paint(x, y), (y * w + x) * 4);
  return `data:image/png;base64,${PNG.sync.write(img).toString('base64')}`;
}
const solid = (w, h, rgba) => png(w, h, () => rgba);

// Remote images become same-size grey data: PNGs, so both renderers lay out
// the same intrinsic size with no network. CSS/attribute backgrounds become
// an 8x8 grey.
function deterministic(html) {
  let n = 0;
  const out = html
    // Fonts first: the url() rule below would otherwise rewrite the import's URL.
    .replace(/@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\)\s*;?/gi, '')
    .replace(/<link\b[^>]*fonts\.googleapis\.com[^>]*>/gi, '')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\ssrc\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      if (!src) return tag;
      const num = (a) => Number((tag.match(new RegExp(`\\s${a}\\s*=\\s*["']?(\\d+)`, 'i')) || [])[1]) || 0;
      const w = num('width') || 200;
      const h = num('height') || 50;
      n += 1;
      return tag.replace(src[1], solid(w, h, [204, 204, 204, 255]));
    })
    // Unquoted: the url() may sit in a double-quoted style attribute, which a `"` would end.
    // A base64 data: URL holds no quote, space or parenthesis, so it needs none.
    .replace(/url\(\s*["']?https?:\/\/[^)"']+["']?\s*\)/gi, () => { n += 1; return `url(${solid(8, 8, [204, 204, 204, 255])})`; })
    .replace(/\sbackground\s*=\s*["']https?:\/\/[^"']+["']/gi, () => { n += 1; return ` background="${solid(8, 8, [204, 204, 204, 255])}"`; });
  return { html: out, replaced: n };
}

function bgImages() {
  const half = (rgb) => (x) => (x % 2 === 0 ? [...rgb, 255] : [0, 0, 0, 0]);
  const logo = png(40, 20, (x) => half([32, 32, 32])(x));          // dark, 50% transparent, wide
  const spacer = png(2, 20, (x) => half([32, 32, 32])(x));         // dark, transparent, 2 px wide
  const hero = solid(600, 600, [240, 240, 240, 255]);              // large, light, opaque
  const photo = solid(100, 100, [235, 235, 235, 255]);             // small, light, opaque
  return `<style>
.logo{width:40px;height:20px;background-image:url("${logo}")}
.spacer{width:2px;height:20px;background-image:url("${spacer}")}
.hero{width:300px;height:300px;background-image:url("${hero}");background-size:cover}
.photo{width:100px;height:100px;background-image:url("${photo}")}
.remote{width:40px;height:40px;background-image:url("https://cdn.blitz-corpus.invalid/a.png")}
</style>
<div class="logo"></div><div class="spacer"></div><div class="hero"></div><div class="photo"></div><div class="remote"></div>
`;
}

const fixtures = OURS.map((id) => ({ id: `ours/${id}`, file: `ours/${id}.html`, source: 'ours' }));
write('ours/bg-images.html', bgImages());
const sources = {};
for (const [name, s] of Object.entries(SOURCES)) {
  sources[name] = { repo: s.repo, commit: s.commit, license: `${name}/${s.license}`, spdx: 'MIT' };
  write(`${name}/${s.license}`, await get(raw(s.repo, s.commit, s.license)));
  for (const [id, path] of Object.entries(s.files)) {
    const { html, replaced } = deterministic(await get(raw(s.repo, s.commit, path)));
    if (/<blockquote|gmail_quote/i.test(html)) throw new Error(`${id} would fold`);
    const file = `${name}/${path.split('/').slice(-2).join('-').replace('content.html', '').replace(/-$/, '') || path}`;
    const out = file.endsWith('.html') ? file : `${file}.html`;
    write(out, html);
    fixtures.push({ id, file: out, source: name, upstreamPath: path, modified: `remote images and backgrounds replaced by data: placeholders (${replaced}); Google Fonts imports removed` });
    // getEmailBodyContent keeps only <body>'s inner HTML, so a template's
    // <head><style> never reaches either renderer. An "-inbody" variant moves
    // those sheets to the top of <body>, so the Dark Reader sheet rewriter is
    // exercised on real-world email CSS too.
    const head = (html.match(/<head\b[\s\S]*?<\/head>/i) || [''])[0];
    const sheets = head.match(/<style\b[\s\S]*?<\/style>/gi) || [];
    if (sheets.length) {
      const inbody = html.replace(/<body\b[^>]*>/i, (tag) => `${tag}\n${sheets.join('\n')}`);
      const file = out.replace(/\.html$/, '-inbody.html');
      write(file, inbody);
      fixtures.push({ id: `${id}-inbody`, file, source: name, upstreamPath: path, modified: `as ${id}, plus its <head> <style> blocks copied to the start of <body>` });
    }
  }
}
write('manifest.json', `${JSON.stringify({ version: 1, sources, fixtures }, null, 2)}\n`);
console.log(`corpus: ${fixtures.length} fixtures`);
