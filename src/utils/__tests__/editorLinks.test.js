// @vitest-environment jsdom
//
// Links in the compose editor, through the real compose schema. A link used
// to swallow whatever was typed after it (the mark was inclusive), and the
// only way to change one was a URL prompt that could not touch its text.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { editorExtensions } from '../../components/RichTextEditor';
import {
  linkRangeAt, applyLink, removeLink, removeLinkWithText, normalizeHref, openLink,
} from '../editorLinks';

const shellOpen = vi.fn(() => Promise.resolve());
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a) => shellOpen(...a) }));

let editor = null;
const load = (content) => {
  editor = new Editor({ extensions: editorExtensions(), content });
  return editor;
};
afterEach(() => { editor?.destroy(); editor = null; shellOpen.mockClear(); });

// The attributes every link carries are not what these cases are about.
const html = () => editor.getHTML().replace(/ target="_blank" rel="noopener noreferrer"/g, '');
const endOf = (ed) => ed.state.doc.content.size - 1;
const posOf = (ed, text) => {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text.includes(text)) found = pos + node.text.indexOf(text);
  });
  return found;
};
// "hello " with its trailing space: parsed from HTML, a block's last space is dropped.
const helloSpace = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello ' }] }] };
// What typing does: ProseMirror inserts the text with the marks the caret has.
const type = (ed, text, at = ed.state.selection.from) => ed.view.dispatch(ed.state.tr.insertText(text, at, at));

describe('typing after a link', () => {
  it('leaves text typed at the end of a link outside it', () => {
    load('<p><a href="https://example.com">https://example.com</a></p>');
    type(editor, ' more text', endOf(editor));
    expect(html()).toBe('<p><a href="https://example.com">https://example.com</a> more text</p>');
  });

  it('leaves text typed after a pasted URL outside the link', () => {
    load('<p></p>');
    // jsdom has no ClipboardEvent, which pasteText would build on its own.
    editor.view.pasteText('https://example.com/path', new Event('paste'));
    // Positive control: the paste made a link in the first place.
    expect(html()).toBe('<p><a href="https://example.com/path">https://example.com/path</a></p>');
    type(editor, ' asdf');
    expect(html()).toBe('<p><a href="https://example.com/path">https://example.com/path</a> asdf</p>');
  });
});

describe('linkRangeAt', () => {
  it('finds the whole link around a position, with its address and text', () => {
    load('<p>see <a href="https://old.example">the old site</a> now</p>');
    const inside = posOf(editor, 'old site');
    const link = linkRangeAt(editor, inside);
    expect(link).toMatchObject({ href: 'https://old.example', text: 'the old site' });
    expect(editor.state.doc.textBetween(link.from, link.to)).toBe('the old site');
  });

  it('finds the link when the caret sits right after it', () => {
    load('<p><a href="https://example.com">site</a> after</p>');
    expect(linkRangeAt(editor, posOf(editor, ' after'))?.href).toBe('https://example.com');
  });

  it('is null away from any link', () => {
    load('<p>plain <a href="https://example.com">site</a></p>');
    expect(linkRangeAt(editor, posOf(editor, 'lain'))).toBe(null);
  });
});

describe('applyLink', () => {
  it('inserts new text carrying the link at the caret', () => {
    load(helloSpace);
    const at = endOf(editor);
    expect(applyLink(editor, { from: at, to: at }, { text: 'site', href: 'https://example.com' })).toBe(true);
    expect(html()).toBe('<p>hello <a href="https://example.com">site</a></p>');
  });

  it('links the selected text as it is when the text is not changed', () => {
    load('<p>hello <strong>bold</strong> world</p>');
    const from = posOf(editor, 'hello');
    const to = posOf(editor, ' world');
    expect(applyLink(editor, { from, to }, { text: 'hello bold', href: 'https://example.com' })).toBe(true);
    expect(html()).toBe('<p><a href="https://example.com">hello <strong>bold</strong></a> world</p>');
  });

  it('changes both the text and the address of an existing link', () => {
    load('<p>see <a href="https://old.example">old</a> now</p>');
    const link = linkRangeAt(editor, posOf(editor, 'old'));
    expect(applyLink(editor, link, { text: 'new', href: 'https://new.example' })).toBe(true);
    expect(html()).toBe('<p>see <a href="https://new.example">new</a> now</p>');
  });

  it('leaves the caret after the link, so typing goes on as plain text', () => {
    load(helloSpace);
    const at = endOf(editor);
    applyLink(editor, { from: at, to: at }, { text: 'site', href: 'https://example.com' });
    type(editor, '!');
    expect(html()).toBe('<p>hello <a href="https://example.com">site</a>!</p>');
  });

  it('refuses a javascript: address and leaves the document alone', () => {
    load('<p>see <a href="https://old.example">old</a> now</p>');
    const before = editor.getHTML();
    const link = linkRangeAt(editor, posOf(editor, 'old'));
    expect(applyLink(editor, link, { text: 'click me', href: 'javascript:alert(1)' })).toBe(false);
    expect(editor.getHTML()).toBe(before);
  });

  it('removes the link when the address is emptied', () => {
    load('<p>see <a href="https://old.example">old</a> now</p>');
    const link = linkRangeAt(editor, posOf(editor, 'old'));
    expect(applyLink(editor, link, { text: 'old', href: '  ' })).toBe(true);
    expect(html()).toBe('<p>see old now</p>');
  });
});

describe('removing a link', () => {
  it('Remove link keeps the text', () => {
    load('<p>see <a href="https://example.com">the site</a> now</p>');
    removeLink(editor, linkRangeAt(editor, posOf(editor, 'site')));
    expect(html()).toBe('<p>see the site now</p>');
  });

  it('Remove link and text deletes both', () => {
    load('<p>see <a href="https://example.com">the site</a> now</p>');
    removeLinkWithText(editor, linkRangeAt(editor, posOf(editor, 'site')));
    expect(html()).toBe('<p>see  now</p>');
  });
});

describe('normalizeHref', () => {
  it('adds https:// to a bare domain and mailto: to a bare address', () => {
    expect(normalizeHref(' example.com/a ')).toBe('https://example.com/a');
    expect(normalizeHref('bob@example.com')).toBe('mailto:bob@example.com');
    expect(normalizeHref('https://example.com')).toBe('https://example.com');
    expect(normalizeHref('mailto:bob@example.com')).toBe('mailto:bob@example.com');
    expect(normalizeHref('')).toBe('');
  });
});

describe('openLink', () => {
  it('hands web and mail addresses to the system opener', async () => {
    await openLink('https://example.com');
    await openLink('mailto:bob@example.com');
    expect(shellOpen.mock.calls).toEqual([['https://example.com'], ['mailto:bob@example.com']]);
  });

  it('opens nothing else', async () => {
    await openLink('javascript:alert(1)');
    await openLink('file:///etc/passwd');
    expect(shellOpen).not.toHaveBeenCalled();
  });
});
