// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildEmailIframeHtml,
  emailScriptNonce,
} from '../emailIframeTemplate';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../iframeQuoteFolding';
import { getDarkReaderInlineScripts } from '../darkReaderInject';

// The reading-pane frames carry `allow-scripts allow-same-origin`, which is no
// sandbox at all: the frame runs whatever the mail carries and reaches the
// parent's IPC bridge. The per-render CSP <meta> is what makes email-authored
// script inert while our own (Dark Reader, quote/signature folding) still runs.
//
// These specs assert the SHAPE of the document. WebKit's ENFORCEMENT of a meta
// CSP for srcdoc and for the file:// popup is proven by the e2e
// (connected-reading-pane-script) — a shape test cannot stand in for it.

/** The script-src value of the first CSP <meta> in the document head. */
function scriptSrc(html) {
  const m = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i,
  );
  if (!m) return null;
  const dir = m[1].split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  return dir || null;
}

describe('emailScriptNonce', () => {
  it('is unguessable per render — two calls never collide', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(emailScriptNonce());
    expect(seen.size).toBe(200);
    // Long enough that a static email cannot brute-force it into its own markup.
    for (const n of seen) expect(n.length).toBeGreaterThanOrEqual(16);
  });

  it('is a bare token safe to drop into a CSP source and an attribute', () => {
    for (let i = 0; i < 20; i++) {
      expect(emailScriptNonce()).toMatch(/^[A-Za-z0-9+/=_-]+$/);
    }
  });
});

describe('buildEmailIframeHtml CSP', () => {
  it('emits a script-src nonce CSP meta as the first element in <head>', () => {
    const out = buildEmailIframeHtml({ bodyHtml: '<p>hi</p>' });
    const headInner = out.match(/<head>([\s\S]*?)<\/head>/i)[1];
    const firstTag = headInner.trim().match(/^<meta[^>]*>/i)[0];
    expect(firstTag).toMatch(/http-equiv="Content-Security-Policy"/i);
    expect(scriptSrc(out)).toMatch(/^script-src 'nonce-[A-Za-z0-9+/=_-]+'$/);
  });

  it('never weakens script-src with unsafe-inline or unsafe-eval', () => {
    const src = scriptSrc(buildEmailIframeHtml({ bodyHtml: '<p>hi</p>', themeTag: 'dark' }));
    expect(src).not.toMatch(/unsafe-inline/);
    expect(src).not.toMatch(/unsafe-eval/);
  });

  it('does not stamp the nonce on script or handlers the mail body carries', () => {
    const body = '<img src="x" onerror="window.__pwn=1">'
      + '<script>window.__pwn2=1<\/script>';
    const out = buildEmailIframeHtml({ bodyHtml: body });
    const nonce = scriptSrc(out).match(/nonce-([A-Za-z0-9+/=_-]+)/)[1];
    // The body is reproduced verbatim; its script gains no nonce, so the CSP
    // blocks it, and the inline handler is inert without unsafe-inline.
    expect(out).toContain('onerror="window.__pwn=1"');
    expect(out).toContain('<script>window.__pwn2=1<\/script>');
    // No app-authored (nonced) script tag was introduced for this bare body.
    expect(out).not.toContain(`nonce="${nonce}"`);
  });

  it('gives our own head/body scripts the SAME nonce the meta grants', () => {
    const nonce = emailScriptNonce();
    const out = buildEmailIframeHtml({
      bodyHtml: '<p>hi</p>',
      themeTag: 'dark',
      nonce,
      extraHead: getDarkReaderInlineScripts({ palette: 'indigo', nonce }),
      extraBody: `${getQuoteFoldingScript(nonce)}${getSignatureFoldingScript('collapsed', nonce)}`,
    });
    expect(scriptSrc(out)).toBe(`script-src 'nonce-${nonce}'`);
    // Every <script> in the document that is ours carries the nonce.
    const scripts = out.match(/<script\b[^>]*>/gi) || [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  });
});

describe('fold scripts accept the render nonce', () => {
  it('getQuoteFoldingScript stamps the nonce on its <script>', () => {
    expect(getQuoteFoldingScript('N0NCE')).toMatch(/<script nonce="N0NCE">/);
  });
  it('getSignatureFoldingScript stamps the nonce on its <script>', () => {
    expect(getSignatureFoldingScript('collapsed', 'N0NCE')).toMatch(/<script nonce="N0NCE">/);
  });
});

describe('Dark Reader inline scripts accept the render nonce', () => {
  it('stamps the nonce on every <script> tag it emits', () => {
    const out = getDarkReaderInlineScripts({ palette: 'indigo', nonce: 'N0NCE' });
    const scripts = out.match(/<script\b[^>]*>/gi) || [];
    expect(scripts.length).toBe(2);
    for (const tag of scripts) expect(tag).toContain('nonce="N0NCE"');
  });
});
