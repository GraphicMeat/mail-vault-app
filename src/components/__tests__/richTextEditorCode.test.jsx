// @vitest-environment jsdom
//
// Code in a message: `inline` and ```fenced``` typing turns into code while the
// message is written, the toolbar toggles inline code, and the sent HTML carries
// the code look inline (mail clients drop <style> blocks).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const { RichTextEditor, inlineComposeSpacing } = await import('../RichTextEditor');

afterEach(cleanup);

async function mount(props = {}) {
  const editorRef = { current: null };
  render(<RichTextEditor editorRef={editorRef} onUpdate={() => {}} {...props} />);
  await waitFor(() => expect(editorRef.current).toBeTruthy());
  return editorRef.current;
}

/// Types the way a keyboard does: each character goes through ProseMirror's
/// text-input handlers first, which is where input rules live.
const type = (editor, text) => act(async () => {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', f => f(editor.view, from, to, ch));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
});
const parse = (html) => new DOMParser().parseFromString(html, 'text/html').body;

describe('typing code', () => {
  it('turns `text` into inline code', async () => {
    const editor = await mount();
    await type(editor, 'run `npm test` now');
    expect(editor.getHTML()).toBe('<p>run <code>npm test</code> now</p>');
  });

  it('turns ``` into a code block that keeps its lines', async () => {
    const editor = await mount();
    await type(editor, '``` ');
    expect(editor.isActive('codeBlock')).toBe(true);
    await type(editor, 'const a = 1;');
    expect(editor.getHTML()).toContain('<pre><code>const a = 1;</code></pre>');
  });
});

describe('toolbar', () => {
  it('has an inline code toggle beside the code block one', async () => {
    const editor = await mount({ content: '<p>run npm test</p>' });
    act(() => { editor.commands.setTextSelection({ from: 5, to: 13 }); });
    fireEvent.mouseDown(screen.getByTitle('Inline code'));
    expect(editor.getHTML()).toBe('<p>run <code>npm test</code></p>');
    expect(screen.getByTitle('Code Block')).toBeTruthy();
  });
});

describe('the sent HTML', () => {
  it('styles inline code so a mail client shows it as code', () => {
    const code = parse(inlineComposeSpacing('<p>run <code>npm test</code></p>')).querySelector('code');
    expect(code.style.fontFamily).toContain('monospace');
    expect(code.style.backgroundColor).toMatch(/^rgba\(/);
    expect(code.style.padding).not.toBe('');
    expect(code.style.borderRadius).not.toBe('');
  });

  it('styles a code block, and does not double the background on the code inside it', () => {
    const body = parse(inlineComposeSpacing('<pre><code>a\n  b</code></pre>'));
    const pre = body.querySelector('pre');
    const code = body.querySelector('pre code');
    expect(pre.style.fontFamily).toContain('monospace');
    expect(pre.style.backgroundColor).toMatch(/^rgba\(/);
    expect(pre.style.whiteSpace).toBe('pre-wrap');
    expect(pre.style.marginTop).toBe('0.5em');
    expect(code.style.backgroundColor).toBe('');
    expect(code.style.padding).toBe('');
  });

  it('keeps a look the message already carries', () => {
    const code = parse(inlineComposeSpacing('<code style="background-color:#ff0">x</code>')).querySelector('code');
    expect(code.style.backgroundColor).toBe('rgb(255, 255, 0)');
  });
});
