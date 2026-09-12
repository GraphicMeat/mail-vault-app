// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DemoShell } from '../DemoShell.jsx';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { demoTranslate } from '../translations.js';

const tick = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 50));
});

beforeEach(() => {
  const frame = callback => setTimeout(callback, 0);
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('cancelAnimationFrame', id => clearTimeout(id));
  window.requestAnimationFrame = frame;
  window.cancelAnimationFrame = id => clearTimeout(id);
});

afterEach(() => {
  cleanup();
  delete window.__MAILVAULT_DEMO__;
  useSettingsStore.setState({ language: 'en', localeEpoch: 0 });
  vi.unstubAllGlobals();
});

describe('DemoShell guided tour', () => {
  it('follows the active app language and localizes return paths', () => {
    useSettingsStore.setState({ language: 'de', localeEpoch: 1 });
    render(<DemoShell><p>Mailbox</p></DemoShell>);

    expect(screen.getByRole('button', { name: 'Rundgang' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zurücksetzen' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Website/ }).getAttribute('href')).toBe('/de/');
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('/de/get-started.html?plan=free');
    expect(screen.getByTestId('demo-storage-status').textContent).toContain('sieben Tage');
  });

  it('shows persistence degradation from the shared storage status interface', () => {
    useSettingsStore.setState({ language: 'en', localeEpoch: 2 });
    window.__MAILVAULT_DEMO__ = { storage: () => ({ status: 'saved', mode: 'memory' }) };
    render(<DemoShell><p>Mailbox</p></DemoShell>);
    expect(screen.getByTestId('demo-storage-status').textContent).toContain('unavailable');

    act(() => window.dispatchEvent(new CustomEvent('demo:storage', { detail: { status: 'expired', mode: 'indexeddb' } })));
    expect(screen.getByTestId('demo-storage-status').textContent).toContain('expired');
  });

  it.each([
    ['es', 'Tema', 'appearance'],
    ['it', 'Tema', 'appearance'],
    ['pt-BR', 'Tema', 'appearance'],
    ['ja', 'テーマ', 'appearance'],
    ['zh-Hans', '主题', 'appearance'],
    ['fr', 'Marquer comme lu', 'flags'],
    ['de', 'Als gelesen markieren', 'flags'],
    ['es', 'Marcar como leído', 'flags'],
    ['it', 'Segna come letto', 'flags'],
    ['pt-BR', 'Marcar como lida', 'flags'],
    ['ja', 'スター', 'flags'],
    ['ko', '별표', 'flags'],
    ['zh-Hans', '星标', 'flags'],
  ])('classifies the localized %s action as %s', (language, label, key) => {
    useSettingsStore.setState({ language, localeEpoch: 3 });
    render(<DemoShell><button aria-label={label}>{label}</button></DemoShell>);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByTestId('demo-explanation').querySelector('h2').textContent)
      .toBe(demoTranslate(language, `copy.${key}.title`));
    expect(document.documentElement.lang).toBe(language);
    cleanup();
  });

  it('uses translated catalog copy for an otherwise unclassified control', () => {
    useSettingsStore.setState({ language: 'de', localeEpoch: 4 });
    render(<DemoShell><button aria-label="Custom control">Custom control</button></DemoShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Custom control' }));
    expect(screen.getByTestId('demo-explanation').querySelector('h2').textContent)
      .toBe(demoTranslate('de', 'copy.control.selected', { label: 'Custom control' }));
  });

  it('opens the hidden search control before focusing its input', async () => {
    const focusSpy = vi.spyOn(window.HTMLInputElement.prototype, 'focus');
    function SearchFixture() {
      const [open, setOpen] = React.useState(false);
      return <>
        <button data-testid="mail-search-toggle" onClick={() => setOpen(true)}>Search</button>
        {open && <input data-testid="mail-search-input" aria-label="Search mail" />}
      </>;
    }

    render(<DemoShell><SearchFixture /></DemoShell>);
    fireEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    fireEvent.click(screen.getByRole('button', { name: /open this in the app/i }));
    await tick();

    expect(focusSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('mail-search-input'));
  });

  it('restores the trigger focus when Escape closes the tour', async () => {
    render(<DemoShell><button>Before tour</button></DemoShell>);
    const trigger = screen.getByRole('button', { name: 'Before tour' });
    trigger.focus();
    fireEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await tick();

    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab focus inside the tour dialog', () => {
    render(<DemoShell><p>Mailbox</p></DemoShell>);
    fireEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    const close = screen.getByRole('button', { name: /exit tour/i });
    const open = screen.getByRole('button', { name: /open this in the app/i });
    const next = screen.getByRole('button', { name: /^next$/i });
    close.focus();

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    expect(open).toBeTruthy();
  });

  it('opens the initial inbox and clicks the exact archive tour row', async () => {
    const accountClick = vi.fn();
    const staleFolderClick = vi.fn();
    const folderClick = vi.fn();
    const rowClick = vi.fn();
    const wrapperClick = vi.fn();
    function NavigationFixture() {
      const [selected, setSelected] = React.useState('second');
      return <>
        <button className="sidebar-account-open" aria-current={selected === 'first' ? 'true' : undefined}
          onClick={event => { accountClick(event); setTimeout(() => setSelected('first'), 0); }}>First sample</button>
        <button className="sidebar-account-open" aria-current={selected === 'second' ? 'true' : undefined}>Second sample</button>
        {selected === 'first' ? <>
          <button data-testid="folder-row" data-path="INBOX" onClick={folderClick}>Inbox</button>
          <div data-testid="digest-wrapper" onClick={wrapperClick}>
            Your weekly workspace digest
            <div data-testid="email-row" onClick={event => { event.stopPropagation(); rowClick(event); }}>Your weekly workspace digest</div>
          </div>
        </> : <button data-testid="folder-row" data-path="INBOX" onClick={staleFolderClick}>Inbox</button>}
      </>;
    }
    render(<DemoShell><NavigationFixture /></DemoShell>);
    fireEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /open this in the app/i }));
    await tick();

    expect(accountClick).toHaveBeenCalledTimes(1);
    expect(staleFolderClick).not.toHaveBeenCalled();
    expect(folderClick).toHaveBeenCalledTimes(1);
    expect(rowClick).toHaveBeenCalledTimes(1);
    expect(wrapperClick).not.toHaveBeenCalled();
  });
});
