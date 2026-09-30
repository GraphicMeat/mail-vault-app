// @vitest-environment jsdom
//
// "/" in the message body opens a command menu at the caret: type to narrow,
// arrows and Enter to pick, Escape to close. Real TipTap; no layout in jsdom, so
// the caret position falls back to the editor's own.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, { get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))), has: () => true });
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => React.forwardRef(({ children, initial, animate, exit, ...props }, ref) => React.createElement('div', { ...props, ref }, children)) }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../../stores/settingsStore', () => {
  const settings = { spellcheckEnabled: true, setSpellcheckEnabled: vi.fn() };
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

afterEach(cleanup);

async function mount(props = {}) {
  const editorRef = { current: null };
  render(<RichTextEditor editorRef={editorRef} onUpdate={() => {}} {...props} />);
  await waitFor(() => expect(editorRef.current).toBeTruthy());
  return editorRef.current;
}

const type = (editor, text) => act(async () => {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', f => f(editor.view, from, to, ch));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
});
const press = (editor, key) => act(async () => { fireEvent.keyDown(editor.view.dom, { key }); });
const menu = () => screen.queryByRole('listbox');
const options = () => within(menu()).getAllByRole('option').map(o => o.textContent);
const text = editor => editor.state.doc.textContent;

describe('the slash menu', () => {
  it('opens on a slash at the start of a line and lists the commands', async () => {
    const editor = await mount();
    expect(menu()).toBeNull();
    await type(editor, '/');
    expect(menu()).toBeTruthy();
    expect(options().length).toBeGreaterThanOrEqual(6);
    expect(options()[0]).toContain('Emoji');
  });

  it('opens after a space, never inside a word', async () => {
    const editor = await mount();
    await type(editor, 'and/or');
    expect(menu()).toBeNull();
    await type(editor, ' /');
    expect(menu()).toBeTruthy();
  });

  it('does not open in inline code or a code block', async () => {
    const editor = await mount({ content: '<pre><code>a</code></pre>' });
    act(() => { editor.commands.focus('end'); });
    await type(editor, ' /');
    expect(menu()).toBeNull();
    cleanup();
    const inline = await mount({ content: '<p>x <code>y</code></p>' });
    act(() => { inline.commands.focus('end'); });
    await type(inline, ' /');
    expect(menu()).toBeNull();
  });

  it('narrows as you type and closes when nothing matches', async () => {
    const editor = await mount();
    await type(editor, '/bul');
    expect(options()).toEqual([expect.stringContaining('Bulleted list')]);
    await type(editor, 'zz');
    expect(menu()).toBeNull();
  });

  it('Enter runs the command, removes what was typed, and does not split the line', async () => {
    const editor = await mount();
    await type(editor, '/bul');
    await press(editor, 'Enter');
    expect(menu()).toBeNull();
    expect(editor.isActive('bulletList')).toBe(true);
    expect(text(editor)).toBe('');
    expect(editor.getHTML()).toMatch(/^<ul><li><p><\/p><\/li><\/ul>/);
  });

  it('the arrows move the pick, and wrap round', async () => {
    const editor = await mount();
    await type(editor, '/');
    expect(screen.getAllByRole('option').map(o => o.getAttribute('aria-selected'))[0]).toBe('true');
    await press(editor, 'ArrowDown');
    await press(editor, 'Enter');
    expect(editor.isActive('orderedList')).toBe(false);
    expect(editor.isActive('bulletList')).toBe(true);           // second item is the bulleted list
    cleanup();
    const again = await mount();
    await type(again, '/');
    await press(again, 'ArrowUp');                              // wraps to the last
    await press(again, 'Enter');
    expect(again.getHTML()).toContain('<hr>');
  });

  it('a click picks a row', async () => {
    const editor = await mount();
    await type(editor, '/');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Quote/ }));
    expect(editor.isActive('blockquote')).toBe(true);
    expect(text(editor)).toBe('');
  });

  it('Escape closes it, keeps the text, and stays closed for that slash', async () => {
    const editor = await mount();
    await type(editor, '/bu');
    await press(editor, 'Escape');
    expect(menu()).toBeNull();
    await type(editor, 'l');
    expect(menu()).toBeNull();
    expect(text(editor)).toBe('/bul');
    await type(editor, ' /');
    expect(menu()).toBeTruthy();                                // a new slash is a new ask
  });

  it('Enter goes to the editor as usual when the menu is closed', async () => {
    const editor = await mount();
    await type(editor, 'hello');
    await press(editor, 'Enter');
    expect(menu()).toBeNull();
  });

  it('Emoji switches the same menu to emoji, and picking one puts it in the text', async () => {
    const editor = await mount();
    await type(editor, '/');
    await press(editor, 'Enter');                               // Emoji is first
    expect(text(editor)).toBe('/emoji ');
    expect(menu()).toBeTruthy();
    expect(options().length).toBeGreaterThan(10);
    await type(editor, 'rocket');
    expect(options()).toEqual([expect.stringContaining('🚀')]);
    await press(editor, 'Enter');
    expect(text(editor)).toBe('🚀');
    expect(menu()).toBeNull();
  });

  it('closes when the caret leaves the slash', async () => {
    const editor = await mount();
    await type(editor, '/bul');
    act(() => { editor.commands.setTextSelection(0); });
    expect(menu()).toBeNull();
  });

  it('is in every rich text editor, a signature included', async () => {
    const editor = await mount({ imageTools: true });
    await type(editor, '/');
    expect(menu()).toBeTruthy();
  });
});
