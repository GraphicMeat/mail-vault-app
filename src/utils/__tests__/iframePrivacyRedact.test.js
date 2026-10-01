// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildNameDictionary } from '../privacy/piiDetector';
import { applyPrivacyRedaction, restorePrivacyRedaction, releasePrivacyGate, isPrivacyGated, PRIVACY_GATE_ID } from '../iframePrivacyRedact';
import { applySearchHighlight, clearSearchHighlight } from '../iframeSearchHighlight';
import { buildEmailIframeHtml } from '../emailIframeTemplate';

const dict = buildNameDictionary({ names: ['John Smith'] });
const docOf = (body) => new DOMParser().parseFromString(buildEmailIframeHtml({ bodyHtml: body, privacy: true }), 'text/html');

describe('iframe privacy redaction', () => {
  it('the srcDoc starts gated when privacy is on, and not otherwise', () => {
    expect(docOf('<p>x</p>').getElementById(PRIVACY_GATE_ID)).toBeTruthy();
    const plain = new DOMParser().parseFromString(buildEmailIframeHtml({ bodyHtml: '<p>x</p>' }), 'text/html');
    expect(plain.getElementById(PRIVACY_GATE_ID)).toBeNull();
  });
  it('masks, releases the gate, and never leaves the original in the DOM', () => {
    const doc = docOf('<p>From John Smith <a href="mailto:j@x.com">j@x.com</a></p>');
    applyPrivacyRedaction(doc, dict);
    expect(doc.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(doc.body.innerHTML).not.toMatch(/John|Smith|j@x\.com/);
  });
  it('restore puts back text and attributes exactly', () => {
    const doc = docOf('<p>From John Smith <a href="mailto:j@x.com" title="John Smith">mail</a></p>');
    const text = doc.body.textContent;
    applyPrivacyRedaction(doc, dict);
    expect(doc.querySelector('a').getAttribute('title')).not.toMatch(/John|Smith/);
    restorePrivacyRedaction(doc);
    expect(doc.body.textContent).toBe(text);
    expect(doc.querySelector('a').getAttribute('href')).toBe('mailto:j@x.com');
    expect(doc.querySelector('a').getAttribute('title')).toBe('John Smith');
  });
  it('search highlight never reveals a masked word, and clearing search keeps it masked', () => {
    const doc = docOf('<p>Meeting with John Smith today</p>');
    applyPrivacyRedaction(doc, dict);
    expect(applySearchHighlight(doc, ['smith'])).toBe(0);
    applySearchHighlight(doc, ['meeting']);
    clearSearchHighlight(doc);
    expect(doc.body.textContent).not.toMatch(/John|Smith/);
  });
  it('releasing the gate alone is safe on a document without one', () => {
    const doc = docOf('<p>x</p>');
    releasePrivacyGate(doc);
    expect(() => releasePrivacyGate(doc)).not.toThrow();
    expect(doc.getElementById(PRIVACY_GATE_ID)).toBeNull();
  });
  it('our <html> carries the gate inline until release, and a plain frame never does', () => {
    const doc = docOf('<p>John Smith</p>');
    expect(doc.documentElement.getAttribute('style')).toBe('opacity:0!important');
    applyPrivacyRedaction(doc, dict);
    expect(doc.documentElement.hasAttribute('style')).toBe(false);
    const plain = new DOMParser().parseFromString(buildEmailIframeHtml({ bodyHtml: '<p>x</p>' }), 'text/html');
    expect(plain.documentElement.hasAttribute('style')).toBe(false);
  });
  it("a mail's nested <html style> leaves the frame gated", () => {
    // Browsers keep an attribute <html> already has (HTML spec, "in body", an
    // html start tag adds only missing attributes). jsdom's parser overwrites it,
    // so here only the head gate is asserted; it alone still hides the body.
    const doc = docOf('<blockquote><html style="opacity:1"><body><p>quoted</p></body></html></blockquote>');
    expect(doc.head.querySelector(`style#${PRIVACY_GATE_ID}`)).not.toBeNull();
    expect(isPrivacyGated(doc)).toBe(true);
  });
  it('releases the inline gate even after a script re-serialized our <html> style', () => {
    const doc = docOf('<p>x</p>');
    doc.documentElement.style.setProperty('color', 'red');
    applyPrivacyRedaction(doc, dict);
    expect(doc.documentElement.style.getPropertyValue('opacity')).toBe('');
    expect(doc.documentElement.style.getPropertyValue('color')).toBe('red');
  });
});
