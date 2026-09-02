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

// A chainable editor that RECORDS what was chained: the toolbar builds
// `editor.chain().focus().x().run()` for every other button, and the two
// effects in RichTextEditor use the same shape. Retracting a spelling marker
// is a chain, not a command, so the chain is what has to be observable.
const commands = { blur: vi.fn(), focus: vi.fn() };
const chained = [];
const chain = () => new Proxy({}, {
  get: (_t, name) => (...args) => { chained.push([String(name), ...args]); return chain(); },
});
const fakeEditor = {
  commands,
  chain,
  // The rebuild puts the caret back where it was, so it has to read it first.
  state: { selection: { from: 3, to: 7 } },
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
  chained.length = 0;
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

  // Replaces an older case that asserted blur() then a deferred focus(). That
  // was the documented cure and it does not work: photographed on the runner,
  // a marked sentence keeps every underline through blur/focus, through
  // `spellcheck=false` on the editable itself, and through a `contenteditable`
  // off/on cycle. WebKit binds the marker to the TEXT NODE; only replacing the
  // nodes retracts it.
  it('rebuilds the text nodes when the switch flips, off the undo history', () => {
    const { rerender } = renderEditor();
    chained.length = 0;

    settings.spellcheckEnabled = false;
    rerender(<RichTextEditor content="" onUpdate={() => {}} />);

    const names = chained.map(([name]) => name);
    expect(names).toContain('setContent');
    // A spellcheck toggle must not become an undo step.
    expect(chained).toContainEqual(['setMeta', 'addToHistory', false]);
    // …and must not throw the caret to the top of the message.
    expect(chained).toContainEqual(['setTextSelection', { from: 3, to: 7 }]);
    // The old cure is gone: it never retracted anything.
    expect(commands.blur).not.toHaveBeenCalled();
  });

  it('does not rebuild on the first paint', () => {
    renderEditor();
    // Mount must not re-set the content: the editor has only just parsed it,
    // and a rebuild here would fight the content-sync effect beside it.
    expect(chained.map(([name]) => name)).not.toContain('setContent');
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
