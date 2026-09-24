// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Keep the real account facade: mocking it as a Zustand store hides this regression.
vi.mock('../../../services/classificationService', () => ({
  getSummary: vi.fn(), getResults: vi.fn(), getStatus: vi.fn(), run: vi.fn(),
}));
vi.mock('../../../services/BulkOperationManager', () => ({
  bulkOperationManager: { start: vi.fn() },
}));
vi.mock('../../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));
vi.mock('../../../hooks/usePremiumPricing.js', () => ({ usePremiumPriceBlurb: () => '' }));
vi.mock('../../../services/attachmentUtils', () => ({ getRealAttachments: () => [], replaceCidUrls: html => html, hydrateInlineImages: email => email }));
// The preview resolves bodies through the shared resolver (vault, then the
// account's own transport). api.js fixes IS_TAURI at import, so mock there.
vi.mock('../../../services/api', async importOriginal => ({
  ...(await importOriginal()), fetchEmailLight: vi.fn(), graphGetMessage: vi.fn(), graphCacheMime: vi.fn(),
}));
vi.mock('../../../services/db', async importOriginal => ({ ...(await importOriginal()), getLocalEmailLight: vi.fn() }));
vi.mock('../../email/AttachmentBar', () => ({ AttachmentItem: () => null }));
// db/keychain.js calls transportSend('get_app_data_dir', ..) eagerly at
// module load, before this file's own top-level statements run (its own
// import of CleanupSettings is static) — vi.hoisted keeps mockSend from
// being read out of the temporal dead zone at that point.
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('../../../services/transport', () => ({ send: (...a) => Promise.resolve(mockSend(...a)) }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }) => ({
    getTotalSize: () => count * 60,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 60, size: 60 })),
  }),
}));

import { CleanupView } from '../CleanupSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import * as classification from '../../../services/classificationService';
import { bulkOperationManager } from '../../../services/BulkOperationManager';
import { ensureFreshToken } from '../../../services/authUtils';
import * as api from '../../../services/api';
import * as db from '../../../services/db';

const account = { id: 'cleanup-account', email: 'cleanup@example.test' };
const item = { messageId: 'message-42', uid: 42, mailbox: 'INBOX', subject: 'Cleanup regression message', from: 'sender@example.test', classification: { category: 'newsletter', action: 'archive', confidence: 0.9 } };
const invoke = vi.fn();
let mailState;
let settingsState;
beforeEach(() => {
  vi.clearAllMocks();
  mailState = useMailStore.getState();
  settingsState = useSettingsStore.getState();
  useMailStore.setState({ accounts: [account], activeAccountId: account.id, activeMailbox: 'INBOX' });
  useSettingsStore.setState({ customCategories: [], billingProfile: { premiumAccess: true, clientAccessGranted: true, hasSubscription: true, status: 'active' } });
  classification.getSummary.mockResolvedValue({ total: 1 });
  classification.getResults.mockResolvedValue([item]);
  classification.getStatus.mockResolvedValue({ status: 'Idle' });
  ensureFreshToken.mockImplementation(async a => ({ ...a, accessToken: 'refreshed-token' }));
  db.getLocalEmailLight.mockResolvedValue(undefined);
  api.fetchEmailLight.mockResolvedValue({ uid: 42, subject: item.subject, textBody: 'Fetched preview body' });
  bulkOperationManager.start.mockResolvedValue(undefined);
  mockSend.mockImplementation(async command => {
    if (command === 'maildir_read_light') return null;
    // Task 5.4a: imap_get_email_light now routes through send() (daemon RPC,
    // its Tauri twin is deleted), not a raw invoke() call.
    if (command === 'imap_get_email_light') return { email: { subject: item.subject, textBody: 'Fetched preview body' } };
  });
  vi.stubGlobal('__TAURI__', { core: { invoke } });
});
afterEach(() => {
  cleanup();
  useMailStore.setState(mailState, true);
  useSettingsStore.setState(settingsState, true);
  vi.unstubAllGlobals();
});

describe('Cleanup account reads', () => {
  it('falls back from local storage to IMAP when a result is opened', async () => {
    render(<CleanupView />);
    const row = await screen.findByText(item.subject);
    // Imperative reads must see the latest account, even after the row rendered.
    const updatedAccount = { ...account, username: 'updated-login' };
    useMailStore.setState({ accounts: [updatedAccount] });
    fireEvent.click(row);
    expect(await screen.findByText('Fetched preview body')).toBeTruthy();
    expect(db.getLocalEmailLight).toHaveBeenCalledWith(account.id, 'INBOX', 42);
    expect(ensureFreshToken).toHaveBeenCalledWith(updatedAccount);
    expect(api.fetchEmailLight).toHaveBeenCalledWith({ ...updatedAccount, accessToken: 'refreshed-token' }, 42, 'INBOX', account.id);
  });

  // The reading pane refreshes an OAuth token before it fetches; the preview
  // sent the store's copy as-is and swallowed the auth failure, so every
  // uncached message on a Gmail/Outlook OAuth account previewed as a blank body.
  it('refreshes an OAuth token before fetching an uncached preview', async () => {
    const oauth = { ...account, authType: 'oauth2', oauth2RefreshToken: 'refresh', oauth2AccessToken: 'stale-token' };
    useMailStore.setState({ accounts: [oauth] });
    ensureFreshToken.mockImplementation(async a => ({ ...a, oauth2AccessToken: 'fresh-token' }));
    const fetchAs = async acct => {
      if (acct.oauth2AccessToken !== 'fresh-token') throw new Error('AUTHENTICATIONFAILED');
      return { uid: 42, subject: item.subject, html: '<p>OAuth preview body</p>' };
    };
    api.fetchEmailLight.mockImplementation(fetchAs);
    mockSend.mockImplementation(async (command, args) => {
      if (command === 'imap_get_email_light') return { email: await fetchAs(args.account) };
      return null;
    });
    const { container } = render(<CleanupView />);
    fireEvent.click(await screen.findByText(item.subject));
    await waitFor(() => expect(container.querySelector('iframe')?.srcdoc).toContain('OAuth preview body'));
  });

  it('says why a preview body could not be loaded instead of rendering nothing', async () => {
    api.fetchEmailLight.mockRejectedValue(new Error('connection reset'));
    mockSend.mockImplementation(async command => {
      if (command === 'imap_get_email_light') throw new Error('connection reset');
      return null;
    });
    render(<CleanupView />);
    fireEvent.click(await screen.findByText(item.subject));
    expect(await screen.findByText(/connection reset/)).toBeTruthy();
  });


  it('preserves a preview while inactive and leaves Escape to the mail view', async () => {
    const onDetailChange = vi.fn();
    const { rerender } = render(<CleanupView accountId={account.id} onDetailChange={onDetailChange} />);
    fireEvent.click(await screen.findByText(item.subject));
    const body = await screen.findByText('Fetched preview body');
    expect(onDetailChange).toHaveBeenLastCalledWith(true);
    rerender(<CleanupView accountId={account.id} onDetailChange={onDetailChange} active={false} />);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => document.body.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(false);
    expect(screen.getByText('Fetched preview body')).toBe(body);
    expect(onDetailChange).toHaveBeenLastCalledWith(true);
    rerender(<CleanupView accountId={account.id} onDetailChange={onDetailChange} active />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('Fetched preview body')).toBeNull();
    expect(onDetailChange).toHaveBeenLastCalledWith(false);
  });

  it.each(['Archive', 'Delete'])('confirms and starts a selected %s operation', async action => {
    render(<CleanupView />);
    await screen.findByText(item.subject);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: `${action} (1)` }));
    const confirmation = screen.getByRole('heading', { name: `${action} emails?` }).parentElement;
    fireEvent.click(within(confirmation).getByRole('button', { name: action, exact: true }));
    await waitFor(() => expect(bulkOperationManager.start).toHaveBeenCalledWith({
      type: action.toLowerCase(), accountId: account.id,
      account: { ...account, accessToken: 'refreshed-token' },
      mailbox: 'INBOX', uids: [42], onProgress: expect.any(Function),
    }));
    expect(ensureFreshToken).toHaveBeenCalledWith(account);
  });
});
