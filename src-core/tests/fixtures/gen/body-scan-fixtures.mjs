#!/usr/bin/env node
// Regenerates the golden corpus the Rust body scan is tested against:
//   src-core/tests/fixtures/body-scan-cases.json (src-core/src/body_scan)
//
// The expected values come from the OLD JavaScript, read out of git at BASE
// (local main when the move started), never from the Rust: trackerList.js,
// trackerDetect.js, linkSafety.js, rowAlerts.js and replyToCheck.js, run under
// jsdom's DOMParser. Their `t()` is the real catalog lookup (en, and de for the
// locale cases), and the fixture carries the templates the app hands the
// daemon, so reasons and the HTML they are written into compare as text.
//
// It also checks the one change of order the move makes: the app now strips
// Google Font imports BEFORE the scan (one RPC does tracker scan, body choice
// and link scan), where the JS stripped between the tracker and the link scan.
// Every pipeline case must come out the same both ways, or this script fails.
//
// Usage, from the repo root (needs git history holding BASE, and node_modules):
//   node src-core/tests/fixtures/gen/body-scan-fixtures.mjs
// then `git diff --exit-code src-core/tests/fixtures` shows nothing changed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { JSDOM } from 'jsdom';

export const BASE = '65040308f';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'body-scan-cases.json');

const show = (path) => execFileSync('git', ['show', `${BASE}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
const catalog = (code) => JSON.parse(show(`src/i18n/locales/${code}.json`));
const EN = catalog('en');
const CATALOGS = { en: EN, de: catalog('de') };

// The keys whose templates the app sends with every scan.
export const TEXT_KEYS = [
  'util.trackerDetect.blockedExplain',
  'util.trackerDetect.blockedLabel',
  'util.trackerDetect.vendorBeacon',
  'util.trackerDetect.beaconPath',
  'util.trackerDetect.imageHiddenCssSoNever',
  'util.trackerDetect.imageHiddenInsideCollapsedContainer',
  'util.trackerDetect.invisibleImageReadReceiptPicture',
  'linkSafety.reason.dangerousScheme',
  'linkSafety.reason.textMismatch',
  'linkSafety.reason.redirect',
];

// A DOMParser like the webview's (jsdom: parse5, scripting off for parsed documents).
const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>');
globalThis.DOMParser = window.DOMParser;

// i18n as src/i18n/index.js resolves and interpolates (no plural keys here).
globalThis.__mvI18n = { locale: 'en', catalog: EN };
globalThis.__mvI18nEn = EN;
const I18N = `
const _interp = (s, vars) =>
  vars ? s.replace(/\\{\\{(\\w+)\\}\\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
export function t(key, vars) {
  const catalog = globalThis.__mvI18n.catalog;
  const en = globalThis.__mvI18nEn;
  return _interp(catalog[key] ?? en[key] ?? key, vars);
}
export const getLocale = () => globalThis.__mvI18n.locale;
`;
const HELPERS = 'export const emailScopeKey = (e) => (e && e._key) || null;\n';

function rewrite(src, pairs) {
  let out = src;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`expected import not found: ${from}`);
    out = out.replace(from, to);
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'mv-body-scan-'));
writeFileSync(join(dir, 'i18n.mjs'), I18N);
writeFileSync(join(dir, 'unifiedHelpers.mjs'), HELPERS);
writeFileSync(join(dir, 'googleFonts.mjs'), 'export const GOOGLE_FONTS = [];\n');
writeFileSync(join(dir, 'trackerList.mjs'), show('src/utils/trackerList.js'));
writeFileSync(join(dir, 'linkSafety.mjs'), rewrite(show('src/utils/linkSafety.js'), [
  ["from '../stores/slices/unifiedHelpers'", "from './unifiedHelpers.mjs'"],
  ["from '../i18n/index.js'", "from './i18n.mjs'"],
]));
writeFileSync(join(dir, 'trackerDetect.mjs'), rewrite(show('src/utils/trackerDetect.js'), [
  ["from './linkSafety'", "from './linkSafety.mjs'"],
  ["from './trackerList'", "from './trackerList.mjs'"],
  ["from '../i18n/index.js'", "from './i18n.mjs'"],
]));
writeFileSync(join(dir, 'replyToCheck.mjs'), show('src/utils/replyToCheck.js'));
writeFileSync(join(dir, 'rowAlerts.mjs'), rewrite(show('src/stores/slices/rowAlerts.js'), [
  ["from '../../utils/replyToCheck'", "from './replyToCheck.mjs'"],
  ["from './unifiedHelpers'", "from './unifiedHelpers.mjs'"],
]));
writeFileSync(join(dir, 'mailFonts.mjs'), rewrite(show('src/utils/mailFonts.js'), [
  ["from './googleFonts'", "from './googleFonts.mjs'"],
]));
const load = (name) => import(pathToFileURL(join(dir, name)).href);
const { TRACKER_PATTERNS } = await load('trackerList.mjs');
const { scanTrackers, summarizeTrackers } = await load('trackerDetect.mjs');
const { scanEmailLinks, classifyLink, isScannableHref } = await load('linkSafety.mjs');
const { annotateRowAlerts } = await load('rowAlerts.mjs');
const { stripGoogleFontImports } = await load('mailFonts.mjs');
rmSync(dir, { recursive: true, force: true });

function useLocale(code) {
  globalThis.__mvI18n = { locale: code, catalog: CATALOGS[code] };
}
const textsFor = (code) => Object.fromEntries(TEXT_KEYS.map(k => [k, CATALOGS[code][k] ?? EN[k]]));
for (const k of TEXT_KEYS) if (typeof EN[k] !== 'string') throw new Error(`missing en key ${k}`);

// ── inputs ──────────────────────────────────────────────────────────────────

const px = (src, extra = '') => `<img src="${src}" width="1" height="1"${extra}>`;
const MC = 'https://example.list-manage.com/track/open.php?u=8f2&amp;id=a91';

const TRACKER_BODIES = [
  ['mailchimp_beacon', `<p>Hi</p>${px(MC)}`],
  ['sendgrid_honest_size', '<img src="https://u123.wl.sendgrid.net/wf/open?upn=abc" width="20" height="20">'],
  ['ordinary_image_untouched', '<p>Hi</p><img src="https://cdn.example.com/logo.png" width="200" height="60" alt="logo">'],
  ['unknown_1x1', px('https://metrics.unknown-vendor.test/i.gif?e=you')],
  ['css_hidden_normal_size', '<img src="https://beacons.unknown.test/i.png" width="100" height="100" style="display:none">'],
  ['hidden_container', '<div style="display:none;max-height:0"><img src="https://beacons.unknown.test/x.png" width="80" height="80"></div>'],
  ['small_visible_icon', '<img src="https://cdn.example.com/icon.png" width="16" height="16">'],
  ['spacers', px('https://cdn.example.com/img/spacer.gif') + px('https://cdn.example.com/img/transparent.gif') + px('https://cdn.example.com/blank.gif')],
  ['inline_embedded', px('cid:logo@example') + px('data:image/gif;base64,R0lGOD') + px('blob:https://x.test/abc')],
  ['beacon_path', '<img src="https://mail.unknown.test/pixel/abc123.gif">'],
  ['beacon_paths_various', ['/open', '/opens/', '/beacon.png?x', '/track', '/tracking/', '/trk', '/impression.jpg', '/o/abc', '/q/abc', '/wf/open', '/x/open.aspx', '/x/open.php', '/x/opened', '/x/pixels', '/x/OPEN.GIF']
    .map(p => `<img src="https://h.unknown.test${p}">`).join('')],
  ['beacon_and_real_image', '<p>Hi</p><img src="https://cdn.example.com/logo.png" width="200" height="60">' + px('https://u1.wl.sendgrid.net/wf/open?upn=x')],
  ['several_beacons', px('https://a.list-manage.com/track/open.php?u=1') + px('https://b.unknown.test/p.gif')],
  ['same_vendor_twice', px('https://a.list-manage.com/track/open.php?u=1') + px('https://b.list-manage.com/track/open.php?u=2')],
  ['noscript_pixel', `<noscript>${px('https://t.unknown.test/p.gif')}</noscript><p>after</p>`],
  ['noscript_and_foreign_text', `<noscript>a &amp; b &lt;i&gt;</noscript><svg><style>a &amp; b</style><foreignObject><p>x</p></foreignObject><clipPath/></svg>${px('https://t.unknown.test/ns.gif')}`],
  ['own_style_display_inside_hidden', '<div style="display:none"><img src="https://t.unknown.test/a.png" style="display:block" width="50" height="50"></div>'],
  ['own_style_border_inside_hidden', '<div style="display:none"><img src="https://t.unknown.test/a.png" style="border:0" width="50" height="50"></div>'],
  ['uppercase_style_parent', '<div STYLE="DISPLAY:none"><img src="https://t.unknown.test/a.png" width="50" height="50"></div>'],
  ['mixedcase_parent_value', '<div style="Display:none"><img src="https://t.unknown.test/a.png" width="50" height="50"></div>'],
  ['nearest_styled_ancestor_wins', '<div style="display:none"><span style="opacity:1"><img src="https://t.unknown.test/a.png" width="50" height="50"></span></div>'],
  ['visibility_hidden_parent', '<table><tr><td style="visibility: hidden"><img src="https://t.unknown.test/a.png" width="50" height="50"></td></tr></table>'],
  ['opacity_cases', ['opacity:0', 'opacity: 0 ;', 'opacity:0.5', 'opacity:0.0', 'opacity:00', 'opacity:.5', 'OPACITY:0', 'max-height:0', 'max-height: 0px', 'visibility:hidden', 'display : none', 'display:none !important', 'opacity:0;opacity:0.5', 'opacity:0.5;opacity:0']
    .map((s, i) => `<img src="https://t.unknown.test/o${i}.png" width="40" height="40" style="${s}">`).join('')],
  ['opacity_parent_cases', ['opacity:0', 'opacity:0.5', 'opacity:0.0'].map((s, i) => `<div style="${s}"><img src="https://t.unknown.test/p${i}.png" width="40" height="40"></div>`).join('')],
  ['sizes', [
    'width="1" height="1"', 'width="3" height="3"', 'width="3" height="4"', 'width="4" height="1"', 'width="0" height="0"',
    'width="1.50" height="1"', 'width=" 1px " height="1PX"', 'width="1" ', 'height="1"', 'width="+1" height="1"', 'width="1e0" height="1"',
    'width="0.0000001" height="0.0000001"', 'width="2.000" height="0.25"', 'width="1px;" height="1"', 'width="\u0661" height="\u0661"',
    'style="width:1px;height:1px"', 'style="width: 2px; height: 3.0px"', 'style="width:1px" height="1"', 'style="max-width:1px;height:1px"',
    'style="width:1em;height:1em" width="1" height="1"', 'style="width:100px;height:100px" width="1" height="1"', 'style="WIDTH:1PX;HEIGHT:1PX"',
    'style="color:red; width:1px ; height : 1px"', 'style="border-width:1px;height:1px" width="200"', 'style=";width:1px;;height:1px"',
    'width="00001" height="1.0"', 'width="1.5px" height="2.25PX"', 'width="1\u00a0" height="\uFEFF1"', 'width="1\u0085" height="1"',
  ].map((a, i) => `<img src="https://cdn.example.com/s${i}.png" ${a}>`).join('')],
  ['spacer_does_not_hide_vendor', px('https://x.list-manage.com/track/open.php/spacer.gif')],
  ['spacer_allowlist_variants', px('https://x.test/a/pixel.gif?') + px('https://x.test/a/pixel.gif?x=1') + px('https://attachments.office.net/owa/x') + px('https://x.test/apple_logo_web.png') + px('https://x.test/SPACER.GIF')],
  ['relative_src_1x1', px('/images/i.gif')],
  ['relative_beacon_path_no_host', '<img src="/track/x.gif">'],
  ['protocol_relative_1x1', px('//t.unknown.test/i.gif')],
  ['protocol_relative_path', '<img src="//t.unknown.test/open.gif">'],
  ['http_and_https_counted', '<img src="http://cdn.example.com/a.png"><img src="https://cdn.example.com/b.png"><img src="HTTPS://cdn.example.com/c.png">' + px('http://t.unknown.test/p.gif')],
  ['empty_and_missing_src', '<img src=""><img alt="none"><img srcset="https://t.test/open.gif 1x" width="1" height="1">'],
  ['uppercase_tags', '<IMG SRC="https://t.unknown.test/i.gif" WIDTH="1" HEIGHT="1">'],
  ['uppercase_data_scheme', px('Data:image/gif;base64,R0lGOD') + px(' cid:x')],
  ['punycode_host', px('https://ex\u0430mple.com/i.gif') + px('https://b\u00fccher.example/i.gif') + px('https://xn--bcher-kva.example/i.gif')],
  ['uppercase_host', '<img src="HTTPS://T.UNKNOWN.TEST/OPEN.GIF">'],
  ['ip_hosts', px('https://0x7f.1/i.gif') + px('https://[::1]/i.gif') + px('https://192.168.0.1:8080/i.gif')],
  ['port_and_userinfo', '<img src="https://t.test:8443/o/x">' + px('https://user:pw@t.test/i.gif')],
  ['entities_in_src', px('https://x.list-manage.com/track/open.php?u=1&amp;id=2&lt;3')],
  ['unicode_long_s', '<img src="https://\u017Fubstack.com/open?x" width="50" height="50">'],
  ['unicode_kelvin', '<img src="https://\u212Alaviyomail.com/x.png" width="50" height="50">'],
  ['unicode_digit_class', '<img src="https://sendibm\u0661.com/x.png" width="50" height="50">'],
  ['unicode_word_class', '<img src="https://ml.closeml.com/t/\u00e9/\u00e9.png" width="50" height="50"><img src="https://ml.closeml.com/t/ab/cd.png" width="50" height="50">'],
  ['dot_vs_line_separator', '<img src="https://simg\u20281und1.de/x" width="50" height="50"><img src="https://simg&#13;1und1.de/x" width="50" height="50"><img src="https://simg&#10;1und1.de/x" width="50" height="50"><img src="https://simgx1und1.de/x" width="50" height="50"><img src="https://simg\u00e91und1.de/x" width="50" height="50"><img src="https://simg\u{1F600}1und1.de/x" width="50" height="50">'],
  ['word_boundary', '<img src="https://facebook.com/tr\u00e4" width="50" height="50"><img src="https://facebook.com/tr_x" width="50" height="50"><img src="https://facebook.com/tr?id=1" width="50" height="50">'],
  ['js_whitespace_in_style', '<img src="https://t.unknown.test/a.png" width="40" height="40" style="display&#x85;:none"><img src="https://t.unknown.test/b.png" width="40" height="40" style="display&#xFEFF;:none"><img src="https://t.unknown.test/c.png" width="40" height="40" style="display&#xA0;:&#x2003;none">'],
  ['vendor_with_ampersand', px('https://simg.1und1.de/x')],
  ['first_match_wins', px('https://x.list-manage.com/track/open.php?u=1') + px('https://x.test/track/open.php?u=1') + px('https://x.awstrack.me/I0/abc')],
  ['google_analytics', '<img src="https://www.google-analytics.com/collect?v=1&amp;t=event" width="50" height="50"><img src="https://x.test/__utm.gif" width="50" height="50">'],
  ['mailgun_pattern', '<img src="https://email.x.test/e/o/abcd" width="50" height="50"><img src="https://email.x.test/o/eJxyz" width="50" height="50">'],
  ['stray_document_tags', `<html><head><title>T</title><style>p{color:red}</style></head><body class="x"><p>a</p>${px(MC)}</body></html><p>after</p>`],
  ['template_content', `<template>${px('https://t.unknown.test/t.gif')}</template>${px('https://t.unknown.test/u.gif')}`],
  ['svg_and_math', `<svg><image href="https://t.unknown.test/open.gif" width="1" height="1"/><img src="https://t.unknown.test/i.gif" width="1" height="1"></svg><math><mi>${px('https://t.unknown.test/m.gif')}</mi></math>`],
  ['entities_and_nbsp', `<p>a&nbsp;b &lt;c&gt; &amp; d&copy; "q" 'a'</p>${px('https://t.unknown.test/e.gif')}`],
  ['attribute_escaping', `<img alt='a"b<c>&amp;d&nbsp;' src="https://t.unknown.test/pixel.gif" width=1 height=1><p title="x<y>" data-q="it's">t</p>`],
  ['raw_text_elements', `<style>a > b { content: "&amp;<" }</style><script>if (a < b && c) {}</script><textarea>&lt;x&gt; & y</textarea><xmp><b>x</b></xmp>${px('https://t.unknown.test/r.gif')}`],
  ['comments_and_doctype', `<!-- c1 --><!DOCTYPE html><p>x</p><!--c2-->${px('https://t.unknown.test/c.gif')}`],
  ['table_foster_parent', `<table><img src="https://t.unknown.test/f.gif" width="1" height="1"><tr><td>x</td></tr></table>`],
  ['misnested_formatting', `<b><i>x</b>y</i><p>a<div>b</p></div>${px('https://t.unknown.test/n.gif')}`],
  ['existing_title_and_marker_attr', `<img title="mine" src="https://t.unknown.test/i.gif" width="1" height="1" data-mv-tracker-blocked="x">`],
  ['void_and_boolean_attrs', `<input disabled value="a&quot;b"><br/><hr><wbr>${px('https://t.unknown.test/v.gif')}`],
  ['pre_and_listing_newline', `<pre>\nkeep</pre><pre>\n\nkeep2</pre><textarea>\nt</textarea><listing>\nl</listing>${px('https://t.unknown.test/pre.gif')}`],
  ['select_option', `<select><option>a<option selected>b</select>${px('https://t.unknown.test/s.gif')}`],
  ['iframe_noembed_noframes', `<iframe><b>x</b></iframe><noembed><b>y</b></noembed><noframes><b>z</b></noframes>${px('https://t.unknown.test/nf.gif')}`],
  ['plaintext_tail', `<p>x</p>${px('https://t.unknown.test/pt.gif')}<plaintext><b>raw</b> & more`],
  ['control_and_astral_chars', `<p>\u0001 \u{1F600} \uFFFD</p>${px('https://t.unknown.test/\u{1F600}.gif')}`],
  ['frameset_ignored', `<frameset><frame src="x"></frameset>${px('https://t.unknown.test/fs.gif')}`],
  ['form_nesting', `<form><form><input name="a"></form></form>${px('https://t.unknown.test/form.gif')}`],
  ['many_trackers_and_text', Array.from({ length: 12 }, (_, i) => `<p>para ${i}</p>${px(`https://t${i}.unknown.test/i.gif`)}`).join('')],
  ['curated_rows', [
    'https://trk.klclick3.com/x', 'https://x.braze-images.com/x', 'https://links.acme.iterable.com/x', 'https://x.customeriomail.com/e',
    'https://acme.substack.com/open?x', 'https://x.beehiiv.com/o/1', 'https://sendibm3.com/x', 'https://x.omnisend.com/track/x',
    'https://x.lemlist.com/api/track/x', 'https://x.woodpecker.co/o/x', 'https://x.gmass.co/track/x', 'https://x.awstrack.me/x',
    'https://x.mailchimpapp.net/x', 'https://x.mailerlite.com/open/x', 'https://zcsend.net/x', 'https://www.facebook.com/tr?id=1',
  ].map(u => `<img src="${u}" width="50" height="50">`).join('')],
  ['upstream_rows', [
    'https://x.test/wf/open?upn=1', 'https://dripemail2.x.test/a', 'https://mailfoogae.appspot.com/t', 'https://t.yesware.com/t/1',
    'https://pstmrk.it/open/x', 'https://x.convertkit-mail2.com/o/x', 'https://x.intercom-mail.com/via/o', 'https://x.mjt.lu/oo/x.gif',
    'https://t.hubspotemail.net/e2t/o/x', 'https://t.strk01.email/x', 'https://go.sparkpostmail2.com/q/x', 'https://x.test/lt.php?l=open',
    'https://x.test/o/abcdefghij/abcdefghij/', 'https://x.test/open/123/abcdefghij', 'https://x.enewsletter.pl/a.gif',
    'https://x.test/optiext/optiextension.dll?ID=1', 'https://mx.technolutions.net/ss/o/abc/ho.gif', 'https://tracking.vocus.io/x',
    'https://x.test/xI0/abcdefghijklmnop-abcdefgh-abcd', 'https://x.test/tools/emails/open/1',
  ].map(u => `<img src="${u}" width="50" height="50">`).join('')],
  ['mtb_rows', [
    'https://x.test/1.gif', 'https://x.test/a.png1', 'https://x.test/open.gif', 'https://x.test/t/o?x', 'https://x.test/q/a~~/b',
    'https://x.test/e/o/abc', 'https://sellercentral-europe.amazon.de/nms/img/x', 'https://x.test/p/rp/abcdefghijklmnop.png',
    'https://mail.x.pl/o/abc', 'https://x.test/o/wwwwwwwwww/wwwwwwwwww', 'https://x.test/nethunt.co/a?/pixel.gif',
    'https://x.test/mo/x.gif', 'https://zen.sr/o', 'https://pixel.wp.com/t.gif', 'https://x.test/d/d.gif?x',
  ].map(u => `<img src="${u}" width="50" height="50">`).join('')],
  ['innocent_urls', ['https://cdn.example.com/images/hero-banner-2026.png', 'https://images.example.com/photo.jpg', 'https://x.test/assets/openings.png', 'https://x.test/tracks/song.png']
    .map(u => `<img src="${u}" width="300" height="200">`).join('')],
  ['empty_body_text', ' '],
];

const LINK_BODIES = [
  ['inbox_body', '<p>Body of the inbox message</p><a href="https://example.com/a">a</a>'],
  ['phish_text_mismatch', '<a href="https://evil.test/login">https://bank.test</a>'],
  ['javascript_link', '<a href="javascript:alert(1)">go</a>'],
  ['data_link_existing_title', '<a href="data:text/html,hi" title="Mine">d</a>'],
  ['uppercase_javascript_skipped', '<a href="JavaScript:alert(1)">go</a><a href=" javascript:alert(1)">sp</a><a href="DATA:text/html,x">D</a>'],
  ['www_text', '<a href="https://evil.test/">www.bank.test</a><a href="https://bank.test/">www.bank.test</a>'],
  ['case_and_port_same_host', '<a href="https://BANK.test:443/x">https://bank.test</a><a href="https://bank.test:8443/">https://bank.test/a</a>'],
  ['userinfo_phish', '<a href="https://paypal.com@evil.example/">https://paypal.com</a>'],
  ['lookalike_hosts', '<a href="https://paypal.com/">https://p\u0430ypal.com</a><a href="https://stra\u00dfe.de/">https://strasse.de</a><a href="https://xn--strae-oqa.de/">https://stra\u00dfe.de</a><a href="https://\u03c2.test/">https://\u03c3.test</a>'],
  ['fullwidth_and_trailing_dot', '<a href="https://bank.test/">https://bank\u3002test</a><a href="https://bank.test/">https://bank.test.</a><a href="https://BANK.TEST/">HTTPS://Bank.Test</a>'],
  ['ip_hosts', '<a href="http://0x7f000001/">http://127.0.0.1/</a><a href="http://[::1]/">http://[0:0::1]/</a><a href="http://1.2.3.4/">http://1.2.3.5/</a>'],
  ['nested_text', '<a href="https://evil.test"><span>https://</span><b>bank.test</b></a>'],
  ['text_with_style_and_template', '<a href="https://evil.test"><style>x</style>https://bank.test</a><a href="https://evil.test"><template>https://bank.test</template>click</a>'],
  ['text_whitespace', '<a href="https://evil.test">\u00a0 https://bank.test \u00a0</a><a href="https://evil.test">\uFEFFhttps://bank.test\u0085</a>'],
  ['redirects', [
    'https://track.test/r?url=https%3A%2F%2Fother.test%2F', 'https://track.test/r?a=1&redirect=https://other.test/', 'https://track.test/r?goto=https://track.test/x',
    'https://track.test/r?URL=https%3A%2F%2Fother.test', 'https://track.test/r?url=%zz', 'https://track.test/r?url=https%3A%2F%2Fother.test%2F%C3%28',
    'https://track.test/r?url=https://other.test/a+b', 'https://track.test/r?url=foo', 'https://track.test/r?url=www.other.test',
    'https://track.test/r?dest=https://other.test#frag', 'https://track.test/r?targeturl=https://other.test', 'https://track.test/r?link=https%3A%2F%2Fother%2Etest',
    'https://bit.ly/r?url=https%3A%2F%2Fother.test%2F', 'https://BIT.LY/r?url=https://other.test', 'https://www.bit.ly/r?url=https://other.test',
    'https://track.test/?url=javascript:alert(1)', 'https://track.test/?destination=https%3A%2F%2F\u00fcn\u00ef.test', 'https://track.test/?target=https://user@other.test',
    'https://t.co/?url=https://other.test', 'https://track.test/r?url=', 'https://track.test/r?url=https%3a%2f%2fother.test',
    'https://track.test/r?url=https%3A%2F%2Fother.test%F0%9F%98%80', 'https://track.test/r?url=https%3A%2F%2Fother.test%ED%A0%80',
  ].map((h, i) => `<a href="${h.replace(/&/g, '&amp;')}">Offer ${i}</a>`).join('')],
  ['skipped_schemes', '<a href="mailto:a@b.test">m</a><a href="tel:+1">t</a><a href="cid:x">c</a><a href="#top">a</a><a href="/relative">r</a><a href="page.html">p</a><a href="">e</a><a>no href</a>'],
  ['ftp_and_other_schemes', '<a href="ftp://x.test/f">https://y.test</a><a href="file:///etc/passwd">f</a><a href="custom://thing">c</a>'],
  ['empty_existing_title', '<a href="https://ok.test/a" title="">a</a><a href="https://ok.test/b" title="kept">b</a>'],
  ['svg_anchor', '<svg><a href="javascript:alert(1)"><text>x</text></a><a xlink:href="javascript:alert(2)"><text>y</text></a></svg>'],
  ['invalid_text_url', '<a href="https://evil.test">http://</a><a href="https://evil.test">see this://thing</a><a href="https://evil.test">www.</a>'],
  ['invalid_href', '<a href="https://exa mple.com">https://bank.test</a><a href="https://">https://bank.test</a>'],
  ['javascript_with_url_text', '<a href="javascript:void(0)">https://bank.test</a>'],
  ['levels_order', '<a href="https://track.test/r?url=https://other.test">y</a><a href="javascript:x">r</a><a href="https://track.test/r?url=https://other2.test">y2</a>'],
  ['yellow_only', '<a href="https://track.test/r?url=https://other.test">y</a>'],
  ['preexisting_alert_attr', '<a href="https://ok.test" data-link-alert="red">ok</a><a href="javascript:x" data-link-alert="yellow" title="old">bad</a>'],
  ['roundtrip_no_links', '<p>hi<b>bold<p>next</p>'],
  ['entities_in_href', '<a href="https://track.test/r?a=1&amp;url=https%3A%2F%2Fother.test&lt;">x</a>'],
  ['anchor_in_table', '<table><a href="javascript:x">t</a><tr><td>c</td></tr></table>'],
  ['nested_anchors', '<a href="https://a.test">outer<a href="javascript:x">inner</a></a>'],
  ['template_anchor', '<template><a href="javascript:x">t</a></template><a href="https://ok.test">ok</a>'],
  ['empty', ''],
];

const CLASSIFY = [
  ['javascript:x()', 'go'], ['data:text/html,hi', ''], ['https://evil.test/login', 'https://bank.test'],
  ['https://track.test/r?url=https%3A%2F%2Fother.test%2F', 'Offer'], ['https://bit.ly/r?url=https%3A%2F%2Fother.test%2F', 'Offer'],
  ['https://fine.test/a', 'A nice page'], [' https://evil.test', 'https://bank.test'], ['javascript:', ''],
  ['https://evil.test', ' https://bank.test '], ['https://evil.test', 'www.bank.test'], ['http://a.test', 'WWW.A.TEST'],
  ['https://evil.test/?url=https%3A%2F%2Fbank.test', 'https://evil.test'], ['mailto:a@b.test', 'https://a.test'],
  ['https://a.test', 'https://a.test@b.test'], ['https://x.test/?goto=%E0%A4%A', 'x'], ['https://x.test/?goto=https%3A%2F%2F%E2%82%AC.test', 'x'],
  ['data:', 'x'], ['https://x.test/?url=//other.test', 'x'], ['https://x.test/?url=HTTPS://OTHER.TEST', 'x'],
  ['https://evil.test', 'https://bank.test\t'], ['https://evil.test', '\nhttps://bank.test'],
];

const SCANNABLE = ['https://a.test', 'http://a.test', 'javascript:x()', 'data:text/html,x', '', '#top', 'cid:img', 'mailto:a@b.test',
  'tel:+1', '/relative', 'page.html', 'JavaScript:x', ' javascript:x', 'x://y', 'mailto://x', 'javascript', 'data:', '#://x', 'ftp://x'];

const GOOGLE_LINK = '<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&amp;display=swap" rel="stylesheet">';
const GOOGLE_IMPORT = '<style>@import url("https://fonts.googleapis.com/css2?family=Lato"); p { color: red }</style>';
const PIPELINE_BODIES = [
  ['tracker_and_phish', `<p>Hi</p>${px(MC)}<a href="https://evil.test/login">https://bank.test</a>`],
  ['clean', '<p>Hi</p><a href="https://ok.test">ok</a><img src="https://cdn.example.com/logo.png" width="200">'],
  ['fonts_and_tracker', `${GOOGLE_LINK}${GOOGLE_IMPORT}<p style="font-family:Roboto">Hi</p>${px('https://t.unknown.test/p.gif')}<a href="javascript:x">bad</a>`],
  ['fonts_only', `${GOOGLE_LINK}<p>Hi</p><a href="https://track.test/r?url=https://other.test">offer</a>`],
  ['fonts_unquoted_link', `<link rel=stylesheet href=https://fonts.googleapis.com/css?family=Open+Sans><p>x</p>${px('https://t.unknown.test/q.gif')}`],
  ['non_google_link', `<link href="https://cdn.example.com/a.css" rel="stylesheet"><p>x</p>${px('https://t.unknown.test/r.gif')}`],
  ['tracker_inside_link_text', `<a href="https://evil.test">https://bank.test${px('https://t.unknown.test/in.gif')}</a>`],
  ['stray_tags', `<html><head>${GOOGLE_LINK}</head><body><p>a</p>${px(MC)}<a href="javascript:x">j</a></body></html>`],
  ['empty', ''],
];

// ── run the JS ──────────────────────────────────────────────────────────────

const stripStyle = ({ indicatorStyle, ...rest }) => ({ ...rest, styled: indicatorStyle !== '' });

function trackerCase([name, html], locale = 'en') {
  useLocale(locale);
  const r = scanTrackers(html, null);
  return { name, locale, html, expected: { trackers: r.trackers, count: r.count, https: r.https, cleanedBodyHtml: r.cleanedBodyHtml } };
}

function linkCase([name, html], locale = 'en') {
  useLocale(locale);
  return { name, locale, html, expected: stripStyle(scanEmailLinks(html, null)) };
}

// What the renderers did (frameBody, then the font strip, then the link scan) ...
function oldOrder(raw, blocking, links) {
  const scan = scanTrackers(raw, null);
  let body = stripGoogleFontImports(blocking ? scan.cleanedBodyHtml : raw);
  let alerts = null;
  let maxAlertLevel = null;
  if (links) {
    const l = scanEmailLinks(body, null);
    body = l.modifiedBodyHtml;
    alerts = l.alerts;
    maxAlertLevel = l.maxAlertLevel;
  }
  return { trackers: scan.trackers, count: scan.count, https: scan.https, html: body, alerts, maxAlertLevel };
}

// ... and what the app and the daemon do now: strip, then one scan.
function newOrder(stripped, blocking, links) {
  const scan = scanTrackers(stripped, null);
  let body = blocking ? scan.cleanedBodyHtml : stripped;
  let alerts = null;
  let maxAlertLevel = null;
  if (links) {
    const l = scanEmailLinks(body, null);
    body = l.modifiedBodyHtml;
    alerts = l.alerts;
    maxAlertLevel = l.maxAlertLevel;
  }
  return { trackers: scan.trackers, count: scan.count, https: scan.https, html: body, alerts, maxAlertLevel };
}

const orderDiffs = [];
function pipelineCases() {
  useLocale('en');
  const out = [];
  for (const [name, raw] of PIPELINE_BODIES) {
    for (const blocking of [true, false]) {
      for (const links of [true, false]) {
        const stripped = stripGoogleFontImports(raw);
        const before = oldOrder(raw, blocking, links);
        const after = newOrder(stripped, blocking, links);
        if (!isDeepStrictEqual(before, after)) orderDiffs.push({ name, blocking, links, before, after });
        out.push({ name: `${name}_${blocking ? 'block' : 'show'}_${links ? 'links' : 'nolinks'}`, html: stripped, blocking, links, expected: after });
      }
    }
  }
  return out;
}

const SENDERS = [
  ['plain', { from: { name: 'Alice', address: 'alice@x.example' } }],
  ['name_is_other_email', { from: { name: 'support@paypal.com', address: 'scam@evil.example' } }],
  ['name_is_same_email', { from: { name: 'Support@X.example', address: 'support@x.example' } }],
  ['name_email_subdomain', { from: { name: 'user@example.com', address: 'user@sub.example.com' } }],
  ['name_email_parent', { from: { name: 'user@sub.example.com', address: 'user@example.com' } }],
  ['name_email_quoted', { from: { name: '"paypal@paypal.com"', address: 'x@evil.example' } }],
  ['name_email_escaped_quotes', { from: { name: '\\"service@bank.example\\"', address: 'x@evil.example' } }],
  ['name_looks_domain', { from: { name: 'ledger.com', address: 'no-reply@ledger-support.example' } }],
  ['name_looks_domain_upper', { from: { name: 'Ledger.COM', address: 'no-reply@ledger-support.example' } }],
  ['name_domain_same', { from: { name: 'snapcraft.io', address: 'news@snapcraft.io' } }],
  ['name_domain_sub', { from: { name: 'snapcraft.io', address: 'news@forum.snapcraft.io' } }],
  ['name_domain_parent', { from: { name: 'forum.snapcraft.io', address: 'news@snapcraft.io' } }],
  ['name_domain_short_tld', { from: { name: 'foo.c', address: 'a@x.example' } }],
  ['name_domain_digit_tld', { from: { name: 'foo.c0m', address: 'a@x.example' } }],
  ['name_domain_long_s', { from: { name: 'paypal.\u017Fom', address: 'a@x.example' } }],
  ['name_domain_kelvin', { from: { name: 'paypal.\u212Aom', address: 'a@x.example' } }],
  ['name_email_nbsp', { from: { name: 'a@b.com\u00a0', address: 'a@x.example' } }],
  ['name_email_inner_nbsp', { from: { name: 'a\u00a0b@c.com', address: 'a@x.example' } }],
  ['name_email_nel', { from: { name: 'a\u0085b@c.com', address: 'a@x.example' } }],
  ['name_email_bom', { from: { name: '\uFEFFservice@paypal.com', address: 'a@x.example' } }],
  ['name_email_two_at', { from: { name: 'a@b@c.com', address: 'a@x.example' } }],
  ['name_email_trailing_dot', { from: { name: 'a@b.', address: 'a@x.example' } }],
  ['address_upper_space', { from: { name: 'service@x.example', address: '  Service@X.Example ' } }],
  ['address_dotted_i', { from: { name: 'a@\u0130.example', address: 'a@\u0130.example' } }],
  ['final_sigma', { from: { name: 'A@\u03a3\u03a3.example', address: 'a@\u03c3\u03c3.example' } }],
  ['no_address', { from: { name: 'paypal.com' } }],
  ['no_from', {}],
  ['string_from', { from: 'a@x.example' }],
  ['reply_to_object_differs', { from: { address: 'a@x.example' }, replyTo: { address: 'b@other.example' } }],
  ['reply_to_object_matches', { from: { address: 'a@x.example' }, replyTo: { address: 'b@X.example' } }],
  ['reply_to_array', { from: { address: 'a@x.example' }, replyTo: [{ address: 'b@other.example' }, { address: 'c@x.example' }] }],
  ['reply_to_array_empty', { from: { address: 'a@x.example' }, replyTo: [] }],
  ['reply_to_string', { from: { address: 'a@x.example' }, replyTo: 'B@Other.Example' }],
  ['reply_to_subdomain', { from: { address: 'a@x.example' }, replyTo: { address: 'b@mail.x.example' } }],
  ['reply_to_parent', { from: { address: 'a@mail.x.example' }, replyTo: { address: 'b@x.example' } }],
  ['reply_to_no_at', { from: { address: 'a@x.example' }, replyTo: { address: 'nobody' } }],
  ['reply_to_spaces', { from: { address: 'a@x.example' }, replyTo: { address: 'b@ other.example ' } }],
  ['reply_to_two_at', { from: { address: 'a@x.example' }, replyTo: { address: 'b@other.example@x.example' } }],
  ['reply_to_no_from_domain', { from: { address: 'nobody' }, replyTo: { address: 'b@other.example' } }],
  ['already_annotated', { from: { name: 'support@paypal.com', address: 'scam@evil.example' }, replyTo: { address: 'b@other.example' }, _senderAlert: null, _replyToMismatch: null }],
];

function rowCases() {
  const out = [];
  for (const enabled of [true, false]) {
    for (const [name, row] of SENDERS) {
      const copy = structuredClone(row);
      annotateRowAlerts([copy], {}, { linkSafetyEnabled: enabled });
      const expected = {};
      for (const k of ['_senderAlert', '_replyToMismatch']) if (!isDeepStrictEqual(copy[k], row[k])) expected[k] = copy[k];
      out.push({ name: `${name}_${enabled ? 'on' : 'off'}`, row, linkSafetyEnabled: enabled, expected });
    }
  }
  // The persisted verdicts, by scoped key, never over one a row carries.
  const settings = {
    linkSafetyEnabled: true,
    linkAlerts: { 'a-INBOX-1': 'red', 'a-INBOX-2': 'yellow' },
    trackerAlerts: { 'a-INBOX-1': { count: 2, vendors: ['Mailchimp'] }, 'a-INBOX-3': { count: 1, vendors: ['x.test'] } },
  };
  const persisted = [
    { _key: 'a-INBOX-1', from: { address: 'a@x.example' } },
    { _key: 'a-INBOX-2', _linkAlert: 'red', from: { address: 'a@x.example' } },
    { _key: 'a-INBOX-3', _trackerInfo: { count: 9, vendors: ['Old'] }, from: { address: 'a@x.example' } },
    { _key: 'a-INBOX-4', from: { address: 'a@x.example' } },
    { from: { address: 'a@x.example' } },
  ];
  for (const row of persisted) {
    const copy = structuredClone(row);
    annotateRowAlerts([copy], {}, settings);
    const expected = {};
    for (const k of ['_linkAlert', '_trackerInfo', '_senderAlert', '_replyToMismatch']) if (!isDeepStrictEqual(copy[k], row[k])) expected[k] = copy[k];
    out.push({ name: `persisted_${row._key || 'nokey'}`, row, settings, expected });
  }
  return out;
}

const SUMMARIES = [
  [[{ vendor: 'MailChimp' }, { vendor: 'MailChimp' }, { vendor: 'SendGrid' }]],
  [[]],
  [[{ vendor: 'x.test' }]],
];

const fixture = {
  note: `Answers of the deleted src/utils/{trackerList,trackerDetect,linkSafety}.js, src/stores/slices/rowAlerts.js and src/utils/replyToCheck.js at ${BASE}, under jsdom. Regenerate with node src-core/tests/fixtures/gen/body-scan-fixtures.mjs.`,
  base: BASE,
  texts: { en: textsFor('en'), de: textsFor('de') },
  patterns: TRACKER_PATTERNS.map(([label, re]) => [label, re.source, re.flags]),
  trackers: [...TRACKER_BODIES.map(c => trackerCase(c)), ...TRACKER_BODIES.slice(0, 12).map(c => trackerCase(c, 'de'))],
  links: [...LINK_BODIES.map(c => linkCase(c)), ...LINK_BODIES.slice(0, 4).map(c => linkCase(c, 'de'))],
  classify: ['en', 'de'].flatMap(locale => CLASSIFY.map(([href, text]) => {
    useLocale(locale);
    return { href, text, locale, expected: classifyLink(href, text) };
  })),
  scannable: SCANNABLE.map(href => ({ href, expected: isScannableHref(href) })),
  pipeline: pipelineCases(),
  rows: rowCases(),
  summaries: SUMMARIES.map(([trackers]) => ({ trackers, expected: summarizeTrackers(trackers) })),
};

if (orderDiffs.length) {
  console.error(JSON.stringify(orderDiffs, null, 2));
  throw new Error(`${orderDiffs.length} pipeline case(s) differ when the font strip runs first`);
}

writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${OUT}: ${fixture.trackers.length} tracker, ${fixture.links.length} link, ${fixture.classify.length} classify, ${fixture.pipeline.length} pipeline, ${fixture.rows.length} row cases, ${fixture.patterns.length} patterns`);
