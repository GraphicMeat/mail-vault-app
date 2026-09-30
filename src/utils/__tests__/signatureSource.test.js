// @vitest-environment jsdom
//
// The signature editor's Code view: the signature's HTML as text, edited by
// hand, and read back through the editor's own schema. That schema is the
// only sanitizer a signature passes through, so nothing typed in Code view
// may reach the stored signature without going through it.
import { describe, it, expect } from 'vitest';
import {
  sanitizeSignatureHtml, prettyPrintSignatureHtml,
  initialSignatureSource, signatureSourceReducer,
} from '../signatureSource';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LINK = '<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.test/a">site</a>';

describe('sanitizeSignatureHtml', () => {
  it('keeps what the editor supports, image, link and formatting included', () => {
    const html = `<p><strong>Ann</strong> <em>Lee</em> <u>CEO</u></p><p>${LINK}</p><p><img src="${PNG}" width="64" height="32"></p><ul><li><p>one</p></li></ul>`;
    const clean = sanitizeSignatureHtml(html);
    expect(clean).toContain('<strong>Ann</strong>');
    expect(clean).toContain('<em>Lee</em>');
    expect(clean).toContain('<u>CEO</u>');
    expect(clean).toContain('href="https://example.test/a"');
    expect(clean).toContain(`src="${PNG}"`);
    expect(clean).toContain('width="64"');
    expect(clean).toContain('<li><p>one</p></li>');
  });

  it('is stable: sanitizing its own output changes nothing', () => {
    const once = sanitizeSignatureHtml(`<p>Hi</p><p><br></p><p>${LINK}</p><p><img src="${PNG}"></p>`);
    expect(sanitizeSignatureHtml(once)).toBe(once);
  });

  it('removes scripts, event handlers, styles and unsafe link targets', () => {
    const clean = sanitizeSignatureHtml(
      '<p onclick="steal()">Hi<script>alert(1)</script></p><style>p{color:red}</style>'
      + '<p><a href="javascript:alert(1)">x</a></p><p><img src="x" onerror="alert(1)"></p><iframe src="https://evil.test"></iframe>');
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|<style|<iframe|evil\.test/i);
    expect(clean).toContain('Hi');
  });

  it('keeps the words of markup it does not support', () => {
    const clean = sanitizeSignatureHtml('<table><tr><td>Ann</td><td>Lee</td></tr></table><div><span style="color:red">Sales</span></div>');
    expect(clean).toContain('Ann');
    expect(clean).toContain('Lee');
    expect(clean).toContain('Sales');
    expect(clean).not.toMatch(/<table|<td|<span|style=/);
  });

  it('closes broken markup instead of failing', () => {
    expect(sanitizeSignatureHtml('<p>open <strong>bold')).toBe('<p>open <strong>bold</strong></p>');
    expect(() => sanitizeSignatureHtml('<<<p>>> </ </p')).not.toThrow();
  });

  it('gives an empty signature back as empty', () => {
    expect(sanitizeSignatureHtml('')).toBe('');
    expect(sanitizeSignatureHtml(undefined)).toBe('');
    expect(sanitizeSignatureHtml(null)).toBe('');
  });

  it('never throws, and falls back to the text it was given a fallback for', () => {
    expect(() => sanitizeSignatureHtml({ not: 'a string' })).not.toThrow();
    expect(sanitizeSignatureHtml({ not: 'a string' }, '<p>kept</p>')).toBe('<p>kept</p>');
  });
});

describe('prettyPrintSignatureHtml', () => {
  it('puts each block on its own line', () => {
    expect(prettyPrintSignatureHtml('<p>Ann</p><p>Lee</p><ul><li><p>a</p></li><li><p>b</p></li></ul>'))
      .toBe('<p>Ann</p>\n<p>Lee</p>\n<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
  });

  it('reads back as exactly the HTML it was made from', () => {
    const html = sanitizeSignatureHtml(`<p><strong>Ann</strong></p><p><br></p><blockquote><p>q</p></blockquote><pre><code>a\n  b</code></pre><ol><li><p>x</p></li></ol><p>${LINK}<br>tail</p><p><img src="${PNG}"></p>`);
    expect(sanitizeSignatureHtml(prettyPrintSignatureHtml(html))).toBe(html);
  });

  it('leaves an empty signature empty', () => {
    expect(prettyPrintSignatureHtml('')).toBe('');
    expect(prettyPrintSignatureHtml(undefined)).toBe('');
  });
});

describe('the Rendered / Code state', () => {
  const start = initialSignatureSource('<p>Ann</p><p>Lee</p>');

  it('starts in Rendered view with nothing drafted', () => {
    expect(start).toEqual({ mode: 'rendered', html: '<p>Ann</p><p>Lee</p>', draft: '' });
  });

  it('shows the signature as source on entering Code view', () => {
    const code = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    expect(code.mode).toBe('code');
    expect(code.draft).toBe('<p>Ann</p>\n<p>Lee</p>');
    expect(code.html).toBe(start.html);
  });

  it('keeps the stored HTML sanitized while the source is edited, and the draft as typed', () => {
    const code = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    const typed = signatureSourceReducer(code, { type: 'draft', draft: '<p>Ann <script>x()</script><b>Lee' });
    expect(typed.draft).toBe('<p>Ann <script>x()</script><b>Lee');
    expect(typed.html).toBe('<p>Ann <strong>Lee</strong></p>');
    expect(typed.html).not.toMatch(/script/);
  });

  it('keeps the last good HTML when a draft cannot be read', () => {
    const code = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    const typed = signatureSourceReducer(code, { type: 'draft', draft: { broken: true } });
    expect(typed.html).toBe(start.html);
  });

  it('drops the draft on returning to Rendered view and shows the sanitized HTML', () => {
    let s = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    s = signatureSourceReducer(s, { type: 'draft', draft: '<div onclick="x()">Hi</div>' });
    s = signatureSourceReducer(s, { type: 'mode', mode: 'rendered' });
    expect(s).toEqual({ mode: 'rendered', html: '<p>Hi</p>', draft: '' });
  });

  it('follows edits made in the rendered editor', () => {
    const s = signatureSourceReducer(start, { type: 'html', html: '<p>New</p>' });
    expect(s.html).toBe('<p>New</p>');
    expect(s.mode).toBe('rendered');
  });

  it('ignores a request for the view it is already in, and for one that does not exist', () => {
    expect(signatureSourceReducer(start, { type: 'mode', mode: 'rendered' })).toBe(start);
    expect(signatureSourceReducer(start, { type: 'mode', mode: 'nope' })).toBe(start);
    const code = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    expect(signatureSourceReducer(code, { type: 'mode', mode: 'code' })).toBe(code);
  });

  it('takes the HTML from outside as the new signature and leaves Code view', () => {
    const code = signatureSourceReducer(start, { type: 'mode', mode: 'code' });
    expect(signatureSourceReducer(code, { type: 'external', html: '<p>Other</p>' }))
      .toEqual({ mode: 'rendered', html: '<p>Other</p>', draft: '' });
  });
});
