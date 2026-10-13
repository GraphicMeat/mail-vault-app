// @vitest-environment jsdom

// Bug report (2026-10-13): Delete everywhere in the reader did nothing on a
// message only the server holds ("On the server, not saved to your vault
// yet"). The reader offers the action whatever the custody; its handler asked
// describePurge for the confirmation copy, got null (describePurge names only
// scopes that reach past the server) and returned. No dialog, no delete.
// When Delete everywhere is the only delete on the bar, the message could not
// be deleted from the reader at all. The reader now purges the server copy:
// everything that holds the message.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const { purge } = vi.hoisted(() => ({ purge: vi.fn() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 700,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey(index), start: 0 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});
vi.mock('../../services/workflows/messageMutations', async importOriginal => ({
  ...(await importOriginal()),
  purgeEverywhereReporting: (...args) => purge(...args),
}));

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { EmailViewer } = await import('../EmailViewer');
const { ThreadView } = await import('../email/ThreadView');

// Server-only: not archived, not in the vault, no backup.
const serverOnly = (overrides = {}) => ({
  uid: 41, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Week 40 winners',
  from: { name: 'DevHunt', address: 'hey@devhunt.example' }, to: [{ address: 'me@example.test' }],
  html: '<p>body</p>', text: 'body', attachments: [], flags: ['\\Seen'], date: '2026-10-13',
  isArchived: false, source: 'server', ...overrides,
});

function seedStores(email) {
  useThemeStore.setState({ palette: 'graphite', theme: 'dark' });
  useSettingsStore.setState({ emailViewerTheme: 'system', linkSafetyEnabled: false, threadReaderLayout: 'timeline', signatureDisplay: 'smart', confirmBeforeDelete: true });
  useSettingsStore.getState().setQuickActionSurface('reader', null, {
    mode: 'inline', entries: [{ id: 'deleteEverywhere', action: 'deleteEverywhere', params: {} }], favoriteId: 'deleteEverywhere', palette: 'neutral',
  });
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }],
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', mailboxScope: null,
    selectedEmail: email, selectedThread: null, loadingEmail: false, selectedEmailSource: 'server',
    emails: [email], sortedEmails: [email], localEmails: [],
    savedEmailIds: new Set(), archivedEmailIds: new Set(),
    backedUpKeys: new Set(), backedUpScopes: new Set(), backupConfigured: false,
    selectedEmailIds: new Set(),
  });
}

// Confirms, returning the label the confirm button carried.
async function confirmPurge() {
  const dialog = await screen.findByRole('alertdialog');
  const button = within(dialog).getAllByRole('button').at(-1);
  const label = button.textContent.trim();
  fireEvent.click(button);
  return label;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  purge.mockReset().mockResolvedValue({ deleted: 1, failed: 0, queuedBackup: 0, needsResync: 0 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('reader Delete everywhere on a message only the server holds', () => {
  it('EmailViewer asks, then purges the server copy', async () => {
    const email = serverOnly();
    seedStores(email);
    render(<EmailViewer />);

    fireEvent.click(screen.getByRole('button', { name: /delete everywhere/i }));
    expect(await confirmPurge()).toBe('Delete from server');

    await vi.waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    expect(purge.mock.calls[0][0]).toEqual([41]);
  });

  it('ThreadView asks, then purges the server copy', async () => {
    const email = serverOnly({ uid: 42 });
    seedStores(email);
    render(<ThreadView thread={{ threadId: 't', subject: 'Week 40 winners', emails: [email], messageCount: 1 }} onComposeReply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /delete everywhere/i }));
    expect(await confirmPurge()).toBe('Delete from server');

    await vi.waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    expect(purge.mock.calls[0][0]).toEqual([42]);
  });

  // Server view writes isArchived false on every row it lists. The vault's
  // keys still hold the message, and the purge clears that copy too: the
  // confirmation must say so, not call it a server delete.
  it('ThreadView names the vault copy a Server-view row does not flag', async () => {
    const email = serverOnly({ uid: 43 });
    seedStores(email);
    useMailStore.setState({ archivedEmailIds: new Set(['acct-1:INBOX:43']) });
    render(<ThreadView thread={{ threadId: 't', subject: 'Week 40 winners', emails: [email], messageCount: 1 }} onComposeReply={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /delete everywhere/i }));
    expect(await confirmPurge()).toBe('Delete from server and vault');
  });
});
