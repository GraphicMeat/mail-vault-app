// @vitest-environment jsdom

// Download modes (H5): a message with no copy on this computer opens on the
// search index's snippet (`_bodyLoading`) while its body downloads. The reader
// marks it, and nothing that acts on "the message" may act on that text: a
// reply or forward resolves the real body first, and quick replies and
// Summarize are not offered on it.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const resolveMessageBody = vi.fn();
vi.mock('../../services/export/bodyResolver', () => ({ resolveMessageBody: (...a) => resolveMessageBody(...a) }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: new Map() }, registerListener: () => () => {} }) };
});

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { openActiveReply } = await import('../../utils/composeOpener');
const { EmailViewer } = await import('../EmailViewer');

const HEADER = {
  uid: 5, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Does Tuesday work?', messageId: '<m5@x>',
  from: { name: 'Ann', address: 'ann@example.test' }, to: [{ address: 'me@example.test' }],
  flags: ['\\Seen'], date: '2026-09-26',
};
const SNIPPET = { ...HEADER, text: 'Does Tuesday at noon', _bodyLoading: true };
const FULL = { text: 'Does Tuesday at noon work for you? Agenda attached.', attachments: [{ filename: 'agenda.pdf', size: 10 }] };

function renderViewer(selectedEmail, onComposeReply = vi.fn()) {
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart' });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [HEADER], sortedEmails: [HEADER], savedEmailIds: new Set(), archivedEmailIds: new Set(),
  });
  const view = render(<EmailViewer onComposeReply={onComposeReply} />);
  return { ...view, bar: within(view.container.querySelector('.email-action-bar')), onComposeReply };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  resolveMessageBody.mockReset().mockResolvedValue({ ok: true, email: FULL });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmailViewer on the index snippet', () => {
  it('shows the snippet with a marker that the full message is downloading', () => {
    renderViewer(SNIPPET);
    expect(screen.getByTestId('email-body-loading')).toBeTruthy();
    expect(screen.getByText('Does Tuesday at noon')).toBeTruthy();
  });

  it('offers neither quick replies nor Summarize on the snippet', () => {
    renderViewer(SNIPPET);
    expect(screen.queryByTestId('quick-reply-chips')).toBeNull();
    expect(screen.queryByTestId('ai-compose-actions')).toBeNull();
    cleanup();
    // Control: the same message with its body offers Summarize.
    renderViewer({ ...HEADER, text: FULL.text });
    expect(screen.getByTestId('ai-compose-actions')).toBeTruthy();
  });

  it('Reply resolves the real body before opening compose, never the snippet', async () => {
    const { bar, onComposeReply } = renderViewer(SNIPPET);
    fireEvent.click(bar.getAllByRole('button', { name: /^Reply$/ })[0]);
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    const [mode, replyTo] = onComposeReply.mock.calls[0];
    expect(mode).toBe('reply');
    expect(replyTo.text).toBe(FULL.text);
    expect(replyTo._bodyLoading).toBeUndefined();
  });

  it('the keyboard reply takes the same path', async () => {
    const { onComposeReply } = renderViewer(SNIPPET);
    expect(openActiveReply('replyAll')).toBe(true);
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    expect(onComposeReply.mock.calls[0][1].text).toBe(FULL.text);
  });

  it('Forward carries the full body and its attachments', async () => {
    const { bar, onComposeReply } = renderViewer(SNIPPET);
    fireEvent.click(bar.getByRole('button', { name: /^Forward$/ }));
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    const [mode, replyTo] = onComposeReply.mock.calls[0];
    expect(mode).toBe('forward');
    expect(replyTo.text).toBe(FULL.text);
    expect(replyTo.attachments).toEqual(FULL.attachments);
  });

  it('a body that cannot be resolved still never quotes the snippet', async () => {
    resolveMessageBody.mockResolvedValue({ ok: false });
    const { bar, onComposeReply } = renderViewer(SNIPPET);
    fireEvent.click(bar.getAllByRole('button', { name: /^Reply$/ })[0]);
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    expect(onComposeReply.mock.calls[0][1].text).toBeUndefined();
  });

  it('a loaded message replies straight away, without a second fetch', async () => {
    const { bar, onComposeReply } = renderViewer({ ...HEADER, text: FULL.text });
    fireEvent.click(bar.getAllByRole('button', { name: /^Reply$/ })[0]);
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    expect(resolveMessageBody).not.toHaveBeenCalled();
    expect(screen.queryByTestId('email-body-loading')).toBeNull();
  });

  it('the forward shortcut (f) forwards the full body and attachments once resolved', async () => {
    const { onComposeReply } = renderViewer(SNIPPET);
    expect(openActiveReply('forward')).toBe(true);
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    const [mode, replyTo] = onComposeReply.mock.calls[0];
    expect(mode).toBe('forward');
    expect(replyTo.text).toBe(FULL.text);
    expect(replyTo.attachments).toEqual(FULL.attachments);
  });

  it('shows reply and forward busy while the body resolves, and a second press starts nothing', async () => {
    let finish;
    resolveMessageBody.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { bar, onComposeReply } = renderViewer(SNIPPET);
    fireEvent.click(bar.getAllByRole('button', { name: /^Reply$/ })[0]);
    await waitFor(() => expect(bar.getByRole('button', { name: /^Forward$/ }).disabled).toBe(true));
    expect(bar.getAllByRole('button', { name: /^Reply$/ })[0].disabled).toBe(true);
    openActiveReply('forward');
    expect(resolveMessageBody).toHaveBeenCalledTimes(1);

    finish({ ok: true, email: FULL });
    await waitFor(() => expect(onComposeReply).toHaveBeenCalledTimes(1));
    expect(onComposeReply.mock.calls[0][0]).toBe('reply');
    await waitFor(() => expect(bar.getByRole('button', { name: /^Forward$/ }).disabled).toBe(false));
  });
});
