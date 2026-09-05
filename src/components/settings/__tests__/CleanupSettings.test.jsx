// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Keep the real account facade: mocking it as a Zustand store hides this regression.
vi.mock('../../../services/classificationService', () => ({
  getSummary: vi.fn(), getResults: vi.fn(), getStatus: vi.fn(), run: vi.fn(),
}));
vi.mock('../../../services/BulkOperationManager', () => ({
  bulkOperationManager: { start: vi.fn() },
}));
vi.mock('../../../services/authUtils', () => ({ ensureFreshToken: vi.fn() }));
vi.mock('../../../hooks/usePremiumPricing.js', () => ({ usePremiumPriceBlurb: () => '' }));
vi.mock('../../../services/attachmentUtils', () => ({ getRealAttachments: () => [], replaceCidUrls: html => html }));
vi.mock('../../email/AttachmentBar', () => ({ AttachmentItem: () => null }));
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
  ensureFreshToken.mockResolvedValue({ ...account, accessToken: 'refreshed-token' });
  bulkOperationManager.start.mockResolvedValue(undefined);
  invoke.mockImplementation(async command => {
    if (command === 'maildir_read_light') return null;
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
    expect(invoke).toHaveBeenCalledWith('maildir_read_light', { accountId: account.id, mailbox: 'INBOX', uid: 42 });
    expect(invoke).toHaveBeenCalledWith('imap_get_email_light', { account: updatedAccount, accountId: account.id, mailbox: 'INBOX', uid: 42 });
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
