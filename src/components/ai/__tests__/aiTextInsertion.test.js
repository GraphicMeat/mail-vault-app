// @vitest-environment jsdom
//
// Phase 6: an AI action's output is inserted into the compose editor as
// `editor.chain().setContent(textToHtml(text)).run()` (ComposeModal.jsx's
// onResult) — the editor's own chain, not the `content` prop RichTextEditor
// syncs externally with `addToHistory: false` (that path exists for
// spellcheck/minimize restores and would make Ctrl+Z unable to undo an AI
// replacement). This proves two things a bare `new Editor()` + `setContent`
// harness can check without mounting React: blank lines in a real
// multi-paragraph AI reply survive the round trip through the real TipTap
// schema (same as a typed message — see richTextEditorLines.test.js's
// "reads a template written as plain text" case for the seam), and the
// replacement is a normal, undoable transaction.

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions, padEmptyLines, textToHtml } from '../../RichTextEditor';

let editor = null;
afterEach(() => { editor?.destroy(); editor = null; });

const doc = (...content) => ({ type: 'doc', content });
const P = (...content) => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const text = (value) => ({ type: 'text', text: value });

describe('AI-generated text surviving the compose editor round trip', () => {
  it('keeps every blank line of a multi-paragraph AI reply', () => {
    const aiText = 'Hi Ann,\n\nThat works for me — Tuesday at 3pm it is.\n\nThanks,\nRokas';
    const html = textToHtml(aiText);

    editor = new Editor({ extensions: editorExtensions(), content: html });
    expect(editor.getJSON()).toEqual(doc(
      P(text('Hi Ann,')),
      P(),
      P(text('That works for me — Tuesday at 3pm it is.')),
      P(),
      P(text('Thanks,')),
      P(text('Rokas')),
    ));

    // A fixed point: ComposeModal's onUpdate re-pads on every keystroke too,
    // and must not grow a second blank line on content it did not touch.
    const padded = padEmptyLines(editor.getHTML());
    editor.commands.setContent(padded);
    expect(padEmptyLines(editor.getHTML())).toBe(padded);
  });

  it('keeps a single blank line as one blank line, not two', () => {
    const html = textToHtml('Got it, thanks!\n\nRokas');
    editor = new Editor({ extensions: editorExtensions(), content: html });
    // Exactly one empty paragraph between the two lines of text — a double
    // blank line here is the `padEmptyLines(textToHtml(x))` double-pad bug
    // this test is guarding against.
    expect(editor.getJSON()).toEqual(doc(P(text('Got it, thanks!')), P(), P(text('Rokas'))));
  });

  it('is a normal, undoable transaction — Ctrl+Z brings the replaced draft back', () => {
    editor = new Editor({ extensions: editorExtensions(), content: '<p>My original draft.</p>' });

    // Exactly what ComposeModal's onResult does: the editor's own chain, no
    // `addToHistory: false` meta.
    editor.chain().focus().setContent(textToHtml('Shortened by AI.')).run();
    expect(editor.getText()).toBe('Shortened by AI.');

    editor.commands.undo();
    expect(editor.getText()).toBe('My original draft.');
  });
});
