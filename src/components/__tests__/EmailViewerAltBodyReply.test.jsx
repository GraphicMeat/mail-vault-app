// @vitest-environment jsdom

// Reply quotes what the user selected in an alternative body. The body hands
// out its selection root through a ref handle; the quote is the selected text
// only, escaped by replySelection, never the root's own markup.
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { registerBodyRenderer, _resetBodyRenderersForTest } from '../email/bodyRendererRegistry';
import { openActiveReply } from '../../utils/composeOpener';
import { replySelection } from '../../utils/replySelection';
import { EmailViewer } from '../EmailViewer';

vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));

// A stand-in for the Blitz Body: real DOM text under a root it hands out,
// laid out like the text layer (positioned spans with inline styles).
const StubBody = forwardRef(function StubBody(_props, ref) {
  const root = useRef(null);
  useImperativeHandle(ref, () => ({ selectionRoot: () => root.current }), []);
  return (
    <div ref={root} data-testid="stub-layer" className="mv-blitz-text">
      <span style={{ position: 'relative', left: 3, letterSpacing: 0.4 }}>Tom &amp; Jerry &lt;3</span>
      <span style={{ position: 'relative', top: 20 }}>{'\nsecond line'}</span>
    </div>
  );
});
// The handle says there is no root (held for privacy, or failed).
const RootlessBody = forwardRef(function RootlessBody(_props, ref) {
  useImperativeHandle(ref, () => ({ selectionRoot: () => null }), []);
  return <div data-testid="rootless">no layer</div>;
});

const mail = {
  uid: 1, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'S',
  from: { name: 'A', address: 'a@example.test' }, to: [{ address: 'me@example.test' }],
  html: '<p>Tom &amp; Jerry &lt;3</p>', text: 'Tom & Jerry <3', attachments: [], flags: ['\\Seen'], date: '2026-10-01',
};

function show(onComposeReply) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', emailRenderer: 'blitz', threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }], activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: mail, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [mail], sortedEmails: [mail], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  return render(<EmailViewer onComposeReply={onComposeReply} />);
}

const select = (layer) => {
  const r = document.createRange();
  r.setStart(layer.firstChild.firstChild, 0);
  r.setEnd(layer.lastChild.firstChild, 7); // "\nsecond"
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
};

beforeEach(() => {
  _resetBodyRenderersForTest();
  registerBodyRenderer('blitz', { Body: StubBody });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.getSelection().removeAllRanges(); _resetBodyRenderersForTest(); });

describe('Reply quotes a selection in an alternative body', () => {
  it('quotes the selected text, escaped exactly like replySelection', async () => {
    const onComposeReply = vi.fn();
    const { getByTestId } = show(onComposeReply);
    const layer = getByTestId('stub-layer');
    select(layer);
    const expected = replySelection(layer, document.getSelection());
    expect(expected).toBe('Tom &amp; Jerry &lt;3<br>second');
    await act(async () => { openActiveReply('reply'); });
    expect(onComposeReply).toHaveBeenCalledWith('reply', expect.objectContaining({ _selectedQuoteHtml: expected }));
  });

  it('the quote carries none of the root\'s layout markup', async () => {
    const onComposeReply = vi.fn();
    const { getByTestId } = show(onComposeReply);
    select(getByTestId('stub-layer'));
    await act(async () => { openActiveReply('reply'); });
    const quote = onComposeReply.mock.calls[0][1]._selectedQuoteHtml;
    expect(quote).toContain('Tom');
    expect(quote).not.toMatch(/<span|left:|top:|letter-spacing|transparent|mv-blitz|style=|class=/);
  });

  it('pressing the Reply button keeps the selection that is then quoted', async () => {
    const onComposeReply = vi.fn();
    const { getByTestId } = show(onComposeReply);
    const layer = getByTestId('stub-layer');
    select(layer);
    const expected = replySelection(layer, document.getSelection());
    const reply = screen.getAllByRole('button').find(b => /^reply$/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    expect(reply).toBeTruthy();
    // A button does not take a selection with it on mousedown: nothing may clear it.
    expect(fireEvent.mouseDown(reply)).toBe(true);
    expect(document.getSelection().isCollapsed).toBe(false);
    await act(async () => { fireEvent.click(reply); });
    expect(onComposeReply).toHaveBeenCalledWith('reply', expect.objectContaining({ _selectedQuoteHtml: expected }));
  });

  it('a selection outside the body quotes nothing', async () => {
    const onComposeReply = vi.fn();
    show(onComposeReply);
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    const r = document.createRange(); r.selectNodeContents(outside);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    await act(async () => { openActiveReply('reply'); });
    expect(onComposeReply).toHaveBeenCalledWith('reply', expect.objectContaining({ _selectedQuoteHtml: '' }));
    outside.remove();
  });

  it('a body with no selection root quotes nothing, whatever is selected', async () => {
    _resetBodyRenderersForTest();
    registerBodyRenderer('blitz', { Body: RootlessBody });
    const onComposeReply = vi.fn();
    const { getByTestId } = show(onComposeReply);
    const r = document.createRange(); r.selectNodeContents(getByTestId('rootless'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r);
    await act(async () => { openActiveReply('reply'); });
    expect(onComposeReply).toHaveBeenCalledWith('reply', expect.objectContaining({ _selectedQuoteHtml: '' }));
  });
});
