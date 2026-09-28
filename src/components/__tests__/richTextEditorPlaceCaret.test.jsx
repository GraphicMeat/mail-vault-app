// @vitest-environment jsdom
//
// Reply opened with the caret after the signature. The editor is built on the
// compose form's empty pre-init body, onCreate places the caret there, and the
// reply body (blank line, "--", signature) arrives afterwards through the
// content sync, whose setContent leaves the caret at the end of the document.
// The real @tiptap/react runs here, built empty, then handed the body.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useRef } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { signatureCaretPos } from '../../utils/signatureCaret';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

let settings;
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

const REPLY_BODY = '<p></p><p>--</p><p>Best,<br>Me</p>';
const placeCaret = (editor) => editor.commands.focus(signatureCaretPos(editor.state.doc) ?? 'start');

let editorRef;
function Harness({ content, withCaret = true }) {
  editorRef = useRef(null);
  return (
    <>
      <input data-testid="elsewhere" />
      <RichTextEditor content={content} onUpdate={() => {}} editorRef={editorRef}
        placeCaret={withCaret ? placeCaret : undefined} />
    </>
  );
}

beforeEach(() => { settings = { spellcheckEnabled: true, setSpellcheckEnabled: vi.fn() }; });
afterEach(() => cleanup());

describe('RichTextEditor placeCaret', () => {
  it('puts the caret above the signature when the body lands after the editor was built', async () => {
    const view = render(<Harness content="" />);
    await waitFor(() => expect(editorRef.current).toBeTruthy());

    view.rerender(<Harness content={REPLY_BODY} />);

    const editor = editorRef.current;
    await waitFor(() => expect(editor.getText()).toContain('--'));
    expect(signatureCaretPos(editor.state.doc)).not.toBeNull();
    expect(editor.state.selection.from).toBe(signatureCaretPos(editor.state.doc));
  });

  it('leaves the caret alone while the person types in another field', async () => {
    const view = render(<Harness content="" />);
    await waitFor(() => expect(editorRef.current).toBeTruthy());
    // onCreate's focus is deferred a frame: let it land, then move away.
    await waitFor(() => expect(editorRef.current.view.dom.contains(document.activeElement)).toBe(true));
    const elsewhere = view.getByTestId('elsewhere');
    elsewhere.focus();

    view.rerender(<Harness content={REPLY_BODY} />);

    const editor = editorRef.current;
    await waitFor(() => expect(editor.getText()).toContain('--'));
    expect(document.activeElement).toBe(elsewhere);
    expect(editor.state.selection.from).not.toBe(signatureCaretPos(editor.state.doc));
  });
});
