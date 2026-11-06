// @vitest-environment jsdom
// The mail frame's document: hostile mail goes in, and what comes out is a page whose first
// element in <head> is the CSP, whose links all leave the frame, and that can never refresh,
// rebase or run anything. Every check re-parses the output with jsdom's parser (parse5). That is
// a spec parser, but not the webview's: it attaches no declarative shadow roots and runs nothing,
// so the module itself re-parses to a fixpoint and refuses anything that still looks forbidden.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMailFrame, cleanToFixpoint, FRAME_CSP } from '../mailFrame.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:; form-action 'none'";
const CSP_REMOTE = "default-src 'none'; style-src 'unsafe-inline'; img-src data: cid: https:; font-src data:; form-action 'none'";

const parse = (s) => new DOMParser().parseFromString(s, 'text/html');
const build = (opts) => buildMailFrame({ html: null, text: null, allowRemote: false, theme: 'light', ...opts });
const cspOf = (doc) => doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');

const SHAPES = {
  ownHead: '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>News</title><style>p{color:red}</style></head><body bgcolor="#eee"><p>Hi</p></body></html>',
  htmlOnly: '<html><body><p>Hi</p></body></html>',
  leadingComment: '<!-- esp: 42 --><!DOCTYPE html><html><head><base href="https://evil.test/"></head><body><p>Hi</p></body></html>',
  fragment: '<p>Hi</p><img src="https://img.test/a.png">',
  headless: '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>Hi</p>',
  strayHead: '<p>before</p><head><meta http-equiv="refresh" content="0;url=https://evil.test/"></head><p>after</p>',
};

describe('buildMailFrame', () => {
  it('csp_is_first_in_head', () => {
    for (const [name, html] of Object.entries(SHAPES)) {
      const out = build({ html });
      const doc = parse(out);
      const first = doc.head.firstElementChild;
      expect(first?.tagName, name).toBe('META');
      expect(first.getAttribute('http-equiv'), name).toBe('Content-Security-Policy');
      expect(first.getAttribute('content'), name).toBe(CSP);
      // Textually first too: nothing of the mail precedes it in the source the webview parses.
      expect(out.indexOf('<meta http-equiv="Content-Security-Policy"'), name).toBeLessThan(out.indexOf('<body'));
      expect(out.slice(0, out.indexOf('<meta')).replace(/<!doctype html>|<html[^>]*>|<head>/gi, '').trim(), name).toBe('');
      // One base, ours: every link without a target leaves the frame.
      const bases = doc.querySelectorAll('base');
      expect(bases.length, name).toBe(1);
      expect(bases[0].getAttribute('target'), name).toBe('_blank');
      expect(bases[0].hasAttribute('href'), name).toBe(false);
    }
    const text = parse(build({ text: 'hello' }));
    expect(text.head.firstElementChild.getAttribute('content')).toBe(CSP);
    const empty = parse(build({}));
    expect(empty.head.firstElementChild.getAttribute('content')).toBe(CSP);
    expect(FRAME_CSP).toBe(CSP);
  });

  it('keeps the mail: its head styles, body attributes and lang survive', () => {
    const doc = parse(build({ html: SHAPES.ownHead }));
    expect(doc.documentElement.getAttribute('lang')).toBe('de');
    expect(doc.body.getAttribute('bgcolor')).toBe('#eee');
    expect([...doc.querySelectorAll('style')].some((s) => s.textContent.includes('p{color:red}'))).toBe(true);
    expect(doc.body.querySelector('p').textContent).toBe('Hi');
  });

  it('remote_images_blocked_unless_allowed', () => {
    const html = '<p>Hi</p><img src="https://img.test/a.png"><div style="background:url(https://img.test/b.png)"></div>';
    const blocked = parse(build({ html }));
    expect(cspOf(blocked)).toBe(CSP);
    expect(cspOf(blocked)).not.toMatch(/https?:/);
    // The URL stays in the document: the CSP blocks it, nothing rewrites it.
    expect(blocked.querySelector('img').getAttribute('src')).toBe('https://img.test/a.png');
    const allowed = parse(build({ html, allowRemote: true }));
    expect(cspOf(allowed)).toBe(CSP_REMOTE);
    expect(allowed.head.firstElementChild.getAttribute('content')).toBe(CSP_REMOTE);
    // Only https: is ever allowed, never plain http or a wildcard.
    expect(cspOf(allowed)).not.toMatch(/http:|\*/);
  });

  it('text_body_is_escaped', () => {
    const text = [
      '<script>alert(1)</script> & "quoted" \'single\'',
      '<img src=x onerror=alert(1)>',
      'See https://example.test/a?b=1&c=<2> and www.example.test/path.',
      'Mail ann@example.test, not javascript:alert(1) or data:text/html,hi or ftp://files.test/x',
      '"https://quote.test/x" onmouseover="alert(1)"',
    ].join('\n');
    const doc = parse(build({ text }));
    const pre = doc.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre.textContent).toBe(text);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('img')).toBeNull();
    const links = [...doc.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.test/a?b=1&c=',
      'https://www.example.test/path',
      'mailto:ann@example.test',
      'https://quote.test/x',
    ]);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect([...a.attributes].map((x) => x.name).sort()).toEqual(['href', 'rel']);
      expect(a.getAttribute('href')).toMatch(/^(https?:|mailto:)/);
    }
    expect(getComputedStyleText(doc)).toMatch(/white-space:\s*pre-wrap/);
  });

  it('script_and_meta_refresh_stay_inert', () => {
    const html = [
      '<head><meta http-equiv="refresh" content="0;url=https://evil.test/1">',
      "<META HTTP-EQUIV='Refresh' CONTENT='5; URL=https://evil.test/2'>",
      '<meta http-equiv=REFRESH content=0;url=https://evil.test/3>',
      '<meta content="0;url=https://evil.test/4" http-equiv="&#82;efresh">',
      '<base href="https://evil.test/" target="_self"><link rel="dns-prefetch" href="https://evil.test/">',
      '<script>top.location="https://evil.test/5"</script></head>',
      '<body><noscript><meta http-equiv="refresh" content="0;url=https://evil.test/6"></noscript>',
      '<a href="https://ok.test/" target="_self" ping="https://evil.test/ping">self</a>',
      '<a href="https://ok.test/2" target="_top">top</a><map><area href="https://ok.test/3" target="frame1"></map>',
      '<a href="https://ok.test/4">plain</a><form action="https://evil.test/f"><button>go</button></form>',
      '<a href="#top" target="_blank">to top</a>',
      '<a href="javascript:alert(1)">js</a><a href=" JavaScript:alert(2)" target="_blank">js2</a><a href="data:text/html,x">data</a>',
      '<svg><script>alert(1)</script></svg><base href="https://evil.test/late/"></body>',
    ].join('');
    const out = build({ html });
    const doc = parse(out);
    const csp = cspOf(doc);
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toMatch(/^default-src 'none';/);
    expect(csp).toMatch(/form-action 'none'/);
    const refresh = [...doc.querySelectorAll('meta')].filter((m) => /refresh/i.test(m.getAttribute('http-equiv') || ''));
    expect(refresh).toEqual([]);
    expect(out).not.toMatch(/evil\.test\/[1-6]/);
    expect(doc.querySelectorAll('meta[http-equiv]').length).toBe(1);
    expect(doc.querySelectorAll('script').length).toBe(0);
    expect(doc.querySelectorAll('link').length).toBe(0);
    const bases = doc.querySelectorAll('base');
    expect(bases.length).toBe(1);
    expect(bases[0].getAttribute('target')).toBe('_blank');
    // An explicit target would keep the page inside the frame: every one is rewritten.
    // Script and data URLs are no longer links at all.
    expect(out).not.toMatch(/javascript:|data:text/i);
    // ...and an in-page anchor only scrolls the frame.
    expect(doc.querySelector('a[href="#top"]').getAttribute('target')).toBe('_self');
    for (const a of doc.querySelectorAll('a[href]:not([href^="#"]), area[href]')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.hasAttribute('ping')).toBe(false);
    }
  });

  it('neutralizes the mail\'s own dark-scheme CSS on the light html canvas', () => {
    const html = '<style>@media (prefers-color-scheme: dark){.card{background:#111}}</style><style media="(prefers-color-scheme:dark)">p{color:#fff}</style><p>Talks about prefers-color-scheme: dark in prose</p>';
    for (const theme of ['light', 'dark']) {
      const doc = parse(build({ html, theme }));
      const css = [...doc.querySelectorAll('style')].map((s) => `${s.getAttribute('media') || ''} ${s.textContent}`).join('\n');
      expect(css).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
      expect(doc.body.querySelector('p').textContent).toContain('prefers-color-scheme: dark');
      expect(getComputedStyleText(doc)).toMatch(/color-scheme:\s*light/);
    }
  });

  it('a text body follows the app theme', () => {
    const light = getComputedStyleText(parse(build({ text: 'hi', theme: 'light' })));
    const dark = getComputedStyleText(parse(build({ text: 'hi', theme: 'dark' })));
    expect(light).toMatch(/color-scheme:\s*light/);
    expect(dark).toMatch(/color-scheme:\s*dark/);
    expect(light).not.toBe(dark);
  });

  it('labels the tracker marker in the UI language, CSS-escaped', () => {
    const html = '<p>x<span data-mv-tracker-blocked="tracker" style="color:#b45309">\u{1F6E1} </span></p>';
    const doc = parse(build({ html, trackerLabel: 'Tracker "blocked" </style><script>' }));
    const css = getComputedStyleText(doc);
    expect(css).toContain('[data-mv-tracker-blocked]::after');
    expect(css).toContain('content: "Tracker \\"blocked\\" \\3c /style>\\3c script>"');
    expect(doc.querySelectorAll('script').length).toBe(0);
    expect(doc.querySelectorAll('style').length).toBe(1);
  });

  it('drops declarative shadow roots and everything inside them', () => {
    const payload = [
      '<link rel="dns-prefetch" href="https://evil.test/sr1">',
      '<meta http-equiv="refresh" content="0;url=https://evil.test/sr2">',
      '<base href="https://evil.test/sr3">',
      '<a href="javascript:alert(1)" ping="https://evil.test/sr4" target="_self">js</a>',
      '<a href="data:text/html,x">data</a>',
      '<script>alert(1)</script>',
    ].join('');
    for (const attr of ['shadowrootmode="open"', 'shadowroot="open"', 'shadowrootmode="closed"']) {
      const out = build({ html: `<div><template ${attr}>${payload}</template><p>after</p></div>` });
      expect(out, attr).not.toMatch(/<template|shadowroot|evil\.test|javascript:|data:text/i);
      expect(parse(out).body.textContent, attr).toContain('after');
    }
  });

  it('removes nested browsing contexts and plugins', () => {
    const html = [
      '<iframe srcdoc="&lt;meta http-equiv=refresh content=0;url=https://evil.test/n1&gt;"></iframe>',
      '<iframe src="https://evil.test/n2"></iframe>',
      '<object data="https://evil.test/n4"><param name="x" value="y"></object>',
      '<embed src="https://evil.test/n5"><applet code="https://evil.test/n6"></applet>',
      '<portal src="https://evil.test/n7"></portal><p>kept</p>',
    ].join('');
    const out = build({ html });
    expect(out).not.toMatch(/<(iframe|frame|frameset|object|embed|applet|portal)\b|evil\.test/i);
    expect(parse(out).body.textContent).toContain('kept');
    const frames = build({ html: '<frameset><frame src="https://evil.test/f1"></frameset>' });
    expect(frames).not.toMatch(/<frame|evil\.test/i);
  });

  it('re-parses to a fixpoint: an mXSS shape cannot bring a removed element back', () => {
    const html = '<form><math><mtext></form><form><mglyph><style></math><img src=x>'
      + '<link rel="dns-prefetch" href="https://evil.test/m1"><meta http-equiv="refresh" content="0;url=https://evil.test/m2">'
      + '<iframe src="https://evil.test/m3"></iframe>';
    const out = build({ html });
    // What the frame parses is the serialization: parse it as the frame would, then again.
    for (const doc of [parse(out), parse(parse(out).documentElement.outerHTML)]) {
      expect(doc.querySelectorAll('link, iframe, script').length).toBe(0);
      expect([...doc.querySelectorAll('meta[http-equiv]')].map((m) => m.getAttribute('http-equiv'))).toEqual(['Content-Security-Policy']);
    }
  });

  it('falls back to the text body when the html never settles', () => {
    // A parser that keeps producing a script is a mail the cleaner cannot trust.
    const hostile = (src) => {
      const doc = new DOMParser().parseFromString(src, 'text/html');
      doc.body.append(doc.createElement('script'));
      return doc;
    };
    expect(cleanToFixpoint('<p>x</p>', hostile)).toBeNull();
    expect(cleanToFixpoint('<p>x</p>')).toContain('<p>x</p>');
    const doc = parse(buildMailFrame({ html: '<p>H</p>', text: 'plain T', theme: 'light', parse: hostile }));
    expect(doc.querySelector('pre').textContent).toBe('plain T');
    expect(doc.head.firstElementChild.getAttribute('content')).toBe(CSP);
    // No text part: the html's own text, escaped.
    const bare = parse(buildMailFrame({ html: '<p>only <b>html</b></p>', text: null, theme: 'light', parse: hostile }));
    expect(bare.querySelector('pre').textContent).toBe('only html');
    expect(bare.querySelector('b')).toBeNull();
  });

  it('strips ping everywhere and filters SVG links like html ones', () => {
    const html = [
      '<p ping="https://evil.test/p1">p</p><img src="data:image/png;base64,AAAA" ping="https://evil.test/p2">',
      '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a>',
      '<a href="data:text/html,x"><text>y</text></a>',
      '<a xlink:href="https://ok.test/svg" target="_self"><text>z</text></a>',
      '<a href="#local"><text>w</text></a>',
      '<use href="https://evil.test/s1#x"/><image href="https://evil.test/s2.png"/>',
      '<image xlink:href="data:image/png;base64,AAAA"/><use href="#sym"/></svg>',
    ].join('');
    const out = build({ html });
    const doc = parse(out);
    expect(doc.querySelectorAll('[ping]').length).toBe(0);
    expect(out).not.toMatch(/javascript:|data:text|evil\.test/i);
    const ok = [...doc.querySelectorAll('svg a')].find((a) => a.textContent === 'z');
    expect(ok.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || ok.getAttribute('href')).toBe('https://ok.test/svg');
    expect(ok.getAttribute('target')).toBe('_blank');
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toMatch(/href="#sym"/);
  });

  it('sends no referrer: the mail cannot ask for one', () => {
    const html = '<head><meta name="referrer" content="unsafe-url"><META NAME="Referrer" CONTENT="origin"></head><p>x</p>';
    const doc = parse(build({ html }));
    const metas = [...doc.querySelectorAll('meta')].filter((m) => /referrer/i.test(m.getAttribute('name') || ''));
    expect(metas.map((m) => m.getAttribute('content'))).toEqual(['no-referrer']);
    expect(doc.head.children[0].getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.head.children[1].getAttribute('name')).toBe('referrer');
    expect(parse(build({ text: 'x' })).head.children[1].getAttribute('content')).toBe('no-referrer');
  });

  it('prefers html over text and copes with neither', () => {
    expect(parse(build({ html: '<p>H</p>', text: 'T' })).body.textContent).toBe('H');
    expect(parse(build({ html: '', text: 'T' })).querySelector('pre').textContent).toBe('T');
    expect(() => build({ html: null, text: null })).not.toThrow();
  });
});

/** Our own stylesheet: the first `<style>` in <head>, right after the CSP and the base. */
function getComputedStyleText(doc) {
  return doc.head.querySelector('style[data-mv-frame]')?.textContent ?? '';
}

// A srcdoc frame inherits the app page's CSP on top of its own, so the app's policy must not undo
// the frame's: Tauri hashing mobile.html's inline <style> into style-src would switch off
// 'unsafe-inline' and drop every style in the mail, and without https: in img-src "Load images"
// could never load one.
describe('the app CSP the frame inherits', () => {
  const conf = JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri-mobile/tauri.conf.json'), 'utf8'));
  const csp = conf.app.security.csp;
  const directive = (name) => csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? [];

  it('keeps inline styles allowed: style-src is not rewritten with hashes', () => {
    expect(directive('style-src')).toContain("'unsafe-inline'");
    expect(conf.app.security.dangerousDisableAssetCspModification).toEqual(['style-src']);
  });

  it('allows https: images, so only the frame CSP decides when they load', () => {
    expect(directive('img-src')).toContain('https:');
    expect(directive('script-src')).toEqual(["'self'"]);
  });
});
