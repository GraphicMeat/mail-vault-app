// @vitest-environment jsdom
//
// Blank lines and line breaks, in and out of the compose editor. TipTap keeps
// an empty line out of its HTML (`<p></p>`, a bare `<br>` ending a paragraph)
// and draws it on screen with a <br> of ProseMirror's own. Outside the editor
// neither has any height, so a message typed with blank lines between its
// paragraphs arrived as one block of text. These run the real schema.

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions, padEmptyLines, textToHtml } from '../RichTextEditor';

let editor = null;
const load = (content) => {
  editor = new Editor({ extensions: editorExtensions(), content });
  return editor;
};
afterEach(() => { editor?.destroy(); editor = null; });

const doc = (...content) => ({ type: 'doc', content });
const P = (...content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const text = (value, marks) => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const br = (marks) => (marks ? { type: 'hardBreak', marks } : { type: 'hardBreak' });
const UL = (...items) => ({ type: 'bulletList', content: items.map((p) => ({ type: 'listItem', content: [p] })) });
const bold = [{ type: 'bold' }];

describe('padEmptyLines', () => {
  it('gives an empty paragraph the <br> that holds its line open', () => {
    expect(padEmptyLines('<p>Lorem ipsum</p><p></p><p>dolor</p>'))
      .toBe('<p>Lorem ipsum</p><p><br></p><p>dolor</p>');
  });

  it('keeps a line break that ends a paragraph from collapsing', () => {
    expect(padEmptyLines('<p>Hey Ben,<br></p>')).toBe('<p>Hey Ben,<br><br></p>');
  });

  it('looks through a mark wrapped around that line break', () => {
    expect(padEmptyLines('<p><strong>Hey<br></strong></p>')).toBe('<p><strong>Hey<br></strong><br></p>');
  });

  it('pads empty paragraphs inside lists and quotes too', () => {
    expect(padEmptyLines('<ul><li><p></p></li></ul><blockquote><p></p></blockquote>'))
      .toBe('<ul><li><p><br></p></li></ul><blockquote><p><br></p></blockquote>');
  });

  it('leaves a paragraph that ends in text, a link or a picture alone', () => {
    const html = '<p>a<br>b</p><p><a href="https://x.dev">x</a></p><p><img src="cid:one"></p>';
    expect(padEmptyLines(html)).toBe(html);
  });

  it('passes empty input through', () => {
    expect(padEmptyLines('')).toBe('');
    expect(padEmptyLines(undefined)).toBe(undefined);
  });
});

describe('reading mail HTML into the editor', () => {
  it('reads <p><br></p> as one blank line, not a line break inside a blank line', () => {
    load('<p>a</p><p><br></p><p>b</p>');
    expect(editor.getJSON()).toEqual(doc(P(text('a')), P(), P(text('b'))));
  });

  it('reads a Gmail or Apple Mail blank line the same way', () => {
    load('<div>a</div><div><br></div><div>b</div>');
    expect(editor.getJSON()).toEqual(doc(P(text('a')), P(), P(text('b'))));
  });

  it('reads a template written as plain text with one blank line per blank line', () => {
    load(textToHtml('Thanks,\n\nRokas'));
    expect(editor.getJSON()).toEqual(doc(P(text('Thanks,')), P(), P(text('Rokas'))));
  });

  it('drops a <br> that only ends its paragraph, the way every mail client draws it', () => {
    load('<p>Hey Ben,<br></p>');
    expect(editor.getJSON()).toEqual(doc(P(text('Hey Ben,'))));
  });

  it('keeps a <br> that more of the line follows, even inside a mark', () => {
    load('<p>a<br>b</p><p><strong>x<br></strong>y</p>');
    expect(editor.getJSON()).toEqual(doc(
      P(text('a'), br(), text('b')),
      P(text('x', bold), br(bold), text('y')),
    ));
  });
});

describe('what the editor hands out is what it reads back', () => {
  const cases = {
    'a blank line': doc(P(text('Lorem ipsum')), P(), P(text('dolor'))),
    'two blank lines': doc(P(text('a')), P(), P(), P(text('b'))),
    'a line break ending a paragraph': doc(P(text('Hey Ben,'), br()), P(text('next'))),
    'a bold line break ending a paragraph': doc(P(text('Hey', bold), br(bold))),
    'two line breaks in a row': doc(P(text('a'), br(), br(), text('b'))),
    'an empty list item': doc(UL(P(text('one')), P()), P(text('after'))),
  };

  for (const [name, json] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      load(json);
      const html = padEmptyLines(editor.getHTML());
      editor.commands.setContent(html);
      expect(editor.getJSON()).toEqual(json);
      // A fixed point, so RichTextEditor's echo comparison never re-sets the document.
      expect(padEmptyLines(editor.getHTML())).toBe(html);
    });
  }
});
