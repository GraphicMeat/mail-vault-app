// @vitest-environment jsdom
//
// Tab out of the subject has to land in the writing space, not wherever the
// editor was last and not under the signature. Real TipTap, real document
// positions — a hand-rolled fake doc would only prove the helper agrees with
// itself.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { signatureCaretPos } from '../signatureCaret';

const SIGNATURE = '<p></p><p>--</p><p>Rokas</p>';

let editor = null;
const open = (html) => {
  editor = new Editor({ extensions: [StarterKit], content: html });
  return editor;
};
afterEach(() => { editor?.destroy(); editor = null; });

describe('signatureCaretPos', () => {
  it('lands at the end of the blank line in front of the separator', () => {
    const { state } = open(SIGNATURE);
    const pos = signatureCaretPos(state.doc);
    // Inside the first (empty) paragraph, which is the writing space.
    expect(pos).toBe(1);
    expect(state.doc.resolve(pos).parent).toBe(state.doc.child(0));
  });

  it('puts the caret after the last character of a prefilled body', () => {
    const { state } = open(`<p>Hello</p>${SIGNATURE}`);
    const pos = signatureCaretPos(state.doc);
    const $pos = state.doc.resolve(pos);
    expect($pos.parent).toBe(state.doc.child(1));       // the blank line, not the quote
    expect($pos.parentOffset).toBe($pos.parent.content.size);
    expect(state.doc.child(2).textContent).toBe('--');
  });

  it('does not read a leading -- line as the separator', () => {
    const { state } = open(`<p>--</p><p>not a signature</p>`);
    expect(signatureCaretPos(state.doc)).toBeNull();
  });

  it('returns null with the signature off, so the caller falls back', () => {
    const { state } = open('<p></p>');
    expect(signatureCaretPos(state.doc)).toBeNull();
  });
});
