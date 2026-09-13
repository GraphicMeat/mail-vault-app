// @vitest-environment jsdom
//
// RichTextEditor hands its parent the padded HTML, and the parent handing that
// same HTML back is not an outside change. Were the echo compared against the
// raw getHTML() again, every keystroke would re-set the whole document.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

let options = null;
let rawHtml = '';
const chained = [];
const chain = () => new Proxy({}, {
  get: (_t, name) => (...args) => { chained.push([String(name), ...args]); return chain(); },
});
const fakeEditor = {
  chain,
  commands: {},
  state: { selection: { from: 1, to: 1 } },
  getHTML: () => rawHtml,
  getText: () => 'Lorem ipsum\n\n\n\ndolor',
  getAttributes: () => ({}),
  isActive: () => false,
  can: () => ({ undo: () => false, redo: () => false }),
};

vi.mock('@tiptap/react', () => ({
  useEditor: (opts) => { options = opts; return fakeEditor; },
  EditorContent: () => React.createElement('div', { className: 'ProseMirror' }),
}));

let settings;
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

const setContents = () => chained.filter(([name]) => name === 'setContent');

beforeEach(() => {
  settings = { spellcheckEnabled: true, setSpellcheckEnabled: vi.fn() };
  chained.length = 0;
  options = null;
});
afterEach(cleanup);

describe('RichTextEditor output', () => {
  it('hands the parent HTML whose blank lines survive outside the editor', () => {
    const onUpdate = vi.fn();
    rawHtml = '<p>Lorem ipsum</p><p></p><p>dolor</p>';
    render(<RichTextEditor content="" onUpdate={onUpdate} />);
    options.onUpdate({ editor: fakeEditor });
    expect(onUpdate.mock.calls).toEqual([['<p>Lorem ipsum</p><p><br></p><p>dolor</p>']]);
  });

  it('does not re-set the document when the parent echoes that HTML back', () => {
    rawHtml = '<p>Lorem ipsum</p><p></p><p>dolor</p>';
    render(<RichTextEditor content="<p>Lorem ipsum</p><p><br></p><p>dolor</p>" onUpdate={() => {}} />);
    expect(setContents()).toEqual([]);
  });

  it('still takes content that really changed from outside', () => {
    rawHtml = '<p>Lorem ipsum</p>';
    render(<RichTextEditor content="<p>Signature</p>" onUpdate={() => {}} />);
    expect(setContents()).toEqual([['setContent', '<p>Signature</p>']]);
  });

  it('re-reads the padded HTML on a spellcheck toggle, so a line break ending a paragraph survives', () => {
    rawHtml = '<p>Hey Ben,<br></p>';
    const content = '<p>Hey Ben,<br><br></p>';
    const { rerender } = render(<RichTextEditor content={content} onUpdate={() => {}} />);
    settings.spellcheckEnabled = false;
    rerender(<RichTextEditor content={content} onUpdate={() => {}} />);
    expect(setContents()).toEqual([['setContent', '<p>Hey Ben,<br><br></p>']]);
  });
});
