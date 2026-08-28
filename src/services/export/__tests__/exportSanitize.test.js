// @vitest-environment jsdom
//
// sanitizeForExport parses with DOMParser, which the default node environment
// does not provide. vitest.config.js only maps src/components/** to jsdom, so
// every service spec that touches the DOM says so itself.
import { describe, it, expect } from 'vitest';
import { sanitizeForExport } from '../exportSanitize';

describe('sanitizeForExport', () => {
  it('keeps the legitimate body intact', () => {
    const out = sanitizeForExport('<p>Hello <b>Ana</b></p><img src="https://x.test/a.png">');
    expect(out).toContain('Hello');
    expect(out).toContain('<b>Ana</b>');
    expect(out).toContain('https://x.test/a.png');
  });

  it('removes script elements and their content', () => {
    const out = sanitizeForExport('<p>a</p><script>window.x = 1</script><p>b</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('window.x');
    expect(out).toContain('<p>a</p>');
    expect(out).toContain('<p>b</p>');
  });

  it('removes a script hidden inside a comment-looking wrapper', () => {
    const out = sanitizeForExport('<div><!-- --><script>alert(1)</script></div>');
    expect(out).not.toContain('alert(1)');
  });

  it('removes on* event handler attributes', () => {
    const out = sanitizeForExport('<img src="a.png" onerror="alert(1)"><div onclick="x()">t</div>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('onclick');
    expect(out).toContain('src="a.png"');
  });

  it('removes javascript: and vbscript: urls but keeps https ones', () => {
    const out = sanitizeForExport('<a href="javascript:alert(1)">x</a><a href="https://ok.test">y</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('https://ok.test');
  });

  it('ignores whitespace and case when detecting javascript urls', () => {
    const out = sanitizeForExport('<a href="  JaVaScRiPt:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('removes nested browsing contexts and plugins', () => {
    const out = sanitizeForExport('<iframe src="https://x.test"></iframe><object data="x"></object><embed src="x">');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
  });

  it('removes meta refresh and base', () => {
    const out = sanitizeForExport('<meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test">');
    expect(out).not.toContain('http-equiv');
    expect(out).not.toContain('<base');
  });

  it('handles empty and null input', () => {
    expect(sanitizeForExport('')).toBe('');
    expect(sanitizeForExport(null)).toBe('');
  });
});
