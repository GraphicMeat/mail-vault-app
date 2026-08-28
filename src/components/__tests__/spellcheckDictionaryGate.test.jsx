// @vitest-environment jsdom
//
// On Linux the spellcheck button can be a switch that switches nothing on:
// WebKitGTK checks words through enchant, and a machine with no hunspell
// dictionary has nothing to check against. A lit button over a dead checker is
// how this feature shipped broken on macOS once already, so what is guarded
// here is that the button stops claiming to be a toggle when there is no
// dictionary — and that it still is one everywhere else.

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

const commands = { blur: vi.fn(), focus: vi.fn() };
const chain = () => new Proxy({}, { get: () => (() => chain()) });
vi.mock('@tiptap/react', () => ({
  useEditor: () => ({
    commands,
    chain,
    getHTML: () => '',
    getText: () => '',
    getAttributes: () => ({}),
    isActive: () => false,
    can: () => ({ undo: () => true, redo: () => true }),
  }),
  EditorContent: () => React.createElement('div', { className: 'ProseMirror', contentEditable: true }),
}));

let settings;
vi.mock('../../stores/settingsStore', () => {
  const hook = vi.fn((selector) => selector(settings));
  hook.getState = () => settings;
  return { useSettingsStore: hook };
});

const openInBrowser = vi.fn(() => Promise.resolve(true));
vi.mock('../../services/billingApi', () => ({ openInBrowser: (url) => openInBrowser(url) }));

// The status is what the Rust side reports; each case sets it before rendering.
let status;
vi.mock('../../hooks/useSpellcheckStatus', () => ({
  useSpellcheckStatus: () => status,
}));

const { RichTextEditor } = await import('../RichTextEditor');

const setSpellcheckEnabled = vi.fn((v) => { settings.spellcheckEnabled = !!v; });
const button = () => screen.getByTitle(/[Ss]pellcheck/);
const renderEditor = () => render(<RichTextEditor content="" onUpdate={() => {}} />);

const MAC = { needsDictionary: false, dictionaries: [], confined: false };
const LINUX_WITH = { needsDictionary: true, dictionaries: ['en_GB'], confined: false };
const LINUX_WITHOUT = { needsDictionary: true, dictionaries: [], confined: false };
const SNAP_WITHOUT = { needsDictionary: true, dictionaries: [], confined: true };

beforeEach(() => {
  settings = { spellcheckEnabled: true, setSpellcheckEnabled };
  status = MAC;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('spellcheck button when the platform finds no dictionary', () => {
  it('offers the instructions instead of a toggle, and does not touch the pref', () => {
    status = LINUX_WITHOUT;
    renderEditor();
    expect(button().getAttribute('title')).toMatch(/needs a dictionary/);

    fireEvent.mouseDown(button());
    expect(setSpellcheckEnabled).not.toHaveBeenCalled();
    expect(screen.getByTestId('spellcheck-help-dialog')).toBeTruthy();
  });

  it('does not light up — a lit button over a dead checker is the bug', () => {
    status = LINUX_WITHOUT;
    const { container } = renderEditor();
    // The pref is on; the button must still read as inactive.
    expect(settings.spellcheckEnabled).toBe(true);
    expect(button().className).not.toMatch(/bg-mail-accent/);
    // Contrast: the same pref with a dictionary present.
    cleanup();
    status = LINUX_WITH;
    renderEditor();
    expect(button().className).toMatch(/bg-mail-accent/);
    expect(container).toBeTruthy();
  });

  it('stays a toggle on Linux once a dictionary is installed', () => {
    status = LINUX_WITH;
    renderEditor();
    expect(button().getAttribute('title')).toBe('Spellcheck on — click to turn off');
    fireEvent.mouseDown(button());
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);
  });

  it('stays a toggle where the OS checks spelling', () => {
    status = MAC;
    renderEditor();
    fireEvent.mouseDown(button());
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('spellcheck-help-dialog')).toBeNull();
  });

  it('survives a status that has not arrived yet', () => {
    status = null;                       // the first paint, before Rust answers
    renderEditor();
    fireEvent.mouseDown(button());
    expect(setSpellcheckEnabled).toHaveBeenCalledWith(false);
  });
});

describe('the instructions themselves', () => {
  it('give a command per package manager, and say to restart', () => {
    status = LINUX_WITHOUT;
    renderEditor();
    fireEvent.mouseDown(button());
    const dialog = screen.getByTestId('spellcheck-help-dialog');
    expect(dialog.textContent).toContain('sudo apt install hunspell-en-us');
    expect(dialog.textContent).toContain('sudo dnf install hunspell-en');
    expect(dialog.textContent).toContain('sudo pacman -S hunspell-en_us');
    expect(dialog.textContent).toContain('sudo zypper install myspell-en_US');
    expect(dialog.textContent).toMatch(/[Rr]estart MailVault/);
  });

  it('does not tell a confined snap user to install a package it could never see', () => {
    status = SNAP_WITHOUT;
    renderEditor();
    fireEvent.mouseDown(button());
    const dialog = screen.getByTestId('spellcheck-help-dialog');
    expect(screen.getByTestId('spellcheck-help-snap')).toBeTruthy();
    expect(dialog.textContent).not.toContain('sudo apt install');
    expect(dialog.textContent).toContain('.deb');
  });

  it('links the guide out to the FAQ anchor the site actually has', () => {
    status = LINUX_WITHOUT;
    renderEditor();
    fireEvent.mouseDown(button());
    fireEvent.click(screen.getByTestId('spellcheck-help-guide'));
    expect(openInBrowser).toHaveBeenCalledWith(
      'https://mailvaultapp.com/faq.html#linux-spellcheck-dictionary'
    );
  });
});
