// @vitest-environment jsdom
//
// The spellcheck toggle. What matters is not that a button lights up: it is
// that the attribute the browser actually reads lands on an ancestor of the
// contenteditable, and that the choice is written to the settings store rather
// than to component state that dies with the compose window.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

// A chainable no-op editor: the toolbar builds `editor.chain().focus().x().run()`
// for every other button, and RichTextEditor's content-sync effect uses the same
// shape. Only blur/focus are observed here.
const commands = { blur: vi.fn(), focus: vi.fn() };
const chain = () => new Proxy({}, { get: () => (() => chain()) });
const fakeEditor = {
  commands,
  chain,
  getHTML: () => '',
  getText: () => '',
  getAttributes: () => ({}),
  isActive: () => false,
  can: () => ({ undo: () => true, redo: () => true }),
};

vi.mock('@tiptap/react', () => ({
  useEditor: () => fakeEditor,
  EditorContent: () => React.createElement('div', { className: 'ProseMirror', contentEditable: true }),
}));

let settings;
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const { RichTextEditor } = await import('../RichTextEditor');

const setSpellcheckEnabled = vi.fn((v) => { settings.spellcheckEnabled = !!v; });

/** The attribute the editable inherits from. */
const wrapper = (container) => container.querySelector('[spellcheck]');

const renderEditor = () => render(
  <RichTextEditor content="" onUpdate={() => {}} />
);

beforeEach(() => {
  settings = { spellcheckEnabled: true, setSpellcheckEnabled };
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('compose spellcheck toggle', () => {
  it('carries the enabled state on an ancestor of the contenteditable', () => {
    const { container } = renderEditor();
    const host = wrapper(container);
    expect(host.getAttribute('spellcheck')).toBe('true');
    // Inheritance is the whole mechanism — if the editable is not inside the
    // element holding the attribute, nothing is spellchecked or unspellchecked.
    expect(host.contains(container.querySelector('.ProseMirror'))).toBe(true);
  });

  it('renders spellcheck="false" when the pref is off', () => {
    settings.spellcheckEnabled = false;
    const { container } = renderEditor();
    expect(wrapper(container).getAttribute('spellcheck')).toBe('false');
  });

  it('treats a store with no pref yet as on', () => {
    delete settings.spellcheckEnabled;
    const { container } = renderEditor();
    expect(wrapper(container).getAttribute('spellcheck')).toBe('true');
  });

  it('writes the flip to the settings store, not to component state', () => {
    renderEditor();
    fireEvent.mouseDown(screen.getByTitle(/^Spellcheck/));
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);
  });

  it('re-enters the editable so the existing squiggles are re-evaluated', () => {
    renderEditor();
    fireEvent.mouseDown(screen.getByTitle(/^Spellcheck/));
    expect(commands.blur).toHaveBeenCalled();
    // focus is deferred a tick — before that the blur has not been applied yet.
    expect(commands.focus).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(commands.focus).toHaveBeenCalled();
  });

  it('says what the click will do, in both states', () => {
    const { unmount } = renderEditor();
    expect(screen.getByTitle('Spellcheck on — click to turn off')).toBeTruthy();
    unmount();

    settings.spellcheckEnabled = false;
    renderEditor();
    expect(screen.getByTitle('Spellcheck off — click to turn on')).toBeTruthy();
  });
});
