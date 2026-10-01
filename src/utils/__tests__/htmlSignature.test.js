// @vitest-environment jsdom
//
// A signature written as HTML the compose schema cannot hold (a generator's
// table layout, inline styles) is kept whole as one block: cleaned by an
// allowlist, carried through the compose editor byte for byte, and sent as
// written.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions, padEmptyLines, inlineComposeSpacing, htmlToText } from '../../components/RichTextEditor';
import { sanitizeSignatureHtml, prettyPrintSignatureHtml } from '../signatureSource';
import { swapSignature } from '../signatureCaret';
import { cleanSignatureMarkup, needsHtmlSignature, isHtmlSignature, unwrapSignatureHtml } from '../htmlSignature';

// The signature from the report: a coloured left border, spacing and a
// button-style link, all tables and inline styles.
const GENERATED = `<table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #333;">
  <tr><td style="border-left: 4px solid #ff7300; padding-left: 12px;">
    <div style="font-size: 18px; font-weight: bold;">Company</div>
    <div style="font-size: 12px; color: #777;">Email: <a href="mailto:me@example.com" style="color: #ff7300;">me@example.com</a></div>
    <table cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color: #ff7300;">
      <a href="https://example.com" style="display: inline-block; padding: 6px 12px; color: #fff;">example.com</a>
    </td></tr></table>
  </td></tr>
</table>`;

const editors = [];
const load = (content) => {
  const editor = new Editor({ extensions: editorExtensions(''), content });
  editors.push(editor);
  return editor;
};
afterEach(() => { while (editors.length) editors.pop().destroy(); });

describe('an HTML signature', () => {
  const stored = sanitizeSignatureHtml(GENERATED);

  it('keeps its tables, inline styles and link styling', () => {
    expect(isHtmlSignature(stored)).toBe(true);
    expect(stored).toContain('<table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, sans-serif; font-size: 13px; color: #333">');
    expect(stored).toContain('style="border-left: 4px solid #ff7300; padding-left: 12px"');
    expect(stored).toContain('<a href="https://example.com" style="display: inline-block; padding: 6px 12px; color: #fff">example.com</a>');
    expect(stored).toContain('style="background-color: #ff7300"');
  });

  it('is stable: sanitizing it again, or its Code view source, changes nothing', () => {
    expect(sanitizeSignatureHtml(stored)).toBe(stored);
    expect(sanitizeSignatureHtml(prettyPrintSignatureHtml(stored))).toBe(stored);
  });

  it('shows in Code view as the markup inside the block, never the block itself', () => {
    const source = prettyPrintSignatureHtml(stored);
    expect(source).not.toContain('data-mv-signature-html');
    expect(source).toContain('<table');
  });

  it('never nests a block in a block', () => {
    const again = sanitizeSignatureHtml(`<div data-mv-signature-html="">${GENERATED}</div>`);
    expect(again).toBe(stored);
    expect(again.match(/data-mv-signature-html/g)).toHaveLength(1);
  });

  it('goes through the compose editor byte for byte, so From can still swap it', () => {
    const block = '<p></p><p>--</p>' + stored;
    const body = padEmptyLines(load('<p>Hello</p>' + block).getHTML());
    expect(body).toContain(stored);
    const other = '<p></p><p>--</p><p>Other</p>';
    expect(swapSignature(body, block, other)).toBe('<p>Hello</p>' + other);
  });

  it('is one piece in the editor', () => {
    const editor = load(stored);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild.type.name).toBe('htmlSignature');
  });

  it('goes out as written: no padding or editor spacing added inside it', () => {
    const withParagraph = sanitizeSignatureHtml('<table><tr><td><p></p><p>Ann</p></td></tr></table>');
    expect(padEmptyLines(withParagraph)).toBe(withParagraph);
    const sent = inlineComposeSpacing('<p>Hi</p>' + withParagraph);
    expect(sent).toContain('<p style="margin: 0px 0px 0.25em;">Hi</p>');
    expect(sent).toContain('<td><p></p><p>Ann</p></td>');
  });

  it('gives a readable plain-text part', () => {
    const text = htmlToText(stored);
    expect(text).toContain('Company');
    expect(text).toContain('Email: me@example.com');
    expect(text).toContain('example.com');
  });
});

describe('cleanSignatureMarkup', () => {
  it('drops scripts, frames, forms and styles, and event handlers', () => {
    const clean = cleanSignatureMarkup(
      '<table onclick="x()"><tr><td onmouseover="x()">A<script>alert(1)</script></td></tr></table>'
      + '<style>body{display:none}</style><iframe src="https://evil.test"></iframe>'
      + '<form action="https://evil.test"><input name="p"><button>Go</button></form><svg onload="x()"></svg>');
    expect(clean).toBe('<table><tbody><tr><td>A</td></tr></tbody></table>');
  });

  it('keeps links to the web, mail and phone only', () => {
    const clean = cleanSignatureMarkup(
      '<a href="https://a.test">a</a><a href="mailto:a@b.test">b</a><a href="tel:+1">c</a>'
      + '<a href="javascript:alert(1)">d</a><a href=" JaVaScRiPt:alert(1)">e</a><a href="java&#9;script:alert(1)">f</a>'
      + '<a href="data:text/html,x">g</a>');
    expect(clean).toBe('<a href="https://a.test">a</a><a href="mailto:a@b.test">b</a><a href="tel:+1">c</a><a>d</a><a>e</a><a>f</a><a>g</a>');
  });

  it('keeps pictures from the web, cid or a data: image, and no other source', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const clean = cleanSignatureMarkup(
      `<img src="https://a.test/l.png"><img src="cid:logo"><img src="${png}"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="javascript:x">`);
    expect(clean).toBe(`<img src="https://a.test/l.png"><img src="cid:logo"><img src="${png}"><img><img>`);
  });

  it('drops style declarations that load, run or leave the block', () => {
    const clean = cleanSignatureMarkup(
      '<div style="color: red; background: url(https://track.test/p.gif); position: fixed; top: 0; width: expression(alert(1)); z-index: 9; font-size: 12px">x</div>');
    expect(clean).toBe('<div style="color: red; font-size: 12px">x</div>');
  });

  it('drops attributes it does not know, ids, classes and data attributes included', () => {
    expect(cleanSignatureMarkup('<td id="a" class="b" data-x="c" width="10" bgcolor="#fff">x</td>'))
      .toBe('x');
    expect(cleanSignatureMarkup('<table><tr><td id="a" class="b" data-x="c" width="10" bgcolor="#fff">x</td></tr></table>'))
      .toBe('<table><tbody><tr><td width="10" bgcolor="#fff">x</td></tr></tbody></table>');
  });

  it('keeps the words of tags it does not list', () => {
    expect(cleanSignatureMarkup('<section><article>Ann</article></section>')).toBe('Ann');
  });
});

describe('the HTML signature block', () => {
  it('is cleaned when read from quoted mail, not trusted for coming from a block', () => {
    const editor = load('<p>Reply</p><blockquote><div data-mv-signature-html=""><img src="x" onerror="alert(1)"><a href="javascript:x()">y</a><table><tr><td style="color: red">z</td></tr></table></div></blockquote>');
    const html = editor.getHTML();
    expect(html).not.toMatch(/onerror|javascript:/);
    expect(html).toContain('<td style="color: red">z</td>');
  });

  it('is not used for what the schema holds on its own', () => {
    const plain = '<p><strong>Ann</strong> <a target="_blank" rel="noopener noreferrer nofollow" href="https://a.test">site</a></p>'
      + '<p><span style="font-family: Georgia, serif;">Lee</span></p><p><img src="https://a.test/l.png" width="64" height="32"></p>'
      + '<ul><li><p>one</p></li></ul><pre><code>a</code></pre><blockquote><p>q</p></blockquote><div>line</div>';
    expect(needsHtmlSignature(cleanSignatureMarkup(plain))).toBe(false);
    expect(isHtmlSignature(sanitizeSignatureHtml(plain))).toBe(false);
  });

  it('is used for a styled span or a table', () => {
    expect(needsHtmlSignature('<p><span style="color: red">x</span></p>')).toBe(true);
    expect(needsHtmlSignature('<table><tbody><tr><td>x</td></tr></tbody></table>')).toBe(true);
  });

  it('unwraps back to its markup', () => {
    expect(unwrapSignatureHtml('<div data-mv-signature-html=""><b>x</b></div>')).toBe('<b>x</b>');
    expect(unwrapSignatureHtml('<p>plain</p>')).toBe('<p>plain</p>');
  });
});

describe('a link inside the HTML signature block', () => {
  it('is not followed on click, so the window keeps the draft', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions: editorExtensions(''), content: sanitizeSignatureHtml(GENERATED) });
    editors.push(editor);
    const a = editor.view.dom.querySelector('[data-mv-signature-html] a[href^="https:"]');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    element.remove();
  });
});
