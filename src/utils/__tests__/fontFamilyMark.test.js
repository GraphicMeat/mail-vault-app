// @vitest-environment jsdom
// A font chosen for a signature travels as an inline `font-family` on a span,
// through the same editor schema the compose window and the Code view use.
// Only family names and generic keywords get through: no URL, no @import, no
// @font-face and no other declaration can ride along into sent mail.
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions, padEmptyLines } from '../../components/RichTextEditor';
import { sanitizeFontFamily } from '../fontFamilyMark';
import { sanitizeSignatureHtml, setSignatureFont } from '../signatureSource';
import { swapSignature } from '../signatureCaret';

const load = html => {
  const editor = new Editor({ extensions: editorExtensions(''), content: html });
  try { return padEmptyLines(editor.getHTML()); } finally { editor.destroy(); }
};

describe('sanitizeFontFamily', () => {
  it('writes one canonical list, as the CSSOM does: plain words bare, anything else double-quoted', () => {
    expect(sanitizeFontFamily('Lora, Georgia, serif')).toBe('Lora, Georgia, serif');
    expect(sanitizeFontFamily(`'Open Sans',Arial ,  sans-serif`)).toBe('"Open Sans", Arial, sans-serif');
    expect(sanitizeFontFamily("'Times New Roman', Times, serif")).toBe('"Times New Roman", Times, serif');
    expect(sanitizeFontFamily('-apple-system, BlinkMacSystemFont, "Segoe UI"')).toBe('-apple-system, BlinkMacSystemFont, "Segoe UI"');
    expect(sanitizeFontFamily('"Source Serif 4", 微软雅黑')).toBe('"Source Serif 4", "微软雅黑"');
  });

  it('drops every entry that is not a plain name', () => {
    expect(sanitizeFontFamily('url(https://evil.test/f.woff2)')).toBe('');
    expect(sanitizeFontFamily('Arial; } @import url(https://evil.test/x.css)')).toBe('Arial');
    expect(sanitizeFontFamily('Arial, expression(alert(1)), serif')).toBe('Arial, serif');
    expect(sanitizeFontFamily('"a\\"b", Arial')).toBe('Arial');
    expect(sanitizeFontFamily('')).toBe('');
    expect(sanitizeFontFamily(undefined)).toBe('');
    expect(sanitizeFontFamily(Array(20).fill('Arial').join(', ')).split(',').length).toBe(8);
  });
});

describe('the fontFamily mark in the editor schema', () => {
  const styled = '<p><span style="font-family: Lora, Georgia, &quot;Times New Roman&quot;, serif;">Ann Lee</span></p>';

  it('keeps a font span exactly as written', () => {
    expect(load(styled)).toBe(styled);
  });

  it('reads another spelling into the canonical one, and keeps nothing else of the style', () => {
    expect(load('<p><span style="color: red; font-family: &quot;Open Sans&quot;, Arial; font-size: 40px">Hi</span></p>'))
      .toBe('<p><span style="font-family: &quot;Open Sans&quot;, Arial;">Hi</span></p>');
  });

  it('never lets a URL, an @import or an @font-face out', () => {
    const out = load([
      '<p><span style="font-family: url(https://evil.test/f.woff2)">a</span></p>',
      '<p><span style="font-family: Arial; } @import url(https://evil.test/x.css); {">b</span></p>',
      '<style>@font-face { font-family: X; src: url(https://evil.test/x.woff2) }</style><p>c</p>',
    ].join(''));
    expect(out).not.toMatch(/url\(|@import|@font-face|evil/);
    expect(out).toBe('<p>a</p><p><span style="font-family: Arial;">b</span></p><p>c</p>');
  });

  it('is stable: the sanitized signature sanitizes to itself', () => {
    const once = sanitizeSignatureHtml(`<p><span style='font-family:"Open Sans",Arial'>Ann</span></p><p>Lee</p>`);
    expect(once).toBe('<p><span style="font-family: &quot;Open Sans&quot;, Arial;">Ann</span></p><p>Lee</p>');
    expect(sanitizeSignatureHtml(once)).toBe(once);
  });
});

describe('setSignatureFont', () => {
  it('sets the whole signature in one family, over any earlier choice', () => {
    const html = setSignatureFont('<p>Ann</p><p><strong>Lee</strong></p>', "Lora, Georgia, serif");
    expect(html).toBe('<p><span style="font-family: Lora, Georgia, serif;">Ann</span></p><p><strong><span style="font-family: Lora, Georgia, serif;">Lee</span></strong></p>');
    expect(setSignatureFont(html, 'Arial, Helvetica, sans-serif')).not.toContain('Lora');
  });

  it('clears the font with an empty stack', () => {
    expect(setSignatureFont(`<p><span style="font-family: Lora, serif">Ann</span></p>`, '')).toBe('<p>Ann</p>');
  });
});

describe('a styled signature in compose', () => {
  it('is found again when the From address swaps it', () => {
    const sig = sanitizeSignatureHtml(`<p><span style="font-family: Lora, Georgia, serif">Ann</span></p>`);
    const other = sanitizeSignatureHtml(`<p><span style="font-family: 'Open Sans', Arial">Desk</span></p>`);
    const block = s => `<p></p><p>--</p>${s}`;
    // The body as the compose editor hands it back after loading it.
    const body = load(`<p>Hello</p>${block(sig)}`);
    expect(swapSignature(body, block(sig), block(other))).toBe(`<p>Hello</p>${block(other)}`);
  });
});
