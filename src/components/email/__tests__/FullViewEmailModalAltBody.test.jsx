// @vitest-environment jsdom
import React, { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const { opened, dblclick } = vi.hoisted(() => ({ opened: { calls: [] }, dblclick: [] }));
vi.mock('../EmailActionBar', () => ({ EmailActionBar: (p) => <button onClick={() => p.onReply(p.email)}>bar-reply</button> }));
vi.mock('../../../utils/replyTarget', () => ({ replyTarget: async (t, _l, _s, sel) => ({ ...t, sel }) }));
vi.mock('../../../utils/composeOpener', () => ({ openCompose: (x) => opened.calls.push(x) }));
vi.mock('../../../utils/emailImages', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, attachImageDoubleClick: (doc, ...rest) => { dblclick.push(doc); return actual.attachImageDoubleClick(doc, ...rest); } };
});
const { FullViewEmailModal } = await import('../FullViewEmailModal');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../bodyRendererRegistry');
const { useSettingsStore } = await import('../../../stores/settingsStore');
const { useThemeStore } = await import('../../../stores/themeStore');
const { useSearchStore } = await import('../../../stores/searchStore');
const { usePrivacyStore } = await import('../../../stores/privacyStore');

const seen = [];
// The handle is { selectionRoot(), selectionText() }; the text carries a newline the DOM text does not.
const Stub = forwardRef((props, ref) => {
  const layer = React.useRef(null);
  useImperativeHandle(ref, () => ({ selectionRoot: () => layer.current, selectionText: () => 'sel text\nsecond line' }));
  seen.push(props);
  return <div data-testid="alt-full"><p ref={layer}><span>sel text</span></p><p>outside text</p></div>;
});
const email = { uid: 3, _accountId: 'a', _mailbox: 'INBOX', subject: 'Full', from: { address: 'f@x.test' }, to: [{ address: 'me@x.test' }], html: '<p>Full body</p>', text: 'Full body', attachments: [], flags: [] };

beforeEach(() => {
  registerBodyRenderer('blitz', { Body: Stub });
  useSettingsStore.setState({ emailRenderer: 'blitz', emailViewerTheme: 'dark' });
  useThemeStore.setState({ theme: 'light', palette: 'graphite' });
});
afterEach(() => {
  cleanup(); seen.length = 0; dblclick.length = 0; opened.calls.length = 0; _resetBodyRenderersForTest();
  useSettingsStore.setState({ emailRenderer: 'web', emailViewerTheme: 'system' });
  useSearchStore.setState({ searchActive: false, searchQuery: '' });
  usePrivacyStore.setState({ enabled: false });
});

const select = (node) => { const r = document.createRange(); r.selectNodeContents(node); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); };

describe('full view on the body seam', () => {
  it('draws through Alt with the same pre-processed body and fills the dialog', () => {
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    expect(document.querySelector('iframe')).toBeNull();
    const p = seen.at(-1);
    expect(p.surface).toBe('fullView');
    expect(p.bodyHtml).toContain('Full body');
    expect(p.sizing).toBe('fill');
    expect(p.className).toBe('w-full h-full');
    expect(p.theme).toEqual({ dark: true, palette: 'graphite' });
    // The full view folds nothing today, so the pre-pass marks no folds.
    expect(p.foldQuotes).toBe(false);
    expect(p.message.uid).toBe(3);
    expect(p.accountId).toBe('a');
    expect(p.messageKey).toBeTruthy();
  });

  it('hands the body the open search, and clears it when the search closes', () => {
    useSearchStore.setState({ searchActive: true, searchQuery: 'budget' });
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    expect(seen.at(-1).searchQuery).toBe('budget');
    act(() => { useSearchStore.setState({ searchActive: false }); });
    expect(seen.at(-1).searchQuery).toBe('');
  });

  it('Reply quotes the selection inside the Blitz text layer, and nothing outside it', async () => {
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    select(screen.getByText('sel text'));
    fireEvent.click(screen.getByText('bar-reply'));
    await waitFor(() => expect(opened.calls).toHaveLength(1));
    expect(opened.calls[0].replyTo.sel).toBe('sel text<br>second line');
    select(screen.getByText('outside text'));
    fireEvent.click(screen.getByText('bar-reply'));
    await waitFor(() => expect(opened.calls).toHaveLength(2));
    expect(opened.calls[1].replyTo.sel).toBe('');
  });

  it('a red link raises link safety, as the iframe does', () => {
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    act(() => { seen.at(-1).onLink({ href: 'https://evil.test/', text: 'bank.com', alert: 'red', title: 'Mismatch' }); });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('web keeps the iframe', () => {
    useSettingsStore.setState({ emailRenderer: 'web' });
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    expect(document.querySelector('iframe')).not.toBeNull();
    expect(screen.queryByTestId('alt-full')).toBeNull();
  });

  it('web: a new email object with the same body reloads the iframe, so handlers attach to a fresh document once', () => {
    useSettingsStore.setState({ emailRenderer: 'web' });
    const { rerender } = render(<FullViewEmailModal email={email} onClose={() => {}} />);
    const before = document.querySelector('iframe').getAttribute('srcdoc');
    rerender(<FullViewEmailModal email={{ ...email, flags: ['\\Seen'] }} onClose={() => {}} />);
    // Fresh nonce per build: the document reloads, so the effect's setup() never runs twice on one document.
    expect(document.querySelector('iframe').getAttribute('srcdoc')).not.toBe(before);
  });

  it('switching blitz to web attaches the iframe handlers to the fresh iframe', () => {
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(dblclick).toHaveLength(0);
    act(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(dblclick).toContain(frame.contentDocument);
  });
});
