// @vitest-environment jsdom
// The signature editor's Rendered / Code toggle. The rich text editor is a
// textarea that reports HTML the way the real one does; the sanitizer is the
// real one (the editor's schema), since it is what the Code view must go through.
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../RichTextEditor', async (importOriginal) => ({
  ...(await importOriginal()),
  RichTextEditor: ({ content, onUpdate }) => (
    <textarea data-testid="fake-editor" value={content} onChange={e => onUpdate(e.target.value)} />
  ),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
const daemonCall = vi.fn(async () => ({ fonts: [], downloading: [] }));
vi.mock('../../../services/daemonClient', () => ({ daemonCall: (...args) => daemonCall(...args) }));

import { SignatureEditor } from '../SignatureEditor';
import { useFontStore } from '../../../services/fontService';

afterEach(cleanup);

const seen = [];
function Harness({ initial = '<p>Ann</p><p>Lee</p>' }) {
  const [html, setHtml] = useState(initial);
  return (
    <>
      <SignatureEditor html={html} placeholder="Best regards" boxTestId="box"
        onChange={next => { seen.push(next); setHtml(next); }} />
      <button data-testid="swap" onClick={() => setHtml('<p>Other</p>')} />
    </>
  );
}
const open = (props) => { seen.length = 0; return render(<Harness {...props} />); };
const pressed = name => screen.getByRole('button', { name }).getAttribute('aria-pressed');
const source = () => screen.getByTestId('signature-source');

describe('SignatureEditor', () => {
  it('opens on the rendered editor, with Rendered pressed and no source shown', () => {
    open();
    expect(screen.getByTestId('fake-editor').value).toBe('<p>Ann</p><p>Lee</p>');
    expect(screen.queryByTestId('signature-source')).toBeNull();
    expect(pressed('Rendered')).toBe('true');
    expect(pressed('Code')).toBe('false');
    expect(screen.getByRole('group', { name: 'Signature view' })).toBeTruthy();
  });

  it('shows the HTML in a monospace textarea in Code view, one block per line', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.queryByTestId('fake-editor')).toBeNull();
    expect(source().value).toBe('<p>Ann</p>\n<p>Lee</p>');
    expect(source().className).toContain('font-mono');
    expect(source().getAttribute('aria-label')).toBe('Signature HTML source');
    expect(pressed('Code')).toBe('true');
    // Switching views alone changes nothing that is saved.
    expect(seen).toEqual([]);
  });

  it('saves the edited source only after the editor schema has read it', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.change(source(), { target: { value: '<p onclick="x()">Hi <script>alert(1)</script><b>there</b></p>' } });
    expect(seen.at(-1)).toBe('<p>Hi <strong>there</strong></p>');
    expect(seen.join('')).not.toMatch(/script|onclick/);
    // What was typed stays as typed while typing.
    expect(source().value).toBe('<p onclick="x()">Hi <script>alert(1)</script><b>there</b></p>');
  });

  it('returns to the rendered editor with the sanitized edit', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.change(source(), { target: { value: '<div>Edited <em>source</em></div>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }));
    expect(screen.queryByTestId('signature-source')).toBeNull();
    expect(screen.getByTestId('fake-editor').value).toBe('<p>Edited <em>source</em></p>');
  });

  it('keeps an inline picture and a link through a round trip in Code view', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const start = `<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.test/">site</a></p><p><img src="${png}" width="40"></p>`;
    open({ initial: start });
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }));
    expect(screen.getByTestId('fake-editor').value).toBe(start);
    expect(seen).toEqual([]);
  });

  it('never loses the signature to source it cannot read', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(() => fireEvent.change(source(), { target: { value: '<<<p>> </ </p <b' } })).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Rendered' }));
    expect(screen.getByTestId('fake-editor')).toBeTruthy();
  });

  it('empties the signature when the source is cleared', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.change(source(), { target: { value: '' } });
    expect(seen.at(-1)).toBe('');
  });

  it('follows the rendered editor too, and shows those edits in Code view', () => {
    open();
    fireEvent.change(screen.getByTestId('fake-editor'), { target: { value: '<p>Typed</p>' } });
    expect(seen.at(-1)).toBe('<p>Typed</p>');
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(source().value).toBe('<p>Typed</p>');
  });

  it('drops back to the rendered editor when the signature is replaced from outside', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    fireEvent.click(screen.getByTestId('swap'));
    expect(screen.queryByTestId('signature-source')).toBeNull();
    expect(screen.getByTestId('fake-editor').value).toBe('<p>Other</p>');
  });

  it('puts the test id on the box that holds either view', () => {
    open();
    const box = screen.getByTestId('box');
    expect(box.contains(screen.getByTestId('fake-editor'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(box.contains(source())).toBe(true);
  });
});

describe('SignatureEditor font', () => {
  const menu = () => {
    fireEvent.click(screen.getByRole('button', { name: /Signature font/ }));
    return screen.getByRole('menu');
  };

  it('writes a common font into the whole signature as an inline stack mail clients have', () => {
    open();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Georgia' }));
    const georgia = 'font-family: Georgia, &quot;Times New Roman&quot;, serif;';
    expect(seen.at(-1)).toBe(`<p><span style="${georgia}">Ann</span></p><p><span style="${georgia}">Lee</span></p>`);
    expect(screen.getByRole('button', { name: /Signature font/ }).textContent).toContain('Georgia');
  });

  it('offers downloaded Google families with a fallback, and says what recipients see', async () => {
    useFontStore.setState({ installed: ['Lora'], progress: {}, errors: {} });
    open();
    expect(screen.getByText(/Recipients who don't have the font see a similar default/)).toBeTruthy();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Lora' }));
    expect(seen.at(-1)).toContain('font-family: Lora, Georgia, &quot;Times New Roman&quot;, serif;');
    useFontStore.setState({ installed: [] });
  });

  it('goes back to the default font', () => {
    open({ initial: `<p><span style="font-family: Georgia, serif">Ann</span></p>` });
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Default font' }));
    expect(seen.at(-1)).toBe('<p>Ann</p>');
  });

  it('opens the Google Fonts picker from More fonts', async () => {
    open();
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'More fonts…' }));
    expect(await screen.findByRole('dialog', { name: 'More fonts' })).toBeTruthy();
  });

  it('is not offered in Code view', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByRole('button', { name: /Signature font/ }).disabled).toBe(true);
  });
});
