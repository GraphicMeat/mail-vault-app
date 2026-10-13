// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../iframeQuoteFolding';
import { quoteFoldTargets, signatureFoldTargets, styleQuoteToggle, isDarkBackground, QUOTE_TOGGLE_CSS, QUOTE_TOGGLE_DARK } from '../foldDetection';
import GMAIL_REPLY from './fixtures/quote-fold-gmail-reply.html?raw';

const FIXTURES = {
  gmail: GMAIL_REPLY,
  fastmail: `<div>Hi Rokas,</div><div><br></div><div>Two more things</div>
    <div><b>Original Message</b><br>From: Ben &lt;ben@fea.st&gt;<br>Date: Aug 22</div>
    <div>Good morning!</div><div>So much for it</div>`,
  outlook: `<div>Reply text.</div><div id="appendonsend"></div><hr>
    <div id="divRplyFwdMsg"><b>From:</b> Person A<br>
    <b>Sent:</b> Friday</div><div>Quoted text.</div>`,
  adjacent: '<p>Reply text.</p><blockquote><p>First.</p></blockquote>\n<br><blockquote><p>Second.</p></blockquote>',
  allQuote: '<div dir="ltr"><br></div><blockquote class="gmail_quote"><div>Quoted.</div></blockquote>',
  signature: '<p>Body.</p><div class="gmail_signature"><div>Person B</div></div>',
  none: '<div>Just a message.</div>',
};

/** The iframe path: the real injected scripts, run as the frame runs them. */
function viaScripts(html, mode) {
  document.body.innerHTML = html;
  for (const js of [getQuoteFoldingScript(), getSignatureFoldingScript(mode)]) {
    // eslint-disable-next-line no-new-func
    if (js) new Function(js.replace(/<\/?script>/g, ''))();
  }
  return document.body.innerHTML;
}

/** The pre-pass path: the shared functions on an inert DOMParser document. */
function viaShared(html, mode) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const dark = isDarkBackground(getComputedStyle(document.body).backgroundColor);
  for (const el of quoteFoldTargets(doc)) {
    el.dataset.quoteFolded = 'true';
    el.style.display = 'none';
    const toggle = doc.createElement('div');
    toggle.dataset.quoteToggle = 'true';
    toggle.textContent = '⋯';
    toggle.title = 'Show quoted text';
    styleQuoteToggle(toggle, dark);
    el.parentNode.insertBefore(toggle, el);
  }
  if (mode !== 'always-show') {
    for (const el of signatureFoldTargets(doc)) {
      el.dataset.sigFolded = 'true';
      el.style.display = 'none';
      if (mode === 'always-hide') continue;
      const toggle = doc.createElement('div');
      toggle.textContent = '▸ Show signature';
      toggle.style.cssText = 'cursor:pointer;color:#9ca3af;font-size:12px;margin:4px 0;user-select:none;';
      el.parentNode.insertBefore(toggle, el);
    }
  }
  return doc.body.innerHTML;
}

describe('fold detection: one source for the iframe and the pre-pass', () => {
  for (const [name, html] of Object.entries(FIXTURES)) {
    for (const mode of ['smart', 'collapsed', 'always-hide', 'always-show']) {
      it(`${name} / ${mode}: same DOM both ways`, () => {
        const shared = viaShared(html, mode);
        expect(shared).toBe(viaScripts(html, mode));
        // A detector that folds nothing would agree with itself: pin that it folds.
        if (['gmail', 'fastmail', 'outlook', 'adjacent'].includes(name)) expect(shared).toContain('data-quote-folded');
        if (name === 'signature' && mode !== 'always-show') expect(shared).toContain('data-sig-folded');
      });
    }
  }

  it('the injected script inlines the shared source, without export or import', () => {
    const js = getQuoteFoldingScript();
    expect(js).toContain('function quoteFoldTargets(');
    expect(js).not.toMatch(/^\s*export\s/m);
    expect(js).not.toMatch(/\bimport\s/);
  });

  it('quote toggle styling is the exact cssText the script always wrote', () => {
    expect(QUOTE_TOGGLE_CSS).toBe('cursor:pointer;color:#6b7280;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:4px;padding:2px 10px;margin:6px 0;display:inline-block;font-size:13px;user-select:none;');
  });

  it('styleQuoteToggle(el, true) writes the dark style', () => {
    const expected = document.createElement('div');
    expected.style.cssText = QUOTE_TOGGLE_CSS;
    expected.style.background = QUOTE_TOGGLE_DARK.background;
    expected.style.color = QUOTE_TOGGLE_DARK.color;
    expected.style.borderColor = QUOTE_TOGGLE_DARK.borderColor;
    const dark = document.createElement('div');
    styleQuoteToggle(dark, true);
    expect(dark.style.cssText).toBe(expected.style.cssText);
    const light = document.createElement('div');
    styleQuoteToggle(light, false);
    expect(light.style.cssText).not.toBe(dark.style.cssText);
    expect(dark.style.color).not.toBe(light.style.color);
  });

  it('isDarkBackground keeps the script quirk: transparent reads as dark', () => {
    expect(isDarkBackground('rgb(255, 255, 255)')).toBe(false);
    expect(isDarkBackground('rgb(24, 26, 27)')).toBe(true);
    expect(isDarkBackground('rgba(0, 0, 0, 0)')).toBe(true);
    expect(isDarkBackground('')).toBe(false);
  });
});
