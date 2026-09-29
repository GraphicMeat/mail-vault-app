// @vitest-environment jsdom
//
// A signature's editor (`imageTools`): an Insert-image button, corner handles
// on a picture, and after a resize the offer to store the file at 3x its
// display size. The real TipTap runs; the image decoder and canvas are stubs.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { RichTextEditor } = await import('../RichTextEditor');

const ORIGINAL = `data:image/png;base64,${'A'.repeat(4000)}`;
const SCALED = `data:image/png;base64,${'B'.repeat(400)}`;

let natural;
const realImage = globalThis.Image;
const realGetContext = HTMLCanvasElement.prototype.getContext;
const realToDataURL = HTMLCanvasElement.prototype.toDataURL;
beforeEach(() => {
  natural = { width: 1200, height: 1200 };
  globalThis.Image = class {
    set src(value) {
      this.naturalWidth = natural.width;
      this.naturalHeight = natural.height;
      queueMicrotask(() => this.onload?.());
    }
  };
  HTMLCanvasElement.prototype.getContext = () => ({ drawImage: vi.fn() });
  HTMLCanvasElement.prototype.toDataURL = () => SCALED;
});
afterEach(() => {
  cleanup();
  globalThis.Image = realImage;
  HTMLCanvasElement.prototype.getContext = realGetContext;
  HTMLCanvasElement.prototype.toDataURL = realToDataURL;
});

async function mount(props = {}) {
  const editorRef = { current: null };
  const onUpdate = vi.fn();
  render(<RichTextEditor editorRef={editorRef} onUpdate={onUpdate} {...props} />);
  await waitFor(() => expect(editorRef.current).toBeTruthy());
  return { editor: editorRef.current, onUpdate };
}

const imageAttrs = (editor) => {
  let found = null;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') found = { pos, ...node.attrs }; });
  return found;
};
const resizeTo = (editor, size) => act(async () => {
  const { pos } = imageAttrs(editor);
  editor.chain().setNodeSelection(pos).updateAttributes('image', { width: size, height: size }).run();
});

describe('a signature editor', () => {
  it('has an Insert image button, and an ordinary editor does not', async () => {
    await mount({ imageTools: true, content: '<p>Hi</p>' });
    expect(screen.getByTestId('editor-image-input')).toBeTruthy();
    expect(screen.getByTitle('Insert image')).toBeTruthy();
    cleanup();
    await mount({ content: '<p>Hi</p>' });
    expect(screen.queryByTestId('editor-image-input')).toBeNull();
    expect(screen.queryByTitle('Insert image')).toBeNull();
  });

  it('puts a picture chosen with the button into the signature', async () => {
    const { editor, onUpdate } = await mount({ imageTools: true, content: '<p>Hi</p>' });
    const file = new File(['png-bytes'], 'logo.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(screen.getByTestId('editor-image-input'), { target: { files: [file] } }); });
    await waitFor(() => expect(imageAttrs(editor)).toBeTruthy());
    expect(imageAttrs(editor).src).toMatch(/^data:image\/png;base64,/);
    expect(imageAttrs(editor).alt).toBe('logo.png');
    expect(onUpdate.mock.calls.at(-1)[0]).toContain('<img');
  });

  it('ignores a file that is not a picture', async () => {
    const { editor } = await mount({ imageTools: true, content: '<p>Hi</p>' });
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.change(screen.getByTestId('editor-image-input'), { target: { files: [file] } }); });
    expect(imageAttrs(editor)).toBeNull();
  });

  it('after a resize offers 3x the display size, and scaling swaps the file, not the display size', async () => {
    const { editor, onUpdate } = await mount({ imageTools: true, content: `<img src="${ORIGINAL}" width="300" height="300">` });
    await resizeTo(editor, 40);
    const dialog = await screen.findByTestId('image-scale');
    expect(dialog.textContent).toContain('40 × 40');
    expect(screen.getByTestId('image-scale-apply').textContent).toBe('Scale to 120 × 120');
    fireEvent.click(screen.getByTestId('image-scale-apply'));
    await waitFor(() => expect(screen.queryByTestId('image-scale')).toBeNull());
    expect(imageAttrs(editor)).toMatchObject({ src: SCALED, width: 40, height: 40 });
    const html = onUpdate.mock.calls.at(-1)[0];
    expect(html).toContain(SCALED);
    expect(html).toMatch(/width="40"/);
  });

  it('keeping the original leaves the file alone', async () => {
    const { editor } = await mount({ imageTools: true, content: `<img src="${ORIGINAL}" width="300" height="300">` });
    await resizeTo(editor, 40);
    fireEvent.click(await screen.findByTestId('image-scale-keep'));
    await waitFor(() => expect(screen.queryByTestId('image-scale')).toBeNull());
    expect(imageAttrs(editor)).toMatchObject({ src: ORIGINAL, width: 40, height: 40 });
  });

  it('asks nothing when the file is already no bigger than 3x the display size', async () => {
    natural = { width: 100, height: 100 };
    const { editor } = await mount({ imageTools: true, content: `<img src="${ORIGINAL}" width="90" height="90">` });
    await resizeTo(editor, 40);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId('image-scale')).toBeNull();
  });

  it('asks nothing about a picture that is merely loaded or inserted', async () => {
    const { editor } = await mount({ imageTools: true, content: `<img src="${ORIGINAL}" width="40" height="40">` });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId('image-scale')).toBeNull();
    expect(imageAttrs(editor).width).toBe(40);
  });

  it('an editor without imageTools never asks, however a picture is resized', async () => {
    const { editor } = await mount({ content: `<img src="${ORIGINAL}" width="300" height="300">` });
    await resizeTo(editor, 40);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId('image-scale')).toBeNull();
  });
});
